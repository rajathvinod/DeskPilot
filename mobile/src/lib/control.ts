/**
 * Taking control away: lock the laptop, or kill every credential.
 *
 * Both actions are deliberate and hard to undo, and they are not symmetric. Locking is the
 * reversible one — the person at the keyboard types a password and is back where they were.
 * The kill switch is the last resort: it revokes every device token, *this phone's included*,
 * and only the laptop's own keyboard can re-arm it.
 *
 * That asymmetry is why the kill switch lives here anyway. Its most likely use is not an
 * intruder, it is you, realising the phone is not in your pocket — and in that moment the tool
 * that keeps working for whoever is holding it is the problem.
 */

import { apiFetch } from '@/lib/auth';

export type ControlOutcome = { ok: true; detail: string } | { ok: false; detail: string };

type PostResult = { ok: true; data: Record<string, unknown> } | { ok: false; detail: string };

async function post(baseUrl: string, path: string, body?: unknown): Promise<PostResult> {
  try {
    const response = await apiFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, detail: `HTTP ${response.status} ${text.slice(0, 160)}` };
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unknown network error' };
  }
}

/** Lock Windows on the laptop. The agent acknowledges only once the session is really locked. */
export async function lockLaptop(baseUrl: string, agentId: string): Promise<ControlOutcome> {
  const result = await post(baseUrl, `/agents/${agentId}/lock`);
  if (!result.ok) return result;
  return { ok: true, detail: 'the laptop is locked' };
}

/**
 * Revoke every device and stop the agents.
 *
 * After this the phone's token is dead, so the caller must forget it locally too — otherwise the
 * app keeps sending a credential that is guaranteed to be refused.
 */
export async function engageKillSwitch(baseUrl: string): Promise<ControlOutcome> {
  const result = await post(baseUrl, '/panic', {});
  if (!result.ok) return result;

  const revoked = typeof result.data.revoked === 'number' ? result.data.revoked : 0;
  return { ok: true, detail: `${revoked} device${revoked === 1 ? '' : 's'} revoked` };
}
