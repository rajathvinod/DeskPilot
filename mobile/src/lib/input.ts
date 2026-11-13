/**
 * Turning a tap on a picture into a point on a desktop.
 *
 * This is the only genuinely fiddly maths in the app, so it lives in pure functions with no
 * React in them: given where the finger landed and how the picture was drawn, what fraction of
 * the *desktop* did it mean — and where on screen should a marker be drawn for a given pixel?
 *
 * The picture is drawn with `resizeMode="contain"`: scaled to fit while keeping its shape,
 * leaving empty bars on two sides. A tap in one of those bars is a tap on nothing, and must not
 * become a click on the edge of the desktop.
 *
 * All three functions share the same geometry, which is the point: the forward mapping and the
 * inverse mapping cannot drift apart if there is only one of them.
 */

import { apiFetch } from '@/lib/auth';

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

/** How the picture is currently framed inside its stage. */
export type FrameView = {
  /** 1 = whole desktop; 2 = half of it across, at double size. */
  zoom: number;
  /** Which point of the picture sits at the centre of the stage, as a 0..1 fraction. */
  center: Point;
};

export const DEFAULT_VIEW: FrameView = { zoom: 1, center: { x: 0.5, y: 0.5 } };

export type Geometry = { drawnWidth: number; drawnHeight: number; offsetX: number; offsetY: number };

/** Where the picture lands inside a stage of `box`, before zoom is applied. */
export function frameGeometry(box: Size, image: Size): Geometry | null {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return null;

  const scale = Math.min(box.width / image.width, box.height / image.height);
  const drawnWidth = image.width * scale;
  const drawnHeight = image.height * scale;
  return {
    drawnWidth,
    drawnHeight,
    offsetX: (box.width - drawnWidth) / 2,
    offsetY: (box.height - drawnHeight) / 2,
  };
}

/**
 * Top-left corner of the (zoomed) picture, in stage coordinates.
 *
 * The whole zoom model is this one formula: pick the centre point, scale the picture, then slide
 * it so that centre lands in the middle of the stage. At zoom 1 and centre (0.5, 0.5) it reduces
 * to the letterbox offsets, which is why there is no separate "unzoomed" code path to get wrong.
 */
function topLeft(geometry: Geometry, view: FrameView): Point {
  return {
    x: geometry.offsetX + geometry.drawnWidth / 2 - view.center.x * geometry.drawnWidth * view.zoom,
    y: geometry.offsetY + geometry.drawnHeight / 2 - view.center.y * geometry.drawnHeight * view.zoom,
  };
}

/** Map a tap in the stage to a 0..1 point of the desktop, or `null` if it missed the picture. */
export function pointFromTap(
  tap: Point,
  box: Size,
  image: Size,
  view: FrameView = DEFAULT_VIEW,
): Point | null {
  const geometry = frameGeometry(box, image);
  if (geometry === null) return null;

  const origin = topLeft(geometry, view);
  const drawnWidth = geometry.drawnWidth * view.zoom;
  const drawnHeight = geometry.drawnHeight * view.zoom;
  const x = (tap.x - origin.x) / drawnWidth;
  const y = (tap.y - origin.y) / drawnHeight;

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** The inverse: where to draw a marker for a given 0..1 point of the desktop. */
export function pointToStage(
  point: Point,
  box: Size,
  image: Size,
  view: FrameView = DEFAULT_VIEW,
): Point | null {
  const geometry = frameGeometry(box, image);
  if (geometry === null) return null;

  const origin = topLeft(geometry, view);
  return {
    x: origin.x + point.x * geometry.drawnWidth * view.zoom,
    y: origin.y + point.y * geometry.drawnHeight * view.zoom,
  };
}

/** Backwards-compatible name for the common case: whole picture, no zoom. */
export function normalizeTap(tap: Point, box: Size, image: Size): Point | null {
  return pointFromTap(tap, box, image);
}

/** The live pinch/pan transform applied to the picture, as React Native applies it. */
export type Transform = { scale: number; tx: number; ty: number };

/**
 * Undo a pinch/pan transform, then map the tap onto the desktop.
 *
 * React Native scales a view about its centre and then translates it, so a drawn point `p`
 * appears at `centre + (p - centre) * scale + translate`. Inverting that is the whole job here,
 * and after the inversion the tap is just an ordinary tap on the untransformed picture — which
 * is why this composes with `pointFromTap` instead of duplicating the letterbox maths.
 *
 * Getting this wrong is subtle rather than obvious: taps would work at 1x, drift further off
 * target the more you zoom, and look like a protocol bug.
 */
export function tapToDesktop(
  tap: Point,
  stage: Size,
  image: Size,
  transform: Transform,
): Point | null {
  if (stage.width <= 0 || stage.height <= 0) return null;
  const scale = transform.scale > 0 ? transform.scale : 1;
  const centre = { x: stage.width / 2, y: stage.height / 2 };

  const untransformed = {
    x: centre.x + (tap.x - transform.tx - centre.x) / scale,
    y: centre.y + (tap.y - transform.ty - centre.y) / scale,
  };

  return pointFromTap(untransformed, stage, image);
}

/** Either the click landed somewhere real, or we know why it did not. */
export type ClickOutcome =
  | { ok: true; screenX: number; screenY: number; latencyMs: number }
  | { ok: false; reason: 'timeout' | 'network' | 'http'; detail: string };

/**
 * One POST that changes something on the laptop, and the shared way it can fail.
 *
 * Typing, keys and scrolling fail for exactly the same three reasons as clicking, so they share
 * this code path rather than each inventing its own error handling.
 */
async function postAction(
  baseUrl: string,
  agentId: string,
  action: 'text' | 'key' | 'scroll',
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ActionOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, reason: 'http', detail: `HTTP ${response.status} ${text.slice(0, 120)}` };
    }

    const parsed: unknown = await response.json();
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      typed: typeof record.typed === 'number' ? record.typed : null,
    };
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

/** Type text into the laptop's focused window. */
export function sendText(
  baseUrl: string,
  agentId: string,
  text: string,
  timeoutMs?: number,
): Promise<ActionOutcome> {
  return postAction(baseUrl, agentId, 'text', { text }, timeoutMs);
}

/** Press one named key, e.g. `enter`. */
export function pressKey(
  baseUrl: string,
  agentId: string,
  key: KeyName,
  timeoutMs?: number,
): Promise<ActionOutcome> {
  return postAction(baseUrl, agentId, 'key', { key }, timeoutMs);
}

/** Scroll by whole wheel notches; positive is up. */
export function scrollBy(
  baseUrl: string,
  agentId: string,
  delta: number,
  timeoutMs?: number,
): Promise<ActionOutcome> {
  return postAction(baseUrl, agentId, 'scroll', { delta }, timeoutMs);
}

/** The keys the phone may press. Matches `KEY_CODES` in the agent and `KEY_NAMES` in the backend. */
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

/** Either an input action landed, or we know why it did not. */
export type ActionOutcome =
  | { ok: true; latencyMs: number; typed: number | null }
  | { ok: false; reason: 'timeout' | 'network' | 'http'; detail: string };

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Ask the backend to act at a fraction of the desktop.
 *
 * `button: 'none'` moves the cursor without clicking. It is what the nudge buttons use: moving
 * first, then clicking, means the last thing that happens on the laptop is a click you aimed
 * deliberately, and the reply's pixel is the truth the screen displays.
 */
export async function clickAt(
  baseUrl: string,
  agentId: string,
  x: number,
  y: number,
  button: 'left' | 'none' = 'left',
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  monitor: number = 1,
): Promise<ClickOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await apiFetch(`${baseUrl}/agents/${agentId}/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `monitor` is what makes a tap on the second screen land on the second screen: the
      // fraction is relative to the display in the picture, not to the desktop as a whole.
      body: JSON.stringify({ x, y, button, monitor }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, reason: 'http', detail: `HTTP ${response.status} ${text.slice(0, 120)}` };
    }

    const body: unknown = await response.json();
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    return {
      ok: true,
      screenX: typeof record.screenX === 'number' ? record.screenX : 0,
      screenY: typeof record.screenY === 'number' ? record.screenY : 0,
      latencyMs: Date.now() - startedAt,
    };
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
