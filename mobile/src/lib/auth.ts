/**
 * The phone's credential, and the one function every request goes through.
 *
 * Two separate ideas, deliberately in one small file:
 *
 *   1. **Where the token lives.** `expo-secure-store` puts it in the platform keystore
 *      (EncryptedSharedPreferences on Android, Keychain on iOS), not in the JS bundle and not
 *      in plain AsyncStorage. It is read once per launch and cached in memory, because a
 *      keystore call per request would be a silly cost for a value that never changes.
 *   2. **Where the header is added.** Every call to the backend needs the same header, so it
 *      is added in exactly one place. Scattering `Authorization` across the app is how one
 *      forgotten call site becomes a mysterious 401 six weeks later.
 *
 * Nothing here contains a secret literal: the token is issued by the laptop during pairing.
 */

import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'deskpilot.deviceToken';

/** `undefined` means "not read yet"; `null` means "read, and there is none". */
let cached: string | null | undefined;

export async function getToken(): Promise<string | null> {
  if (cached !== undefined) return cached;
  try {
    cached = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    // A keystore that refuses to answer must not crash the app; it just means "unpaired".
    cached = null;
  }
  return cached;
}

async function setToken(token: string): Promise<void> {
  cached = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function forgetDevice(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Already gone, or the keystore is unhappy. Either way the app is now unpaired.
  }
}

/** Every backend request goes through here, so the credential exists in one place. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

export type PairOutcome =
  | { ok: true; name: string }
  | { ok: false; reason: 'bad_code' | 'expired' | 'no_code' | 'http' | 'network'; detail: string };

/**
 * Exchange a code from the laptop for this device's token.
 *
 * The code is typed, not scanned yet: a QR needs a camera module, and the milestone that adds
 * one should not also be the milestone that changes who can control the laptop.
 */
export async function pairDevice(
  baseUrl: string,
  code: string,
  name: string,
): Promise<PairOutcome> {
  try {
    const response = await fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Read the backend's own `error` field rather than grepping the prose: "no code is
      // waiting" and "that is the wrong code" are different problems for the person typing.
      let reason: 'bad_code' | 'expired' | 'no_code' | 'http' = 'http';
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (parsed.error === 'bad_code' || parsed.error === 'expired' || parsed.error === 'no_code') {
          reason = parsed.error;
        }
      } catch {
        // Not JSON (a proxy error page, say). "http" plus the raw detail is the honest answer.
      }
      return { ok: false, reason, detail: `HTTP ${response.status} ${body.slice(0, 160)}` };
    }

    const parsed = (await response.json()) as { token?: unknown; name?: unknown };
    if (typeof parsed.token !== 'string' || parsed.token === '') {
      return { ok: false, reason: 'http', detail: 'the backend answered without a token' };
    }

    await setToken(parsed.token);
    return { ok: true, name: typeof parsed.name === 'string' ? parsed.name : name };
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      detail: error instanceof Error ? error.message : 'unknown network error',
    };
  }
}
