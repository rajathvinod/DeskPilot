# DeskPilot — mobile app (Android)

Expo + React Native + TypeScript, routed with Expo Router. **You will never type an API key in
this folder** — anything in the bundle can be extracted.

## Setup (one time)

```bash
npm install
cp .env.example .env
```

## Run

```bash
npx expo start
```

Then install **Expo Go** from the Play Store and scan the QR code in the terminal.
Phone and laptop must be on the same network for the QR scan (or use
`npx expo start --tunnel` if your network blocks it).

## Where things live

```
src/app/            routes (file = screen). _layout.tsx = navigators
src/constants/       design tokens (colors, spacing)
```

## Environment variables

Only `EXPO_PUBLIC_*` variables reach the app, and they are **inlined into the bundle**:
anyone can read them. That is why `EXPO_PUBLIC_API_URL` is fine and
`OPENAI_API_KEY` never will be.

## Milestone 1 screen

The home screen shows the configured backend URL and a **Check backend** button that calls
`GET /health` with a 5 second timeout.

- `127.0.0.1` only works on the phone itself (or on web).
- For a real phone, put your laptop's LAN IP in `.env`, e.g. `http://192.168.1.42:8787`, and
  set `DP_HOST=0.0.0.0` in `backend/.env` **only while testing on your own network**.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `Unable to resolve module` | dependency missing | `npm install` |
| QR scans but app is stuck on "Bundling" | phone can't reach the Metro port | use `--tunnel`, or check firewall allows ports 8081 |
| *Check backend* → "Network request failed" | backend not running, wrong IP, or firewall | curl the URL from the laptop first |
| *Check backend* → "Timed out after 5s" | reachable address but no response | confirm `DP_PORT` matches the URL |
