/**
 * How much harm one step could do, in three levels.
 *
 * This exists because "the AI may click anything" is not a policy — it is the absence of one.
 * A click on a scrollbar and a click on a Delete button are the same message on the wire, so the
 * only honest way to tier them is to look at what the action *could* do rather than at what it
 * is aimed at: we cannot see the control under the cursor, and pretending otherwise would be a
 * false promise. The tiers below are therefore deliberately pessimistic.
 *
 *   0 — look:     nothing on disk or in a form changes. Safe to do unattended.
 *   1 — change:   something on screen is edited. Undoable in most apps, but visible.
 *   2 — commit:   Enter, Backspace, Delete. Submits a form, sends a message, erases text.
 *
 * The threshold that actually triggers a question lives in the task options, not here, so the
 * same classification can serve a strict user (ask about anything above "look") and a relaxed
 * one (only ask about "commit").
 */

import type { Step } from './tasks.js';

export type RiskTier = 0 | 1 | 2;

export type Assessment = {
  tier: RiskTier;
  label: 'look' | 'change' | 'commit';
  /** One sentence for the human who has to answer: why this needs a decision. */
  because: string;
};

/** Keys that move a selection or a viewport. They change nothing durable. */
const NAVIGATION_KEYS = new Set([
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'pageup',
  'pagedown',
  'home',
  'end',
]);

/** Keys that can submit or erase. The only ones worth calling irreversible in this vocabulary. */
const COMMITTING_KEYS = new Set(['enter', 'backspace', 'delete']);

export function assessStep(step: Step): Assessment {
  switch (step.action) {
    case 'scroll':
      return {
        tier: 0,
        label: 'look',
        because: 'scrolling only changes what you are looking at',
      };

    case 'key':
      if (NAVIGATION_KEYS.has(step.key)) {
        return {
          tier: 0,
          label: 'look',
          because: `${step.key} only moves the selection`,
        };
      }
      if (COMMITTING_KEYS.has(step.key)) {
        return {
          tier: 2,
          label: 'commit',
          because: `${step.key} can submit a form or erase what is written`,
        };
      }
      return {
        tier: 1,
        label: 'change',
        because: `${step.key} can change what is on screen`,
      };

    case 'text':
      return {
        tier: 1,
        label: 'change',
        because: 'typing edits whatever window has focus',
      };

    case 'click':
      return {
        tier: 1,
        label: 'change',
        because: 'a click can press any button, and nothing here knows which one is under the pointer',
      };
  }
}

/**
 * A step in words a human can judge in one second.
 *
 * The phone shows this instead of raw JSON, because "click x=0.52 y=0.31" asks the reader to do
 * arithmetic before they can decide.
 */
export function describeStep(step: Step): string {
  switch (step.action) {
    case 'scroll': {
      const notches = Math.abs(step.delta);
      return `scroll ${step.delta > 0 ? 'up' : 'down'} ${notches} notch${notches === 1 ? '' : 'es'}`;
    }
    case 'key':
      return `press ${step.key}`;
    case 'text': {
      const short = step.text.length > 40 ? `${step.text.slice(0, 40)}…` : step.text;
      return `type "${short}"`;
    }
    case 'click':
      return `click at ${Math.round(step.x * 100)}%, ${Math.round(step.y * 100)}% of the screen`;
  }
}
