"""Remember which steps have already run, so a retry cannot run one twice.

The problem is subtle and specific: a socket can die *after* an action was carried out but
*before* its acknowledgement arrived. From the backend's side that is indistinguishable from
"it never arrived", so it retries — and without this ledger a half-finished sequence would
replay its earlier steps. Clicking a Submit button twice is not a small bug.

The ledger is persisted because the same reasoning applies across an agent restart: a crash
between "clicked" and "answered" leaves exactly the same ambiguity. Entries are bounded so the
file cannot grow forever, which also means a very old step id is forgotten — acceptable, because
the backend only retries within a short resume window.

Keyed by `stepId`, which the backend derives from the task and the step's position, so the same
logical step always carries the same key even though every envelope has a fresh id.
"""

from __future__ import annotations

import json
import logging
import pathlib
import threading
from collections import OrderedDict
from typing import Any

log = logging.getLogger("deskpilot.steps")

# How many step ids to remember. Large enough to cover any task the backend will run, small
# enough that the file stays a few tens of kilobytes.
CAPACITY = 500


class StepLedger:
    """A bounded, on-disk record of `stepId -> the answer that step produced`."""

    def __init__(self, path: pathlib.Path | None = None) -> None:
        self.path = path or pathlib.Path(__file__).resolve().parent.parent / ".state" / "step-ledger.json"
        self._entries: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            # A corrupt ledger must never stop the agent from starting. Losing it costs the
            # duplicate-protection of old steps, which is far better than refusing to run.
            log.warning("ignoring unreadable step ledger at %s", self.path)
            return

        if not isinstance(raw, list):
            return
        for item in raw:
            if isinstance(item, dict) and isinstance(item.get("stepId"), str):
                self._entries[item["stepId"]] = {key: value for key, value in item.items() if key != "stepId"}
        if self._entries:
            log.info("step ledger restored: %d entries", len(self._entries))

    def lookup(self, step_id: str) -> dict[str, Any] | None:
        """The answer this step produced, or `None` if it has never run."""
        with self._lock:
            found = self._entries.get(step_id)
            return dict(found) if found is not None else None

    def remember(self, step_id: str, ack: dict[str, Any]) -> None:
        """Record that a step ran, and what it answered."""
        with self._lock:
            self._entries[step_id] = dict(ack)
            self._entries.move_to_end(step_id)
            while len(self._entries) > CAPACITY:
                self._entries.popitem(last=False)
            self._flush_locked()

    def _flush_locked(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            payload = [{"stepId": key, **value} for key, value in self._entries.items()]
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            # Rename is atomic on this filesystem: a crash mid-write leaves the old file whole
            # instead of a truncated one that would fail to load.
            temporary.replace(self.path)
        except OSError:
            log.warning("could not persist the step ledger", exc_info=True)
