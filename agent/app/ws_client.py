"""Outbound WebSocket client: the agent dials the backend and keeps one socket open.

Why outbound, in one sentence: a connection your program *starts* is allowed through
every router and firewall on the way, while a connection someone else starts to you is
blocked by default. So the agent calls out, and the laptop never opens a port.

Everything interesting in this file is the state machine. A network link is not a boolean:
"connected" can mean "healthy", "open but silent", or "we think it is open but nothing gets
through". Naming those states is what makes the reconnection logic readable instead of a
pile of `if`s.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import platform
import random
import socket
import time
import uuid
from enum import Enum
from typing import Any
from urllib.parse import urlparse, urlunparse

import websockets
from websockets.asyncio.client import ClientConnection

from app import __version__
from app.activity import ActivityMonitor
from app.config import Settings
from app.input_control import (
    KEY_CODES,
    click_normalized,
    lock_workstation,
    press_key,
    primary_screen_size,
    scroll,
    type_text,
)
from app.screen import DEFAULT_MAX_WIDTH, DEFAULT_QUALITY, capture_jpeg, list_monitors
from app.step_ledger import StepLedger

log = logging.getLogger("deskpilot.ws")

PROTOCOL_VERSION = 1


class ConnectionState(str, Enum):
    """The named states. Nothing else is allowed to be `self.state`."""

    DISCONNECTED = "disconnected"   # nothing is open, nothing is scheduled
    CONNECTING = "connecting"       # dialling / handshaking, no service yet
    CONNECTED = "connected"         # handshake done, heartbeat answered on schedule
    DEGRADED = "degraded"           # socket open, heartbeat unanswered — do not trust it
    RECONNECTING = "reconnecting"   # intentionally waiting out a backoff timer
    FAILED = "failed"               # the backend refused us; retrying will not help


# The legal moves. Anything not listed is a bug, and `_transition` raises on it. Writing
# the table down is most of the design work: it forces every "how did we get here?" case.
ALLOWED_TRANSITIONS: dict[ConnectionState, frozenset[ConnectionState]] = {
    ConnectionState.DISCONNECTED: frozenset({ConnectionState.CONNECTING}),
    ConnectionState.CONNECTING: frozenset(
        {ConnectionState.CONNECTED, ConnectionState.RECONNECTING, ConnectionState.FAILED}
    ),
    ConnectionState.CONNECTED: frozenset(
        {ConnectionState.DEGRADED, ConnectionState.RECONNECTING, ConnectionState.DISCONNECTED}
    ),
    ConnectionState.DEGRADED: frozenset(
        {ConnectionState.CONNECTED, ConnectionState.RECONNECTING, ConnectionState.DISCONNECTED}
    ),
    ConnectionState.RECONNECTING: frozenset({ConnectionState.CONNECTING, ConnectionState.DISCONNECTED}),
    ConnectionState.FAILED: frozenset({ConnectionState.DISCONNECTED}),
}


class ProtocolError(Exception):
    """The backend said something we cannot work with. Retrying will not fix it."""


def derive_ws_url(backend_url: str, path: str = "/agent/ws") -> str:
    """Turn `http://host:8787` into `ws://host:8787/agent/ws`.

    Same host, same port — only the scheme changes, because a WebSocket *is* an HTTP
    request that asks to be upgraded. A missing scheme is treated as http.
    """
    raw = backend_url.strip().rstrip("/")
    if raw == "":
        raise ValueError("DP_BACKEND_URL is empty")
    if "://" not in raw:
        raw = f"http://{raw}"

    parsed = urlparse(raw)
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme)
    if scheme is None:
        raise ValueError(f"DP_BACKEND_URL must start with http:// or https://, got {backend_url!r}")

    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


def backoff_delay(attempt: int, *, base: float, cap: float) -> float:
    """Exponential backoff with "equal jitter".

    attempt 1 -> about base, 2 -> about 2x, 3 -> about 4x ... capped.
    Half the delay is fixed and half is random. The fixed half stops us from hammering a
    backend that is down; the random half stops a thousand agents reconnecting in lockstep
    the moment it comes back up.
    """
    if attempt < 1:
        raise ValueError("attempt is 1-based")
    ceiling = min(cap, base * (2 ** (attempt - 1)))
    return round(ceiling / 2 + random.uniform(0, ceiling / 2), 2)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _unit(value: Any) -> float | None:
    """Read a 0..1 fraction off the wire, or `None` if it is not a number.

    Clamped rather than rejected: a tap at the very edge of a scaled image can compute to
    1.0000001, and refusing that would be a worse bug than rounding it.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return min(1.0, max(0.0, float(value)))


def _bounded_int(value: Any, fallback: int, ceiling: int) -> int:
    """Read an integer off the wire without trusting it.

    `bool` is excluded explicitly: in Python `True` is an int, and a `quality: true` from a
    confused peer should fall back rather than mean "1".
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if value <= 0:
        return fallback
    return min(int(value), ceiling)


def _envelope(type_: str, payload: dict[str, Any]) -> str:
    return json.dumps({"type": type_, "id": str(uuid.uuid4()), "payload": payload})


class AgentConnection:
    """Owns exactly one socket at a time, plus the timer that decides the next attempt."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state = ConnectionState.DISCONNECTED
        self.attempt = 0
        self.last_rtt_ms: float | None = None
        self._pong = asyncio.Event()
        self._stopping = False
        # The kill switch. When engaged, everything that moves or looks at the desktop is
        # refused — not just "no tokens are valid right now", because a token can be stolen.
        self._suspended = False
        # Remembers which steps already ran, so a backend retry after a dropped socket cannot
        # click or type the same step twice.
        self.ledger = StepLedger()

        # Temporary identity: derived from the hostname so it is stable across restarts
        # (the backend uses it to replace a stale connection from the same machine).
        # Phase 11 replaces this with a real paired device identity.
        self.agent_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, socket.gethostname()))

    # ------------------------------------------------------------------ state machine

    def _transition(self, new_state: ConnectionState, **fields: object) -> None:
        if new_state is self.state:
            return
        if new_state not in ALLOWED_TRANSITIONS[self.state]:
            raise RuntimeError(f"illegal state transition {self.state.value} -> {new_state.value}")

        detail = " ".join(f"{key}={value}" for key, value in fields.items())
        log.info("state %s -> %s%s", self.state.value, new_state.value, f"  ({detail})" if detail else "")
        self.state = new_state

    def stop(self) -> None:
        """Ask run_forever() to exit after its current attempt."""
        self._stopping = True

    # ---------------------------------------------------------------------- main loop

    async def run_forever(self) -> None:
        try:
            url = derive_ws_url(self.settings.backend_url)
        except ValueError as exc:
            log.error("cannot connect: %s", exc)
            self._transition(ConnectionState.FAILED, reason=str(exc))
            return

        log.info("backend websocket target %s (agent id %s)", url, self.agent_id)

        while not self._stopping:
            self._transition(ConnectionState.CONNECTING, attempt=self.attempt + 1)
            try:
                await self._connect_and_serve(url)
                log.info("socket closed by the backend")
            except asyncio.CancelledError:
                raise
            except ProtocolError as exc:
                # Not a network problem: the backend does not want us. Retrying is noise.
                self._transition(ConnectionState.FAILED, reason=str(exc))
                return
            except Exception as exc:  # noqa: BLE001 - any socket failure leads to the same retry
                log.warning("connection failed: %s: %s", type(exc).__name__, exc)

            if self._stopping:
                break

            self.attempt += 1
            delay = backoff_delay(
                self.attempt,
                base=self.settings.backoff_base_s,
                cap=self.settings.backoff_max_s,
            )
            self._transition(
                ConnectionState.RECONNECTING,
                attempt=self.attempt,
                retry_in=f"{delay}s",
            )
            await asyncio.sleep(delay)

        self._transition(ConnectionState.DISCONNECTED, reason="stopped")

    async def _connect_and_serve(self, url: str) -> None:
        """One attempt: dial, handshake, then serve until the socket dies."""
        # The agent's credential is a shared secret in `.env`, not a device token: it proves
        # "this is the process the laptop launched", which is the one thing the backend cannot
        # infer from the fact that someone dialled in.
        headers = (
            {"X-Agent-Token": self.settings.agent_token} if self.settings.agent_token else {}
        )
        if not headers:
            log.debug("DP_AGENT_TOKEN is empty: connecting without an agent token")

        async with websockets.connect(
            url,
            additional_headers=headers,
            open_timeout=self.settings.connect_timeout_s,
            close_timeout=5,
            # We do our own application-level heartbeat below. Protocol-level pings would be
            # a second, invisible mechanism doing almost the same job — one is easier to
            # reason about and to see in the logs.
            ping_interval=None,
            max_size=1_000_000,
        ) as ws:
            await self._handshake(ws)
            # A completed handshake means the *path* works, so the next failure starts its
            # wait from one second again instead of resuming the old long delay.
            self.attempt = 0
            self._transition(ConnectionState.CONNECTED)
            await self._session(ws)

    async def _handshake(self, ws: ClientConnection) -> None:
        payload: dict[str, Any] = {
            "agentId": self.agent_id,
            "hostname": socket.gethostname(),
            "platform": f"{platform.system()} {platform.release()}",
            "version": __version__,
            "protocolVersion": PROTOCOL_VERSION,
        }

        # Advertised once, not per frame: the desktop's size changes only when someone changes
        # a display setting, and it is what lets the phone map a tap without knowing it.
        try:
            width, height = primary_screen_size()
            payload["screen"] = {"width": width, "height": height}
        except Exception:  # noqa: BLE001 - a missing size must not block the handshake
            log.warning("could not read the screen size at handshake", exc_info=True)

        try:
            # Sent with the handshake so the phone can offer a picker before it asks for a
            # frame: a list that only arrived with the first capture would make the choice
            # impossible on the screen where it is needed.
            payload["monitors"] = list_monitors()
        except Exception:  # noqa: BLE001 - a machine without a readable display is still an agent
            payload["monitors"] = []

        await ws.send(_envelope("hello", payload))

        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=self.settings.connect_timeout_s)
        except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed) as exc:
            raise ProtocolError("no hello.ack from backend") from exc

        message = json.loads(raw)
        type_ = message.get("type")
        payload = message.get("payload") or {}

        if type_ == "error":
            raise ProtocolError(f"backend rejected handshake: {payload.get('code')} {payload.get('message')}")
        if type_ != "hello.ack":
            raise ProtocolError(f"expected hello.ack, got {type_!r}")

        remote_version = payload.get("protocolVersion")
        if remote_version != PROTOCOL_VERSION:
            raise ProtocolError(f"protocol mismatch: agent v{PROTOCOL_VERSION}, backend v{remote_version}")

        # The backend mirrors the kill switch in every handshake, so an agent that restarts
        # while the laptop is "killed" comes back refusing input instead of trusting memory.
        self._suspended = payload.get("suspended") is True
        if self._suspended:
            log.warning("kill switch engaged: input and frames are refused until the laptop re-arms")

        log.info(
            "handshake ok: backend v%s, heartbeat every %sms",
            remote_version,
            payload.get("heartbeatIntervalMs"),
        )

    async def _session(self, ws: ClientConnection) -> None:
        """Read frames until the socket closes, with the heartbeat running alongside."""
        heartbeat = asyncio.create_task(self._heartbeat(ws), name="heartbeat")
        # Milestone 12: what is in front of the laptop travels on its own timer, so the audit
        # trail keeps filling while nobody is watching this socket.
        activity = asyncio.create_task(self._activity(ws), name="activity")
        try:
            async for raw in ws:
                await self._handle(ws, raw)
        finally:
            # Both tasks are cancelled together: a socket that died must not leave a reporter
            # quietly sampling the desktop and pushing into a closed pipe.
            for task in (heartbeat, activity):
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _handle(self, ws: ClientConnection, raw: str | bytes) -> None:
        if isinstance(raw, (bytes, bytearray)):
            # The backend sends no pixels in this direction today. If it ever does (a cursor
            # overlay, say), this is where they land.
            log.debug("ignoring %d-byte binary frame from backend", len(raw))
            return

        try:
            message = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            log.warning("ignoring non-JSON frame from backend")
            return

        type_ = message.get("type")
        payload = message.get("payload") or {}

        # A killed laptop accepts nothing but its own release. Checked before dispatch, not
        # inside each handler, so a message type added later cannot quietly bypass the switch.
        if self._suspended and type_ not in {"pong", "system.resume", "system.suspend"}:
            await ws.send(
                _envelope(
                    "error",
                    {
                        "code": "suspended",
                        "message": "the kill switch is engaged; re-arm it on the laptop",
                    },
                )
            )
            return

        if type_ == "pong":
            sent_at = payload.get("sentAt")
            if isinstance(sent_at, (int, float)):
                self.last_rtt_ms = round(_now_ms() - sent_at, 1)
            self._pong.set()
            if self.state is ConnectionState.DEGRADED:
                self._transition(ConnectionState.CONNECTED, note="heartbeat answered again")
        elif type_ == "system.lock":
            await self._lock(ws, message.get("id"))
        elif type_ == "system.suspend":
            self._suspended = True
            log.warning("kill switch engaged by the backend: input and frames are refused")
            await self._system_ack(ws, message.get("id"), "suspend")
        elif type_ == "system.resume":
            self._suspended = False
            log.info("kill switch released: control is available again")
            await self._system_ack(ws, message.get("id"), "resume")
        elif type_ == "screen.request":
            await self._send_screen(ws, payload)
        elif type_ == "input.click":
            await self._click(ws, message.get("id"), payload)
        elif type_ == "input.text":
            await self._text(ws, message.get("id"), payload)
        elif type_ == "input.key":
            await self._key(ws, message.get("id"), payload)
        elif type_ == "input.scroll":
            await self._scroll(ws, message.get("id"), payload)
        elif type_ == "error":
            log.error("backend reported %s: %s", payload.get("code"), payload.get("message"))
        else:
            log.debug("ignoring message type %s", type_)

    async def _lock(self, ws: ClientConnection, envelope_id: Any) -> None:
        """Lock the session on request, and answer either way.

        Locking the real desktop is the one action here with an obvious, immediate effect on the
        person sitting at the machine, so it is acknowledged like a click rather than assumed:
        the phone shows what happened, not what was attempted.
        """
        try:
            await asyncio.to_thread(lock_workstation)
        except Exception as exc:  # noqa: BLE001 - any failure is an answer for the backend
            log.exception("lock failed")
            await ws.send(_envelope("error", {"code": "lock_failed", "message": str(exc)}))
            return

        log.warning("workstation locked on request")
        await self._system_ack(ws, envelope_id, "lock")

    async def _system_ack(self, ws: ClientConnection, envelope_id: Any, action: str) -> None:
        """A system action finished. Separate from `input.ack` so the logs stay readable."""
        await ws.send(
            _envelope("system.ack", {"for": envelope_id or "", "ok": True, "action": action})
        )

    async def _click(self, ws: ClientConnection, envelope_id: Any, payload: dict[str, Any]) -> None:
        """Move the cursor and click at a normalised point.

        The acknowledgement echoes the request's envelope id, because unlike a screenshot there
        is no ambiguity here: the backend may have several clicks in flight, and each reply must
        be matched to the request that caused it.
        """
        replay = self._replay(payload, envelope_id)
        if replay is not None:
            await ws.send(_envelope("input.ack", replay))
            return

        x = _unit(payload.get("x"))
        y = _unit(payload.get("y"))
        button = payload.get("button") if isinstance(payload.get("button"), str) else "left"

        if x is None or y is None:
            await ws.send(
                _envelope(
                    "error",
                    {"code": "bad_click", "message": "x and y must be numbers between 0 and 1"},
                )
            )
            return

        # Which display the click was aimed at. Absent means primary, which is what an older
        # backend sends and what a single-monitor laptop always means.
        monitor = payload.get("monitor")
        monitor = monitor if isinstance(monitor, int) and monitor >= 1 else 1

        try:
            # A Win32 call blocks for a moment; keep it off the event loop like the capture.
            at = await asyncio.to_thread(click_normalized, x, y, button, monitor)
        except Exception as exc:  # noqa: BLE001 - any failure is an answer for the backend
            log.exception("click failed")
            await ws.send(_envelope("error", {"code": "click_failed", "message": str(exc)}))
            return

        log.info(
            "click %s at (%.3f, %.3f) -> (%d, %d)",
            button,
            x,
            y,
            at["screenX"],
            at["screenY"],
        )
        self._remember(payload, dict(at))
        await ws.send(
            _envelope("input.ack", {"for": envelope_id or "", **at})
        )

    async def _text(self, ws: ClientConnection, envelope_id: Any, payload: dict[str, Any]) -> None:
        """Type text into the focused window.

        The text is sent exactly as given — no key-by-key translation on this side, because
        the agent has no idea which keyboard layout the user has. `KEVENTF_UNICODE` handles
        that in Windows itself.
        """
        replay = self._replay(payload, envelope_id)
        if replay is not None:
            await ws.send(_envelope("input.ack", replay))
            return

        text = payload.get("text")
        if not isinstance(text, str) or text == "":
            await ws.send(
                _envelope("error", {"code": "bad_text", "message": "text must be a non-empty string"})
            )
            return

        try:
            typed = await asyncio.to_thread(type_text, text)
        except Exception as exc:  # noqa: BLE001 - any failure is an answer for the backend
            log.exception("typing failed")
            await ws.send(_envelope("error", {"code": "text_failed", "message": str(exc)}))
            return

        log.info("typed %d characters", typed)
        ack = {"ok": True, "typed": typed}
        self._remember(payload, ack)
        await ws.send(_envelope("input.ack", {"for": envelope_id or "", **ack}))

    async def _key(self, ws: ClientConnection, envelope_id: Any, payload: dict[str, Any]) -> None:
        """Press one named key. The name is checked against a fixed list, never passed through."""
        replay = self._replay(payload, envelope_id)
        if replay is not None:
            await ws.send(_envelope("input.ack", replay))
            return

        name = payload.get("key")
        if not isinstance(name, str) or name.lower() not in KEY_CODES:
            await ws.send(
                _envelope(
                    "error",
                    {"code": "bad_key", "message": f"key must be one of {sorted(KEY_CODES)}"},
                )
            )
            return

        try:
            await asyncio.to_thread(press_key, name)
        except Exception as exc:  # noqa: BLE001
            log.exception("key press failed")
            await ws.send(_envelope("error", {"code": "key_failed", "message": str(exc)}))
            return

        log.info("pressed %s", name)
        ack = {"ok": True}
        self._remember(payload, ack)
        await ws.send(_envelope("input.ack", {"for": envelope_id or "", **ack}))

    async def _scroll(self, ws: ClientConnection, envelope_id: Any, payload: dict[str, Any]) -> None:
        """Scroll the window under the cursor by whole wheel notches."""
        replay = self._replay(payload, envelope_id)
        if replay is not None:
            await ws.send(_envelope("input.ack", replay))
            return

        delta = payload.get("delta")
        if isinstance(delta, bool) or not isinstance(delta, int) or not -10 <= delta <= 10:
            await ws.send(
                _envelope(
                    "error",
                    {"code": "bad_scroll", "message": "delta must be an integer between -10 and 10"},
                )
            )
            return

        try:
            await asyncio.to_thread(scroll, delta)
        except Exception as exc:  # noqa: BLE001
            log.exception("scroll failed")
            await ws.send(_envelope("error", {"code": "scroll_failed", "message": str(exc)}))
            return

        ack = {"ok": True}
        self._remember(payload, ack)
        await ws.send(_envelope("input.ack", {"for": envelope_id or "", **ack}))

    def _replay(self, payload: dict[str, Any], envelope_id: Any) -> dict[str, Any] | None:
        """If this step already ran, the answer it already gave. Otherwise `None`.

        Returning the old answer (rather than doing the work again) is what turns a retry into
        a no-op. The envelope id is refreshed because the duplicate arrived in a new envelope,
        while `replayed` makes the reuse visible in the logs.
        """
        step_id = payload.get("stepId")
        if not isinstance(step_id, str) or step_id == "":
            return None

        cached = self.ledger.lookup(step_id)
        if cached is None:
            return None

        log.info("step %s already executed, replaying its answer", step_id)
        return {"for": envelope_id or "", "replayed": True, **cached}

    def _remember(self, payload: dict[str, Any], ack: dict[str, Any]) -> None:
        step_id = payload.get("stepId")
        if isinstance(step_id, str) and step_id != "":
            self.ledger.remember(step_id, ack)

    async def _send_screen(self, ws: ClientConnection, payload: dict[str, Any]) -> None:
        """Capture one frame and answer with raw JPEG bytes.

        Binary, not JSON: base64 would inflate the payload by a third to protect a format
        that is already compact. The envelope exists for *control* messages; pixels speak for
        themselves, and the request/reply pairing is guaranteed by the backend allowing only
        one outstanding request per agent.
        """
        max_width = _bounded_int(payload.get("maxWidth"), DEFAULT_MAX_WIDTH, 4096)
        quality = _bounded_int(payload.get("quality"), DEFAULT_QUALITY, 100)
        monitor = payload.get("monitor")
        monitor = monitor if isinstance(monitor, int) and monitor >= 1 else 1

        try:
            # Reading the desktop blocks inside the OS call. In a thread, the heartbeat keeps
            # running and the socket cannot look dead while a frame is being encoded.
            frame = await asyncio.to_thread(capture_jpeg, max_width, quality, monitor)
        except Exception as exc:  # noqa: BLE001 - any capture failure is an answer for the backend
            log.exception("screen capture failed")
            await ws.send(_envelope("error", {"code": "capture_failed", "message": str(exc)}))
            return

        await ws.send(frame.jpeg)
        log.info(
            "frame sent %dx%d %.0f KB (capture %.0fms, encode %.0fms)",
            frame.width,
            frame.height,
            len(frame.jpeg) / 1024,
            frame.capture_ms,
            frame.encode_ms,
        )

    async def _activity(self, ws: ClientConnection) -> None:
        """Report the foreground window when it changes, and once a minute when it does not.

        The Win32 probe runs in a thread like every other OS call here. It is cheap, but
        "cheap" is not the same as "cannot block": the event loop also carries the heartbeat,
        and a heartbeat delayed by a stuck call would make a healthy agent look dead.
        """
        monitor = ActivityMonitor(self.settings.activity_report_s)

        while True:
            await asyncio.sleep(self.settings.activity_interval_s)

            try:
                sample = await asyncio.to_thread(monitor.sample)
            except Exception:  # noqa: BLE001 - a failed probe is not a failed connection
                log.warning("activity sample failed", exc_info=True)
                continue

            if sample is None:
                continue

            await ws.send(_envelope("activity", sample))
            if sample.get("changed"):
                log.info("activity %s: %s", sample.get("app"), sample.get("title"))

    async def _heartbeat(self, ws: ClientConnection) -> None:
        """Send a ping on a timer; a ping nobody answers is the definition of degraded."""
        interval = self.settings.heartbeat_interval_s
        timeout = self.settings.heartbeat_timeout_s

        while True:
            await asyncio.sleep(interval)

            self._pong.clear()
            await ws.send(_envelope("ping", {"sentAt": _now_ms()}))

            try:
                await asyncio.wait_for(self._pong.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                self._transition(ConnectionState.DEGRADED, waited_for_pong=f"{timeout}s")
                # Do not sit on a socket that lies. Close it and let the loop reconnect —
                # this is the transition that a `connected: true` flag could not express.
                await ws.close(code=4002, reason="heartbeat timeout")
                return

            log.debug("heartbeat ok (rtt %.1fms)", self.last_rtt_ms if self.last_rtt_ms is not None else -1)
