"""Service configuration from environment variables.

Every setting has a documented default except the service token, which must be
provided explicitly so the API is never started unauthenticated.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

SERVICE_VERSION = "0.1.0"

DEFAULT_DATA_DIR = "/home/echo/.local/share/metal-craft-artwork/dev"

# Catalog media hosts the worker may fetch from, with the path prefix each
# host serves originals under (scout report: Convex storage and Library CDN).
DEFAULT_ALLOWED_SOURCES: dict[str, str] = {
    "convex.echoray.io": "/api/storage/",
    "cdn.echoray.io": "/",
}


class ConfigError(Exception):
    pass


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ConfigError(f"{name} must be >= {minimum}, got {value}")
    return value


def _parse_sources(raw: str) -> dict[str, str]:
    """Parse "host[/prefix],host2[/prefix]" into {host: prefix}."""
    out: dict[str, str] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        host, slash, rest = item.partition("/")
        out[host.lower()] = "/" + rest if slash else "/"
    if not out:
        raise ConfigError("ARTWORK_ALLOWED_SOURCES must list at least one host")
    return out


def _fixture_dir(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_dir():
        raise ConfigError(f"ARTWORK_TEST_FIXTURE_DIR is not a directory: {path}")
    return path


@dataclass(frozen=True)
class Config:
    data_dir: Path
    token: str
    host: str = "127.0.0.1"
    port: int = 8766
    worker_concurrency: int = 1
    lease_seconds: int = 30
    heartbeat_seconds: float = 2.0
    poll_seconds: float = 0.5
    max_attempts: int = 3
    trace_timeout_s: int = 300
    nest_overhead_s: int = 600
    # Free space that must remain after writing an artifact.
    min_free_bytes: int = 256 * 1024 * 1024
    fetch_max_bytes: int = 40 * 1024 * 1024
    fetch_timeout_s: float = 30.0
    fetch_max_redirects: int = 3
    max_source_pixels: int = 60_000_000
    allowed_sources: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_ALLOWED_SOURCES))
    # Acceptance testing only: serve `test-fixture://local/<name>` source URLs
    # from this directory. Unset (the default) means such URLs are rejected
    # like any other non-HTTPS URL.
    test_fixture_dir: Path | None = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "artwork.sqlite3"

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"

    @property
    def sources_dir(self) -> Path:
        return self.data_dir / "sources"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.artifacts_dir, self.sources_dir, self.tmp_dir):
            d.mkdir(parents=True, exist_ok=True)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["data_dir"] = str(self.data_dir)
        data["test_fixture_dir"] = str(self.test_fixture_dir) if self.test_fixture_dir else None
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Config":
        data = dict(data)
        data["data_dir"] = Path(data["data_dir"])
        if data.get("test_fixture_dir"):
            data["test_fixture_dir"] = Path(data["test_fixture_dir"])
        return cls(**data)

    @classmethod
    def from_env(cls) -> "Config":
        token = os.environ.get("ARTWORK_SERVICE_TOKEN", "")
        if len(token) < 16:
            raise ConfigError("ARTWORK_SERVICE_TOKEN must be set to a secret of at least 16 characters")
        sources = os.environ.get("ARTWORK_ALLOWED_SOURCES")
        fixture_dir = os.environ.get("ARTWORK_TEST_FIXTURE_DIR")
        return cls(
            data_dir=Path(os.environ.get("ARTWORK_DATA_DIR") or DEFAULT_DATA_DIR).expanduser(),
            token=token,
            host=os.environ.get("ARTWORK_HOST", "127.0.0.1"),
            port=_env_int("ARTWORK_PORT", 8766, minimum=1),
            worker_concurrency=_env_int("ARTWORK_WORKERS", 1, minimum=1),
            lease_seconds=_env_int("ARTWORK_LEASE_SECONDS", 30, minimum=5),
            max_attempts=_env_int("ARTWORK_MAX_ATTEMPTS", 3, minimum=1),
            trace_timeout_s=_env_int("ARTWORK_TRACE_TIMEOUT_S", 300, minimum=10),
            min_free_bytes=_env_int("ARTWORK_MIN_FREE_BYTES", 256 * 1024 * 1024),
            fetch_max_bytes=_env_int("ARTWORK_FETCH_MAX_BYTES", 40 * 1024 * 1024, minimum=1024),
            allowed_sources=_parse_sources(sources) if sources else dict(DEFAULT_ALLOWED_SOURCES),
            test_fixture_dir=_fixture_dir(fixture_dir) if fixture_dir else None,
        )
