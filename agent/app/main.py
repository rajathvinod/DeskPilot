"""DeskPilot Windows agent — process entrypoint.

Two things run here at once, in one event loop:

  1. the FastAPI HTTP server on loopback (health, and later local diagnostics)
  2. the outbound WebSocket client that dials the backend

They share a loop on purpose. Everything in both is waiting on I/O, so one thread is
plenty — and a single loop means a slow screenshot later cannot be hidden behind a second
thread with its own copy of the connection state.

No screen capture, no input injection yet. Keeping this file this small is deliberate:
every capability we add later is a decision, not a surprise.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import platform
import socket
import time

import uvicorn
from fastapi import FastAPI

from app import __version__
from app.config import settings
from app.input_control import ensure_dpi_aware
from app.ws_client import AgentConnection

STARTED_AT = time.time()

log = logging.getLogger("deskpilot.agent")

app = FastAPI(
    title="DeskPilot Agent",
    version=__version__,
    docs_url="/docs",  # interactive API explorer, useful for poking at the agent by hand
)


@app.get("/health")
async def health() -> dict[str, object]:
    """Liveness + identity.

    The phone and the backend will both use this to answer: is the agent process alive,
    on which machine, and running which version?
    """
    return {
        "service": "deskpilot-agent",
        "status": "ok",
        "version": __version__,
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "uptimeSeconds": round(time.time() - STARTED_AT, 1),
        # False until QR pairing (Phase 5) has stored a device identity.
        "paired": False,
    }


def _configure_logging() -> None:
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


async def _serve() -> None:
    _configure_logging()

    log.info("DeskPilot agent %s", __version__)
    log.info("http     http://%s:%s/health", settings.host, settings.port)

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=settings.host,
            port=settings.port,
            log_level=settings.log_level.lower(),
        )
    )

    client: AgentConnection | None = None
    ws_task: asyncio.Task[None] | None = None

    if settings.backend_url:
        client = AgentConnection(settings)
        ws_task = asyncio.create_task(client.run_forever(), name="backend-ws")
    else:
        # Not an error: the agent is still useful standalone (health checks, local tests).
        # It just cannot be reached by the phone until it has somewhere to dial.
        log.warning("DP_BACKEND_URL is empty — running HTTP only, no backend connection")

    try:
        await server.serve()
    finally:
        if client is not None and ws_task is not None:
            client.stop()
            ws_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ws_task


def main() -> None:
    # Before anything reads or moves the mouse: without this, Windows reports a scaled-down
    # screen and every click lands in the wrong place on a display that is not at 100%.
    ensure_dpi_aware()
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        # Ctrl+C is the normal way to stop this process, not an error.
        pass


if __name__ == "__main__":
    main()
