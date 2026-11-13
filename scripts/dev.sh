#!/usr/bin/env bash
# DeskPilot dev supervisor — start, stop and inspect the local processes.
#
# Why this is a script and not three hand-typed terminals:
#   * A server whose terminal you closed keeps holding its port. The next start then dies
#     with EADDRINUSE, and "did it actually restart?" becomes unanswerable.
#   * One command that remembers what it started makes every state visible: running,
#     stopped, or orphaned by an older session.
#
# Usage:
#   ./scripts/dev.sh start [--no-mobile]   # backend + agent in background, Expo in front
#   ./scripts/dev.sh stop                  # stop everything, free the ports
#   ./scripts/dev.sh status                # what is up, on which port, for how long
#   ./scripts/dev.sh restart [--no-mobile]
#   ./scripts/dev.sh pair                   print a one-time pairing code for a new phone

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/logs" # already gitignored, so pid and log files never reach a commit

BACKEND_PORT="${DP_BACKEND_PORT:-8787}"
AGENT_PORT="${DP_AGENT_PORT:-8788}"

BACKEND_PID_FILE="$RUN_DIR/backend.pid"
AGENT_PID_FILE="$RUN_DIR/agent.pid"
BACKEND_LOG="$RUN_DIR/backend.log"
AGENT_LOG="$RUN_DIR/agent.log"

say() { printf '%s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# `kill -0` cannot see every native Windows pid from Git Bash, so ask the OS instead.
proc_alive() {
  powershell -NoProfile -Command \
    "if (Get-Process -Id $1 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" \
    >/dev/null 2>&1
}

# Which pid is listening on a port (empty when the port is free).
port_pid() {
  netstat -ano | tr -d '\r' | awk -v pat=":$1\$" '$4 == "LISTENING" && $2 ~ pat { print $5; exit }'
}

# The command line behind a pid, so we never kill something that merely happens to own the port.
proc_cmdline() {
  powershell -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter 'ProcessId=$1' -ErrorAction SilentlyContinue).CommandLine" \
    2>/dev/null | tr -d '\r'
}

# Parent of a pid, in Windows numbering (empty when unknown).
parent_pid() {
  powershell -NoProfile -Command \
    "(Get-CimInstance Win32_Process -Filter 'ProcessId=$1').ParentProcessId" \
    2>/dev/null | tr -d '\r'
}

# Git Bash numbers its own processes; Windows tools use a different number for the same
# process. This translates one into the other (empty when unknown).
winpid() {
  ps -W 2>/dev/null | awk -v p="$1" '
    NR == 1 { for (i = 1; i <= NF; i++) if ($i == "WINPID") c = i; next }
    $1 == p { print $c; exit }
  '
}

kill_tree() { # $1 pid, in either numbering scheme
  local pid="$1" win
  win="$(winpid "$pid")"
  [[ -n "$win" ]] && pid="$win"
  taskkill //PID "$pid" //T //F >/dev/null 2>&1
}

# Is this process part of this project? The only thing that makes a kill safe.
#
# A repo path in the command line is not enough on its own: `python -m app.main` shows up as
# the *base* interpreter ("...\Python312\python.exe" -m app.main) with no path to the repo at
# all, so we also accept our services' own signatures, and any ancestor launched from here.
ours() {
  local pid="$1" cmd hop=0 parent
  cmd="$(proc_cmdline "$pid")"
  printf '%s' "$cmd" | grep -qi 'DeskPilot' && return 0
  printf '%s' "$cmd" | grep -qiE '(-m app\.main|src/server\.ts)' && return 0
  parent="$pid"
  while ((hop < 6)); do
    parent="$(parent_pid "$parent")"
    [[ -z "$parent" || "$parent" == "0" ]] && break
    proc_cmdline "$parent" | grep -qi 'DeskPilot' && return 0
    hop=$((hop + 1))
  done
  return 1
}

# Climb to the outermost ancestor that still belongs to this project.
#
# The process holding port 8787 is a child of `tsx watch`, which respawns it the moment it
# dies. Killing the listener alone would just move the conflict one pid over, so we record
# the watcher instead. The climb stops at the first ancestor that is not ours, so a terminal
# or shell that happened to launch the server is never in the blast radius.
root_pid() {
  local pid="$1" parent
  while :; do
    parent="$(parent_pid "$pid")"
    [[ -z "$parent" || "$parent" == "0" ]] && break
    ours "$parent" || break
    pid="$parent"
  done
  printf '%s' "$pid"
}

# Poll an HTTP endpoint until it answers 200. Readiness, not "the process spawned".
wait_http() { # $1 url, $2 seconds
  local url="$1" limit="$2" waited=0
  while ((waited < limit * 2)); do
    if curl -s -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null | grep -q '^200$'; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

start_backend() {
  local pid spawned
  if [[ -f "$BACKEND_PID_FILE" ]] && proc_alive "$(cat "$BACKEND_PID_FILE")"; then
    say "backend   already running (pid $(cat "$BACKEND_PID_FILE"))"
    return 0
  fi

  pid="$(port_pid "$BACKEND_PORT")"
  if [[ -n "$pid" ]]; then
    # Started by hand before this script existed: take ownership instead of fighting it.
    if ours "$pid"; then
      pid="$(root_pid "$pid")"
      echo "$pid" >"$BACKEND_PID_FILE"
      say "backend   :$BACKEND_PORT already served by pid $pid — adopting it (stop will end it)"
      return 0
    fi
    die "port $BACKEND_PORT is held by pid $pid, which is not part of this project:
       $(proc_cmdline "$pid" | cut -c1-100)
     Not touching it. Stop that process yourself, then retry."
  fi

  mkdir -p "$RUN_DIR"
  pushd "$ROOT/backend" >/dev/null || die "cannot enter backend/"
  npm run dev >"$BACKEND_LOG" 2>&1 &
  spawned=$!
  popd >/dev/null || true

  if ! wait_http "http://127.0.0.1:$BACKEND_PORT/health" 45; then
    say "backend   did not answer /health within 45s. Last log lines:"
    tail -n 20 "$BACKEND_LOG" 2>/dev/null
    kill_tree "$spawned"
    rm -f "$BACKEND_PID_FILE"
    return 1
  fi
  # Record the native pid that owns the port (and the watcher above it), not the number
  # Git Bash handed out — `status` and `taskkill` both speak Windows pids.
  pid="$(root_pid "$(port_pid "$BACKEND_PORT")")"
  [[ -z "$pid" ]] && pid="$(winpid "$spawned")"
  echo "$pid" >"$BACKEND_PID_FILE"
  say "backend   up on :$BACKEND_PORT (pid $pid) — log: logs/backend.log"
}

start_agent() {
  local pid spawned py="$ROOT/agent/.venv/Scripts/python.exe"
  [[ -x "$py" ]] || die "agent/.venv is missing. Create it first (see README → Quick start)."

  if [[ -f "$AGENT_PID_FILE" ]] && proc_alive "$(cat "$AGENT_PID_FILE")"; then
    say "agent     already running (pid $(cat "$AGENT_PID_FILE"))"
    return 0
  fi

  pid="$(port_pid "$AGENT_PORT")"
  if [[ -n "$pid" ]]; then
    if ours "$pid"; then
      pid="$(root_pid "$pid")"
      echo "$pid" >"$AGENT_PID_FILE"
      say "agent     :$AGENT_PORT already served by pid $pid — adopting it (stop will end it)"
      return 0
    fi
    die "port $AGENT_PORT is held by pid $pid, which is not part of this project:
       $(proc_cmdline "$pid" | cut -c1-100)
     Not touching it. Stop that process yourself, then retry."
  fi

  mkdir -p "$RUN_DIR"
  pushd "$ROOT/agent" >/dev/null || die "cannot enter agent/"
  "$py" -m app.main >"$AGENT_LOG" 2>&1 &
  spawned=$!
  popd >/dev/null || true

  if ! wait_http "http://127.0.0.1:$AGENT_PORT/health" 30; then
    say "agent     did not answer its local /health within 30s. Last log lines:"
    tail -n 20 "$AGENT_LOG" 2>/dev/null
    kill_tree "$spawned"
    rm -f "$AGENT_PID_FILE"
    return 1
  fi
  pid="$(root_pid "$(port_pid "$AGENT_PORT")")"
  [[ -z "$pid" ]] && pid="$(winpid "$spawned")"
  echo "$pid" >"$AGENT_PID_FILE"
  say "agent     up on :$AGENT_PORT (pid $pid) — log: logs/agent.log"

  # The agent's own /health proves the process booted; the backend seeing a handshake is
  # what proves the link. Worth distinguishing: they fail for totally different reasons.
  local waited=0
  while ((waited < 40)); do
    if curl -s -m 2 "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null | grep -qE '"agentsConnected":[1-9]'; then
      say "agent     handshake complete — the backend can see it"
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  say "agent     running, but no handshake after 20s — check logs/agent.log and DP_BACKEND_URL in agent/.env"
}

stop_one() { # $1 pidfile, $2 label
  local file="$1" label="$2" pid
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  pid="$(cat "$file" 2>/dev/null)"
  if [[ -n "$pid" ]] && proc_alive "$pid"; then
    kill_tree "$pid"
    say "$label   stopped (pid $pid)"
  else
    say "$label   was not running (stale pid file)"
  fi
  rm -f "$file"
}

# Anything still holding our port after the tracked kill is an orphan from an older session.
# Repeated a few times because a watcher can respawn a child between kill and re-check.
sweep_port() { # $1 port, $2 label
  local port="$1" label="$2" pid tries=0
  while ((tries < 4)); do
    pid="$(port_pid "$port")"
    [[ -z "$pid" ]] && return 0
    if ours "$pid"; then
      pid="$(root_pid "$pid")"
      kill_tree "$pid"
      say "$label   released :$port (killed orphan pid $pid and its children)"
    else
      say "$label   :$port held by pid $pid — not ours, left alone"
      return 0
    fi
    sleep 1
    tries=$((tries + 1))
  done
  pid="$(port_pid "$port")"
  [[ -z "$pid" ]] || say "$label   WARNING :$port still held by pid $pid"
}

all_stop() {
  trap - EXIT INT TERM # stopping must never re-enter itself
  say "stopping DeskPilot services…"
  stop_one "$AGENT_PID_FILE" "agent"
  stop_one "$BACKEND_PID_FILE" "backend"
  sleep 1
  sweep_port "$AGENT_PORT" "agent"
  sweep_port "$BACKEND_PORT" "backend"
}

service_status() { # $1 label, $2 pidfile, $3 port
  local label="$1" file="$2" port="$3" pid listener state note pidshow
  pid="$( [[ -f "$file" ]] && cat "$file" 2>/dev/null || true)"
  listener="$(port_pid "$port")"
  if [[ -n "$pid" ]] && proc_alive "$pid"; then state="running"; else state="stopped"; fi
  pidshow="-"
  [[ -n "$pid" ]] && pidshow="pid $pid"

  if [[ -z "$listener" ]]; then
    if [[ "$state" == "running" ]]; then
      note="pid alive, :$port not listening (still booting?)"
    else
      note="port :$port free"
    fi
  else
    note="listening :$port (pid $listener)"
    [[ "$state" == "stopped" ]] && note="$note — ORPHAN, no pid file tracks it; run stop"
  fi
  printf '%-9s %-8s %-11s %s\n' "$label" "$state" "$pidshow" "$note"
}

status() {
  say "DeskPilot — $ROOT"
  service_status backend "$BACKEND_PID_FILE" "$BACKEND_PORT"
  service_status agent "$AGENT_PID_FILE" "$AGENT_PORT"
  say "mobile    runs in the foreground of start (Expo), so it is not tracked here"

  local body up seen
  body="$(curl -s -m 2 "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null)"
  if [[ -n "$body" ]]; then
    up="$(printf '%s' "$body" | grep -o '"uptimeSeconds":[0-9]*' | cut -d: -f2)"
    seen="$(printf '%s' "$body" | grep -o '"agentsConnected":[0-9]*' | cut -d: -f2)"
    [[ -n "$up" ]] && say "" && say "backend uptime $((up / 60))m $((up % 60))s, agents connected: $seen"
  fi
}

start() {
  local mobile=1 dev_client=0 arg
  for arg in "$@"; do
    case "$arg" in
      --no-mobile) mobile=0 ;;
      # The QR is the same app either way; what changes is which binary answers it. Expo Go
      # cannot load a screen that imports a native module it does not contain, so the flag is
      # the difference between "works only in Expo Go" and "works only in the dev build".
      --dev-client) dev_client=1 ;;
      '') ;;
      *) die "unknown option: $arg (use --no-mobile and/or --dev-client)" ;;
    esac
  done

  mkdir -p "$RUN_DIR"
  start_backend || exit 1
  start_agent || exit 1
  say ""

  if ((mobile == 0)); then
    say "backend and agent are up in the background. Stop with: ./scripts/dev.sh stop"
    return 0
  fi

  local expo=(start)
  if ((dev_client == 1)); then
    expo+=(--dev-client)
    say "starting Expo for the development build — open the installed DeskPilot app. Ctrl-C stops all three."
  else
    say "starting Expo in the foreground — scan the QR with Expo Go. Ctrl-C stops all three."
  fi

  trap 'all_stop' EXIT INT TERM
  (cd "$ROOT/mobile" && npx expo "${expo[@]}")
}


# Mint a pairing code from the laptop itself.
#
# The code is only issued to a loopback caller, so this script is the intended way to get one:
# it is proof that the person asking is sitting at the machine.
pair() {
  local port="${DP_BACKEND_PORT:-8787}" body code expires
  body="$(curl -s -m 5 "http://127.0.0.1:$port/pair/code" 2>/dev/null)"
  [[ -z "$body" ]] && die "no answer from the backend on :$port — start it first (./scripts/dev.sh start)"
  printf '%s' "$body" | grep -q 'loopback_only' && die "the backend refused: pairing codes are only issued on the laptop"

  code="$(printf '%s' "$body" | grep -o '"code":"[^"]*"' | cut -d'"' -f4)"
  expires="$(printf '%s' "$body" | grep -o '"expiresAt":"[^"]*"' | cut -d'"' -f4)"
  [[ -z "$code" ]] && die "could not read a code from: $(printf '%s' "$body" | cut -c1-120)"

  say ""
  say "  pairing code   $code"
  say "  expires        $expires   (single use)"
  say ""
  say "  On the phone: PAIR THIS PHONE -> type $code -> Pair"
  say ""
}

# List paired devices from the laptop itself, and revoke them from here too.
#
# Both talk to `/local/*`, which the backend only answers on loopback. That is the point: the
# alternative was pairing a throwaway phone to get a token with which to revoke a stale one,
# which is a workaround that leaves its own junk behind.
#
# The JSON is handled by node rather than grep: `devices.json` is a real file with real names in
# it, and a device name containing a quote should not break the listing.
devices() {
  local port="${DP_BACKEND_PORT:-8787}" show_all="${1:-}"
  node --input-type=module - "$port" "$show_all" <<'JS'
const port = Number(process.argv[2] ?? 8787);
const showAll = process.argv[3] === '-a' || process.argv[3] === '--all';
const base = `http://127.0.0.1:${port}`;

const pad = (value, width) => String(value).padEnd(width);
const ago = (iso) => {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
};

let payload;
try {
  const response = await fetch(`${base}/local/devices`, { signal: AbortSignal.timeout(5000) });
  if (response.status === 403) {
    console.error('refused: this command only works on the laptop itself');
    process.exit(2);
  }
  if (!response.ok) {
    console.error(`HTTP ${response.status} from ${base}/local/devices`);
    process.exit(2);
  }
  payload = await response.json();
} catch {
  console.error(`no answer from ${base} — start the backend first (./scripts/dev.sh start --no-mobile)`);
  process.exit(2);
}

const all = payload.devices ?? [];
const live = all.filter((device) => device.revokedAt === null);
const revoked = all.filter((device) => device.revokedAt !== null);

console.log(`${live.length} live, ${revoked.length} revoked`);
for (const device of live) {
  console.log(`  ${pad(device.name, 18)} ${device.deviceId}  paired ${ago(device.pairedAt)}  seen ${ago(device.lastSeenAt)}`);
}
if (showAll) {
  for (const device of revoked) {
    console.log(`  - ${pad(device.name, 17)} ${device.deviceId}  revoked ${ago(device.revokedAt)}`);
  }
} else if (revoked.length > 0) {
  console.log(`\n  ${revoked.length} revoked records kept as history — ./scripts/dev.sh devices -a to show them`);
}
JS
}

revoke() {
  local port="${DP_BACKEND_PORT:-8787}" target="${1:-}"
  [[ -z "$target" ]] && die "say which device: ./scripts/dev.sh revoke <deviceId> | --stale"
  node --input-type=module - "$port" "$target" <<'JS'
const port = Number(process.argv[2] ?? 8787);
const target = process.argv[3] ?? '';
const base = `http://127.0.0.1:${port}`;

async function list() {
  const response = await fetch(`${base}/local/devices`, { signal: AbortSignal.timeout(5000) });
  if (response.status === 403) {
    console.error('refused: revoking only works on the laptop itself');
    process.exit(2);
  }
  if (!response.ok) {
    console.error(`HTTP ${response.status} from ${base}/local/devices`);
    process.exit(2);
  }
  return (await response.json()).devices ?? [];
}

let devices;
try {
  devices = await list();
} catch {
  console.error(`no answer from ${base} — start the backend first (./scripts/dev.sh start --no-mobile)`);
  process.exit(2);
}

const live = devices.filter((device) => device.revokedAt === null);
let victims = [];

if (target === '--stale') {
  /**
   * A live device is stale when another *live* device with the same name was used more recently.
   * That is what re-pairing the same phone looks like from this side: two rows, one name, one of
   * them dead since before the other was created. Anything else — a second phone you actually
   * own — needs an explicit id, so this command cannot quietly unpair a device you still use.
   */
  const newest = new Map();
  for (const device of live) {
    const seen = Date.parse(device.lastSeenAt ?? device.pairedAt);
    const best = newest.get(device.name);
    if (best === undefined || seen > best.seen) newest.set(device.name, { id: device.deviceId, seen });
  }
  victims = live.filter((device) => newest.get(device.name)?.id !== device.deviceId);
  if (victims.length === 0) {
    console.log('nothing stale: every live device is the newest one with its name');
    process.exit(0);
  }
  console.log('stale — superseded by a newer pairing of the same name:');
  for (const device of victims) console.log(`  ${device.name}  ${device.deviceId}`);
} else {
  const match =
    live.find((device) => device.deviceId === target) ??
    devices.find((device) => device.deviceId === target);
  if (match === undefined) {
    console.error(`no device ${target} — ./scripts/dev.sh devices`);
    process.exit(1);
  }
  if (match.revokedAt !== null) {
    console.log(`${match.name} (${match.deviceId}) was already revoked`);
    process.exit(0);
  }
  victims = [match];
}

for (const device of victims) {
  const response = await fetch(`${base}/local/devices/${device.deviceId}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  });
  console.log(response.ok
    ? `revoked ${device.name} (${device.deviceId})`
    : `FAILED ${device.name}: HTTP ${response.status}`);
}

const after = (await list()).filter((device) => device.revokedAt === null);
console.log(`${after.length} live device${after.length === 1 ? '' : 's'} left`);
if (after.length > 0) {
  console.log("  a revoked phone shows 'pair this device first' until you pair it again");
}
JS
}

usage() {
  cat <<'TXT'
DeskPilot dev supervisor

  ./scripts/dev.sh start [--no-mobile] [--dev-client]
                                         backend + agent in background, Expo in foreground
                                         --dev-client targets the development build
  ./scripts/dev.sh stop                  stop everything and free the ports
  ./scripts/dev.sh status                what is up, on which port, for how long
  ./scripts/dev.sh restart [--no-mobile] [--dev-client]

  ./scripts/dev.sh pair                  pairing code for a new phone (laptop only)
  ./scripts/dev.sh devices [-a]          paired devices, live first (laptop only)
  ./scripts/dev.sh revoke <id|--stale>   revoke one device, or the shadowed duplicates (laptop only)

Ctrl-C during `start` stops all three.
TXT
}

case "${1:-}" in
  start)
    shift || true
    start "$@"
    ;;
  stop) all_stop ;;
  status) status ;;
  restart)
    shift || true
    all_stop
    start "$@"
    ;;
  pair) pair ;;
  devices) devices "${2:-}" ;;
  revoke) revoke "${2:-}" ;;
  *)
    usage
    exit 1
    ;;
esac
