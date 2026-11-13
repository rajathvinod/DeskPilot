/**
 * The kill switch: turn remote control off, and keep it off.
 *
 * Two questions decided this design, and both are about the phone being the thing that goes
 * missing rather than the thing that saves you:
 *
 *   - **What does it do?** It revokes every device token and tells connected agents to refuse
 *     input and frames. Control does not degrade, it stops.
 *   - **Who can undo it?** Only someone at the laptop's own keyboard. The release route (`POST
 *     /arm`) is loopback-only, exactly like minting a pairing code — because a switch that any
 *     holder of a stolen phone can turn back off is a button, not a switch.
 *
 * The engaged state is a file, so a backend restart does not quietly re-arm the laptop. That is
 * the whole point: the failure this guards against happens while you are not watching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

export type KillSwitchState = {
  suspended: boolean;
  /** When it was engaged, or `null` when released. */
  since: string | null;
  changedAt: string;
};

export class KillSwitch {
  private readonly file: string;
  private state: KillSwitchState;

  constructor(
    stateDir: string,
    private readonly log: FastifyBaseLogger,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'suspended.json');
    this.state = this.load();
  }

  get(): KillSwitchState {
    return this.state;
  }

  get suspended(): boolean {
    return this.state.suspended;
  }

  engage(): KillSwitchState {
    return this.write(true);
  }

  release(): KillSwitchState {
    return this.write(false);
  }

  private write(suspended: boolean): KillSwitchState {
    if (this.state.suspended === suspended) return this.state;

    const now = new Date().toISOString();
    this.state = { suspended, since: suspended ? now : null, changedAt: now };
    try {
      writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.log.error({ err: error }, 'could not persist the kill switch state');
    }
    // Warn either way: engaging is news, and releasing is news that someone was at the keyboard.
    this.log.warn({ suspended }, 'kill switch changed');
    return this.state;
  }

  private load(): KillSwitchState {
    const off: KillSwitchState = {
      suspended: false,
      since: null,
      changedAt: new Date().toISOString(),
    };
    if (!existsSync(this.file)) return off;

    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KillSwitchState>;
      if (typeof parsed.suspended !== 'boolean') return off;
      return {
        suspended: parsed.suspended,
        since: typeof parsed.since === 'string' ? parsed.since : null,
        changedAt: typeof parsed.changedAt === 'string' ? parsed.changedAt : off.changedAt,
      };
    } catch (error) {
      // Unreadable means "assume engaged". Refusing input is undone at the keyboard in seconds;
      // silently accepting it again is the exact failure this file exists to prevent.
      this.log.warn({ err: error }, 'could not read the kill switch state; assuming engaged');
      return { suspended: true, since: off.changedAt, changedAt: off.changedAt };
    }
  }
}
