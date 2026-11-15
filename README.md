# DeskPilot

Remote control for a Windows desktop, from an Android phone. See the screen, drive the mouse and
keyboard, talk to it, hand it a sentence and let an AI do the boring part — and know what happened
while you were away.

Personal-use project: one laptop, one phone, no multi-tenant anything. It is built to run on your
own machines and to be read by whoever maintains it.

```
┌────────────┐        HTTPS + device token        ┌────────────┐        WebSocket        ┌────────────┐
│   phone    │ ────────────────────────────────▶  │  backend   │ ◀────────────────────── │   agent    │
│ Expo/RN app│ ◀────────────────────────────────  │  Fastify   │ ──────────────────────▶ │  Python    │
└────────────┘        JSON / JPEG frames           └────────────┘     commands, acks     └────────────┘
                                                     holds API key                          binds 127.0.0.1
```

Three parts, three processes. The **agent** only ever dials out, so the laptop never accepts an
inbound connection from the internet. The **backend** is the only component that holds API keys.
The **phone** holds one credential: a device token.

## What it does

| Area | What you get |
|---|---|
| Live view | on-demand and refresh-loop screenshots, pinch-zoom, tap-to-click at pixel accuracy |
| Input | text as characters (layout-safe), named keys, chords, wheel scrolling |
| Resilience | tasks resume across a dropped socket without replaying a step (on-disk ledger) |
| AI loop | a goal becomes a plan, the plan runs, then a screenshot verifies what happened |
| Risk control | three tiers; change-tier steps pause the run until you approve on the phone |
| Away mode | the laptop reports the window in front; changes become alerts |
| Audit trail | append-only, bounded, acknowledged by watermark rather than edited |
| Lock & kill switch | lock the session remotely; revoke every device in one action (release needs the laptop's keyboard) |
| Voice | speak a task instead of typing it |
| Notifications | alert banners on the phone, with a stored on/off toggle |

## Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 22.x | backend and mobile |
| Python | 3.12 | Windows agent |
| Expo Go (Android) | latest | runs everything except voice/notifications |
| EAS CLI | 16.x | only for the development build (`npm i -g eas-cli`) |
| Tailscale | any | optional; needed to reach the laptop from outside your network |

## Setup

Three components, each with its own dependencies.

**1. Backend**

```bash
cd backend
npm install
cp .env.example .env      # edit if you want AI features
npm run dev               # → http://localhost:8787/health
```

**2. Windows agent**

```bash
cd agent
python -m venv .venv
source .venv/Scripts/activate     # Windows Git Bash
pip install -r requirements.txt
cp .env.example .env              # DP_BACKEND_URL, and DP_AGENT_TOKEN
python -m app.main                # → http://127.0.0.1:8788/health
```

`DP_AGENT_TOKEN` must match the same variable in `backend/.env`. With it unset both sides still
work, but the backend accepts any client that can reach the agent socket — it says so in `/health`
as `auth.agentSocket: "open"`.

**3. Phone**

```bash
cd mobile
npm install
cp .env.example .env      # EXPO_PUBLIC_API_URL = http://<laptop LAN or tailnet IP>:8787
npx expo start            # scan the QR with Expo Go
```

On a phone, `127.0.0.1` is the phone — use the laptop's LAN address (same Wi-Fi) or its Tailscale
`100.x` address.

## One command instead of three terminals

```bash
./scripts/dev.sh start              # backend + agent in the background, Expo in the foreground
./scripts/dev.sh status             # what is up, on which port, for how long
./scripts/dev.sh stop               # stop everything and free the ports
./scripts/dev.sh start --no-mobile  # backend work without Expo
./scripts/dev.sh start --dev-client # Expo aimed at the development build
```

## Terminal CLI (laptop side)

`scripts/deskpilot.cmd` wraps the setup steps and the routes you would otherwise curl:

```bash
./scripts/deskpilot.cmd install     # deps, venv, .env files, generated agent token, LAN address
./scripts/deskpilot.cmd doctor      # check the setup without changing anything
./scripts/deskpilot.cmd install --autostart   # also start backend + agent at login
./scripts/deskpilot.cmd install --remove-autostart
./scripts/deskpilot.cmd start --dev-client
./scripts/deskpilot.cmd status
./scripts/deskpilot.cmd pair [--qr]     # --qr prints a scannable QR and the address to use
./scripts/deskpilot.cmd devices [-a]
./scripts/deskpilot.cmd revoke <id|--stale>
```

`install` only creates what is missing — re-running it is how you check, not how you reset.
Add `scripts/` to PATH once to invoke it as `deskpilot`.

The PowerShell file is deliberately ASCII-only: Windows PowerShell 5.1 reads a BOM-less script as
ANSI, where a single em dash turns into a smart quote and swallows the rest of the file.

## Pairing

The phone needs a token; the laptop is the only place a pairing code can be minted.

```bash
./scripts/dev.sh pair     # prints a six-character code, single use, ~30 minutes
```

Type it into the phone's PAIR card. Codes live in memory, so restarting the backend throws an
unredeemed code away — the safe direction. Manage devices from the laptop:

```bash
./scripts/dev.sh devices          # live devices first, with ids
./scripts/dev.sh devices -a       # include revoked history
./scripts/dev.sh revoke <id>      # revoke one device
./scripts/dev.sh revoke --stale   # revoke live devices shadowed by a newer pairing of the same name
```

## Development build (voice and notifications)

Expo Go contains a fixed set of native modules, and a speech recogniser and notifications are not
in it. Everything else runs in Expo Go; those two need a build of this project:

```bash
cd mobile
npm i -g eas-cli && eas login
npm run build:dev:android         # APK via EAS
npm run start:dev                 # then open the installed app, not Expo Go
```

## Security model, briefly

- Device tokens are random 32-byte values; the laptop stores only their SHA-256.
- Pairing codes are minted **loopback only**, single use, and burn after five wrong guesses.
- `/agent/ws` requires a shared secret (`DP_AGENT_TOKEN`), compared in constant time.
- The agent binds to `127.0.0.1` and never accepts inbound connections.
- Every request except `/health`, `/pair`, `/pair/code`, `/arm` needs a device token; `/local/*`
  answers only on the laptop itself.
- The kill switch revokes every device and suspends every agent; releasing it needs physical
  access to the laptop.

Not covered: TLS between phone and backend (the tailnet encrypts transport), and push
notifications (alerts are local to the phone's own polling).

## Layout

```
backend/   TypeScript + Fastify — auth, AI orchestration, validation, audit
agent/     Python + FastAPI — screen capture, input execution, activity reporting
mobile/    React Native + Expo — UI, voice, approvals, notifications
scripts/   dev.sh supervisor
```

## Status

All planned milestones are built; most are verified on a real phone and laptop. Per-milestone
notes, trade-offs and known gaps are kept privately rather than in this repository.

## Licensing

No license file: this is a personal project, shared as source. Ask before reusing it commercially.
