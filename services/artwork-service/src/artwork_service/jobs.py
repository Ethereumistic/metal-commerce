"""Durable job queue on SQLite.

States: queued -> running -> succeeded | failed | cancelled, plus
running -> queued when an abandoned lease is recovered (the database trigger
rejects anything else). A worker leases a job for `lease_seconds` and extends
the lease with heartbeats; a lease that expires (worker crash, restart) is
recovered by the next lease call, which requeues the job or fails it once its
attempts are exhausted. Attempts are counted when a job is leased.
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any

from .errors import ServiceError
from .storage import Database, dumps, loads, new_id, utcnow

TERMINAL = ("succeeded", "failed", "cancelled")


class LeaseLost(Exception):
    """The worker no longer holds the job lease (it expired and was recovered)."""


def enqueue(conn: sqlite3.Connection, *, business_id: str, kind: str, payload: dict[str, Any],
            max_attempts: int, timeout_s: float) -> str:
    job_id = new_id()
    now = utcnow()
    conn.execute(
        "INSERT INTO jobs (id, business_id, kind, status, stage, progress, payload, max_attempts, timeout_s,"
        " created_at, updated_at) VALUES (?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?)",
        (job_id, business_id, kind, dumps(payload), max_attempts, timeout_s, now, now),
    )
    return job_id


def recover_expired(conn: sqlite3.Connection, *, now: float | None = None, all_running: bool = False) -> int:
    """Requeue (or fail, when out of attempts) running jobs whose lease expired.

    `all_running` is used at service start: no worker can hold a lease from a
    previous run, so every running job is abandoned.
    """
    now = time.time() if now is None else now
    if all_running:
        rows = conn.execute("SELECT * FROM jobs WHERE status = 'running'").fetchall()
    else:
        rows = conn.execute("SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at < ?",
                            (now,)).fetchall()
    for row in rows:
        stamp = utcnow()
        if row["cancel_requested"]:
            conn.execute(
                "UPDATE jobs SET status = 'cancelled', stage = 'cancelled', lease_owner = NULL,"
                " lease_expires_at = NULL, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                (dumps(_error("CANCELLED", "The job was cancelled.")), stamp, stamp, row["id"]),
            )
        elif row["attempts"] >= row["max_attempts"]:
            err = _error("TIMEOUT", "The job was abandoned by its worker too many times and was stopped.",
                         {"attempts": row["attempts"]})
            conn.execute(
                "UPDATE jobs SET status = 'failed', stage = 'failed', lease_owner = NULL, lease_expires_at = NULL,"
                " error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                (dumps(err), stamp, stamp, row["id"]),
            )
        else:
            conn.execute(
                "UPDATE jobs SET status = 'queued', stage = 'requeued', lease_owner = NULL,"
                " lease_expires_at = NULL, updated_at = ? WHERE id = ?",
                (stamp, row["id"]),
            )
    return len(rows)


def lease_next(db: Database, owner: str, lease_seconds: float) -> sqlite3.Row | None:
    """Atomically recover expired leases and lease the oldest queued job."""
    with db.tx() as conn:
        recover_expired(conn)
        row = conn.execute(
            "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        now = time.time()
        stamp = utcnow()
        conn.execute(
            "UPDATE jobs SET status = 'running', stage = 'starting', attempts = attempts + 1, lease_owner = ?,"
            " lease_expires_at = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?"
            " WHERE id = ?",
            (owner, now + lease_seconds, stamp, stamp, stamp, row["id"]),
        )
        return conn.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone()


def heartbeat(db: Database, job_id: str, owner: str, lease_seconds: float, *,
              progress: float | None = None, stage: str | None = None) -> bool:
    """Extend the lease and record progress; returns whether cancellation was requested."""
    with db.tx() as conn:
        row = conn.execute("SELECT status, lease_owner, cancel_requested FROM jobs WHERE id = ?",
                           (job_id,)).fetchone()
        if row is None or row["status"] != "running" or row["lease_owner"] != owner:
            raise LeaseLost(job_id)
        stamp = utcnow()
        conn.execute(
            "UPDATE jobs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?,"
            " progress = COALESCE(?, progress), stage = COALESCE(?, stage) WHERE id = ?",
            (time.time() + lease_seconds, stamp, stamp,
             None if progress is None else max(0.0, min(1.0, progress)), stage, job_id),
        )
        return bool(row["cancel_requested"])


def finish(conn: sqlite3.Connection, job_id: str, owner: str, *, status: str,
           result: dict[str, Any] | None = None, error: dict[str, Any] | None = None,
           cache_hit: bool = False) -> None:
    """Move a leased job to a terminal state inside the caller's transaction."""
    if status not in TERMINAL:
        raise ValueError(status)
    row = conn.execute("SELECT status, lease_owner FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None or row["status"] != "running" or row["lease_owner"] != owner:
        raise LeaseLost(job_id)
    stamp = utcnow()
    conn.execute(
        "UPDATE jobs SET status = ?, stage = ?, progress = CASE WHEN ? = 'succeeded' THEN 1 ELSE progress END,"
        " result = ?, error = ?, cache_hit = ?, lease_owner = NULL, lease_expires_at = NULL,"
        " finished_at = ?, updated_at = ? WHERE id = ?",
        (status, status, status, None if result is None else dumps(result),
         None if error is None else dumps(error), int(cache_hit), stamp, stamp, job_id),
    )


def request_cancel(conn: sqlite3.Connection, business_id: str, job_id: str) -> sqlite3.Row:
    """Idempotent: queued jobs cancel at once, running jobs at their next checkpoint."""
    row = get_job(conn, business_id, job_id)
    stamp = utcnow()
    if row["status"] == "queued":
        conn.execute(
            "UPDATE jobs SET status = 'cancelled', stage = 'cancelled', cancel_requested = 1, error = ?,"
            " finished_at = ?, updated_at = ? WHERE id = ?",
            (dumps(_error("CANCELLED", "The job was cancelled before it started.")), stamp, stamp, job_id),
        )
    elif row["status"] == "running" and not row["cancel_requested"]:
        conn.execute("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?", (stamp, job_id))
    return get_job(conn, business_id, job_id)


def get_job(conn: sqlite3.Connection, business_id: str, job_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM jobs WHERE id = ? AND business_id = ?", (job_id, business_id)).fetchone()
    if row is None:
        raise ServiceError("NOT_FOUND", "Job not found.", {"job_id": job_id})
    return row


_NO_PRODUCT = {"product_id": None, "product_name": None, "product_slug": None, "product_thumbnail_url": None}


def _trace_products(conn: sqlite3.Connection, rows: list[sqlite3.Row]) -> dict[str, dict[str, Any]]:
    """Product identity per trace job, from the source snapshot the job was queued with.

    Every trace job ever queued points at its own snapshot, so a later prepare
    of the same product never changes how an older job is named.
    """
    payloads = {row["id"]: loads(row["payload"]) for row in rows if row["kind"] == "trace"}
    source_ids = sorted({p["source_id"] for p in payloads.values() if p.get("source_id")})
    sources: dict[str, sqlite3.Row] = {}
    for start in range(0, len(source_ids), 500):
        chunk = source_ids[start:start + 500]
        query = f"SELECT id, product_id, name, slug FROM product_sources WHERE id IN ({', '.join('?' * len(chunk))})"
        sources.update({src["id"]: src for src in conn.execute(query, chunk)})
    products = {}
    for job_id, payload in payloads.items():
        src = sources.get(payload.get("source_id"))
        products[job_id] = {
            "product_id": payload.get("product_id") or (src["product_id"] if src else None),
            "product_name": src["name"] if src else None,
            "product_slug": src["slug"] if src else None,
            # Jobs queued before thumbnails were recorded have none.
            "product_thumbnail_url": payload.get("thumbnail_url"),
        }
    return products


def job_views(conn: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    products = _trace_products(conn, rows)
    return [job_view(row, products.get(row["id"], _NO_PRODUCT)) for row in rows]


def job_view(row: sqlite3.Row, product: dict[str, Any] = _NO_PRODUCT) -> dict[str, Any]:
    return {
        **product,
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "stage": row["stage"],
        "progress": row["progress"],
        "heartbeat_at": row["heartbeat_at"],
        "attempts": row["attempts"],
        "cache_hit": bool(row["cache_hit"]),
        "error": loads(row["error"]),
        "result": loads(row["result"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def queue_counts(conn: sqlite3.Connection) -> dict[str, int]:
    counts = {"queued": 0, "running": 0}
    for row in conn.execute("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')"
                            " GROUP BY status"):
        counts[row["status"]] = row["n"]
    return counts


def _error(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"code": code, "message": message, "details": details or {}}
