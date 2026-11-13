# DeskPilot — Windows agent

Screenshot capture, mouse/keyboard execution, local activity monitoring.
**Runs on the Windows machine you want to control.**

Two things run at once: a small HTTP server on loopback (health) and an outbound WebSocket
client that dials the backend. The agent never accepts a connection from the network.

## Setup (one time)

From this `agent/` directory, in Git Bash:

```bash
python -m venv .venv
source .venv/Scripts/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
```

`source .venv/Scripts/activate` activates a virtual environment: a private Python
installation inside `.venv/` so this project's packages never collide with system or
other-project packages. You must activate it in every new terminal (or use
`.venv/Scripts/python.exe` directly).

## Run

Backend first (in another terminal), then:

```bash
python -m app.main
```

Expected — local server, then the outbound connection:

```
12:00:01 INFO    deskpilot.agent: DeskPilot agent 0.1.0
12:00:01 INFO    deskpilot.agent: http     http://127.0.0.1:8788/health
12:00:01 INFO    deskpilot.ws: backend websocket target ws://127.0.0.1:8787/agent/ws (agent id 3f2a…)
12:00:01 INFO    deskpilot.ws: state disconnected -> connecting  (attempt=1)
12:00:01 INFO    deskpilot.ws: handshake ok: backend v1, heartbeat every 10000ms
12:00:01 INFO    deskpilot.ws: state connecting -> connected
12:00:11 INFO    deskpilot.ws: heartbeat ok (rtt 0.4ms)   # only at DP_LOG_LEVEL=debug
```

`DP_LOG_LEVEL=debug` in `.env` shows the heartbeat every interval. At `info` you only see
state changes, which is usually what you want.

## Why the agent dials out

A connection your program *starts* is allowed through every router and firewall on the way.
A connection someone else starts to you is blocked by default. So the agent calls out and
keeps that socket open; the laptop opens no port and needs no port forwarding.

This is also why `DP_BACKEND_URL` is a plain `http://` address. The agent derives
`ws://…/agent/ws` from it — same host, same port, because a WebSocket *is* an HTTP request
that asks to be upgraded.

## Connection states

A network link is not a boolean. `connected: true` would stay true while a half-dead socket
carried nothing, and your click would go nowhere. So:

| State | Meaning | What it does next |
|---|---|---|
| `disconnected` | nothing open, nothing scheduled | start |
| `connecting` | dialling / handshaking | succeed → `connected`, fail → `reconnecting` |
| `connected` | handshake done, heartbeat answered | pong missing → `degraded` |
| `degraded` | socket open, heartbeat unanswered | drop the socket → `reconnecting` |
| `reconnecting` | waiting out a backoff timer | timer done → `connecting` |
| `failed` | backend refused us (version/auth) | **stops.** Retrying cannot help |

An illegal move raises an error instead of being silently allowed — e.g. `degraded` can go
back to `connected` if a late pong arrives, but `failed` cannot go anywhere except
`disconnected`.

Backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s, each with **jitter** (half fixed, half random)
so a restarting backend is not hit by every agent at the same instant. The counter resets
after a successful handshake, so a brief blip does not leave the next attempt waiting 30s.

## Verifying it works

With the backend running, from another terminal:

```bash
# is the agent connected, and how fast is the round trip?
curl http://127.0.0.1:8787/agents
```

```json
{"protocolVersion":1,"heartbeatIntervalMs":10000,"helloTimeoutMs":5000,
 "uptimeSeconds":2796,"startedAt":"2026-11-03T17:09:47.000Z",
 "agents":[{"agentId":"3f2a…","hostname":"laptop","platform":"Windows 11",
            "connectedForMs":12000,"lastSeenAgoMs":300,"lastRttMs":0.5}]}
```

`uptimeSeconds` and `startedAt` are there to answer a question the agent list cannot: did
the backend restart, or am I looking at the same process as before? A restarted backend
reconnects the agent within seconds, so the list alone looks identical either way.

Now stop the backend and watch the agent: `connected -> reconnecting (retry_in=1.0s)`, then
`connecting`, then a failed attempt, then `retry_in=2.0s`, and so on up to 30s. Start the
backend again and it reconnects within one backoff window, resetting the counter.

## Why bind the HTTP server to 127.0.0.1?

`0.0.0.0` would accept connections from any machine that can route here. `127.0.0.1` accepts
only this machine. The agent has no reason to be reachable from anywhere: the backend talks
to it over the socket the agent opened.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DP_HOST` | `127.0.0.1` | HTTP bind address. Keep it loopback. |
| `DP_PORT` | `8788` | HTTP port. |
| `DP_BACKEND_URL` | *(empty)* | Where to dial, e.g. `http://127.0.0.1:8787`. Empty = HTTP only. |
| `DP_HEARTBEAT_INTERVAL_S` | `10` | Ping period. |
| `DP_HEARTBEAT_TIMEOUT_S` | `5` | No pong within this = `degraded`. |
| `DP_BACKOFF_BASE_S` | `1` | First retry delay. Doubles each attempt. |
| `DP_BACKOFF_MAX_S` | `30` | Retry ceiling. |
| `DP_LOG_LEVEL` | `info` | `debug` to see heartbeats. |

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'app'` | running from the wrong directory | run from `agent/`, not from the repo root |
| `ModuleNotFoundError: No module named 'fastapi'` | venv not activated | `source .venv/Scripts/activate` |
| `[Errno 10048] address already in use` | port 8788 taken | stop the old process, or change `DP_PORT` in `.env` |
| `DP_BACKEND_URL is empty — running HTTP only` | `.env` has no backend URL | set it, e.g. `DP_BACKEND_URL=http://127.0.0.1:8787` |
| `connection failed: ConnectionRefusedError` repeating | backend is not running | start the backend; the agent retries with growing delays by design |
| `handshake ... protocol_mismatch` then `state -> failed` | agent and backend disagree on protocol version | update both sides; this is deliberately **not** retried |
| `ValidationError ... port Input should be >= 1024` | an env var named `PORT` is exported by another tool and overrides `.env` | we use `DP_PORT` for exactly this reason — check you copied the current `.env.example` |
