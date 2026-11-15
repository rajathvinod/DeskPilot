"""The laptop's text clipboard.

Small on purpose. `pyperclip` is the whole mechanism: it shells out to the Windows clipboard
and has no state of its own, which is what we want — the clipboard belongs to the desktop, not
to this process, and an agent restart must not lose what the person copied.

Two rules worth stating out loud:

* **A cap, not a truncation.** A photo on the clipboard can be megabytes of text if it is
  pasted as HTML; sending that through a socket would stall every other request behind it. Over
  the cap is refused, so nobody receives half a document and believes it is the whole thing.
* **No history.** Read is a pass-through. Keeping a copy would turn "show me what I copied" into
  a clipboard manager nobody asked for, with its own privacy surface.
"""

from __future__ import annotations

import pyperclip

# Enough for a long email or a file's contents; small enough that one message stays one frame.
MAX_CLIPBOARD_CHARS = 20_000


class ClipboardError(RuntimeError):
    """The clipboard could not be read or written (locked by another process, usually)."""


def read_text() -> str:
    """What is on the clipboard right now, as text. Empty string when it holds no text."""
    try:
        value = pyperclip.paste()
    except Exception as exc:  # noqa: BLE001 - pyperclip raises several types per platform
        raise ClipboardError(f"could not read the clipboard: {exc}") from exc
    return value if isinstance(value, str) else ""


def write_text(text: str) -> int:
    """Replace the clipboard with `text`. Returns how many characters were written."""
    if len(text) > MAX_CLIPBOARD_CHARS:
        raise ClipboardError(
            f"clipboard text is {len(text)} characters; the limit is {MAX_CLIPBOARD_CHARS}"
        )
    try:
        pyperclip.copy(text)
    except Exception as exc:  # noqa: BLE001
        raise ClipboardError(f"could not write the clipboard: {exc}") from exc
    return len(text)
