/**
 * DeskPilot wire protocol — version 1.
 *
 * Every message on the agent WebSocket is one JSON object with three fields:
 *
 *   { "type": "ping", "id": "a-uuid", "payload": { ... } }
 *
 * Why an envelope instead of sending bare payloads:
 *  - `type` lets both sides route without guessing from the shape of the data.
 *  - `id` lets us correlate a reply to a request (and later, log one task end to end).
 *  - `payload` keeps the interesting data in one predictable slot, so adding a field
 *    never changes the routing logic.
 *
 * Versioning rule: we never change the meaning of an existing `type`. A breaking change
 * becomes a new type (or bumps PROTOCOL_VERSION and both sides refuse to talk). That is
 * what makes an old agent and a new backend fail loudly instead of misbehaving subtly.
 *
 * The Python agent mirrors these names in `agent/app/ws_client.py`. When you add a type,
 * add it in both places — this file is documentation, not a compiler for the other side.
 */

/** Bumped only for breaking envelope/payload changes. Negotiated in `hello` / `hello.ack`. */
export const PROTOCOL_VERSION = 1;

export type Envelope<TType extends string = string, TPayload = unknown> = {
  type: TType;
  id: string;
  payload: TPayload;
};

/** Agent → backend, first message after the socket opens. */
export type AgentInfo = {
  agentId: string;
  hostname: string;
  platform: string;
  version: string;
  protocolVersion: number;
  /**
   * Physical size of the desktop, in pixels, when the agent could measure it.
   *
   * The phone maps a tap to a fraction of the screen using this, so it never has to know — or
   * guess — the resolution. Optional because an older agent, or a machine with no readable
   * display, is still a usable agent for everything except pointing.
   */
  screen: { width: number; height: number } | null;
};

/** backend → agent, answers `hello` and tells the agent how often to ping. */
export type HelloAckPayload = {
  protocolVersion: number;
  heartbeatIntervalMs: number;
  serverTime: string;
};

/** Agent → backend, on a timer. `sentAt` is epoch milliseconds. */
export type PingPayload = { sentAt: number };

/** backend → agent, echoes `sentAt` so the agent can measure round-trip time itself. */
export type PongPayload = { sentAt: number; serverTime: number };

/** backend → agent: "send me one screen frame now". */
export type ScreenRequestPayload = {
  /** Longest edge in pixels. The agent scales down to fit and clamps absurd values. */
  maxWidth: number;
  /** JPEG quality, 1-100. */
  quality: number;
};

/** backend → agent: click at a point expressed as a fraction of the screen (Milestone 5). */
export type ClickPayload = {
  x: number;
  y: number;
  /** `none` moves without clicking — needed for dragging later, and testable without side effects. */
  button: 'left' | 'none';
};

/** backend → agent: type text into the focused window (Milestone 6). */
export type TextPayload = { text: string };

/** The keys the phone may press by name. A fixed list, so nothing novel reaches the OS. */
export type KeyName =
  | 'enter'
  | 'tab'
  | 'escape'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'space';

/** backend → agent: press and release one named key. */
export type KeyPayload = { key: KeyName };

/** backend → agent: scroll by whole wheel notches; positive is up. */
export type ScrollPayload = { delta: number };

/**
 * agent → backend: what is in front of the laptop, and how quiet the keyboard has been
 * (Milestone 12). Sent unsolicited — there is no request and therefore no answer.
 *
 * `changed` separates the event worth alerting on (a different window came to the front) from
 * the once-a-minute sample that only proves the monitor is still running. Without that flag the
 * phone could not tell them apart, and every heartbeat would look like someone using the laptop.
 */
export type ActivityPayload = {
  /** Executable name, e.g. `Code.exe`. Empty when Windows refused to say. */
  app: string;
  /** Window title; the one field that can carry document or page content. */
  title: string;
  /** Seconds since the last keyboard or mouse input, when the agent could measure it. */
  idleSeconds: number | null;
  changed: boolean;
  /** The agent's clock, ISO 8601. The backend stamps its own receive time too. */
  at: string;
};

/** agent → backend: where the click actually landed, in desktop pixels. */
export type ClickAckPayload = { for: string; screenX: number; screenY: number };

/**
 * agent → backend: an input action completed.
 *
 * `for` is the request's envelope id, so any number of actions can be in flight. Input is the
 * one place where "it probably worked" is not good enough: the phone needs to know whether the
 * keystroke landed before it clears the text box.
 */
export type InputAckPayload = { for: string; ok: boolean; typed?: number };

/** Either direction, for anything that is not fatal. */
export type ErrorPayload = { code: string; message: string };

export function encodeEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  id: string = crypto.randomUUID(),
): string {
  return JSON.stringify({ type, id, payload } satisfies Envelope<TType, TPayload>);
}

/**
 * Turn a raw socket frame into an envelope, or `null` if it is not shaped like one.
 *
 * Returning `null` rather than throwing keeps the socket handler flat: every handler reads
 * "bad input" the same way, and no single malformed frame can crash the process.
 */
export function parseEnvelope(raw: string | Buffer | ArrayBuffer | Buffer[]): Envelope | null {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<Envelope>;
  if (typeof candidate.type !== 'string' || candidate.type === '') return null;
  if (typeof candidate.id !== 'string' || candidate.id === '') return null;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return null;

  return candidate as Envelope;
}

/** Read a string field from a payload without trusting its type. */
export function readString(payload: unknown, key: string, fallback = ''): string {
  if (typeof payload !== 'object' || payload === null) return fallback;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : fallback;
}

/** Read a numeric field from a payload without trusting its type. */
export function readNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a boolean field from a payload.
 *
 * Only a literal `true` counts. `"true"`, `1` and a missing field all mean false, because a
 * wrongly-true `changed` would turn a quiet heartbeat into an alert on the phone.
 */
export function readBoolean(payload: unknown, key: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)[key] === true;
}

/** Validate a `hello` payload. Anything missing or the wrong type means we cannot trust it. */
export function readAgentInfo(payload: unknown): AgentInfo | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const strings = ['agentId', 'hostname', 'platform', 'version'] as const;
  for (const key of strings) {
    if (typeof value[key] !== 'string' || value[key] === '') return null;
  }
  const protocolVersion = value.protocolVersion;
  if (typeof protocolVersion !== 'number') return null;

  return {
    agentId: value.agentId as string,
    hostname: value.hostname as string,
    platform: value.platform as string,
    version: value.version as string,
    protocolVersion,
    screen: readScreen(value.screen),
  };
}

/** A screen size is only usable if both numbers are finite and positive. */
function readScreen(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}
