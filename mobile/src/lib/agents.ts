/**
 * Talking to the backend's `/agents` endpoint, and turning the reply into a verdict.
 *
 * Kept apart from the screen on purpose: this file knows about HTTP and payload shapes,
 * `index.tsx` only knows how to draw. When the endpoint changes shape for screen streaming
 * in Milestone 3, only this file moves.
 */

import { apiFetch } from '@/lib/auth';

/** One display the laptop can capture, as the agent measured it. */
export type MonitorInfo = {
  index: number;
  /** Desktop coordinates; negative for a display placed left of / above the primary one. */
  left: number;
  top: number;
  width: number;
  height: number;
  primary: boolean;
};

/** One connected agent, as the backend describes it. */
export type AgentSummary = {
  agentId: string;
  hostname: string;
  platform: string;
  version: string;
  remoteAddress: string;
  /** Desktop size in pixels when the agent reported it, else null. */
  screenWidth: number | null;
  screenHeight: number | null;
  /** Empty means "this agent offered no displays", which is the single-screen case. */
  monitors: MonitorInfo[];
  connectedForMs: number;
  /** How long ago the agent last proved it was alive. An *age*, not a timestamp — see below. */
  lastSeenAgoMs: number;
  lastRttMs: number | null;
};

export type AgentsSnapshot = {
  protocolVersion: number;
  heartbeatIntervalMs: number;
  helloTimeoutMs: number;
  /** Seconds this backend process has been running; null if the field is missing. */
  uptimeSeconds: number | null;
  /** ISO timestamp of when this backend process started. */
  startedAt: string | null;
  agents: AgentSummary[];
};

/** Either we got an answer, or we know precisely why we did not. */
export type FetchOutcome =
  | { ok: true; snapshot: AgentsSnapshot; latencyMs: number }
  | { ok: false; reason: 'timeout' | 'network' | 'http'; detail: string };

/**
 * What the screen should say. Four cases, not two.
 *
 * The whole point: "I could not reach the backend" and "the backend says nobody is
 * connected" are completely different situations that a naive `agents.length > 0` check
 * would collapse into one sad empty screen.
 */
export type Link =
  | { state: 'unreachable'; reason: 'timeout' | 'network' | 'http'; detail: string }
  | { state: 'no-agent' }
  | { state: 'unstable'; agent: AgentSummary; sinceMs: number }
  | { state: 'connected'; agent: AgentSummary };

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Fetch the agent list with a hard timeout.
 *
 * Two separate failure modes are reported separately: the request never completing
 * (AbortError) and the request failing outright (connection refused, DNS, TLS). A phone on
 * flaky mobile data hits both, and they deserve different words on screen.
 */
export async function fetchAgents(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await apiFetch(`${baseUrl}/agents`, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, reason: 'http', detail: `HTTP ${response.status}` };
    }
    const snapshot = parseSnapshot(await response.json());
    return { ok: true, snapshot, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', detail: `no answer in ${timeoutMs / 1000}s` };
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

/**
 * Turn a reply into a verdict.
 *
 * On staleness: the backend drops a silent agent after 2.5 heartbeats (see
 * `docs/protocol.md` §6). A record older than that is one the backend is about to discard,
 * so we call it out before the backend does. This label is advisory until Milestone 3
 * gives the phone real data to judge by.
 */
export function deriveLink(outcome: FetchOutcome): Link {
  if (!outcome.ok) {
    return { state: 'unreachable', reason: outcome.reason, detail: outcome.detail };
  }

  const { agents, heartbeatIntervalMs } = outcome.snapshot;
  const agent = agents[0];
  if (!agent) {
    return { state: 'no-agent' };
  }

  const staleAfterMs = heartbeatIntervalMs * 2.5;
  if (agent.lastSeenAgoMs > staleAfterMs) {
    return { state: 'unstable', agent, sinceMs: agent.lastSeenAgoMs };
  }
  return { state: 'connected', agent };
}

/**
 * A start time as local clock time, e.g. "22:38:44".
 *
 * The backend sends UTC; the phone shows the timezone it actually lives in, because the
 * human comparing this against their watch is the one looking at the screen.
 */
export function humanClock(iso: string | null): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleTimeString();
}

/** Milliseconds as something a human reads without doing arithmetic. */
export function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Read a payload we do not fully trust.
 *
 * The phone runs whatever build the user last installed, against whatever backend happens
 * to be running. If the backend drops or renames a field, a blind cast (`as AgentsSnapshot`)
 * would hand `undefined` to the UI and crash on `.toFixed()`. Defaulting each field keeps a
 * contract mismatch survivable instead of fatal.
 */
function parseSnapshot(raw: unknown): AgentsSnapshot {
  const body = isRecord(raw) ? raw : {};
  const list = Array.isArray(body.agents) ? body.agents : [];

  return {
    protocolVersion: numberOf(body.protocolVersion, 0),
    heartbeatIntervalMs: numberOf(body.heartbeatIntervalMs, 10000),
    helloTimeoutMs: numberOf(body.helloTimeoutMs, 5000),
    // null rather than a default: a made-up uptime would defeat the whole purpose of
    // showing it, so "I don't know" has to be representable.
    uptimeSeconds: nullableNumber(body.uptimeSeconds),
    startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
    agents: list.filter(isRecord).map(toAgent).filter((agent) => agent.agentId !== ''),
  };
}

function toAgent(raw: Record<string, unknown>): AgentSummary {
  return {
    agentId: text(raw.agentId),
    hostname: text(raw.hostname, 'unknown host'),
    platform: text(raw.platform, 'unknown platform'),
    version: text(raw.version, '?'),
    remoteAddress: text(raw.remoteAddress, '?'),
    screenWidth: nullableNumber(raw.screenWidth),
    screenHeight: nullableNumber(raw.screenHeight),
    monitors: toMonitors(raw.monitors),
    connectedForMs: numberOf(raw.connectedForMs, 0),
    // An age is only interesting if it is small; defaulting to "just seen" would hide a
    // silent agent, so an unreadable value is treated as infinitely old.
    lastSeenAgoMs: numberOf(raw.lastSeenAgoMs, Number.MAX_SAFE_INTEGER),
    lastRttMs: typeof raw.lastRttMs === 'number' && Number.isFinite(raw.lastRttMs) ? raw.lastRttMs : null,
  };
}

/** Keep only monitor entries that could produce a frame. A bad option is worse than none. */
function toMonitors(value: unknown): MonitorInfo[] {
  if (!Array.isArray(value)) return [];
  const monitors: MonitorInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const index = numberOf(entry.index, 0);
    const width = numberOf(entry.width, 0);
    const height = numberOf(entry.height, 0);
    if (index < 1 || width <= 0 || height <= 0) continue;
    monitors.push({
      index,
      left: numberOf(entry.left, 0),
      top: numberOf(entry.top, 0),
      width,
      height,
      primary: entry.primary === true,
    });
  }
  return monitors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
