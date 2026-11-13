import Fastify, { type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';

import {
  AgentHub,
  AgentNotFoundError,
  FrameFailedError,
  FrameTimeoutError,
  HEARTBEAT_INTERVAL_MS,
  HELLO_TIMEOUT_MS,
} from './agentHub.js';
import { AiLoop, AiModelError, AiNotConfiguredError, AiRateLimitError } from './ai/loop.js';
import { timingSafeEqual } from 'node:crypto';

import { AuditLog, AwayMode } from './audit.js';
import { loadConfig } from './config.js';
import { DeviceRegistry } from './devices.js';
import { KEY_NAMES } from './keys.js';
import { KillSwitch } from './killswitch.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { TaskRunner, type Step as TaskStep } from './tasks.js';

const config = loadConfig();

// Fastify has pino built in: structured logs, zero extra dependencies. We add pretty-printing
// later only if the JSON output actually gets in the way.
const app = Fastify({ logger: { level: config.logLevel } });

const startedAt = Date.now();

/**
 * How long the phone's request may wait for pixels. Deliberately longer than a capture
 * should take: a slow frame is better than a spurious failure, and the phone's own HTTP
 * timeout is what protects the user from waiting forever.
 */
const FRAME_TIMEOUT_MS = 8_000;

/** A click should be nearly instant; if the agent takes 3 s, something is wrong with it. */
const CLICK_TIMEOUT_MS = 3_000;

/**
 * Read a numeric query parameter, or `undefined` when it is absent or nonsense.
 *
 * Anything on the tailnet can call this route, so a query value is a hint, never an
 * instruction: `agentHub` clamps it and the agent clamps it again before capturing.
 */
function numericQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * One mapping from "the agent did not answer" to an HTTP status, shared by every input route.
 *
 * 404 means start the agent, 504 means the agent went quiet, 502 means it answered with an
 * error. Collapsing these into one 500 would tell the phone nothing it can act on.
 */
function inputFailure(reply: FastifyReply, error: unknown, label: string): FastifyReply {
  if (error instanceof AgentNotFoundError) {
    return reply.code(404).send({ error: 'agent_not_connected', message: error.message });
  }
  if (error instanceof FrameTimeoutError) {
    return reply.code(504).send({ error: `${label}_timeout`, message: error.message });
  }
  if (error instanceof FrameFailedError) {
    return reply.code(502).send({ error: `${label}_failed`, message: error.message });
  }
  return reply.code(500).send({ error: 'internal_error', message: `could not ${label}` });
}

const hub = new AgentHub(app.log);

/**
 * Sequences live in their own object because they own something the hub does not: a task has a
 * position in the middle of its steps, and that position has to survive a socket dying.
 */
const tasks = new TaskRunner(hub, app.log, {
  approvalTier: config.approvals.tier,
  approvalWaitMs: config.approvals.waitMs,
});

/**
 * The AI loop needs the hub (to see) and the runner (to act). It gets no Fastify instance, so it
 * cannot invent routes and cannot be reached except through the two below.
 */
const ai = new AiLoop(hub, tasks, app.log, config.ai);

/**
 * Who may drive this laptop. Built before the routes so the auth hook below can use it, and
 * before the first request so a corrupt registry stops the process instead of silently
 * unpairing every device.
 */
const devices = new DeviceRegistry(config.stateDir, app.log, config.pairCodeTtlMs);

/**
 * The audit trail and away mode. Both are file-backed in `DP_STATE_DIR`, so a restart does not
 * erase what happened, and does not silently end a mode whose whole purpose is to keep watching.
 */
const audit = new AuditLog(config.stateDir, app.log);
const away = new AwayMode(config.stateDir, app.log);

/**
 * The kill switch, loaded before the first request so a laptop that was killed and then
 * restarted comes back killed rather than quietly available again.
 */
const killSwitch = new KillSwitch(config.stateDir, app.log);
if (killSwitch.suspended) {
  // No agents are connected yet; this sets the flag they will read in `hello.ack`.
  hub.suspendAll();
  app.log.warn({ since: killSwitch.get().since }, 'kill switch is engaged; input is refused');
}

/**
 * Every activity report becomes an audit event; when away mode is on, a *change* of foreground
 * window also becomes an alert.
 *
 * The decision lives here rather than in the agent because it needs your intent, and the phone is
 * where that is expressed. The periodic "still here" samples are recorded but never alarming —
 * otherwise the trail would alert once a minute on an untouched laptop.
 */
hub.onActivity((info, activity) => {
  const alert = away.get().enabled && activity.changed;
  const event = audit.record({
    source: 'agent',
    at: activity.at === '' ? undefined : activity.at,
    agentId: info.agentId,
    agentHostname: info.hostname,
    app: activity.app,
    title: activity.title,
    idleSeconds: activity.idleSeconds,
    changed: activity.changed,
    alert,
  });
  if (alert) {
    app.log.warn(
      { agentId: info.agentId, app: event.app, title: event.title, idleSeconds: event.idleSeconds },
      'activity while away',
    );
  }
});

/**
 * Routes that must work without a device token, and why each one is safe.
 *
 * `/health` is a liveness probe with no personal data. `/pair` and `/pair/code` are how a
 * device *becomes* trusted, so they cannot require trust. `/arm` releases the kill switch, and
 * is safe without a token because the route itself checks for loopback — the same
 * physical-presence rule that makes `/pair/code` a second factor. `/agent/ws` is the agent's
 * outgoing socket: it is dialled from the laptop itself, and authenticating it is a separate
 * job (documented as a remaining gap rather than pretended away).
 */
const PUBLIC_ROUTES = new Set(['/health', '/pair', '/pair/code', '/arm', '/agent/ws']);

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value !== undefined && value !== ''
    ? value.trim()
    : undefined;
}

/** Loopback is "someone sitting at the laptop", the one caller we trust without a token. */
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Does this socket's `X-Agent-Token` match `DP_AGENT_TOKEN`?
 *
 * `expected === null` means the check is disabled, which is the pre-existing behaviour and is
 * stated at startup rather than assumed. Compared with `timingSafeEqual` because a token check
 * that leaks its prefix length is a token check that can be walked one character at a time —
 * slowly, but the fix costs three lines.
 */
function agentTokenMatches(header: string | string[] | undefined, expected: string | null): boolean {
  if (expected === null) return true;

  const presented = Array.isArray(header) ? header[0] : header;
  if (typeof presented !== 'string' || presented === '') return false;

  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * One hook, so the answer to "is this request allowed?" is in exactly one place.
 *
 * A per-route guard would be more explicit, but it would also be one forgotten route away
 * from a hole — and the forgotten route would be the newest one, because nobody writes the
 * guard on the day they add a feature.
 */
app.addHook('onRequest', async (request, reply) => {
  const path = (request.raw.url ?? '').split('?')[0] ?? '';
  if (PUBLIC_ROUTES.has(path)) return;

  /**
   * `/local/*` is the laptop's own console: listing and revoking devices used to need a device
   * token, which meant pairing a throwaway phone to clean up a stale one — the workaround left
   * behind exactly the kind of record it was meant to remove.
   *
   * Checked here, on the prefix, for the same reason the token check lives in one hook: a route
   * added under `/local/` that forgot its own guard would be reachable from the whole tailnet.
   */
  if (path === '/local' || path.startsWith('/local/')) {
    if (isLoopback(request.ip)) return;
    app.log.warn({ path, remoteAddress: request.ip }, 'refused a /local request from off the laptop');
    return reply.code(403).send({
      error: 'loopback_only',
      message: 'this route only answers on the laptop itself',
    });
  }

  if (devices.verify(bearerToken(request.headers.authorization)) !== null) return;

  app.log.warn({ path, remoteAddress: request.ip }, 'request without a valid device token');
  return reply.code(401).send({ error: 'unauthorized', message: 'pair this device first' });
});

/**
 * `steps` is an array of four different shapes, which a JSON schema cannot require per-action
 * without a `oneOf` per case. Checking here keeps the schema readable and still refuses bad
 * steps before any task is started.
 */
function validateStep(step: TaskStep, index: number): string | null {
  switch (step.action) {
    case 'text':
      return typeof step.text === 'string' && step.text !== ''
        ? null
        : `steps[${index}] needs a non-empty text`;
    case 'key':
      return KEY_NAMES.includes(step.key as (typeof KEY_NAMES)[number])
        ? null
        : `steps[${index}] key must be one of ${KEY_NAMES.join(', ')}`;
    case 'scroll':
      return Number.isInteger(step.delta) && step.delta >= -10 && step.delta <= 10
        ? null
        : `steps[${index}] delta must be an integer between -10 and 10`;
    case 'click':
      return (step.x >= 0 && step.x <= 1 && step.y >= 0 && step.y <= 1)
        ? null
        : `steps[${index}] x and y must be between 0 and 1`;
  }
}

/**
 * Liveness + identity endpoint.
 *
 * Why every service gets one from day one: it is the cheapest possible test of
 * "is this process up, reachable, and running the code I think it is?".
 * Milestone 2's connectivity check and the phone's status screen both call this.
 */
app.get('/health', async () => {
  return {
    service: 'deskpilot-backend',
    status: 'ok',
    version: '0.1.0',
    env: config.nodeEnv,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    agentsConnected: hub.count,
    // Says whether the AI loop can work at all, without ever revealing the key itself.
    ai: {
      configured: config.ai.apiKey !== null,
      model: config.ai.model,
      maxSteps: config.ai.maxSteps,
    },
    // Reported so "why did it ask me?" has an answer that does not require reading the code.
    approvals: { tier: config.approvals.tier, waitMs: config.approvals.waitMs },
    // How many devices can drive this laptop right now. Zero means nobody can, which is a
    // state worth being able to see from the phone even when the phone is locked out — and
    // exactly what the kill switch leaves behind.
    auth: {
      required: true,
      pairedDevices: devices.count,
      suspended: killSwitch.suspended,
      // "open" here is a fact worth being able to see, not a recommendation.
      agentSocket: config.agentToken === null ? 'open' : 'token',
    },
    time: new Date().toISOString(),
  };
});

async function main(): Promise<void> {
  // Registered before the WebSocket route on purpose: the plugin adds the routing hook
  // that lets Fastify treat `{ websocket: true }` routes as socket handlers.
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  /**
   * The agent's front door.
   *
   * Authenticated with a shared secret when `DP_AGENT_TOKEN` is set. The check happens after
   * the HTTP upgrade, so a refusal is a socket close (4003) rather than a 401 — but it happens
   * before `hello` is read, so a forged agent never gets to claim an identity, and the hub never
   * replaces a real laptop's connection.
   *
   * With no token configured the door is open. That is the old behaviour, kept so an existing
   * install does not break on upgrade; the startup log says so plainly instead of leaving it to
   * be discovered.
   */
  app.get('/agent/ws', { websocket: true }, (socket, request) => {
    if (!agentTokenMatches(request.headers['x-agent-token'], config.agentToken)) {
      app.log.warn(
        { remoteAddress: request.raw.socket.remoteAddress },
        'agent socket refused: missing or wrong DP_AGENT_TOKEN',
      );
      socket.close(4003, 'unauthorized');
      return;
    }
    hub.attach(socket, request.raw.socket.remoteAddress ?? 'unknown');
  });

  /**
   * Live agent status for the phone. This is the endpoint that makes the WebSocket
   * *observable* — without it, "is the laptop agent connected?" is only answerable by
   * reading logs.
   */
  app.get('/agents', async () => {
    return {
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      helloTimeoutMs: HELLO_TIMEOUT_MS,
      // A restart is otherwise invisible from the phone: the agent reconnects and the list
      // looks exactly as it did before. These two numbers make "did the backend actually
      // restart?" answerable without walking to the laptop and reading a terminal.
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      startedAt: new Date(startedAt).toISOString(),
      agents: hub.snapshot(),
    };
  });

  /**
   * One screenshot, on demand: the phone asks here, the backend asks the agent, the agent
   * captures and answers with JPEG bytes.
   *
   * Pull, not push. The phone's request *is* the trigger, so an idle laptop captures nothing
   * and a forgotten tab on the phone costs no battery. Milestone 4 adds the loop that
   * repeats this; the shape of the request does not have to change.
   *
   * Three failures deserve three status codes, because they are fixed in three different
   * places: no such agent (start it), agent too slow (check the laptop), capture broke
   * (read the agent log).
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { maxWidth?: string; quality?: string; monitor?: string };
  }>(
    '/agents/:agentId/screen',
    async (request, reply) => {
      const { agentId } = request.params;
      // Optional tuning, because live view (Milestone 4) wants smaller frames than a single
      // deliberate capture: motion hides detail that a still image has to preserve.
      const options = {
        maxWidth: numericQuery(request.query.maxWidth),
        quality: numericQuery(request.query.quality),
        // A query parameter rather than a required field: every existing caller keeps working
        // and simply gets the primary display, which is what they were getting before.
        monitor: numericQuery(request.query.monitor),
      };
      try {
        const frame = await hub.requestFrame(agentId, FRAME_TIMEOUT_MS, options);
        return reply
          .type('image/jpeg')
          // A screenshot is stale the instant it is taken; caching it would be a lie.
          .header('Cache-Control', 'no-store')
          .send(frame);
      } catch (error) {
        if (error instanceof AgentNotFoundError) {
          return reply.code(404).send({ error: 'agent_not_connected', message: error.message });
        }
        if (error instanceof FrameTimeoutError) {
          return reply.code(504).send({ error: 'frame_timeout', message: error.message });
        }
        if (error instanceof FrameFailedError) {
          return reply.code(502).send({ error: 'capture_failed', message: error.message });
        }
        app.log.error({ err: error, agentId }, 'screen request failed');
        return reply.code(500).send({ error: 'internal_error', message: 'could not produce a frame' });
      }
    },
  );

  /**
   * A tap, as a fraction of the screen.
   *
   * `x`/`y` are 0..1, not pixels: the phone has no idea what resolution the desktop is, and
   * the agent is the only component that can map a fraction to a real pixel. The schema below
   * is why this project uses Fastify — an out-of-range value is rejected before any handler
   * code runs, with a 400 and the offending field named.
   */
  app.post<{
    Params: { agentId: string };
    Body: { x: number; y: number; button?: 'left' | 'none'; monitor?: number };
  }>(
    '/agents/:agentId/click',
    {
      schema: {
        body: {
          type: 'object',
          required: ['x', 'y'],
          additionalProperties: false,
          properties: {
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
            // `none` moves without clicking: needed for dragging later, and lets the mapping
            // be verified without clicking something on the desktop.
            button: { type: 'string', enum: ['left', 'none'] },
            // The display the fraction refers to. Omitted means primary, so an older phone
            // build keeps working against this backend.
            monitor: { type: 'integer', minimum: 1, maximum: 8 },
          },
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const { x, y, button = 'left', monitor } = request.body;
      try {
        const at = await hub.click(agentId, x, y, button, CLICK_TIMEOUT_MS, undefined, monitor);
        return reply.send({ ok: true, screenX: at.screenX, screenY: at.screenY, button });
      } catch (error) {
        if (error instanceof AgentNotFoundError) {
          return reply.code(404).send({ error: 'agent_not_connected', message: error.message });
        }
        if (error instanceof FrameTimeoutError) {
          return reply.code(504).send({ error: 'click_timeout', message: error.message });
        }
        if (error instanceof FrameFailedError) {
          return reply.code(502).send({ error: 'click_failed', message: error.message });
        }
        app.log.error({ err: error, agentId }, 'click failed');
        return reply.code(500).send({ error: 'internal_error', message: 'could not click' });
      }
    },
  );

  /**
   * Type text into whatever window has focus on the laptop.
   *
   * The phone sends the characters, not key codes: the agent knows neither the keyboard layout
   * nor the language, and Windows can turn a Unicode character into the right keystroke itself.
   * `maxLength` is a limit on damage, not on usability — nobody types 2 KB by accident, but a
   * runaway client could.
   */
  app.post<{ Params: { agentId: string }; Body: { text: string } }>(
    '/agents/:agentId/text',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      try {
        const ack = await hub.typeText(agentId, request.body.text, CLICK_TIMEOUT_MS);
        const typed = typeof ack.typed === 'number' ? ack.typed : request.body.text.length;
        return reply.send({ ok: true, typed });
      } catch (error) {
        if (!(error instanceof AgentNotFoundError || error instanceof FrameTimeoutError || error instanceof FrameFailedError)) {
          app.log.error({ err: error, agentId }, 'text failed');
        }
        return inputFailure(reply, error, 'text');
      }
    },
  );

  /** Press one named key. Names are a closed list, so no arbitrary key can be pressed. */
  app.post<{ Params: { agentId: string }; Body: { key: (typeof KEY_NAMES)[number] } }>(
    '/agents/:agentId/key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key'],
          additionalProperties: false,
          properties: { key: { type: 'string', enum: [...KEY_NAMES] } },
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      try {
        await hub.pressKey(agentId, request.body.key, CLICK_TIMEOUT_MS);
        return reply.send({ ok: true, key: request.body.key });
      } catch (error) {
        if (!(error instanceof AgentNotFoundError || error instanceof FrameTimeoutError || error instanceof FrameFailedError)) {
          app.log.error({ err: error, agentId }, 'key press failed');
        }
        return inputFailure(reply, error, 'key');
      }
    },
  );

  /**
   * Scroll by whole wheel notches, positive up.
   *
   * Notches rather than pixels: Windows itself decides how far a notch travels, per application,
   * so "three notches" behaves the same in a browser and a spreadsheet, while "120 pixels"
   * would mean something different in each.
   */
  app.post<{ Params: { agentId: string }; Body: { delta: number } }>(
    '/agents/:agentId/scroll',
    {
      schema: {
        body: {
          type: 'object',
          required: ['delta'],
          additionalProperties: false,
          properties: { delta: { type: 'integer', minimum: -10, maximum: 10 } },
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      try {
        await hub.scroll(agentId, request.body.delta, CLICK_TIMEOUT_MS);
        return reply.send({ ok: true, delta: request.body.delta });
      } catch (error) {
        if (!(error instanceof AgentNotFoundError || error instanceof FrameTimeoutError || error instanceof FrameFailedError)) {
          app.log.error({ err: error, agentId }, 'scroll failed');
        }
        return inputFailure(reply, error, 'scroll');
      }
    },
  );

  /**
   * Start a task: a short sequence of steps that runs once each, even if the agent drops out.
   *
   * The reply is immediate (`202`) because a task outlives the request that started it — that is
   * the whole point. Progress is read from the task's own endpoint.
   */
  app.post<{
    Params: { agentId: string };
    Body: { name?: string; steps: TaskStep[]; gapMs?: number };
  }>(
    '/agents/:agentId/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['steps'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 80 },
            gapMs: { type: 'integer', minimum: 0, maximum: 5000 },
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['action'],
                additionalProperties: false,
                properties: {
                  action: { type: 'string', enum: ['text', 'key', 'scroll', 'click'] },
                  text: { type: 'string', minLength: 1, maxLength: 2000 },
                  key: { type: 'string' },
                  delta: { type: 'integer', minimum: -10, maximum: 10 },
                  x: { type: 'number', minimum: 0, maximum: 1 },
                  y: { type: 'number', minimum: 0, maximum: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      const { steps, name, gapMs } = request.body;

      for (const [index, step] of steps.entries()) {
        const problem = validateStep(step, index);
        if (problem !== null) return reply.code(400).send({ error: 'invalid_step', message: problem });
      }

      const task = tasks.create(agentId, name ?? 'task', steps, gapMs);
      return reply.code(202).send(task);
    },
  );

  /** Progress of one task. `waiting` means the agent is away and the task is holding its place. */
  app.get<{ Params: { agentId: string; taskId: string } }>(
    '/agents/:agentId/tasks/:taskId',
    async (request, reply) => {
      const { agentId, taskId } = request.params;
      const task = tasks.get(taskId);
      if (task === null || task.agentId !== agentId) {
        return reply.code(404).send({ error: 'task_not_found', message: `no task ${taskId}` });
      }
      return reply.send(task);
    },
  );

  /** Recent tasks, so "what did I just run?" does not require reading the log. */
  app.get<{ Params: { agentId: string } }>('/agents/:agentId/tasks', async (request) => {
    return { tasks: tasks.list(request.params.agentId) };
  });

  /** Cancel: the step in flight finishes, later steps are skipped. */
  app.delete<{ Params: { agentId: string; taskId: string } }>(
    '/agents/:agentId/tasks/:taskId',
    async (request, reply) => {
      const { agentId, taskId } = request.params;
      const existing = tasks.get(taskId);
      if (existing === null || existing.agentId !== agentId) {
        return reply.code(404).send({ error: 'task_not_found', message: `no task ${taskId}` });
      }
      const cancelled = tasks.cancel(taskId);
      return reply.send(cancelled ?? existing);
    },
  );

  /**
   * Answer a paused task: approve the step it is waiting on, or refuse the rest of the run.
   *
   * 409 rather than 404 when the task exists but is not waiting for that step: a second tap on
   * Approve must not look like a missing task, and must not run anything either.
   */
  app.post<{
    Params: { agentId: string; taskId: string };
    Body: { decision: 'approve' | 'deny'; stepIndex: number };
  }>(
    '/agents/:agentId/tasks/:taskId/approval',
    {
      schema: {
        body: {
          type: 'object',
          required: ['decision', 'stepIndex'],
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['approve', 'deny'] },
            stepIndex: { type: 'integer', minimum: 0, maximum: 49 },
          },
        },
      },
    },
    async (request, reply) => {
      const { agentId, taskId } = request.params;
      const existing = tasks.get(taskId);
      if (existing === null || existing.agentId !== agentId) {
        return reply.code(404).send({ error: 'task_not_found', message: `no task ${taskId}` });
      }

      const updated = tasks.approve(taskId, request.body.stepIndex, request.body.decision);
      if (updated === null) {
        return reply.code(409).send({
          error: 'not_waiting',
          message: `task ${taskId} is not waiting for approval of step ${request.body.stepIndex}`,
        });
      }
      return reply.send(updated);
    },
  );

  /**
   * One sentence in, an executed and verified run out.
   *
   * Synchronous on purpose: the caller asked for an outcome, and splitting this into a queue
   * would mean the phone has to poll to learn whether its own request worked. The bound is the
   * step cap, the per-call timeout and the task deadline, which together keep one request well
   * under a minute.
   *
   * `dryRun` plans without acting: the cheap way to check that a key works and see what the model
   * would do, without letting it touch the desktop.
   */
  app.post<{ Params: { agentId: string }; Body: { goal: string; dryRun?: boolean } }>(
    '/agents/:agentId/ai',
    {
      schema: {
        body: {
          type: 'object',
          required: ['goal'],
          additionalProperties: false,
          properties: {
            goal: { type: 'string', minLength: 3, maxLength: 500 },
            dryRun: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { agentId } = request.params;
      try {
        const run = await ai.run(agentId, request.body.goal, { dryRun: request.body.dryRun === true });
        return reply.send(run);
      } catch (error) {
        if (error instanceof AiNotConfiguredError) {
          return reply
            .code(503)
            .send({ error: 'ai_not_configured', message: error.message, hint: 'set DP_AI_API_KEY in backend/.env' });
        }
        if (error instanceof AiRateLimitError) {
          return reply.code(429).send({ error: 'ai_rate_limited', message: error.message });
        }
        if (error instanceof AiModelError) {
          return reply.code(502).send({ error: 'ai_model_failed', message: error.message });
        }
        if (error instanceof AgentNotFoundError) {
          return reply.code(404).send({ error: 'agent_not_connected', message: error.message });
        }
        if (error instanceof FrameTimeoutError) {
          return reply.code(504).send({ error: 'ai_timeout', message: error.message });
        }
        if (error instanceof FrameFailedError) {
          return reply.code(502).send({ error: 'ai_failed', message: error.message });
        }
        app.log.error({ err: error, agentId }, 'ai run failed');
        return reply.code(500).send({ error: 'internal_error', message: 'the ai run failed' });
      }
    },
  );

  /** Read back a run, including what the model planned and whether it verified. */
  app.get<{ Params: { agentId: string; runId: string } }>(
    '/agents/:agentId/ai/:runId',
    async (request, reply) => {
      const { agentId, runId } = request.params;
      const run = ai.get(runId);
      if (run === null || run.agentId !== agentId) {
        return reply.code(404).send({ error: 'run_not_found', message: `no run ${runId}` });
      }
      return reply.send(run);
    },
  );

  /**
   * Mint a one-time pairing code — loopback only.
   *
   * The code is the only thing that can create a device token, so it must not be readable from
   * the tailnet: a code anyone can fetch is not a second factor, it is a convenience. Loopback
   * means the person at the keyboard, which is the one party we do trust.
   */
  app.get('/pair/code', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({
        error: 'loopback_only',
        message: 'pairing codes are only issued on the laptop itself: ./scripts/dev.sh pair',
      });
    }
    return reply.send(devices.createCode());
  });

  /**
   * Trade a code for this device's token.
   *
   * Public by necessity — it is the door — so the code itself carries all the weight: single
   * use, thirty minutes by default (`DP_PAIR_TTL_MIN`), and burned after five wrong guesses.
   *
   * The three refusals are deliberately distinct. "Wrong code", "that code expired" and "no code
   * is waiting" need different actions from the person holding the phone, and codes live in
   * memory, so a dev-server reload silently turns a valid code into no code at all.
   */
  app.post<{ Body: { code: string; name: string } }>(
    '/pair',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code', 'name'],
          additionalProperties: false,
          properties: {
            code: { type: 'string', minLength: 4, maxLength: 12 },
            name: { type: 'string', minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = devices.redeem(request.body.code, request.body.name);
      if (result.ok) {
        return reply.code(201).send({ deviceId: result.deviceId, name: result.name, token: result.token });
      }
      const message =
        result.error === 'expired'
          ? 'that code expired; ask the laptop for a new one'
          : result.error === 'no_code'
            ? 'no pairing code is waiting; run ./scripts/dev.sh pair on the laptop'
            : 'that code is not the one the laptop is showing';
      const status = result.error === 'expired' ? 410 : result.error === 'no_code' ? 409 : 401;
      return reply.code(status).send({ error: result.error, message });
    },
  );

  /** The devices that can drive this laptop. Hashes and tokens are never included. */
  app.get('/devices', async () => ({ devices: devices.list() }));

  /**
   * The same registry, from the laptop's own keyboard.
   *
   * Loopback is the credential, exactly as it is for `/pair/code`: the person at the machine is
   * the one party this system trusts without a token. That is what makes `./scripts/dev.sh
   * devices` and `revoke` possible without first pairing something. It is also deliberately a
   * *different path* from `/devices`, so a mistaken proxy rule cannot expose the phone-facing
   * route as an unauthenticated admin one.
   */
  app.get('/local/devices', async () => ({ devices: devices.list() }));

  /** Revoke from the laptop. Same registry call as `/devices/:deviceId`, different door. */
  app.delete<{ Params: { deviceId: string } }>(
    '/local/devices/:deviceId',
    async (request, reply) => {
      const revoked = devices.revoke(request.params.deviceId);
      if (revoked === null) {
        return reply.code(404).send({ error: 'device_not_found', message: 'no such device' });
      }
      return reply.send(revoked);
    },
  );

  /** Revoke a device. Its token stops working on the very next request. */
  app.delete<{ Params: { deviceId: string } }>('/devices/:deviceId', async (request, reply) => {
    const revoked = devices.revoke(request.params.deviceId);
    if (revoked === null) {
      return reply.code(404).send({ error: 'device_not_found', message: 'no such device' });
    }
    return reply.send(revoked);
  });

  /**
   * The audit trail, newest first, plus away mode and the unacknowledged alert count.
   *
   * Read-only on purpose: no route edits or deletes a past event, because a trail you can
   * rewrite answers none of the questions it exists for.
   */
  /**
   * Lock the Windows session — the remote equivalent of Win+L.
   *
   * The agent is the only component that can do this, so the failures are the same three as a
   * screenshot: no agent, no answer, or an agent that refused. Locking is also acknowledged
   * rather than assumed, because it is the one action whose effect the person at the desk sees
   * immediately.
   */
  app.post<{ Params: { agentId: string } }>('/agents/:agentId/lock', async (request, reply) => {
    const { agentId } = request.params;
    try {
      await hub.lock(agentId, FRAME_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: 'agent_not_connected', message: error.message });
      }
      if (error instanceof FrameTimeoutError) {
        return reply.code(504).send({ error: 'lock_timeout', message: error.message });
      }
      if (error instanceof FrameFailedError) {
        return reply.code(502).send({ error: 'lock_failed', message: error.message });
      }
      app.log.error({ err: error, agentId }, 'lock request failed');
      return reply.code(500).send({ error: 'internal_error', message: 'could not lock the laptop' });
    }

    audit.record({
      source: 'phone',
      agentId,
      app: 'DeskPilot',
      title: 'laptop locked on request',
      changed: false,
      alert: false,
    });
    return { locked: true };
  });

  /**
   * The kill switch.
   *
   * It turns control **off**, including for the caller: every device token is revoked and every
   * connected agent is told to refuse input and frames. Undoing it needs the laptop's own
   * keyboard (`POST /arm`), because a switch that the holder of a stolen phone can turn back off
   * is a button, not a switch.
   */
  app.post('/panic', async () => {
    const revoked = devices.revokeAll();
    killSwitch.engage();
    const reached = hub.suspendAll();
    audit.record({
      source: 'phone',
      app: 'DeskPilot',
      title: `kill switch engaged: ${revoked} device(s) revoked, ${reached} agent(s) stopped`,
      changed: false,
      alert: false,
    });
    app.log.warn({ revoked, reached }, 'kill switch engaged from a paired device');
    return { revoked, agentsSuspended: reached, suspended: true };
  });

  /**
   * Re-arm — loopback only, like minting a pairing code.
   *
   * This is the other half of the kill switch and the reason it can be a real one: the person
   * who can undo it is the person sitting at the laptop. A phone cannot do this, and neither can
   * another device on the tailnet.
   */
  app.post('/arm', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({
        error: 'loopback_only',
        message: 're-arming is only possible on the laptop itself',
      });
    }

    killSwitch.release();
    const reached = hub.resumeAll();
    audit.record({
      source: 'phone',
      app: 'DeskPilot',
      title: `kill switch released at the laptop (${reached} agent(s) resumed)`,
      changed: false,
      alert: false,
    });
    return { suspended: false, agentsResumed: reached };
  });

  app.get<{ Querystring: { limit?: string } }>('/audit', async (request) => {
    // Clamped rather than validated: a hand-typed `?limit=1e9` should not ask this process to
    // build a giant array, but it also should not be an error worth a status code.
    const limit = Math.min(200, Math.max(1, Math.round(numericQuery(request.query.limit) ?? 50)));
    return { away: away.get(), alerts: audit.unacknowledgedCount, events: audit.list(limit) };
  });

  /**
   * Turn away mode on or off.
   *
   * Persisted, because "I have left the laptop" is a statement about you and not about this
   * process — and a backend that restarts during the afternoon is exactly the moment you would
   * not notice it had forgotten.
   */
  app.post<{ Body: { enabled: boolean } }>(
    '/away',
    {
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const state = away.set(request.body.enabled);
      // The toggle itself belongs in the trail: "when did the alerts start?" is a question the
      // feed should be able to answer without guessing.
      audit.record({
        source: 'phone',
        app: 'DeskPilot',
        title: state.enabled ? 'away mode on' : 'away mode off',
        changed: false,
        alert: false,
      });
      return state;
    },
  );

  /** Mark every alert so far as seen. The events stay; only the watermark moves. */
  app.post('/audit/acknowledge', async () => audit.acknowledge());

  if (config.agentToken === null) {
    app.log.warn(
      'DP_AGENT_TOKEN is not set: /agent/ws accepts any client that can reach this port. Set it in backend/.env and agent/.env to close that gap.',
    );
  }

  try {
    await app.listen({ host: config.host, port: config.port });
    if (config.host === '0.0.0.0') {
      app.log.warn(
        'bound to 0.0.0.0: reachable from your whole LAN. Needed so the phone can reach the backend over Tailscale; do not leave this open without pairing (Phase 5).',
      );
    }
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

// Shut down cleanly so the port is released and in-flight requests finish.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, closing server`);
    hub.closeAll();
    void app.close().then(() => process.exit(0));
  });
}

void main();
