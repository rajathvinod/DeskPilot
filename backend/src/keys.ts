/**
 * The closed list of keys the phone and the planner may name.
 *
 * Shared so three surfaces cannot drift: the Fastify route's schema, the AI plan validator, and
 * the agent's `KEY_CODES` (which is the one that matters, because it is what reaches Windows).
 * A name that is not on this list never becomes a keystroke.
 */
export const KEY_NAMES = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'space',
] as const;

export type KeyName = (typeof KEY_NAMES)[number];

export function isKeyName(value: unknown): value is KeyName {
  return typeof value === 'string' && (KEY_NAMES as readonly string[]).includes(value);
}
