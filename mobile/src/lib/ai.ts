/**
 * Phone side of the AI loop.
 *
 * The phone sends a sentence and gets back an outcome. It never sees an API key, a prompt or a
 * base URL: the model lives behind the backend, and the only credential in this app is the
 * backend's address.
 *
 * The timeout is generous (75 s) because one request can include a plan call, up to eight input
 * steps and a verification call. A spinner that gives up after ten seconds would lie about a run
 * that is still going.
 *
 * Milestone 10 adds two shapes the phone must understand: a run that stopped to ask permission,
 * and a run that is still finishing in the background after the answer was given.
 */

import { apiFetch } from '@/lib/auth';

/** A step the backend refuses to take without a human saying yes. */
export type Pending = {
  taskId: string;
  stepIndex: number;
  tier: number;
  label: string;
  /** Already written for a human, e.g. `click at 52%, 31% of the screen`. */
  summary: string;
  because: string;
};

export type AiOutcome =
  | {
      ok: true;
      latencyMs: number;
      runId: string;
      state: string;
      steps: number;
      note: string;
      /** `null` when the run was a dry run: nothing ran, so nothing was verified. */
      done: boolean | null;
      reason: string | null;
      error: string | null;
      /** Set only while the run is `awaiting-approval`. */
      pending: Pending | null;
    }
  | { ok: false; reason: 'timeout' | 'network' | 'http'; detail: string };

const DEFAULT_TIMEOUT_MS = 75_000;

/** States in which the backend still has work to do on its own. */
const IN_FLIGHT = new Set(['planned', 'running', 'awaiting-approval']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** One place that turns a backend run document into the flat shape the UI renders. */
function toOutcome(record: Record<string, unknown>, latencyMs: number): AiOutcome {
  const verification = asRecord(record.verification);
  const task = asRecord(record.task);
  const pending = asRecord(task?.pending);
  const step = asRecord(pending?.step);

  return {
    ok: true,
    latencyMs,
    runId: text(record, 'runId') ?? '',
    state: text(record, 'state') ?? 'unknown',
    steps: Array.isArray(record.steps) ? record.steps.length : 0,
    note: text(record, 'note') ?? '',
    done: typeof verification?.done === 'boolean' ? verification.done : null,
    reason: text(verification ?? {}, 'reason'),
    error: text(record, 'error'),
    pending:
      pending === null || task === null
        ? null
        : {
            taskId: text(task, 'taskId') ?? '',
            stepIndex: typeof pending.index === 'number' ? pending.index : 0,
            tier: typeof pending.tier === 'number' ? pending.tier : 1,
            label: text(pending, 'label') ?? 'change',
            summary: text(pending, 'summary') ?? text(step ?? {}, 'action') ?? 'a step',
            because: text(pending, 'because') ?? '',
          },
  };
}

async function readRun(response: Response, startedAt: number): Promise<AiOutcome> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, reason: 'http', detail: `HTTP ${response.status} ${body.slice(0, 200)}` };
  }
  const parsed = asRecord(await response.json());
  return toOutcome(parsed ?? {}, Date.now() - startedAt);
}

export async function askAgent(
  baseUrl: string,
  agentId: string,
  goal: string,
  options: { dryRun?: boolean; timeoutMs?: number } = {},
): Promise<AiOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, dryRun: options.dryRun === true }),
      signal: controller.signal,
    });
    return await readRun(response, startedAt);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `no answer in ${Math.round(timeoutMs / 1000)}s` };
    }
    return {
      ok: false,
      reason: 'network',
      detail: error instanceof Error ? error.message : 'unknown network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a run back. The only way to see what happened after an approval. */
export async function fetchRun(
  baseUrl: string,
  agentId: string,
  runId: string,
): Promise<AiOutcome> {
  const startedAt = Date.now();
  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/ai/${runId}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return await readRun(response, startedAt);
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      detail: error instanceof Error ? error.message : 'unknown network error',
    };
  }
}

/** Answer the question the backend is holding a task open for. */
export async function decideApproval(
  baseUrl: string,
  agentId: string,
  taskId: string,
  stepIndex: number,
  decision: 'approve' | 'deny',
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/tasks/${taskId}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, stepIndex }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, detail: `HTTP ${response.status} ${body.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'network error' };
  }
}

/**
 * Poll a run until it stops moving on its own.
 *
 * After an approval the backend finishes in the background, so there is nothing to await over
 * HTTP — the phone watches the run document instead. Bounded, because a screen that spins for
 * ever is worse than one that says "still going, check again".
 */
export async function waitForRun(
  baseUrl: string,
  agentId: string,
  runId: string,
  options: { afterStep?: number; timeoutMs?: number } = {},
): Promise<AiOutcome> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  let last = await fetchRun(baseUrl, agentId, runId);

  /**
   * Keep polling while the run is moving. Stop when it settles, or when it asks something we
   * have not answered yet — the question the user just answered must not be shown again.
   */
  const stillMoving = (outcome: AiOutcome): boolean => {
    if (!outcome.ok) return false;
    if (outcome.state === 'done' || outcome.state === 'failed') return false;
    if (outcome.state !== 'awaiting-approval') return IN_FLIGHT.has(outcome.state);

    // No question attached means the run is past the approval stage and finishing up (it
    // verifies in the background), so keep watching rather than showing an empty prompt.
    const question = outcome.pending;
    if (question === null) return true;
    return options.afterStep !== undefined && question.stepIndex === options.afterStep;
  };

  while (last.ok && stillMoving(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    last = await fetchRun(baseUrl, agentId, runId);
  }
  return last;
}
