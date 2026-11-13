"""Turn a normalised tap into a real mouse event on Windows.

The phone never sends pixels. It sends a fraction of the screen (0..1), and this module maps
that onto whatever resolution the desktop happens to have. Two reasons:

  * the phone does not need to know the resolution, so nothing breaks when you change it;
  * the agent stays the single owner of geometry — one place converts, one place can be wrong.

Windows calls are made through `ctypes` (the standard library) rather than a mouse library:
it is three function calls, they are stable since Windows 2000, and a dependency would be a
third-party wrapper around the same three calls.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import logging
import time
from typing import Any

import mss

log = logging.getLogger("deskpilot.input")

# Mouse event flags. "LEFTDOWN then LEFTUP" is a complete click; some applications ignore a
# press that lasts 0 ms, hence the small sleep between them.
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_WHEEL = 0x0800

# One "notch" of a mouse wheel, as Windows defines it. A scroll of +120 is one notch up.
WHEEL_DELTA = 120

# Keyboard events go through SendInput rather than keybd_event, because SendInput can carry
# a Unicode character directly instead of guessing which key produces it on the active
# keyboard layout. That is what makes "type this text" work for any language.
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

try:  # importing this module on a non-Windows machine should still be possible
    _user32: Any = ctypes.WinDLL("user32", use_last_error=True)
except AttributeError:  # pragma: no cover - only reachable off Windows
    _user32 = None


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.wintypes.LONG),
        ("dy", ctypes.wintypes.LONG),
        ("mouseData", ctypes.wintypes.DWORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.wintypes.WORD),
        ("wScan", ctypes.wintypes.WORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", ctypes.wintypes.DWORD), ("u", _INPUTUNION)]


# Named keys, so the phone sends "enter" instead of making the caller know VK codes.
KEY_CODES: dict[str, int] = {
    "enter": 0x0D,
    "tab": 0x09,
    "escape": 0x1B,
    "backspace": 0x08,
    "delete": 0x2E,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "space": 0x20,
}


def ensure_dpi_aware() -> None:
    """Ask Windows for true pixels instead of scaled ones. Call once, at startup.

    This is the least obvious bug in the whole milestone. On a display scaled to 125%, a
    process that never declares itself DPI-aware is told the screen is ~1536x864 when it is
    really 1920x1080. Captures then come out smaller, and — worse — a click computed from the
    "right" coordinate lands somewhere else entirely, because Windows quietly scales it a
    second time.

    `SetProcessDpiAwareness(2)` means per-monitor aware. The older `SetProcessDPIAware()` is
    the fallback for Windows versions that lack the newer API.
    """
    if _user32 is None:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001 - any failure here falls back, never aborts startup
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            log.warning("could not enable DPI awareness; coordinates may be scaled")


def primary_screen_size() -> tuple[int, int]:
    """Physical size of the primary monitor, in pixels."""
    with mss.mss() as recorder:
        box = recorder.monitors[1]
        return int(box["width"]), int(box["height"])


def to_pixels(x: float, y: float) -> tuple[int, int]:
    """Map a 0..1 point onto the desktop's pixel grid.

    `-1` because 1.0 means "the last pixel", not "one past the edge": on a 1920-wide screen
    that is 1919, which is a valid coordinate, while 1920 is off-screen.
    """
    width, height = primary_screen_size()
    return (
        max(0, min(width - 1, round(x * (width - 1)))),
        max(0, min(height - 1, round(y * (height - 1)))),
    )


def _key_input(vk: int = 0, scan: int = 0, flags: int = 0) -> _INPUT:
    """One keyboard event. `vk` for named keys, `scan` for a Unicode code unit."""
    event = _INPUT()
    event.type = INPUT_KEYBOARD
    event.ki = _KEYBDINPUT(vk, scan, flags, 0, None)
    return event


def _send_inputs(events: list[_INPUT]) -> None:
    """Hand a batch of events to Windows in one call.

    Batching matters for more than speed: events sent in one `SendInput` call cannot be
    interleaved with other applications' keystrokes, so a word arrives as a word rather
    than as characters racing someone else's typing.
    """
    if _user32 is None:
        raise RuntimeError("keyboard control is only implemented on Windows")
    if not events:
        return

    batch = (_INPUT * len(events))(*events)
    sent = _user32.SendInput(len(events), batch, ctypes.sizeof(_INPUT))
    if sent != len(events):
        raise OSError(ctypes.get_last_error(), f"SendInput accepted {sent} of {len(events)} events")


def type_text(text: str) -> int:
    """Type text into whatever window has focus, as if it came from the keyboard.

    Each character is sent as a Unicode scan code, so it does not matter which keyboard layout
    is active: `é`, `ж` and `漢` arrive as themselves instead of as the letters that happen to
    share their key. Newlines become a real Enter press, because pasting text into a
    multi-line program is not the same as entering it.
    """
    if _user32 is None:
        raise RuntimeError("keyboard control is only implemented on Windows")

    events: list[_INPUT] = []
    for char in text:
        if char == "\r":
            continue
        if char == "\n":
            events.append(_key_input(vk=0x0D))
            events.append(_key_input(vk=0x0D, flags=KEYEVENTF_KEYUP))
            continue

        code = ord(char)
        if code > 0xFFFF:
            # Windows keys are UTF-16: a character above U+FFFF is sent as a surrogate pair.
            code -= 0x10000
            units = (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF))
        else:
            units = (code,)

        for unit in units:
            events.append(_key_input(scan=unit, flags=KEYEVENTF_UNICODE))
            events.append(_key_input(scan=unit, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))

    # 200 events is 100 characters: small enough that a long paste cannot delay the socket's
    # heartbeat for long, large enough that the round trip count stays sane.
    for start in range(0, len(events), 200):
        _send_inputs(events[start : start + 200])
    return len(text)


def press_key(name: str) -> None:
    """Press and release one named key, e.g. `enter` or `tab`."""
    vk = KEY_CODES.get(name.lower())
    if vk is None:
        raise ValueError(f"unsupported key {name!r}")
    _send_inputs([_key_input(vk=vk), _key_input(vk=vk, flags=KEYEVENTF_KEYUP)])


def scroll(notches: int) -> int:
    """Scroll the window under the cursor. Positive is up, one step is one wheel notch."""
    if _user32 is None:
        raise RuntimeError("scroll is only implemented on Windows")
    if not isinstance(notches, int):
        raise ValueError("notches must be an integer")
    if notches == 0:
        return 0

    # `mouse_event` wants the distance in wheel units and lets a negative value mean "down".
    _user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, notches * WHEEL_DELTA, 0)
    return notches


def click_normalized(x: float, y: float, button: str = "left") -> dict[str, int]:
    """Move the cursor to a normalised point, then click there.

    `button="none"` moves without clicking. That is not a test escape hatch: dragging and
    hovering both need "move, then act separately", and it makes the coordinate mapping
    verifiable without clicking something on your desktop.
    """
    if _user32 is None:
        raise RuntimeError("mouse control is only implemented on Windows")

    pixel_x, pixel_y = to_pixels(x, y)
    if not _user32.SetCursorPos(pixel_x, pixel_y):
        raise OSError(ctypes.get_last_error(), f"SetCursorPos({pixel_x}, {pixel_y}) failed")

    if button == "none":
        return {"screenX": pixel_x, "screenY": pixel_y}
    if button != "left":
        raise ValueError(f"unsupported button {button!r}")

    # `mouse_event` is the older sibling of SendInput. It is still supported everywhere we
    # care about, needs no struct packing, and is honest about being a legacy call.
    _user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.01)
    _user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    return {"screenX": pixel_x, "screenY": pixel_y}


def lock_workstation() -> None:
    """Lock the Windows session — the same thing Win+L does.

    Deliberately not "log out" and not "shut down": locking is undone by the person at the
    keyboard in two seconds and leaves every open program exactly where it was. A remote
    command that can sign you out is one mistake away from losing unsaved work, and the point
    of this milestone is taking control away, not destroying anything.

    `LockWorkStation` reports refusal by returning zero rather than raising, so the failure is
    turned into an exception here, where the caller can answer the phone with it.
    """
    if _user32 is None:
        raise RuntimeError("locking is only implemented on Windows")
    if not _user32.LockWorkStation():
        raise OSError(ctypes.get_last_error(), "LockWorkStation refused")
