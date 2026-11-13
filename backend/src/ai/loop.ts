/**
 * The AI loop: goal → plan → run → verify.
 *
 * The shape matters more than the model. A single "ask the model what to do" call is a demo; it
 * cannot tell you whether anything worked. This loop is deliberately closed:
 *
 *   1. **Look.** Capture the current screen and send it with the goal, so the plan is grounded in
 *      what is actually on the desktop rather than in the model's imagination.
 *   2. **Plan.** Ask for a JSON list of steps from the fixed action vocabulary.
 *   3. **Validate.** Refuse anything malformed or oversized before it can touch the desktop.
 *   4. **Run.** Hand the steps to the milestone 7 task runner: at-most-once, resumable.
 *   5. **Verify.** Capture again and ask whether the goal was achieved, with the second screenshot
 *      as evidence. The answer is reported, not assumed.
 *
 * Step 5 is the part most agent demos skip, and skipping it is why they feel impressive and
 * useless: the user's next question is always "did it work?".
 *
 * Milestone 10 splits step 4 in two. A run that reaches a step needing approval returns at once
 * with `awaiting-approval`, because a human may take a minute and an HTTP request must not. The
 * phone answers, and the loop finishes the job (including verification) in the background, so an
 * approved run still ends with a verdict instead of a task id.
 */

import type { FastifyBaseLogger } from 'fastify';

import {
  AgentNotFoundError,
  FrameFailedError,
  FrameTimeoutError,
  type AgentHub,
} from '../agentHub.js';
import type { AiConfig } from '../config.js';
import type { Step, TaskRunner, TaskSnapshot } from '../tasks.js';
import { AiRequestError, chatJson, type ChatMessage } from './client.js';
import { PlanError, parsePlan, parseVerdict, type Verdict } from './plan.js';

/** No API key, or a model that is not on the allowlist: a configuration problem, not a bug. */
export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

/** The daily run cap has been reached. */
export class AiRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiRateLimitError';
  }
}

/** The model answered, but not with something usable. */
export class AiModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiModelError';
  }
}

export type AiRunState = 'planned' | 'running' | 'awaiting-approval' | 'done' | 'failed';

export type AiRunSnapshot = {
  runId: string;
  agentId: string;
  goal: string;
  state: AiRunState;
  model: string;
  /** The validated plan. Empty while planning, or when planning failed. */
  steps: Step[];
  note: string;
  task: TaskSnapshot | null;
  verification: Verdict | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type AiRun = AiRunSnapshot;

const PLAN_SYSTEM = `You control a Windows desktop through a small fixed set of actions.
Reply with JSON only, in exactly this shape:
{"steps":[ ... ],"note":"one short sentence"}

Each step is one of:
  {"action":"click","x":0..1,"y":0..1}   fractions of the screen, 0,0 is the top-left corner
  {"action":"text","text":"literal text"}  types into whatever window has focus
  {"action":"key","key":"enter|tab|escape|backspace|delete|up|down|left|right|home|end|pageup|pagedown|space"}
  {"action":"scroll","delta":-10..10}      whole wheel notches, positive scrolls up

Rules:
  - Coordinates are fractions, never pixels.
  - Click the field before typing into it; text goes to the focused window, not a chosen one.
  - Use the smallest number of steps that achieves the goal.
  - If the goal cannot be done with these actions, reply {"steps":[],"note":"why not"} is NOT
    allowed; return a single key or scroll step that moves towards it, or a click on the most
    relevant visible control.
  - Never invent key names outside the list.`;

const VERIFY_SYSTEM = `You verify whether a goal was achieved on a Windows desktop.
You are given the goal and a screenshot taken after some actions ran.
Reply with JSON only: {"done":true|false,"reason":"one short sentence"}.
Answer from what is visible in the screenshot. If you cannot tell, say so and use done:false.`;

const REPAIR_HINT = 'Your previous reply could not be used. Fix exactly that problem and reply with the same JSON shape.';

/** Sort a base64 screenshot into a content part the chat API understands. */
function imagePart(frame: Buffer): ChatMessage['content'] extends string ? never : { type: 'image_url'; image_url: { url: string } } {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Terminal states: nothing more will happen to this task on its own. */
function isSettled(state: TaskSnapshot['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

export class AiLoop {
  private readonly runs = new Map<string, AiRun>();
  private day = '';
  private usedToday = 0;

  constructor(
    private readonly hub: AgentHub,
    private readonly tasks: TaskRunner,
    private readonly log: FastifyBaseLogger,
    private readonly config: AiConfig,
  ) {}

  get(runId: string): AiRunSnapshot | null {
    const run = this.runs.get(runId);
    return run === undefined ? null : { ...run, steps: [...run.steps] };
  }

  /**
   * Run one goal end to end.
   *
   * Throws typed errors rather than returning failure objects, because the HTTP layer has to map
   * "no key" to 503 and "the agent vanished" to 404 — and those are different promises to keep.
   */
  async run(agentId: string, goal: string, options: { dryRun?: boolean } = {}): Promise<AiRunSnapshot> {
    const apiKey = this.config.apiKey;
    if (apiKey === null) {
      throw new AiNotConfiguredError('no model key is configured; set DP_AI_API_KEY in backend/.env');
    }
    if (!this.config.models.includes(this.config.model)) {
      throw new AiNotConfiguredError(
        `model "${this.config.model}" is not in DP_AI_MODELS, so this server will not call it`,
      );
    }
    this.spend();

    const now = new Date().toISOString();
    const run: AiRun = {
      runId: crypto.randomUUID(),
      agentId,
      goal,
      state: 'planned',
      model: this.config.model,
      steps: [],
      note: '',
      task: null,
      verification: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.runId, run);
    this.prune();

    try {
      // Look before planning. Without the screenshot the model is guessing at what is on screen.
      const before = await this.capture(agentId);
      const plan = await this.plan(apiKey, goal, before);

      run.steps = plan.steps;
      run.note = plan.note;
      run.state = options.dryRun === true ? 'planned' : 'running';
      run.updatedAt = new Date().toISOString();

      this.log.info(
        { runId: run.runId, agentId, steps: plan.steps.length, dryRun: options.dryRun === true },
        'ai plan ready',
      );

      if (options.dryRun === true) return this.get(run.runId) ?? run;

      const task = this.tasks.create(agentId, `ai: ${goal.slice(0, 40)}`, plan.steps);
      const settled = await this.waitForTask(
        task.taskId,
        60_000,
        (snapshot) => isSettled(snapshot.state) || snapshot.state === 'paused',
      );

      if (settled.state === 'paused') {
        run.task = settled;
        run.state = 'awaiting-approval';
        run.updatedAt = new Date().toISOString();
        this.log.info(
          { runId: run.runId, taskId: task.taskId, step: settled.pending?.index ?? null },
          'ai run paused for approval',
        );
        // The request has to return: a human may take a minute to answer. Finishing in the
        // background keeps the promise that an approved run still gets a verification.
        void this.finishLater(apiKey, run);
        return this.get(run.runId) ?? run;
      }

      return await this.complete(apiKey, run, settled);
    } catch (error) {
      this.applyError(run, error);
      if (error instanceof PlanError) {
        throw new AiModelError(`the model could not produce a usable plan: ${error.message}`);
      }
      if (error instanceof AiRequestError) {
        throw new AiModelError(`the model call failed: ${error.message}`);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ internals

  /** Verify and record the outcome once the task has finished, however it finished. */
  private async complete(apiKey: string, run: AiRun, finished: TaskSnapshot): Promise<AiRunSnapshot> {
    run.task = finished;
    run.updatedAt = new Date().toISOString();

    if (finished.state !== 'done') {
      run.state = 'failed';
      run.error = `the task ended as "${finished.state}"${finished.lastError === null ? '' : `: ${finished.lastError}`}`;
      this.log.warn({ runId: run.runId, state: finished.state }, 'ai task did not finish');
      return this.get(run.runId) ?? run;
    }

    // Verification is still work in progress. Say so, instead of leaving the run looking like it
    // is waiting for a human it has already heard from — the phone stops polling on that state.
    run.state = 'running';
    run.updatedAt = new Date().toISOString();

    // Verify against a *fresh* frame: the point is what the desktop looks like now.
    const after = await this.capture(run.agentId);
    run.verification = parseVerdict(await this.ask(apiKey, this.verifyMessages(run.goal, after)));
    run.state = 'done';
    run.updatedAt = new Date().toISOString();

    this.log.info(
      { runId: run.runId, verified: run.verification.done, reason: run.verification.reason },
      'ai run finished',
    );
    return this.get(run.runId) ?? run;
  }

  /**
   * Wait for the approval answer, then finish the run.
   *
   * Runs after the HTTP response has already gone out, so nothing here may throw: an exception
   * would be an unhandled rejection and the run would stay `awaiting-approval` for ever. The
   * generous deadline covers a human taking their time, while still ending a run whose approval
   * timed out at the task level.
   */
  private async finishLater(apiKey: string, run: AiRun): Promise<void> {
    const taskId = run.task?.taskId;
    if (taskId === undefined) return;

    let answered = -1;

    try {
      for (;;) {
        const snapshot = await this.waitForTask(
          taskId,
          10 * 60_000,
          (task) =>
            isSettled(task.state) ||
            (task.state === 'paused' && (task.pending?.index ?? -1) !== answered),
        );

        // Keep the run document current. The phone reads the question from here, so a stale
        // copy would offer to approve a step that has already been approved — and the answer
        // would come back as a 409 for no reason the user can see.
        run.task = snapshot;
        run.updatedAt = new Date().toISOString();

        if (isSettled(snapshot.state)) {
          await this.complete(apiKey, run, snapshot);
          return;
        }

        answered = snapshot.pending?.index ?? -1;
        this.log.info({ runId: run.runId, step: answered }, 'ai run paused for approval');
      }
    } catch (error) {
      this.applyError(run, error);
      this.log.warn({ runId: run.runId, error: run.error }, 'ai run failed after approval');
    }
  }

  private applyError(run: AiRun, error: unknown): void {
    run.state = 'failed';
    run.error =
      error instanceof PlanError
        ? `the model could not produce a usable plan: ${error.message}`
        : error instanceof AiRequestError
          ? `the model call failed: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    run.updatedAt = new Date().toISOString();
  }

  private async capture(agentId: string): Promise<Buffer> {
    // Smaller and softer than the phone's view: the model needs to recognise controls, not read
    // body text, and every extra pixel is tokens.
    return this.hub.requestFrame(agentId, 8_000, { maxWidth: 1024, quality: 60 });
  }

  private ask(apiKey: string, messages: ChatMessage[]): Promise<unknown> {
    return chatJson({
      baseUrl: this.config.baseUrl,
      apiKey,
      model: this.config.model,
      timeoutMs: this.config.timeoutMs,
      messages,
    });
  }

  /** One planning call, plus a single repair attempt if the reply could not be used. */
  private async plan(
    apiKey: string,
    goal: string,
    frame: Buffer,
  ): Promise<{ steps: Step[]; note: string }> {
    const messages = this.planMessages(goal, frame);

    try {
      return parsePlan(await this.ask(apiKey, messages), this.config.maxSteps);
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;

      this.log.warn({ problem: error.message }, 'ai plan rejected, asking for a correction');
      const repaired = [
        ...messages,
        { role: 'user' as const, content: `${REPAIR_HINT}\nProblem: ${error.message}` },
      ];
      return parsePlan(await this.ask(apiKey, repaired), this.config.maxSteps);
    }
  }

  private planMessages(goal: string, frame: Buffer): ChatMessage[] {
    return [
      { role: 'system', content: PLAN_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Goal: ${goal}\nUse at most ${this.config.maxSteps} steps.` },
          imagePart(frame),
        ],
      },
    ];
  }

  private verifyMessages(goal: string, frame: Buffer): ChatMessage[] {
    return [
      { role: 'system', content: VERIFY_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Goal: ${goal}\nThis is the screen after the actions ran.` },
          imagePart(frame),
        ],
      },
    ];
  }

  /**
   * Wait until the task is worth reporting. Bounded, because the caller is either an HTTP
   * request or a background continuation, and neither may wait for ever.
   *
   * The caller supplies the condition, because "interesting" differs: the request returns at the
   * first question (so the HTTP call can end), while the background watcher waits for the *next*
   * question or the end of the task.
   */
  private async waitForTask(
    taskId: string,
    deadlineMs: number,
    until: (snapshot: TaskSnapshot) => boolean,
  ): Promise<TaskSnapshot> {
    const deadline = Date.now() + deadlineMs;

    for (;;) {
      const snapshot = this.tasks.get(taskId);
      if (snapshot === null) throw new FrameFailedError(`task ${taskId} disappeared`);

      if (until(snapshot)) return snapshot;
      if (Date.now() > deadline) {
        throw new FrameTimeoutError(
          `task ${taskId} did not finish within ${Math.round(deadlineMs / 1000)}s`,
        );
      }
      await sleep(250);
    }
  }

  /** Count a run against today's cap, resetting at midnight UTC. */
  private spend(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.usedToday = 0;
    }
    if (this.usedToday >= this.config.dailyRuns) {
      throw new AiRateLimitError(
        `the daily limit of ${this.config.dailyRuns} AI runs is used up; it resets at midnight UTC`,
      );
    }
    this.usedToday += 1;
  }

  /** Keep the run map bounded; the phone only ever asks about the newest one. */
  private prune(): void {
    const finished = [...this.runs.values()].filter(
      (run) => run.state === 'done' || run.state === 'failed',
    );
    for (const run of finished.slice(0, Math.max(0, finished.length - 20))) {
      this.runs.delete(run.runId);
    }
  }
}

export { AgentNotFoundError, FrameFailedError, FrameTimeoutError };
