/**
 * Tasks: several input steps run once each, surviving a reconnect in the middle.
 *
 * Why this exists at all: a single click is atomic enough — either it happened or it did not.
 * A *sequence* is not. If the agent's socket dies after step 2, the naive recovery is "start
 * again", which replays steps 1 and 2 and can double-submit a form or click the wrong button
 * the second time round.
 *
 * So each step carries a stable `stepId` (`taskId:index`). The agent keeps a ledger of step ids
 * it has already carried out and answers a repeat from that ledger instead of acting again.
 * That makes the retry safe by construction rather than by timing.
 *
 * The backend's half of the bargain is to wait, not fail: a dropped socket is usually a Wi-Fi
 * hiccup or a restarting agent, and both come back. Waiting up to `resumeWindowMs` turns "your
 * task broke" into "your task took 4 seconds longer".
 *
 * Milestone 10 adds a third way to stop between steps: a step that is not safe to do unattended
 * parks the task in `paused` and waits for a human answer. The position is already durable (the
 * ledger), so approving simply resumes the loop at the same index — nothing before it replays.
 */

import type { FastifyBaseLogger } from 'fastify';

import { AgentNotFoundError, FrameTimeoutError, type AgentHub } from './agentHub.js';
import { assessStep, describeStep, type Assessment, type RiskTier } from './risk.js';

/** One thing to do. Deliberately the same four actions the phone can send on its own. */
export type Step =
  | { action: 'text'; text: string }
  | { action: 'key'; key: string }
  | { action: 'scroll'; delta: number }
  | { action: 'click'; x: number; y: number };

export type TaskState = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled';

/** The step a paused task is waiting on, described for a human rather than for a machine. */
export type PendingApproval = {
  index: number;
  step: Step;
  tier: RiskTier;
  label: string;
  summary: string;
  because: string;
};

export type TaskSnapshot = {
  taskId: string;
  agentId: string;
  name: string;
  state: TaskState;
  /** Steps in the task, and how many are confirmed done. */
  total: number;
  completed: number;
  /** Time spent waiting for the agent to come back, so a stall is visible rather than mysterious. */
  waitedMs: number;
  lastError: string | null;
  /** Set only while `state` is `paused`: what is being asked, and why. */
  pending: PendingApproval | null;
  createdAt: string;
  updatedAt: string;
};

type Gate = { index: number; resolve: (decision: 'approve' | 'deny') => void };

type Task = TaskSnapshot & { steps: Step[]; cancelled: boolean; gapMs: number; gate: Gate | null };

export type TaskOptions = {
  /** How long one step may take before it counts as failed. */
  stepTimeoutMs: number;
  /** How long a task may wait for its agent to reconnect before giving up. */
  resumeWindowMs: number;
  /** Pause between steps. Actions arriving faster than the desktop can react is its own bug. */
  gapMs: number;
  /** How many finished tasks to keep for inspection. */
  keep: number;
  /**
   * Steps at or above this tier wait for a human answer.
   * 1 = anything that changes something, 2 = only Enter/Backspace/Delete, 3 = never ask.
   */
  approvalTier: number;
  /** How long a paused task waits for an answer. Silence is treated as "no". */
  approvalWaitMs: number;
};

const DEFAULTS: TaskOptions = {
  stepTimeoutMs: 5_000,
  resumeWindowMs: 20_000,
  gapMs: 250,
  keep: 50,
  approvalTier: 1,
  approvalWaitMs: 120_000,
};

/** Errors that mean "try again when the agent is back", as opposed to "this step is wrong". */
function isTransient(error: unknown): boolean {
  return error instanceof AgentNotFoundError || error instanceof FrameTimeoutError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskRunner {
  private readonly tasks = new Map<string, Task>();
  private readonly options: TaskOptions;

  constructor(
    private readonly hub: AgentHub,
    private readonly log: FastifyBaseLogger,
    options: Partial<TaskOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Start a task and return immediately: the work continues in the background. */
  create(agentId: string, name: string, steps: Step[], gapMs?: number): TaskSnapshot {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: crypto.randomUUID(),
      agentId,
      name,
      state: 'running',
      total: steps.length,
      completed: 0,
      waitedMs: 0,
      lastError: null,
      pending: null,
      createdAt: now,
      updatedAt: now,
      steps,
      cancelled: false,
      gapMs: Math.min(this.options.gapMs * 8, Math.max(0, gapMs ?? this.options.gapMs)),
      gate: null,
    };

    this.tasks.set(task.taskId, task);
    this.prune();
    this.log.info({ taskId: task.taskId, agentId, steps: steps.length }, 'task started');
    void this.run(task);
    return this.snapshot(task);
  }

  get(taskId: string): TaskSnapshot | null {
    const task = this.tasks.get(taskId);
    return task === undefined ? null : this.snapshot(task);
  }

  list(agentId?: string): TaskSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => agentId === undefined || task.agentId === agentId)
      .map((task) => this.snapshot(task));
  }

  /**
   * Answer a paused task.
   *
   * Returns `null` when this task is not waiting for that particular step — the caller turns
   * that into a 409, because "you are approving something that is not being asked" is a
   * different situation from "no such task".
   */
  approve(taskId: string, stepIndex: number, decision: 'approve' | 'deny'): TaskSnapshot | null {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.gate === null || task.pending === null) return null;
    if (task.gate.index !== stepIndex) return null;

    const gate = task.gate;
    task.gate = null;
    task.pending = null;

    if (decision === 'approve') {
      task.state = 'running';
    } else {
      task.cancelled = true;
      task.state = 'cancelled';
    }
    task.updatedAt = new Date().toISOString();
    gate.resolve(decision);

    this.log.info({ taskId, step: stepIndex, decision }, 'task approval answered');
    return this.snapshot(task);
  }

  /** Ask a task to stop. The step in flight finishes; later steps are skipped. */
  cancel(taskId: string): TaskSnapshot | null {
    const task = this.tasks.get(taskId);
    if (task === undefined) return null;

    task.cancelled = true;
    if (task.state !== 'done' && task.state !== 'failed') task.state = 'cancelled';
    task.updatedAt = new Date().toISOString();

    // A paused task is waiting on a promise, not on the network: without this it would sit
    // there until the approval timeout even though it has already been cancelled.
    if (task.gate !== null) {
      const gate = task.gate;
      task.gate = null;
      task.pending = null;
      gate.resolve('deny');
    }

    return this.snapshot(task);
  }

  private async run(task: Task): Promise<void> {
    for (let index = task.completed; index < task.steps.length; index += 1) {
      if (task.cancelled) break;

      const step = task.steps[index];
      if (step === undefined) break;

      // Some steps are not safe to take unattended. Ask before those and treat silence as "no":
      // a task nobody approved must not act by default.
      const assessment = assessStep(step);
      if (assessment.tier >= this.options.approvalTier) {
        const decision = await this.requestApproval(task, index, step, assessment);
        if (decision !== 'approve') {
          task.state = 'cancelled';
          task.updatedAt = new Date().toISOString();
          this.log.info(
            { taskId: task.taskId, step: index, decision, action: step.action },
            'task stopped without approval',
          );
          return;
        }
      }

      // Stable across retries and across reconnects; the agent uses it to dedupe.
      const stepId = `${task.taskId}:${index}`;
      const ok = await this.runStep(task, stepId, step);

      if (!ok) {
        task.state = task.cancelled ? 'cancelled' : 'failed';
        task.updatedAt = new Date().toISOString();
        this.log.warn(
          { taskId: task.taskId, step: index, completed: task.completed, error: task.lastError },
          'task stopped',
        );
        return;
      }

      task.completed = index + 1;
      task.state = 'running';
      task.updatedAt = new Date().toISOString();

      if (index + 1 < task.steps.length && task.gapMs > 0) await sleep(task.gapMs);
    }

    task.state = task.cancelled ? 'cancelled' : 'done';
    task.updatedAt = new Date().toISOString();
    this.log.info(
      { taskId: task.taskId, completed: task.completed, waitedMs: task.waitedMs },
      task.state === 'done' ? 'task finished' : 'task stopped',
    );
  }

  /**
   * Park the task until someone answers, or until nobody does.
   *
   * The promise is the whole mechanism: the loop is already a sequence of `await`s, so waiting
   * for a human is not a special case — it is one more thing to await. No polling, no extra
   * state machine, and the step position is still in `completed` if the backend restarts.
   */
  private requestApproval(
    task: Task,
    index: number,
    step: Step,
    assessment: Assessment,
  ): Promise<'approve' | 'deny'> {
    return new Promise((resolve) => {
      task.pending = {
        index,
        step,
        tier: assessment.tier,
        label: assessment.label,
        summary: describeStep(step),
        because: assessment.because,
      };
      task.state = 'paused';
      task.updatedAt = new Date().toISOString();
      this.log.info(
        { taskId: task.taskId, step: index, tier: assessment.tier, action: step.action },
        'task paused for approval',
      );

      const timer = setTimeout(() => {
        if (task.gate?.index !== index) return;
        task.gate = null;
        task.pending = null;
        task.cancelled = true;
        task.state = 'cancelled';
        task.updatedAt = new Date().toISOString();
        this.log.warn({ taskId: task.taskId, step: index }, 'nobody approved, task stopped');
        resolve('deny');
      }, this.options.approvalWaitMs);
      // Do not keep the process alive just to time out an unanswered question.
      timer.unref();

      task.gate = {
        index,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      };
    });
  }

  /**
   * Run one step, retrying while the agent is away.
   *
   * The retry is safe because the agent remembers the step id: if the step ran but its
   * acknowledgement was lost, the retry is answered from the ledger rather than acted on again.
   */
  private async runStep(task: Task, stepId: string, step: Step): Promise<boolean> {
    let waited = 0;

    for (;;) {
      if (task.cancelled) return false;

      try {
        await this.dispatch(task.agentId, stepId, step);
        return true;
      } catch (error) {
        if (!isTransient(error)) {
          task.lastError = error instanceof Error ? error.message : String(error);
          return false;
        }

        if (waited >= this.options.resumeWindowMs) {
          task.lastError = `agent did not come back within ${Math.round(this.options.resumeWindowMs / 1000)}s`;
          return false;
        }

        task.state = 'waiting';
        task.updatedAt = new Date().toISOString();
        await sleep(250);
        waited += 250;
        task.waitedMs += 250;
      }
    }
  }

  private dispatch(agentId: string, stepId: string, step: Step): Promise<unknown> {
    switch (step.action) {
      case 'text':
        return this.hub.typeText(agentId, step.text, this.options.stepTimeoutMs, stepId);
      case 'key':
        return this.hub.pressKey(agentId, step.key, this.options.stepTimeoutMs, stepId);
      case 'scroll':
        return this.hub.scroll(agentId, step.delta, this.options.stepTimeoutMs, stepId);
      case 'click':
        return this.hub.click(agentId, step.x, step.y, 'left', this.options.stepTimeoutMs, stepId);
    }
  }

  private snapshot(task: Task): TaskSnapshot {
    const { steps: _steps, cancelled: _cancelled, gapMs: _gapMs, gate: _gate, ...snapshot } = task;
    return snapshot;
  }

  /** Keep the map bounded: finished tasks are kept for inspection, but not forever. */
  private prune(): void {
    const finished = [...this.tasks.values()].filter(
      (task) => task.state === 'done' || task.state === 'failed' || task.state === 'cancelled',
    );
    for (const task of finished.slice(0, Math.max(0, finished.length - this.options.keep))) {
      this.tasks.delete(task.taskId);
    }
  }
}
