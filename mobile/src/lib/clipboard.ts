/**
 * Clipboard sync, phone half.
 *
 * Two different clips are involved and mixing them up is the whole bug surface:
 *
 *   - the laptop's clipboard, reached through the backend (`/agents/:id/clipboard`)
 *   - this phone's clipboard, reached through `expo-clipboard`
 *
 * `expo-clipboard` is native, so it is loaded the same defensive way as speech and the camera: a
 * lazy `require` plus a `requireOptionalNativeModule` probe. A build without it still shows the
 * card and still explains why it cannot act — it does not crash and it does not pretend.
 */

import { apiFetch } from '@/lib/auth';

type ClipboardPackage = typeof import('expo-clipboard');
type ModulesCore = { requireOptionalNativeModule: (name: string) => unknown };

let cached: ClipboardPackage | null | undefined;

function load(): ClipboardPackage | null {
  if (cached !== undefined) return cached;
  try {
    cached = require('expo-clipboard') as ClipboardPackage;
  } catch {
    cached = null;
  }
  return cached;
}

export type ClipboardSupport = { available: true } | { available: false; reason: string };

export async function probePhoneClipboard(): Promise<ClipboardSupport> {
  if (load() === null) return { available: false, reason: 'the clipboard module is not part of this build' };
  try {
    const core = require('expo-modules-core') as ModulesCore;
    const native = core.requireOptionalNativeModule('ExpoClipboard');
    if (native === null || native === undefined) {
      return {
        available: false,
        reason: 'this build has no clipboard module — rebuild to sync text (docs/development-build.md)',
      };
    }
    return { available: true };
  } catch {
    return { available: false, reason: 'the clipboard module could not be loaded in this build' };
  }
}

/** This phone's clipboard. `null` already means "empty or unavailable", never an exception. */
export async function readPhoneClipboard(): Promise<string | null> {
  const clipboard = load();
  if (clipboard === null) return null;
  try {
    const value = await clipboard.getStringAsync();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export async function writePhoneClipboard(text: string): Promise<boolean> {
  const clipboard = load();
  if (clipboard === null) return false;
  try {
    await clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

export type LaptopClipboard = {
  ok: boolean;
  text: string;
  chars: number;
  error: string | null;
};

/**
 * The laptop's clipboard.
 *
 * `null` means the request itself failed (no agent, timeout, unauthenticated); `ok: false` means
 * the agent answered and refused, which is a different sentence for the person reading it.
 */
export async function fetchLaptopClipboard(
  baseUrl: string,
  agentId: string,
): Promise<LaptopClipboard | null> {
  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/clipboard`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as Record<string, unknown>;
    return {
      ok: raw.ok === true,
      text: typeof raw.text === 'string' ? raw.text : '',
      chars: typeof raw.chars === 'number' ? raw.chars : 0,
      error: typeof raw.error === 'string' ? raw.error : null,
    };
  } catch {
    return null;
  }
}

/** Put text on the laptop's clipboard. Returns the character count the agent confirmed, or null. */
export async function sendLaptopClipboard(
  baseUrl: string,
  agentId: string,
  text: string,
): Promise<number | null> {
  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/clipboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as Record<string, unknown>;
    return typeof raw.chars === 'number' ? raw.chars : null;
  } catch {
    return null;
  }
}
