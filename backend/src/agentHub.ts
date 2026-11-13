/**
 * The agent hub: one place that knows which agents are currently connected.
 *
 * The direction of the connection is the important part. The agent *dials out* to this
 * process, so the agent never has to listen on a network address. That is why the laptop
 * needs no open port and no port forwarding — and why "remote control surface exposed to
 * the LAN" is not a thing that can happen by accident.
 *
 * What this file owns:
 *  - the `hello` handshake (who is this agent, does it speak our protocol)
 *  - reply routing for the application-level heartbeat
 *  - a watchdog that kills sockets which look open but have gone silent
 *  - a snapshot of live connections for the HTTP API / phone
 */

import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  encodeEnvelope,
  parseEnvelope,
  readAgentInfo,
  readBoolean,
  readNumber,
  readString,
  type ActivityPayload,
  type AgentInfo,
} from './protocol.js';

/** How long a freshly upgraded socket has to introduce itself with `hello`. */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * How often a healthy agent sends `ping`. The agent receives this value in `hello.ack`,
 * so the interval lives in exactly one place instead of drifting between two codebases.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Silence longer than this means the socket is dead even though TCP has not noticed yet.
 * Two and a half heartbeat intervals tolerates one lost ping before we accuse the agent.
 */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2.5;

/** How often the watchdog looks for silent sockets. */
const WATCHDOG_INTERVAL_MS = 5_000;

/**
 * How many pixels to ask for, and how hard to compress them.
 *
 * 1280 wide at quality 70 is roughly 100-200 KB for a typical desktop: legible over
 * Tailscale, quick to render on a phone, and cheap enough to repeat in Milestone 4's loop.
 */
export const FRAME_MAX_WIDTH = 1280;
export const FRAME_JPEG_QUALITY = 70;

/**
 * What the caller may ask for. Both fields are hints; they are clamped before use.
 *
 * `| undefined` is explicit because this project compiles with `exactOptionalPropertyTypes`:
 * there, "absent" and "present but undefined" are different types, and a caller that builds
 * the object from optional query parameters produces the latter.
 */
export type FrameOptions = { maxWidth?: number | undefined; quality?: number | undefined };

const WIDTH_BOUNDS = { min: 320, max: 2560 } as const;
const QUALITY_BOUNDS = { min: 30, max: 90 } as const;

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/** Raised when the requested agent is not connected at all. */
export class AgentNotFoundError extends Error {}

/** Raised when the agent is connected but did not deliver a frame in time. */
export class FrameTimeoutError extends Error {}

/** Raised when the agent answered with an error instead of pixels. */
export class FrameFailedError extends Error {}

type PendingFrame = {
  promise: Promise<Buffer>;
  resolve: (frame: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * An input action waiting for its acknowledgement, keyed by the id its request carried.
 *
 * The payload is kept unparsed: clicks answer with a pixel, typing answers with a count, and
 * the caller knows which shape it asked for. Parsing here would mean a union of every future
 * reply in one type.
 */
type PendingAck = {
  agentId: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ConnectedAgent = {
  info: AgentInfo;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  lastRttMs: number | null;
  remoteAddress: string;
};

export type AgentSnapshot = {
  agentId: string;
  hostname: string;
  platform: string;
  version: string;
  remoteAddress: string;
  /** Desktop size in pixels, or null if the agent could not report it. */
  screenWidth: number | null;
  screenHeight: number | null;
  connectedForMs: number;
  lastSeenAgoMs: number;
  lastRttMs: number | null;
};

/** Normalise the three shapes `ws` can hand us into one Buffer. */
function toBuffer(raw: RawData): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return null;
}

export class AgentHub {
  private readonly agents = new Map<string, ConnectedAgent>();
  private readonly pending = new Map<string, PendingFrame>();
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly watchdog: NodeJS.Timeout;
  /**
   * Who wants to know about activity reports.
   *
   * A callback rather than a direct call into the audit log: the hub's job is "who is connected
   * and what did they say", and keeping that free of storage decisions is what lets the audit
   * trail change without touching the socket code.
   */
  private readonly activityHandlers: ((info: AgentInfo, activity: ActivityPayload) => void)[] = [];

  /**
   * Mirrors the backend's kill switch.
   *
   * Held here as well as in `killswitch.ts` because it travels in every `hello.ack`: an agent
   * that restarts while the laptop is "killed" must come back refusing input, not trusting its
   * own memory of how things were.
   */
  private suspended = false;

  constructor(private readonly log: FastifyBaseLogger) {
    this.watchdog = setInterval(() => this.sweep(), WATCHDOG_INTERVAL_MS);
    // Never keep the process alive just for the watchdog; the HTTP server owns the lifecycle.
    this.watchdog.unref();
  }

  get count(): number {
    return this.agents.size;
  }

  /** Subscribe to unsolicited activity reports. Returns nothing: there is no unsubscribe yet. */
  onActivity(handler: (info: AgentInfo, activity: ActivityPayload) => void): void {
    this.activityHandlers.push(handler);
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Tell every connected agent to refuse input, and remember it for the ones that reconnect.
   *
   * Returns how many sockets it actually reached. A switch whose reach you cannot see is a
   * switch you have to take on faith.
   */
  suspendAll(): number {
    this.suspended = true;
    return this.broadcast('system.suspend');
  }

  resumeAll(): number {
    this.suspended = false;
    return this.broadcast('system.resume');
  }

  /** Lock one session, and wait for the agent to confirm it happened. */
  lock(agentId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return this.request(agentId, 'system.lock', {}, timeoutMs);
  }

  /**
   * Fire-and-forget over every open socket.
   *
   * No acknowledgement is waited for, deliberately: the kill switch has to work on an agent
   * that is half-asleep, and "wait for five agents to answer" is a way to make the button
   * unreliable exactly when it matters. The count of sockets written to is the honest report.
   */
  private broadcast(type: string): number {
    let reached = 0;
    for (const agent of this.agents.values()) {
      if (agent.socket.readyState !== agent.socket.OPEN) continue;
      try {
        agent.socket.send(encodeEnvelope(type, {}));
        reached += 1;
      } catch (error) {
        this.log.warn({ err: error, agentId: agent.info.agentId }, 'could not send to agent');
      }
    }
    return reached;
  }

  /** Take over a freshly upgraded socket. Listens; never blocks. */
  attach(socket: WebSocket, remoteAddress: string): void {
    let agentId: string | null = null;

    const helloTimer = setTimeout(() => {
      this.log.warn({ remoteAddress }, 'socket opened but never said hello, closing');
      socket.close(4000, 'expected hello');
    }, HELLO_TIMEOUT_MS);

    const forget = (reason: string): void => {
      if (agentId === null) return;
      const current = this.agents.get(agentId);
      // Only remove the entry if it still points at *this* socket. Otherwise a late close
      // from a replaced connection would delete the newer, healthy one.
      if (current?.socket === socket) {
        this.agents.delete(agentId);
        // Anyone waiting on a frame from this agent must hear about it now. Without this a
        // disconnect would look like a slow capture until the timeout fired.
        this.rejectPending(agentId, new AgentNotFoundError('agent disconnected while a frame was pending'));
        this.rejectAcksFor(agentId, new AgentNotFoundError('agent disconnected while a click was pending'));
        this.log.info({ agentId, reason }, 'agent disconnected');
      }
    };

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      // Binary frames are pixels; JSON frames are control. Keeping them apart is what stops
      // a screenshot from being base64-inflated by a third on its way to the phone.
      if (isBinary) {
        if (agentId === null) {
          this.log.warn({ remoteAddress }, 'binary frame before hello, closing');
          socket.close(4000, 'expected hello first');
          return;
        }
        this.handleFrame(agentId, raw);
        return;
      }

      const envelope = parseEnvelope(raw);
      if (envelope === null) {
        this.sendError(socket, 'bad_envelope', 'expected JSON object {type,id,payload}');
        return;
      }

      // ---- before hello: nothing but hello is allowed ----
      if (agentId === null) {
        if (envelope.type !== 'hello') {
          this.log.warn({ remoteAddress, type: envelope.type }, 'first message was not hello, closing');
          socket.close(4000, 'expected hello first');
          return;
        }
        const info = readAgentInfo(envelope.payload);
        if (info === null) {
          socket.close(4001, 'invalid hello payload');
          return;
        }
        if (info.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(
            socket,
            'protocol_mismatch',
            `backend speaks protocol v${PROTOCOL_VERSION}, agent speaks v${info.protocolVersion}`,
          );
          socket.close(4001, 'protocol mismatch');
          return;
        }
        clearTimeout(helloTimer);
        agentId = info.agentId;
        this.register(info, socket, remoteAddress);
        socket.send(
          encodeEnvelope('hello.ack', {
            protocolVersion: PROTOCOL_VERSION,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            // The kill switch travels with the handshake: a restarted agent must not come
            // back willing to accept input that the laptop has already refused.
            suspended: this.suspended,
            serverTime: new Date().toISOString(),
          }),
        );
        return;
      }

      // ---- after hello: the steady state ----
      const agent = this.agents.get(agentId);
      if (agent === undefined) return;
      agent.lastSeenAt = Date.now();

      switch (envelope.type) {
        case 'ping': {
          const sentAt = readNumber(envelope.payload, 'sentAt');
          // Round-trip time from the agent's own timestamp. This subtracts one process's
          // clock from another's, so it can land slightly below zero; clamp instead of
          // reporting a negative duration.
          if (sentAt !== null) agent.lastRttMs = Math.max(0, Date.now() - sentAt);
          socket.send(
            encodeEnvelope('pong', { sentAt: sentAt ?? 0, serverTime: Date.now() }),
          );
          break;
        }
        // `system.ack` shares the routing with `input.ack` on purpose: both are "the reply to
        // the request with this id", and a second map would be a second thing to get wrong.
        case 'input.ack':
        case 'system.ack': {
          const forId = readString(envelope.payload, 'for');
          const waiting = this.pendingAcks.get(forId);
          if (waiting === undefined) {
            this.log.warn({ agentId, forId }, 'input acknowledgement with no request outstanding');
            break;
          }
          clearTimeout(waiting.timer);
          this.pendingAcks.delete(forId);
          waiting.resolve(envelope.payload as Record<string, unknown>);
          break;
        }
        case 'activity': {
          // Unsolicited: the agent decides when the laptop changed, not this side. Everything
          // is read defensively because a title is arbitrary text from another program.
          const activity: ActivityPayload = {
            app: readString(envelope.payload, 'app'),
            title: readString(envelope.payload, 'title'),
            idleSeconds: readNumber(envelope.payload, 'idleSeconds'),
            changed: readBoolean(envelope.payload, 'changed'),
            at: readString(envelope.payload, 'at'),
          };
          for (const handler of this.activityHandlers) {
            // One failing listener must not take the socket down with it.
            try {
              handler(agent.info, activity);
            } catch (error) {
              this.log.error({ err: error, agentId }, 'activity handler failed');
            }
          }
          break;
        }
        case 'error': {
          const code = readString(envelope.payload, 'code', 'unknown');
          const message = readString(envelope.payload, 'message');
          this.log.warn({ agentId, code, message }, 'agent reported an error');
          // A capture failure is an answer, not a network problem: fail the wait immediately
          // so the phone gets a real error instead of a timeout it cannot explain.
          this.rejectPending(agentId, new FrameFailedError(`${code}: ${message}`));
          this.rejectAcksFor(agentId, new FrameFailedError(`${code}: ${message}`));
          break;
        }
        default:
          // Unknown types are not fatal: an old backend meeting a new agent should log and
          // carry on, not drop the session.
          this.log.warn({ agentId, type: envelope.type }, 'unhandled message type from agent');
          this.sendError(socket, 'unhandled_type', `backend does not handle "${envelope.type}" yet`);
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      const text = reason.toString('utf8');
      forget(text === '' ? `close ${code}` : `close ${code} ${text}`);
    });

    socket.on('error', (error: Error) => {
      this.log.warn({ remoteAddress, err: error }, 'agent socket error');
      forget('socket error');
    });
  }

  /** Current connections, safe to serialise as JSON. */
  snapshot(): AgentSnapshot[] {
    const now = Date.now();
    return [...this.agents.values()].map((agent) => ({
      agentId: agent.info.agentId,
      hostname: agent.info.hostname,
      platform: agent.info.platform,
      version: agent.info.version,
      remoteAddress: agent.remoteAddress,
      screenWidth: agent.info.screen?.width ?? null,
      screenHeight: agent.info.screen?.height ?? null,
      connectedForMs: now - agent.connectedAt,
      lastSeenAgoMs: now - agent.lastSeenAt,
      lastRttMs: agent.lastRttMs,
    }));
  }

  /**
   * Ask one agent for a single frame and wait for the pixels.
   *
   * Only one request is outstanding per agent, enforced rather than documented: a binary
   * reply carries no id to correlate against, so two in flight would be ambiguous. A second
   * caller joins the request already waiting instead of starting a race.
   */
  requestFrame(agentId: string, timeoutMs: number, options: FrameOptions = {}): Promise<Buffer> {
    const agent = this.agents.get(agentId);
    if (agent === undefined) {
      return Promise.reject(new AgentNotFoundError(`agent ${agentId} is not connected`));
    }

    const existing = this.pending.get(agentId);
    if (existing !== undefined) return existing.promise;

    if (agent.socket.readyState !== agent.socket.OPEN) {
      return Promise.reject(new FrameFailedError('agent socket is not open'));
    }

    let resolve!: (frame: Buffer) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Buffer>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.pending.delete(agentId);
      reject(new FrameTimeoutError(`no frame from ${agentId} within ${timeoutMs} ms`));
    }, timeoutMs);

    this.pending.set(agentId, { promise, resolve, reject, timer });

    try {
      agent.socket.send(
        encodeEnvelope('screen.request', {
          // Clamped here as well as in the agent: a request that arrives by hand-typed URL
          // should not be able to ask the laptop for a 40-megapixel capture.
          maxWidth: clamp(options.maxWidth ?? FRAME_MAX_WIDTH, WIDTH_BOUNDS),
          quality: clamp(options.quality ?? FRAME_JPEG_QUALITY, QUALITY_BOUNDS),
        }),
      );
    } catch {
      this.rejectPending(agentId, new FrameFailedError('could not send the request to the agent'));
    }

    return promise;
  }

  /**
   * Click at a normalised point on the agent's desktop.
   *
   * Unlike frames, clicks are matched by id: the reply echoes the request's envelope id, so any
   * number can be in flight without ambiguity. The agent converts the fraction to pixels and
   * answers with where it actually landed — which is what the phone shows, because it is the
   * only coordinate that can be checked against reality.
   */
  async click(
    agentId: string,
    x: number,
    y: number,
    button: 'left' | 'none',
    timeoutMs: number,
    stepId?: string,
  ): Promise<{ screenX: number; screenY: number }> {
    const ack = await this.request(
      agentId,
      'input.click',
      stepId === undefined ? { x, y, button } : { x, y, button, stepId },
      timeoutMs,
    );
    return {
      screenX: readNumber(ack, 'screenX') ?? 0,
      screenY: readNumber(ack, 'screenY') ?? 0,
    };
  }

  /** Type text into the agent's focused window. Resolves once the agent confirms. */
  typeText(
    agentId: string,
    text: string,
    timeoutMs: number,
    stepId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      agentId,
      'input.text',
      stepId === undefined ? { text } : { text, stepId },
      timeoutMs,
    );
  }

  /** Press one named key, e.g. `enter`. */
  pressKey(
    agentId: string,
    key: string,
    timeoutMs: number,
    stepId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      agentId,
      'input.key',
      stepId === undefined ? { key } : { key, stepId },
      timeoutMs,
    );
  }

  /** Scroll by whole wheel notches; positive is up. */
  scroll(
    agentId: string,
    delta: number,
    timeoutMs: number,
    stepId?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      agentId,
      'input.scroll',
      stepId === undefined ? { delta } : { delta, stepId },
      timeoutMs,
    );
  }

  /**
   * Send one message that expects an `input.ack`, and wait for the reply carrying its id.
   *
   * Everything the phone does to the desktop goes through here, because the failure modes are
   * identical: no agent, a dead socket, or a silent agent. Writing them once means a new input
   * type cannot invent a fifth way to fail.
   */
  private request(
    agentId: string,
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const agent = this.agents.get(agentId);
    if (agent === undefined) {
      return Promise.reject(new AgentNotFoundError(`agent ${agentId} is not connected`));
    }
    if (agent.socket.readyState !== agent.socket.OPEN) {
      return Promise.reject(new FrameFailedError('agent socket is not open'));
    }

    const id = crypto.randomUUID();
    let resolve!: (ack: Record<string, unknown>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Record<string, unknown>>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.pendingAcks.delete(id);
      reject(new FrameTimeoutError(`no ${type} acknowledgement from ${agentId} within ${timeoutMs} ms`));
    }, timeoutMs);

    this.pendingAcks.set(id, { agentId, resolve, reject, timer });

    try {
      agent.socket.send(encodeEnvelope(type, payload, id));
    } catch {
      this.rejectAck(id, new FrameFailedError(`could not send ${type} to the agent`));
    }

    return promise;
  }

  /** Close every agent socket and stop the watchdog. Called on shutdown. */
  closeAll(): void {
    for (const agentId of [...this.pending.keys()]) {
      this.rejectPending(agentId, new FrameFailedError('backend shutting down'));
    }
    for (const id of [...this.pendingAcks.keys()]) {
      this.rejectAck(id, new FrameFailedError('backend shutting down'));
    }
    clearInterval(this.watchdog);
    for (const agent of this.agents.values()) {
      agent.socket.close(1001, 'backend shutting down');
    }
    this.agents.clear();
  }

  private register(info: AgentInfo, socket: WebSocket, remoteAddress: string): void {
    const existing = this.agents.get(info.agentId);
    if (existing !== undefined && existing.socket !== socket) {
      // The newest connection wins. When a phone's radio drops, the old socket can sit
      // there looking alive for minutes; the fresh reconnect is the truthful signal.
      this.log.info({ agentId: info.agentId }, 'replacing previous connection for this agent');
      existing.socket.terminate();
    }

    this.agents.set(info.agentId, {
      info,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastRttMs: null,
      remoteAddress,
    });

    this.log.info(
      {
        agentId: info.agentId,
        // Prefixed because pino already logs a top-level `hostname` (this machine's).
        agentHostname: info.hostname,
        platform: info.platform,
        version: info.version,
        remoteAddress,
      },
      'agent connected',
    );
  }

  /**
   * Kill sockets that have gone quiet.
   *
   * Without this, a laptop entering sleep or a Wi-Fi drop leaves a half-open TCP socket
   * that reports itself as connected while carrying nothing. `terminate()` is deliberate:
   * a polite `close()` would queue a frame that will never be delivered.
   */
  private sweep(): void {
    const now = Date.now();
    for (const agent of this.agents.values()) {
      const silentFor = now - agent.lastSeenAt;
      if (silentFor <= STALE_AFTER_MS) continue;
      this.log.warn({ agentId: agent.info.agentId, silentForMs: silentFor }, 'agent went silent, terminating socket');
      agent.socket.terminate();
    }
  }

  /** A binary frame: pixels that answer the one outstanding request, if there is one. */
  private handleFrame(agentId: string, raw: RawData): void {
    const frame = toBuffer(raw);
    if (frame === null) {
      this.log.warn({ agentId }, 'binary frame was not bytes, dropping');
      return;
    }

    // Pixels are proof of life as much as a ping is; without this an agent that is busy
    // capturing could be mistaken for a silent one and terminated.
    const agent = this.agents.get(agentId);
    if (agent !== undefined) agent.lastSeenAt = Date.now();

    const pending = this.pending.get(agentId);
    if (pending === undefined) {
      this.log.warn({ agentId, bytes: frame.length }, 'frame arrived with no request outstanding, dropping');
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(agentId);
    pending.resolve(frame);
  }

  private rejectAck(id: string, error: Error): void {
    const waiting = this.pendingAcks.get(id);
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    this.pendingAcks.delete(id);
    waiting.reject(error);
  }

  /** Fail every click still waiting on one agent, e.g. because it disconnected. */
  private rejectAcksFor(agentId: string, error: Error): void {
    for (const [id, waiting] of [...this.pendingAcks.entries()]) {
      if (waiting.agentId === agentId) this.rejectAck(id, error);
    }
  }

  private rejectPending(agentId: string, error: Error): void {
    const pending = this.pending.get(agentId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(agentId);
    pending.reject(error);
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeEnvelope('error', { code, message }));
  }
}
