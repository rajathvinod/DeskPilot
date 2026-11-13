"""Capture one frame of the Windows desktop as JPEG.

Three deliberate choices:

  * `mss` reads the screen through the OS graphics API. It is the fastest portable option and
    needs no window manager, no file on disk and no re-reading of a screenshot.
  * Pillow does the JPEG encoding. mss hands back raw pixels; something has to turn them into
    a format the phone can decode.
  * The image is downscaled and re-encoded rather than sent at native size. A 1920x1080 frame
    as PNG is several megabytes; this is ~150 KB, and the phone is looking at a ~1080-wide
    screen anyway.

This module is synchronous on purpose: the OS calls block. `ws_client` runs it in a worker
thread so the WebSocket keeps breathing while a frame is being read.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass

import mss
from PIL import Image

DEFAULT_MAX_WIDTH = 1280
DEFAULT_QUALITY = 70

# Guard rails: the backend asks for what it wants, but the agent pays for it. A request for
# a 6000px frame would cost memory and bandwidth for pixels nobody can see.
_MAX_WIDTH_LIMIT = 2560
_MAX_QUALITY = 90


@dataclass(frozen=True)
class Frame:
    """One encoded frame plus the numbers that make its cost visible in the logs."""

    jpeg: bytes
    width: int
    height: int
    capture_ms: float
    encode_ms: float


def list_monitors() -> list[dict[str, object]]:
    """Every display the OS will admit to, with the rectangle it occupies.

    `monitors[0]` in mss is the bounding box of *all* displays — a virtual desktop whose pixels
    no single screen owns. It is deliberately not offered as a choice: capturing it would give
    the phone a picture whose fractions map onto empty space between monitors.

    `left`/`top` are desktop coordinates and can be negative (a display placed left of the
    primary one). They are what makes a tap on monitor 2 land on monitor 2 instead of on the
    primary screen's copy of the same fraction.
    """
    with mss.mss() as recorder:
        return [
            {
                "index": number,
                "left": int(box["left"]),
                "top": int(box["top"]),
                "width": int(box["width"]),
                "height": int(box["height"]),
                "primary": number == 1,
            }
            for number, box in enumerate(recorder.monitors[1:], start=1)
        ]


def capture_jpeg(
    max_width: int = DEFAULT_MAX_WIDTH,
    quality: int = DEFAULT_QUALITY,
    monitor: int = 1,
) -> Frame:
    """Grab one monitor, scale it down if needed, and encode it as JPEG."""
    width_limit = max(320, min(int(max_width), _MAX_WIDTH_LIMIT))
    jpeg_quality = max(30, min(int(quality), _MAX_QUALITY))

    started = time.perf_counter()
    with mss.mss() as recorder:
        # monitors[0] is the bounding box of every display; 1..n are the displays themselves.
        # An out-of-range index falls back to the primary instead of raising: a phone asking for
        # monitor 3 after a display was unplugged should get a picture, not an error.
        index = monitor if 1 <= monitor < len(recorder.monitors) else 1
        box = recorder.monitors[index]
        shot = recorder.grab(box)
        # grab() returns BGRA; `.rgb` drops the alpha channel we have no use for.
        image = Image.frombytes("RGB", shot.size, shot.rgb)
    captured = time.perf_counter()

    if image.width > width_limit:
        height = max(1, round(image.height * width_limit / image.width))
        # LANCZOS is slower than BILINEAR but keeps text legible — the entire point of
        # sending a desktop to a phone.
        image = image.resize((width_limit, height), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    # subsampling=1 keeps more colour detail than the JPEG default without paying much size;
    # optimize=False because saving a few KB is not worth the extra CPU per frame.
    image.save(buffer, format="JPEG", quality=jpeg_quality, subsampling=1)
    encoded = time.perf_counter()

    return Frame(
        jpeg=buffer.getvalue(),
        width=image.width,
        height=image.height,
        capture_ms=(captured - started) * 1000,
        encode_ms=(encoded - captured) * 1000,
    )
