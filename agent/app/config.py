"""Agent configuration.

Same rules as the backend: configuration is read from the environment once, validated,
and handed around as a typed object. Python gives us this almost for free through
pydantic-settings, which also fails loudly at startup when a value is malformed.
"""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    # env_prefix="DP_" means the field `port` is read from env var DP_PORT.
    # Bare names like PORT/HOST are frequently exported by unrelated tools, and OS env
    # variables override .env values — this environment has PORT=0 set globally, which
    # would otherwise silently break our config.
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        env_prefix="DP_",
        extra="ignore",
    )

    # The agent binds to loopback by default. It must never listen on 0.0.0.0:
    # that is the difference between "private tool" and "open remote-control port".
    host: str = Field(default="127.0.0.1")

    # Separate port from the backend so both can run on the same laptop.
    port: int = Field(default=8788, ge=1024, le=65535)

    log_level: str = Field(default="info")

    # Where the agent dials out to (Milestone 2b). Empty means "do not connect": the agent
    # still runs its local HTTP health endpoint, it just is not reachable by the phone.
    # http/https is accepted; the WebSocket scheme is derived from it.
    backend_url: str = Field(default="")

    # Shared secret for /agent/ws. Empty sends no header, which only works against a backend
    # that does not require one (a warning in both logs is the intended reminder).
    agent_token: str = Field(default="")

    # Heartbeat: send a ping every interval, and treat no reply within the timeout as
    # "degraded". The backend's hello.ack advertises its own interval — keep these in the
    # same ballpark so we do not ping far more often than the server watches for.
    heartbeat_interval_s: float = Field(default=10.0, gt=0)
    heartbeat_timeout_s: float = Field(default=5.0, gt=0)

    # Dialling the backend over a relay can take a second or two; 10s is generous but still
    # finite, so a black-holed route fails instead of hanging forever.
    connect_timeout_s: float = Field(default=10.0, gt=0)

    # Milestone 12: how often the agent looks at the foreground window, and how often it says
    # "still here" when nothing changed. The second number is what keeps "nothing happened"
    # distinguishable from "the monitor stopped".
    activity_interval_s: float = Field(default=3.0, gt=0)
    activity_report_s: float = Field(default=60.0, gt=0)

    # Reconnect backoff: base * 2^(attempt-1), capped, with jitter. See ws_client.backoff_delay.
    backoff_base_s: float = Field(default=1.0, gt=0)
    backoff_max_s: float = Field(default=30.0, gt=0)


settings = Settings()
