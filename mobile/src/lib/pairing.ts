/**
 * The pairing QR, decoded without a URL parser.
 *
 * React Native ships a minimal `URL` that has no `searchParams`, so the payload is read with a
 * regex instead: two query keys, both optional. A QR that carries no code returns `null` rather
 * than throwing, because the scanner calls this on every frame it happens to decode and a camera
 * pointed at a poster should do nothing at all.
 *
 * Two shapes are accepted on purpose:
 *   - `deskpilot://pair?code=ABC123&url=http://192.168.2.108:8787` (what `deskpilot pair --qr` shows)
 *   - a bare `ABC123`, because people screenshot the code or read it off a terminal
 */

export type PairPayload = {
  code: string;
  /** The laptop's address, when the QR carried one. The phone still pairs against its own base. */
  url: string | null;
};

const CODE_ONLY = /^[A-Za-z0-9]{4,12}$/;
const CODE_PARAM = /[?&]code=([A-Za-z0-9]+)/;
const URL_PARAM = /[?&]url=([^&]+)/;

export function parsePairPayload(raw: string): PairPayload | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (CODE_ONLY.test(trimmed)) {
    return { code: trimmed.toUpperCase(), url: null };
  }

  const code = CODE_PARAM.exec(trimmed)?.[1];
  if (code === undefined) return null;

  const url = URL_PARAM.exec(trimmed)?.[1];
  return { code: code.toUpperCase(), url: url === undefined ? null : decodeURIComponent(url) };
}
