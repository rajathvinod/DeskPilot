/**
 * The audit trail, and away mode.
 *
 * Milestone 12 answers a question the earlier milestones could not: *what happened on the laptop
 * while I was not looking?* The agent already reports the window in front of it, and this file
 * decides what is worth keeping, how long to keep it, and which events should interrupt you.
 *
 * Four decisions worth understanding:
 *
 *   - **Bounded, on purpose.** Memory holds the newest 300 events and the file rotates at 2 MB.
 *     An audit trail that grows until the disk is full is a denial of service you inflict on
 *     yourself; a trail that silently keeps a week of window titles is a privacy problem. This
 *     keeps roughly a day of ordinary use, and says so rather than pretending otherwise.
 *   - **The media is a JSONL file.** Append-only means a crash costs the last line at worst, and
 *     every line can be read by eye — no database, no migration, no schema drift in a personal
 *     tool that may not be touched for a month.
 *   - **Alerts are a property of the event, not a separate list.** "Was this alarming?" is
 *     decided once, when the event is recorded, using away mode *at that moment*. Recomputing
 *     it later would let toggling away mode rewrite history.
 *   - **Acknowledging is a watermark, not an edit.** Marking alerts seen records a timestamp;
 *     the events themselves never change. An audit that can be edited is not an audit.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

/** Newest events kept in memory, and served to the phone at most. */
const MAX_EVENTS = 300;

/** Rotate rather than fill the disk: at ~200 bytes an event this is ~10,000 events. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type AuditSource = 'agent' | 'phone';

export type AuditEvent = {
  eventId: string;
  /** When the laptop said it happened (agent clock), or when the phone acted. */
  at: string;
  /** When this backend heard about it. The gap between the two is the network delay. */
  receivedAt: string;
  source: AuditSource;
  agentId: string | null;
  agentHostname: string | null;
  app: string;
  title: string;
  /** Seconds since the last keyboard or mouse input, when the agent could tell. */
  idleSeconds: number | null;
  /** A different window came to the front. Periodic samples are `false`. */
  changed: boolean;
  /** This happened while you had declared yourself away from the laptop. */
  alert: boolean;
  /** Derived from the acknowledgement watermark; never stored per event. */
  acknowledged: boolean;
};

export type AwayState = {
  enabled: boolean;
  /** When away mode was switched on, or `null` when it is off. */
  since: string | null;
  changedAt: string;
};

export type NewAuditEvent = {
  source: AuditSource;
  at?: string | undefined;
  agentId?: string | null;
  agentHostname?: string | null;
  app: string;
  title: string;
  idleSeconds?: number | null;
  changed?: boolean;
  alert?: boolean;
};

/** Everything the phone needs in one response: the trail, the mode, and what needs attention. */
export type AuditSnapshot = {
  away: AwayState;
  alerts: number;
  events: AuditEvent[];
};

export class AuditLog {
  private readonly file: string;
  private readonly watermarkFile: string;
  private events: AuditEvent[];
  /** Alerts at or before this instant are considered seen. */
  private acknowledgedThrough: string | null;

  constructor(
    stateDir: string,
    private readonly log: FastifyBaseLogger,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'audit.jsonl');
    this.watermarkFile = join(stateDir, 'audit-acks.json');
    this.events = this.loadEvents();
    this.acknowledgedThrough = this.loadWatermark();
  }

  get unacknowledgedCount(): number {
    const through = this.acknowledgedThrough;
    return this.events.filter((event) => event.alert && (through === null || event.at > through)).length;
  }

  /**
   * Record one event and return it as stored.
   *
   * The write is synchronous and the file is opened per append. For a single user that is
   * simpler and safer than a write stream — and it means an event is on disk the instant the
   * function returns, which is the one property an audit trail must have.
   */
  record(input: NewAuditEvent): AuditEvent {
    const receivedAt = new Date().toISOString();
    const event: AuditEvent = {
      eventId: crypto.randomUUID(),
      at: input.at ?? receivedAt,
      receivedAt,
      source: input.source,
      agentId: input.agentId ?? null,
      agentHostname: input.agentHostname ?? null,
      app: input.app.slice(0, 120),
      // Titles can be long, and a phone line is not a place for a 4,000-character page title.
      title: input.title.slice(0, 300),
      idleSeconds: input.idleSeconds ?? null,
      changed: input.changed ?? false,
      alert: input.alert ?? false,
      acknowledged: false,
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);

    // `acknowledged` is derived when reading; storing it would make the file and the
    // watermark able to disagree.
    const { acknowledged: _derived, ...stored } = event;
    try {
      appendFileSync(this.file, `${JSON.stringify(stored)}\n`, 'utf8');
      this.rotateIfLarge();
    } catch (error) {
      // A full or locked disk must not take the phone's approval flow down with it. The
      // in-memory trail still works for this session, so say so and carry on.
      this.log.error({ err: error }, 'could not append to the audit file');
    }

    return this.view(event);
  }

  /** Newest first, capped. That is the order a person reads a feed in. */
  list(limit: number): AuditEvent[] {
    return this.events.slice(-limit).reverse().map((event) => this.view(event));
  }

  /** Mark every alert so far as seen. Returns how many that covered. */
  acknowledge(): { acknowledged: number; through: string } {
    const covered = this.unacknowledgedCount;
    const through = new Date().toISOString();
    this.acknowledgedThrough = through;
    try {
      writeFileSync(this.watermarkFile, `${JSON.stringify({ acknowledgedThrough: through })}\n`, 'utf8');
    } catch (error) {
      this.log.error({ err: error }, 'could not write the acknowledgement watermark');
    }
    return { acknowledged: covered, through };
  }

  private view(event: AuditEvent): AuditEvent {
    const through = this.acknowledgedThrough;
    return { ...event, acknowledged: !event.alert || (through !== null && event.at <= through) };
  }

  private loadEvents(): AuditEvent[] {
    if (!existsSync(this.file)) return [];

    const events: AuditEvent[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Partial<AuditEvent>;
        if (typeof parsed.eventId !== 'string' || typeof parsed.at !== 'string') continue;
        events.push({ ...(parsed as AuditEvent), acknowledged: false });
      } catch {
        // A torn last line from a crash. Skipping it is the point of append-only JSONL.
      }
    }
    return events.slice(-MAX_EVENTS);
  }

  private loadWatermark(): string | null {
    if (!existsSync(this.watermarkFile)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.watermarkFile, 'utf8')) as {
        acknowledgedThrough?: unknown;
      };
      return typeof parsed.acknowledgedThrough === 'string' ? parsed.acknowledgedThrough : null;
    } catch {
      return null;
    }
  }

  private rotateIfLarge(): void {
    if (statSync(this.file).size <= MAX_FILE_BYTES) return;
    const previous = `${this.file}.1`;
    // Windows will not rename onto an existing file, so the previous rotation is discarded
    // first. One generation is enough: the point is a bounded disk footprint, not history.
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(this.file, previous);
    this.log.info({ bytes: MAX_FILE_BYTES }, 'rotated the audit file');
  }
}

/**
 * Away mode: "I have left the laptop, tell me if it starts doing something."
 *
 * Persisted, because silently ending away mode on a backend restart would be the failure the
 * feature exists to prevent. Kept in its own tiny file rather than the database this project
 * does not have yet.
 */
export class AwayMode {
  private readonly file: string;
  private state: AwayState;

  constructor(
    stateDir: string,
    private readonly log: FastifyBaseLogger,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'away.json');
    this.state = this.load();
  }

  get(): AwayState {
    return this.state;
  }

  set(enabled: boolean): AwayState {
    if (this.state.enabled === enabled) return this.state;

    const now = new Date().toISOString();
    this.state = { enabled, since: enabled ? now : null, changedAt: now };
    try {
      writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log.error({ err: error }, 'could not persist away mode');
    }
    this.log.info({ enabled }, 'away mode changed');
    return this.state;
  }

  private load(): AwayState {
    const off: AwayState = { enabled: false, since: null, changedAt: new Date().toISOString() };
    if (!existsSync(this.file)) return off;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AwayState>;
      if (typeof parsed.enabled !== 'boolean') return off;
      return {
        enabled: parsed.enabled,
        since: typeof parsed.since === 'string' ? parsed.since : null,
        changedAt: typeof parsed.changedAt === 'string' ? parsed.changedAt : off.changedAt,
      };
    } catch (error) {
      // Unreadable is not the same as "off": starting in away mode is the safe direction,
      // because it turns activity into alerts rather than letting it pass silently.
      this.log.warn({ err: error }, 'could not read away mode; starting away');
      return { enabled: true, since: off.changedAt, changedAt: off.changedAt };
    }
  }
}
