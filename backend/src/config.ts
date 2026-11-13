/**
 * Central place where the process reads its configuration.
 *
 * Rules we are establishing here and will keep for the whole project:
 *  - Config comes from environment variables only (12-factor style).
 *  - Config is parsed and validated ONCE at startup, then passed around as a typed object.
 *    Nothing else in the codebase calls process.env.
 *  - Bad config = crash at startup with a clear message, not a mystery 500 later.
 */

// Node 22 can load a .env file natively, so we do not need the `dotenv` package.
// It throws when the file is missing (normal in production), hence the try/catch.
try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on real environment variables.
}

export type NodeEnv = 'development' | 'test' | 'production';

export type AppConfig = {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  logLevel: string;
  ai: AiConfig;
  approvals: ApprovalConfig;
  /** Where the device registry and other durable-but-not-database state lives. */
  stateDir: string;
  /**
   * How long a freshly minted pairing code stays valid.
   *
   * Longer than a password reset on purpose: this code is read off one screen and typed into
   * another by a human, sometimes after finding their phone. Five minutes proved too short to
   * be useful, and the code is single use and burns after five wrong guesses regardless.
   */
  pairCodeTtlMs: number;
  /**
   * Shared secret the agent presents on `/agent/ws`.
   *
   * `null` means "no check", which is only acceptable on a machine whose port is already
   * private. Set `DP_AGENT_TOKEN` and a client that cannot reach the laptop's `.env` can no
   * longer register itself as your laptop.
   */
  agentToken: string | null;
};

/**
 * Everything the AI loop needs, and nothing it does not.
 *
 * `apiKey` is `null` rather than empty so "not configured" is a type the routes have to handle:
 * the feature then fails with a clear 503 instead of sending `Bearer ` to a provider and
 * reporting a confusing 401.
 */
export type AiConfig = {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Models this server will send a request for. Anything else is refused before the call. */
  models: readonly string[];
  maxSteps: number;
  /** Runs allowed per calendar day. A runaway client must not spend real money by accident. */
  dailyRuns: number;
  timeoutMs: number;
};

/**
 * When a step needs a human answer.
 *
 * `tier` is the line in the sand: steps at or above it pause the task and wait. 1 asks about
 * anything that changes something (the default, because this moves a real mouse), 2 only asks
 * about Enter/Backspace/Delete, and 3 turns the question off entirely.
 */
export type ApprovalConfig = {
  tier: number;
  waitMs: number;
};

function readInt(name: string, fallback: number): number {
  return readBoundedInt(name, fallback, 1, 65535);
}

/** An integer in a range, or a startup crash naming the variable and the range. */
function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

/** Comma-separated names, trimmed and de-duplicated. Used for the model allowlist. */
function readList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? fallback : [...new Set(items)];
}

/**
 * The AI loop's configuration.
 *
 * The default base URL is Freebuff's OpenAI-compatible endpoint, because the owner of this
 * project already has a key there. Any provider speaking the same chat-completions shape works
 * unchanged by setting `DP_AI_BASE_URL` (Z.ai, OpenAI, a local server).
 */
function readAiConfig(): AiConfig {
  const model = process.env.DP_AI_MODEL ?? 'gpt-4o-mini';
  const apiKey = process.env.DP_AI_API_KEY ?? '';
  return {
    baseUrl: (process.env.DP_AI_BASE_URL ?? 'https://freebuff.com/api/v1/paid').replace(/\/+$/, ''),
    apiKey: apiKey === '' ? null : apiKey,
    model,
    models: readList('DP_AI_MODELS', [model]),
    maxSteps: readBoundedInt('DP_AI_MAX_STEPS', 8, 1, 30),
    dailyRuns: readBoundedInt('DP_AI_DAILY_RUNS', 20, 1, 10_000),
    timeoutMs: readBoundedInt('DP_AI_TIMEOUT_MS', 30_000, 1_000, 120_000),
  };
}

function readApprovalConfig(): ApprovalConfig {
  return {
    tier: readBoundedInt('DP_APPROVAL_TIER', 1, 1, 3),
    waitMs: readBoundedInt('DP_APPROVAL_WAIT_MS', 120_000, 1_000, 600_000),
  };
}

function readNodeEnv(): NodeEnv {
  const raw = process.env.NODE_ENV ?? 'development';
  if (raw !== 'development' && raw !== 'test' && raw !== 'production') {
    throw new Error(`Invalid NODE_ENV: expected development | test | production, got "${raw}"`);
  }
  return raw;
}

/**
 * `DP_PAIR_TTL_MIN` in minutes. Defaults to 30, clamped to 1..240.
 *
 * Clamped rather than refused: a typo should not stop the backend from starting, but it also
 * should not be able to leave a pairing code alive for a week.
 */
function readPairCodeTtlMs(): number {
  const raw = Number(process.env.DP_PAIR_TTL_MIN ?? 30);
  const minutes = Number.isFinite(raw) ? raw : 30;
  return Math.min(240, Math.max(1, minutes)) * 60_000;
}

/** `DP_AGENT_TOKEN`, trimmed. Empty or missing means "do not require one". */
function readAgentToken(): string | null {
  const raw = (process.env.DP_AGENT_TOKEN ?? '').trim();
  return raw === '' ? null : raw;
}

export function loadConfig(): AppConfig {
  return {
    nodeEnv: readNodeEnv(),
    // Bind to loopback by default. We widen this only when we deliberately expose the
    // backend on the Tailscale interface (Milestone 2), and we say so in the docs.
    //
    // Note the DP_ prefix. Bare names like PORT and HOST are routinely exported by other
    // tools on a developer machine (this one has PORT=0 set globally), and OS environment
    // variables take precedence over .env — so a generic name silently hijacks our config.
    // Namespacing is the cheap, permanent fix.
    host: process.env.DP_HOST ?? '127.0.0.1',
    port: readInt('DP_PORT', 8787),
    logLevel: process.env.DP_LOG_LEVEL ?? 'info',
    ai: readAiConfig(),
    approvals: readApprovalConfig(),
    // Relative to backend/ because that is the working directory `npm run dev` uses.
    stateDir: process.env.DP_STATE_DIR ?? '.state',
    pairCodeTtlMs: readPairCodeTtlMs(),
    agentToken: readAgentToken(),
  };
}
