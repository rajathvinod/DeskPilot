/**
 * Who is allowed to drive this laptop.
 *
 * Until now the answer was "anything that can reach the port", which on a tailnet means every
 * device you have ever added, plus anything that has compromised one. This file is the answer
 * to that: a small file-backed registry of paired devices, each holding a token whose hash is
 * all we keep.
 *
 * Three decisions worth understanding:
 *
 *   - **The token is never stored.** We keep a SHA-256 of it. A stolen `devices.json` therefore
 *     cannot be replayed; it is a list of hashes, not of keys. (A slow KDF would be better if
 *     tokens were human-chosen; these are 32 random bytes, so a plain hash is proportionate.)
 *   - **Pairing codes are single use and short lived.** The code is the only way to create a
 *     token, so it gets the treatment of a one-time password: thirty minutes by default
 *     (`DP_PAIR_TTL_MIN`), one redemption, replaced the moment a new one is asked for.
 *   - **Pairing codes live in memory.** A restart throws away any un-redeemed code, which is
 *     the safe direction to fail: a code that outlives its purpose is a spare key on the mat.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

export type Device = {
  deviceId: string;
  name: string;
  /** SHA-256 of the token, hex. The token itself exists only on the phone. */
  tokenHash: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

/** What the API may say about a device. No hash, no token — ever. */
export type DeviceView = {
  deviceId: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

type Registry = { devices: Device[] };

/**
 * `no_code` is separate from `bad_code` on purpose: "there is no live code" (already used,
 * expired, burned, or lost to a restart) and "that is not the code" want different actions from
 * the person holding the phone, and a single "not accepted" sends them looking for the wrong one.
 */
export type PairFailure = 'bad_code' | 'expired' | 'no_code';

export type PairResult =
  | { ok: true; deviceId: string; name: string; token: string }
  | { ok: false; error: PairFailure };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/1, no O/0: people read these aloud
const CODE_LENGTH = 6;
/** Default lifetime. Overridable via `DP_PAIR_TTL_MIN`; see `config.ts`. */
const CODE_TTL_MS = 30 * 60_000;
/** Five wrong guesses burn the code. Guessing is 32^6 against a five-minute window. */
const MAX_FAILURES = 5;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compare two hex digests without leaking where they first differ. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class DeviceRegistry {
  private readonly file: string;
  private devices: Device[] = [];
  /** Only one code is ever valid: asking for a new one cancels the old one. */
  private code: { value: string; expiresAt: number } | null = null;
  private failures = 0;

  constructor(
    stateDir: string,
    private readonly log: FastifyBaseLogger,
    private readonly codeTtlMs: number = CODE_TTL_MS,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'devices.json');
    this.devices = this.load();
  }

  get count(): number {
    return this.devices.filter((device) => device.revokedAt === null).length;
  }

  list(): DeviceView[] {
    return this.devices.map(({ deviceId, name, pairedAt, lastSeenAt, revokedAt }) => ({
      deviceId,
      name,
      pairedAt,
      lastSeenAt,
      revokedAt,
    }));
  }

  /** Mint a code. Only reachable from the laptop itself, which is what makes it a secret. */
  createCode(): { code: string; expiresAt: string; ttlSeconds: number } {
    const value = Array.from({ length: CODE_LENGTH }, () => {
      const index = randomBytes(1)[0]! % CODE_ALPHABET.length;
      return CODE_ALPHABET[index];
    }).join('');

    this.code = { value, expiresAt: Date.now() + this.codeTtlMs };
    this.failures = 0;
    this.log.info({ expiresInSeconds: this.codeTtlMs / 1000 }, 'pairing code issued');
    return {
      code: value,
      expiresAt: new Date(this.code.expiresAt).toISOString(),
      ttlSeconds: this.codeTtlMs / 1000,
    };
  }

  redeem(rawCode: string, name: string): PairResult {
    const code = rawCode.trim().toUpperCase().replace(/\s+/g, '');
    const current = this.code;

    if (current === null) return { ok: false, error: 'no_code' };

    if (Date.now() > current.expiresAt) {
      this.code = null;
      return { ok: false, error: 'expired' };
    }

    if (code !== current.value) {
      this.failures += 1;
      if (this.failures >= MAX_FAILURES) {
        this.code = null;
        this.log.warn({ failures: this.failures }, 'pairing code burned after repeated guesses');
      }
      return { ok: false, error: 'bad_code' };
    }

    // Single use: the code dies with its first success, before the device is written.
    this.code = null;
    this.failures = 0;

    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const device: Device = {
      deviceId: crypto.randomUUID(),
      name: name.trim() === '' ? 'unnamed device' : name.trim().slice(0, 60),
      tokenHash: hash(token),
      pairedAt: now,
      lastSeenAt: now,
      revokedAt: null,
    };

    this.devices.push(device);
    this.save();
    this.log.info({ deviceId: device.deviceId, name: device.name }, 'device paired');
    return { ok: true, deviceId: device.deviceId, name: device.name, token };
  }

  /**
   * Resolve a bearer token to a live device, or `null`.
   *
   * Compared by hash, and re-derived on every request: an in-memory "already checked" cache
   * would keep working after a revoke, which is precisely the case that must not work.
   */
  verify(token: string | undefined): Device | null {
    if (token === undefined || token === '') return null;
    const digest = hash(token);

    for (const device of this.devices) {
      if (device.revokedAt !== null) continue;
      if (!sameDigest(device.tokenHash, digest)) continue;

      // Touch at most every 30s: this is a debug aid, not an audit log, and a write per
      // request would turn a quiet phone poll into constant disk activity.
      const now = Date.now();
      if (device.lastSeenAt === null || now - Date.parse(device.lastSeenAt) > 30_000) {
        device.lastSeenAt = new Date(now).toISOString();
        this.save();
      }
      return device;
    }
    return null;
  }

  revoke(deviceId: string): DeviceView | null {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (device === undefined) return null;
    if (device.revokedAt === null) {
      device.revokedAt = new Date().toISOString();
      this.save();
      this.log.info({ deviceId, name: device.name }, 'device revoked');
    }
    const { tokenHash: _hash, ...view } = device;
    return view;
  }

  /**
   * Revoke every device, including the caller's. This is what the kill switch pulls.
   *
   * Returns how many were live before the call: a kill switch that cannot say what it killed
   * is hard to trust, and the phone shows that number before it locks itself out.
   */
  revokeAll(): number {
    const now = new Date().toISOString();
    let revoked = 0;
    for (const device of this.devices) {
      if (device.revokedAt !== null) continue;
      device.revokedAt = now;
      revoked += 1;
    }
    if (revoked > 0) {
      this.save();
      this.log.warn({ revoked }, 'every device revoked by the kill switch');
    }
    return revoked;
  }

  private load(): Device[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Registry;
      return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch (error) {
      // A corrupt registry must not silently become an empty one — that would quietly unpair
      // every device. Refuse to start instead, and let the owner look at the file.
      throw new Error(
        `could not read ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Write to a temp file, then rename: a half-written registry is worse than none. */
  private save(): void {
    const body: Registry = { devices: this.devices };
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.file);
  }
}
