/**
 * The audit feed, and away mode, as the phone sees them.
 *
 * Every call goes through `apiFetch`, so the device token is attached in the one place it
 * exists. These are read-and-toggle operations only: there is deliberately no function that
 * edits or deletes an event, because the backend offers no such route.
 */

import { apiFetch } from '@/lib/auth';

export type AuditEvent = {
  eventId: string;
  /** When the laptop said it happened, or when the phone acted. ISO 8601. */
  at: string;
  receivedAt: string;
  source: 'agent' | 'phone';
  agentId: string | null;
  agentHostname: string | null;
  app: string;
  title: string;
  idleSeconds: number | null;
  /** A different window came to the front; periodic samples are false. */
  changed: boolean;
  /** This happened while away mode was on. */
  alert: boolean;
  acknowledged: boolean;
};

export type AwayState = {
  enabled: boolean;
  since: string | null;
  changedAt: string;
};

export type AuditSnapshot = {
  away: AwayState;
  /** How many alerts have not been acknowledged yet. */
  alerts: number;
  events: AuditEvent[];
};

export type AuditOutcome = { ok: true; snapshot: AuditSnapshot } | { ok: false; detail: string };

export type WriteOutcome = { ok: true } | { ok: false; detail: string };

/** Newest-first feed. The backend clamps `limit`, so asking for a lot is harmless. */
export async function fetchAudit(baseUrl: string, limit = 12): Promise<AuditOutcome> {
  try {
    const response = await apiFetch(`${baseUrl}/audit?limit=${limit}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status} from /audit` };
    }

    const parsed = (await response.json()) as Partial<AuditSnapshot>;
    if (!Array.isArray(parsed.events) || typeof parsed.alerts !== 'number' || parsed.away === undefined) {
      return { ok: false, detail: 'the backend answered with an audit payload this app does not understand' };
    }

    return { ok: true, snapshot: parsed as AuditSnapshot };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'unknown network error',
    };
  }
}

export async function setAway(baseUrl: string, enabled: boolean): Promise<WriteOutcome> {
  return post(baseUrl, '/away', { enabled });
}

/** Acknowledge every alert so far. The events remain readable; only the badge clears. */
export async function acknowledgeAlerts(baseUrl: string): Promise<WriteOutcome> {
  return post(baseUrl, '/audit/acknowledge', {});
}

async function post(baseUrl: string, path: string, body: unknown): Promise<WriteOutcome> {
  try {
    const response = await apiFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, detail: `HTTP ${response.status} ${text.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'unknown network error',
    };
  }
}
