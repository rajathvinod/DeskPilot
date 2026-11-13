/**
 * One screenshot, fetched with the device's credential.
 *
 * Milestone 11 made every route except `/health` and `/pair` require a token. That collides
 * with how the screen used to load: `<Image source={{ uri }}>` and `Image.prefetch` are the
 * platform's own downloaders and they cannot be given an `Authorization` header. The three
 * ways out of that were:
 *
 *   1. put the token in the query string — it then lives in logs, in image caches and in
 *      anything that ever echoes a URL. Not worth it for a convenience;
 *   2. leave `/agents/:id/screen` public — which hands the desktop's pixels to every device on
 *      the tailnet, undoing the whole point of pairing;
 *   3. download the frame here, with the header, and hand the view a `data:` URI.
 *
 * This is (3). It costs a base64 expansion (~33%) on the phone's side only — the wire still
 * carries raw JPEG — and it keeps the credential in exactly one place, `apiFetch`.
 */

import { apiFetch } from '@/lib/auth';

export type FrameResult =
  | { ok: true; uri: string }
  | { ok: false; detail: string };

/**
 * A Blob read as `data:image/jpeg;base64,…`.
 *
 * `FileReader` rather than manual base64: it is the one conversion React Native's Blob
 * implementation supports without pulling in a polyfill.
 */
function toDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the frame'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export async function fetchFrame(baseUrl: string, agentId: string): Promise<FrameResult> {
  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/screen`, {
      headers: { Accept: 'image/jpeg' },
    });

    if (response.status === 401) {
      return { ok: false, detail: 'this phone is not paired with the laptop (HTTP 401)' };
    }
    if (!response.ok) {
      return { ok: false, detail: `no frame came back (HTTP ${response.status})` };
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      return { ok: false, detail: 'the laptop answered with an empty frame' };
    }

    return { ok: true, uri: await toDataUri(blob) };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'unknown network error',
    };
  }
}
