"""What the laptop is doing — the foreground window, and nothing else.

Milestone 12's audit trail needs a *little* information about the machine: which application is
in front, what its title says, and how long the keyboard has been quiet. That is the whole
inventory. No keystrokes, no typed text, no clipboard, no file contents, no screenshots — an
audit trail that quietly records everything is not an audit trail, it is surveillance.

The one field that can carry content is the window title (a document name, a page title). It is
sent to your own backend over the tailnet and stored there; it is never logged by the agent, and
`docs/roadmap.md` says so where a reader will find it.

All of this goes through Win32 `ctypes`, like `input_control.py`: these are the same few calls
Windows itself makes to draw the taskbar, and they need no dependency that can go missing.
"""

from __future__ import annotations

import ctypes
import time
from ctypes import wintypes
from datetime import datetime, timezone
from typing import Any

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Enough for any sane title; GetWindowTextW truncates rather than failing.
_TITLE_MAX = 512
# The least privilege that can still read a process's image name on modern Windows.
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class _LastInputInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def idle_seconds() -> float | None:
    """Seconds since the last keyboard or mouse input, or `None` if Windows will not say.

    This is what makes "away" checkable rather than assumed: a window title changing while the
    keyboard has been quiet for an hour is a different event from a person typing.
    """
    info = _LastInputInfo(cbSize=ctypes.sizeof(_LastInputInfo), dwTime=0)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return None
    # Both are 32-bit tick counts that wrap every ~49 days; the subtraction is modulo 2^32,
    # so it stays correct across a wrap as long as the idle time itself is short.
    now = kernel32.GetTickCount()
    return ((now - info.dwTime) & 0xFFFFFFFF) / 1000.0


def _process_name(pid: int) -> str:
    """Executable file name behind a pid, e.g. `Code.exe`. Empty when Windows refuses."""
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(_TITLE_MAX)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return ""
        # Name only: a full path contains the Windows username, which is not our business.
        return buffer.value.rsplit("\\", 1)[-1]
    finally:
        kernel32.CloseHandle(handle)


def foreground() -> dict[str, str] | None:
    """The window in front, as `{app, title}`, or `None` when there is nothing to report.

    `None` is real and normal: a locked screen, a secure desktop, or the moment between two
    windows leaving and arriving all produce no foreground window. Reporting that honestly
    keeps "no data" from being confused with "the same window as last time".
    """
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None

    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(max(1, min(length, _TITLE_MAX) + 1))
    user32.GetWindowTextW(hwnd, buffer, len(buffer))

    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

    return {"app": _process_name(pid.value), "title": buffer.value}


class ActivityMonitor:
    """Turns a 3-second poll into "send this" or "nothing worth sending".

    Two reasons to send, deliberately different:

      * **the window changed** — the fact the audit trail exists for;
      * **a periodic sample** — proof the monitor is alive. Without it, "nobody touched the
        laptop" and "the monitor died" look identical from the phone, and the second one is
        the failure you actually want to notice.
    """

    def __init__(self, report_every_s: float) -> None:
        self._report_every_s = report_every_s
        self._last_key: tuple[str, str] | None = None
        self._last_sent_at = 0.0

    def sample(self) -> dict[str, Any] | None:
        current = foreground()
        if current is None:
            return None

        key = (current["app"], current["title"])
        now = time.monotonic()
        changed = key != self._last_key
        due = now - self._last_sent_at >= self._report_every_s
        if not changed and not due:
            return None

        self._last_key = key
        self._last_sent_at = now

        idle = idle_seconds()
        return {
            "app": current["app"],
            "title": current["title"],
            "idleSeconds": None if idle is None else round(idle, 1),
            "changed": changed,
            # The agent's own clock. The backend also stamps its receive time, and the gap
            # between the two is the network delay — which is worth knowing when an alert
            # arrives late.
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
