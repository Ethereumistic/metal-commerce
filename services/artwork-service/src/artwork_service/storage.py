"""SQLite metadata store and content-addressed artifact files.

The database runs in WAL mode and is shared by the API process and the worker
processes; every write happens inside a short `BEGIN IMMEDIATE` transaction.
Artifact bytes live on disk under `artifacts/<sha[:2]>/<sha>`; files are written
to a temporary path, fsynced and atomically renamed before the row that
references them is committed, so a crash never publishes half-written output.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .config import Config
from .errors import InsufficientDisk, ServiceError

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_sources (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_revision INTEGER,
    name TEXT,
    slug TEXT,
    gallery_index INTEGER NOT NULL CHECK (gallery_index = 0),
    source_identity TEXT NOT NULL,
    source_version TEXT,
    original_url TEXT NOT NULL,
    declared_width INTEGER,
    declared_height INTEGER,
    byte_sha256 TEXT,
    width INTEGER,
    height INTEGER,
    format TEXT,
    fetched_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_sources_product ON product_sources (business_id, product_id);

CREATE TABLE IF NOT EXISTS masters (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    product_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_id TEXT NOT NULL REFERENCES product_sources (id),
    source_sha256 TEXT NOT NULL,
    trace_engine TEXT NOT NULL,
    trace_version TEXT NOT NULL,
    settings_hash TEXT NOT NULL,
    trace_settings TEXT NOT NULL,
    aspect_ratio REAL NOT NULL CHECK (aspect_ratio > 0),
    normalized_bounds TEXT NOT NULL,
    components INTEGER NOT NULL,
    holes INTEGER NOT NULL,
    vertex_count INTEGER NOT NULL,
    diagnostics TEXT NOT NULL,
    transform TEXT NOT NULL,
    master_json_artifact TEXT NOT NULL,
    master_svg_artifact TEXT NOT NULL,
    overlay_png_artifact TEXT NOT NULL,
    solid_png_artifact TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (business_id, cache_key)
);

-- One in-flight trace per cache key: concurrent duplicate prepares wait for
-- the holder instead of tracing the same bytes twice.
CREATE TABLE IF NOT EXISTS master_builds (
    business_id TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (business_id, cache_key)
);

CREATE TABLE IF NOT EXISTS product_masters (
    business_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    master_id TEXT NOT NULL REFERENCES masters (id),
    revision INTEGER NOT NULL,
    source_id TEXT NOT NULL REFERENCES product_sources (id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (business_id, product_id, master_id),
    UNIQUE (business_id, product_id, revision)
);

CREATE TABLE IF NOT EXISTS product_states (
    business_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
    job_id TEXT,
    pending_source_id TEXT,
    active_master_id TEXT REFERENCES masters (id),
    active_source_id TEXT REFERENCES product_sources (id),
    revision INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (business_id, product_id)
);

CREATE TABLE IF NOT EXISTS fabrication_profiles (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    material TEXT NOT NULL,
    thickness_mm REAL NOT NULL CHECK (thickness_mm > 0),
    revision INTEGER NOT NULL,
    min_feature_mm REAL,
    min_hole_mm REAL,
    required_for_export INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (business_id, material, thickness_mm, revision)
);

CREATE TABLE IF NOT EXISTS size_variants (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    master_id TEXT NOT NULL REFERENCES masters (id),
    part_key TEXT NOT NULL,
    width_mm REAL NOT NULL CHECK (width_mm > 0),
    height_mm REAL NOT NULL CHECK (height_mm > 0),
    geometry_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (business_id, part_key)
);

CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'invalid', 'queued', 'nesting', 'completed',
                                           'incomplete', 'failed', 'cancelled')),
    request TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    groups TEXT NOT NULL,
    totals TEXT,
    validation TEXT,
    error TEXT,
    job_id TEXT,
    manifest_artifact TEXT,
    zip_artifact TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS batches_business ON batches (business_id, created_at);

CREATE TABLE IF NOT EXISTS batch_lines (
    batch_id TEXT NOT NULL REFERENCES batches (id),
    line_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    product_id TEXT NOT NULL,
    master_id TEXT,
    size_variant_id TEXT,
    profile_id TEXT,
    size_mode TEXT NOT NULL,
    requested_width_mm REAL,
    requested_height_mm REAL,
    actual_width_mm REAL,
    actual_height_mm REAL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    material TEXT NOT NULL,
    thickness_mm REAL NOT NULL,
    allowed_rotations TEXT NOT NULL,
    variant_id TEXT,
    fits INTEGER NOT NULL,
    errors TEXT NOT NULL,
    feature_check TEXT NOT NULL,
    PRIMARY KEY (batch_id, line_id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('trace', 'nest')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    stage TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at REAL,
    heartbeat_at TEXT,
    timeout_s REAL NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_business ON jobs (business_id, created_at);

-- Enforce the job state machine in the database itself.
CREATE TRIGGER IF NOT EXISTS jobs_status_transition
BEFORE UPDATE OF status ON jobs
WHEN NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled', 'failed')) OR
    (OLD.status = 'running' AND NEW.status IN ('queued', 'succeeded', 'failed', 'cancelled'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid job status transition');
END;

CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches (id),
    business_id TEXT NOT NULL,
    group_key TEXT NOT NULL,
    sheet_index INTEGER NOT NULL,
    sheet_number INTEGER NOT NULL,
    width_mm REAL NOT NULL,
    height_mm REAL NOT NULL,
    metrics TEXT NOT NULL,
    dxf_artifact TEXT,
    svg_artifact TEXT,
    UNIQUE (batch_id, group_key, sheet_index),
    UNIQUE (batch_id, sheet_number)
);

CREATE TABLE IF NOT EXISTS placements (
    batch_id TEXT NOT NULL REFERENCES batches (id),
    sheet_id TEXT NOT NULL REFERENCES sheets (id),
    instance_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    part_key TEXT NOT NULL,
    rotation_deg INTEGER NOT NULL,
    tx_mm REAL NOT NULL,
    ty_mm REAL NOT NULL,
    PRIMARY KEY (batch_id, instance_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    business_id TEXT NOT NULL,
    key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status_code INTEGER,
    response TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (business_id, key)
);

CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    heartbeat_at REAL NOT NULL
);
"""


def utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id() -> str:
    return uuid.uuid4().hex


def dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def loads(value: str | None) -> Any:
    return None if value is None else json.loads(value)


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA synchronous = NORMAL")
        return conn

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(SCHEMA)
            conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
                         (str(SCHEMA_VERSION),))
        finally:
            conn.close()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """A write transaction; BEGIN IMMEDIATE serializes writers across processes."""
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()


CONTENT_TYPES = {
    "json": "application/json",
    "svg": "image/svg+xml",
    "png": "image/png",
    "dxf": "application/dxf",
    "zip": "application/zip",
}


class ArtifactStore:
    """Content-addressed artifact bytes plus business-scoped artifact rows."""

    def __init__(self, config: Config) -> None:
        self.root = config.artifacts_dir
        self.tmp = config.tmp_dir
        self.min_free_bytes = config.min_free_bytes

    def path_for(self, sha256: str) -> Path:
        return self.root / sha256[:2] / sha256

    def write_bytes(self, data: bytes) -> str:
        """Store bytes by SHA-256 and return the digest; idempotent."""
        digest = hashlib.sha256(data).hexdigest()
        final = self.path_for(digest)
        if final.exists():
            return digest
        write_atomic(final, data, tmp_dir=self.tmp, min_free_bytes=self.min_free_bytes)
        return digest

    def put(self, conn: sqlite3.Connection, business_id: str, data: bytes, *, kind: str,
            ext: str, filename: str) -> str:
        """Write bytes (if new) and insert an artifact row; returns the artifact id.

        Call inside the transaction that publishes the owning record so the row
        and its reference commit together; the file is already durable by then.
        """
        digest = self.write_bytes(data)
        artifact_id = new_id()
        conn.execute(
            "INSERT INTO artifacts (id, business_id, sha256, kind, content_type, filename, size_bytes, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (artifact_id, business_id, digest, kind, CONTENT_TYPES[ext], filename, len(data), utcnow()),
        )
        return artifact_id


def write_atomic(final: Path, data: bytes, *, tmp_dir: Path, min_free_bytes: int) -> None:
    """Write to a temp file in the same filesystem, fsync, then rename into place."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    final.parent.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(tmp_dir).free
    if free - len(data) < min_free_bytes:
        raise InsufficientDisk(
            "Not enough free disk space to store results; free space on the artwork data disk and retry.",
            {"free_bytes": free, "required_bytes": len(data) + min_free_bytes},
        )
    tmp = tmp_dir / f"{final.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, final)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        if exc.errno in (errno.ENOSPC, errno.EDQUOT):
            raise InsufficientDisk("The artwork data disk is full; free space and retry.",
                                   {"errno": exc.errno}) from exc
        raise


def get_artifact(conn: sqlite3.Connection, business_id: str, artifact_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM artifacts WHERE id = ? AND business_id = ?",
                       (artifact_id, business_id)).fetchone()
    if row is None:
        raise ServiceError("NOT_FOUND", "Artifact not found.", {"artifact_id": artifact_id})
    return row
