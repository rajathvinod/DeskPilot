/**
 * Turning whatever the model said into steps that are safe to run.
 *
 * A language model is an untrusted input source. It is not malicious, but it is *wrong* in
 * ordinary ways: it invents a key name, sends pixel coordinates where fractions were asked for,
 * or returns forty steps for a one-step goal. Everything here exists to refuse that before a
 * click reaches the desktop.
 *
 * The rule is the same one the HTTP routes follow: validate at the boundary, then trust the
 * type. Nothing downstream of `parsePlan` has to wonder whether `x` is a number.
 */

import { isKeyName } from '../keys.js';
import type { Step } from '../tasks.js';

/** The model's plan was unusable, even after being asked to fix it. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export type ParsedPlan = { steps: Step[]; note: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one step, or explain why it is not runnable.
 *
 * The messages name the index and the field, because they are also fed back to the model when it
 * is asked to correct itself — a bare "invalid plan" teaches it nothing.
 */
function parseStep(value: unknown, index: number): Step {
  if (!isRecord(value)) throw new PlanError(`steps[${index}] is not an object`);
  const action = value['action'];

  switch (action) {
    case 'text': {
      const text = value['text'];
      if (typeof text !== 'string' || text === '') {
        throw new PlanError(`steps[${index}] text must be a non-empty string`);
      }
      if (text.length > 2000) throw new PlanError(`steps[${index}] text is longer than 2000 characters`);
      return { action: 'text', text };
    }

    case 'key': {
      const key = value['key'];
      if (!isKeyName(key)) {
        throw new PlanError(`steps[${index}] key must be one of: enter, tab, escape, backspace, delete, up, down, left, right, home, end, pageup, pagedown, space`);
      }
      return { action: 'key', key };
    }

    case 'scroll': {
      const delta = value['delta'];
      if (typeof delta !== 'number' || !Number.isInteger(delta) || delta < -10 || delta > 10) {
        throw new PlanError(`steps[${index}] delta must be a whole number between -10 and 10`);
      }
      return { action: 'scroll', delta };
    }

    case 'click': {
      const x = value['x'];
      const y = value['y'];
      for (const [name, coord] of [
        ['x', x],
        ['y', y],
      ] as const) {
        if (typeof coord !== 'number' || !Number.isFinite(coord) || coord < 0 || coord > 1) {
          throw new PlanError(
            `steps[${index}] ${name} must be a fraction of the screen between 0 and 1 (got ${String(coord)})`,
          );
        }
      }
      return { action: 'click', x: x as number, y: y as number };
    }

    default:
      throw new PlanError(
        `steps[${index}] action must be "click", "text", "key" or "scroll" (got ${String(action)})`,
      );
  }
}

/**
 * Validate a whole plan: an object with a non-empty `steps` array and an optional `note`.
 *
 * `maxSteps` is enforced here rather than only in the prompt, because a prompt is a request and
 * this is a limit. Extra fields are ignored rather than refused — dropping a `confidence` field
 * costs nothing, while refusing the plan wastes a paid call.
 */
export function parsePlan(raw: unknown, maxSteps: number): ParsedPlan {
  if (!isRecord(raw)) throw new PlanError('the reply was not a JSON object');

  const steps = raw['steps'];
  if (!Array.isArray(steps)) throw new PlanError('the reply has no "steps" array');
  if (steps.length === 0) throw new PlanError('"steps" is empty, so there is nothing to do');
  if (steps.length > maxSteps) {
    throw new PlanError(`the plan has ${steps.length} steps; the limit is ${maxSteps}`);
  }

  const note = typeof raw['note'] === 'string' ? raw['note'].slice(0, 300) : '';
  return { steps: steps.map((step, index) => parseStep(step, index)), note };
}

/** The verification reply: did the goal actually happen? */
export type Verdict = { done: boolean; reason: string };

export function parseVerdict(raw: unknown): Verdict {
  if (!isRecord(raw)) throw new PlanError('the verification reply was not a JSON object');
  const done = raw['done'];
  const reason = raw['reason'];
  if (typeof done !== 'boolean') throw new PlanError('verification reply needs a boolean "done"');
  return { done, reason: typeof reason === 'string' ? reason.slice(0, 300) : '' };
}
