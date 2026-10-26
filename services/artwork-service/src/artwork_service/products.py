"""Product preparation: source snapshots, trace jobs and reusable masters.

A product's state row points at its active master and the source snapshot it
was traced from. Preparing a product whose active master was traced from the
same first-image identity/version is a no-op; a different identity/version (or
an explicit reprocess) records a new snapshot and queues a trace job. The trace
job fetches the bytes once, then converges on one master per cache key
(business + byte SHA-256 + engine/version + normalized settings), so identical
bytes are never traced twice, even by concurrent jobs.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from . import geometry as geo
from . import jobs
from .catalog_source import inspect_image
from .config import Config
from .contracts import PrepareRequest, StatusRequest
from .errors import ServiceError
from .storage import dumps, get_artifact, loads, new_id, utcnow, write_atomic
from .tracing import TraceSettings, get_tracer

if TYPE_CHECKING:
    from .worker import JobContext

log = logging.getLogger(__name__)

BUILD_WAIT_POLL_S = 0.25


# ---------------------------------------------------------------- API helpers


def _same_source(source: sqlite3.Row | None, identity: str | None, version: str | None) -> bool:
    return source is not None and source["source_identity"] == identity and source["source_version"] == version


def _state(conn: sqlite3.Connection, business_id: str, product_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM product_states WHERE business_id = ? AND product_id = ?",
                        (business_id, product_id)).fetchone()


def _source(conn: sqlite3.Connection, source_id: str | None) -> sqlite3.Row | None:
    if source_id is None:
        return None
    return conn.execute("SELECT * FROM product_sources WHERE id = ?", (source_id,)).fetchone()


def _item(product_id: str, status: str, *, master_id: str | None = None, job_id: str | None = None,
          error: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"product_id": product_id, "status": status, "master_id": master_id, "job_id": job_id, "error": error}


def _upsert_state(conn: sqlite3.Connection, business_id: str, product_id: str, **fields: Any) -> None:
    fields["updated_at"] = utcnow()
    if _state(conn, business_id, product_id) is None:
        fields.setdefault("status", "failed")
        cols = ["business_id", "product_id", *fields]
        conn.execute(f"INSERT INTO product_states ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                     (business_id, product_id, *fields.values()))
    else:
        assignments = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE product_states SET {assignments} WHERE business_id = ? AND product_id = ?",
                     (*fields.values(), business_id, product_id))


def prepare(conn: sqlite3.Connection, business_id: str, req: PrepareRequest, config: Config) -> dict[str, Any]:
    items = []
    for product in req.products:
        pid = product.product_id
        state = _state(conn, business_id, pid)
        active_master = state["active_master_id"] if state else None
        if product.source is None:
            err = {"code": "NO_FIRST_IMAGE", "message": "The product has no first catalog image to trace.",
                   "details": {}}
            _upsert_state(conn, business_id, pid, status="failed", job_id=None, pending_source_id=None,
                          error=dumps(err))
            items.append(_item(pid, "failed", master_id=active_master, error=err))
            continue
        src = product.source
        if state is not None and state["status"] in ("queued", "processing"):
            pending = _source(conn, state["pending_source_id"])
            if _same_source(pending, src.source_identity, src.source_version):
                items.append(_item(pid, state["status"], master_id=active_master, job_id=state["job_id"]))
                continue
        active_source = _source(conn, state["active_source_id"]) if state else None
        if (not req.reprocess and active_master is not None
                and _same_source(active_source, src.source_identity, src.source_version)):
            items.append(_item(pid, "ready", master_id=active_master))
            continue
        source_id = new_id()
        conn.execute(
            "INSERT INTO product_sources (id, business_id, product_id, product_revision, name, slug, gallery_index,"
            " source_identity, source_version, original_url, declared_width, declared_height, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
            (source_id, business_id, pid, product.product_revision, product.name, product.slug,
             src.source_identity, src.source_version, src.original_url, src.width, src.height, utcnow()),
        )
        job_id = jobs.enqueue(conn, business_id=business_id, kind="trace",
                              payload={"source_id": source_id, "product_id": pid, "reprocess": req.reprocess,
                                       "thumbnail_url": product.thumbnail_url},
                              max_attempts=config.max_attempts, timeout_s=config.trace_timeout_s)
        _upsert_state(conn, business_id, pid, status="queued", job_id=job_id, pending_source_id=source_id,
                      error=None)
        items.append(_item(pid, "queued", master_id=active_master, job_id=job_id))
    return {"items": items}


def status(conn: sqlite3.Connection, business_id: str, req: StatusRequest) -> dict[str, Any]:
    items = []
    for product in req.products:
        pid = product.product_id
        state = _state(conn, business_id, pid)
        if state is None:
            items.append(_item(pid, "unprepared"))
            continue
        master_id = state["active_master_id"]
        if state["status"] in ("queued", "processing"):
            items.append(_item(pid, state["status"], master_id=master_id, job_id=state["job_id"]))
        elif state["status"] == "failed":
            items.append(_item(pid, "failed", master_id=master_id, job_id=state["job_id"],
                               error=loads(state["error"])))
        elif _same_source(_source(conn, state["active_source_id"]), product.source_identity, product.source_version):
            items.append(_item(pid, "ready", master_id=master_id, job_id=state["job_id"]))
        else:
            items.append(_item(pid, "stale", master_id=master_id, job_id=state["job_id"], error={
                "code": "MASTER_STALE",
                "message": "The product's first image changed since its master was traced; prepare it again.",
                "details": {},
            }))
    return {"items": items}


def public_url(url: str) -> str:
    """Drop query and fragment: signed media URLs carry credentials there."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def master_view(conn: sqlite3.Connection, business_id: str, master_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM masters WHERE id = ? AND business_id = ?", (master_id, business_id)).fetchone()
    if row is None:
        raise ServiceError("NOT_FOUND", "Master not found.", {"master_id": master_id})
    src = _source(conn, row["source_id"])
    diagnostics = loads(row["diagnostics"])
    return {
        "id": row["id"],
        "product_id": row["product_id"],
        "revision": row["revision"],
        "source": {
            "product_id": src["product_id"],
            "product_revision": src["product_revision"],
            "gallery_index": src["gallery_index"],
            "source_identity": src["source_identity"],
            "source_version": src["source_version"],
            "original_url": public_url(src["original_url"]),
            "byte_sha256": row["source_sha256"],
            "width": src["width"],
            "height": src["height"],
            "format": src["format"],
            "fetched_at": src["fetched_at"],
        },
        "aspect_ratio": row["aspect_ratio"],
        "normalized_bounds": loads(row["normalized_bounds"]),
        "components": row["components"],
        "holes": row["holes"],
        "vertex_count": row["vertex_count"],
        "trace_engine": row["trace_engine"],
        "trace_version": row["trace_version"],
        "trace_settings": loads(row["trace_settings"]),
        "transform": loads(row["transform"]),
        "diagnostics": {
            "threshold": diagnostics["threshold"],
            "candidates": diagnostics["candidates"],
            "noise_removed_area_px": diagnostics["noise_removed_area_px"],
            "warnings": diagnostics["warnings"],
            "details": diagnostics,
        },
        "artifacts": {
            "overlay_png": row["overlay_png_artifact"],
            "solid_png": row["solid_png_artifact"],
            "master_json": row["master_json_artifact"],
            "master_svg": row["master_svg_artifact"],
        },
        "created_at": row["created_at"],
    }


def load_master_geometry(conn: sqlite3.Connection, business_id: str, master_id: str, config: Config):
    row = conn.execute("SELECT master_json_artifact FROM masters WHERE id = ? AND business_id = ?",
                       (master_id, business_id)).fetchone()
    if row is None:
        raise ServiceError("NOT_FOUND", "Master not found.", {"master_id": master_id})
    artifact = get_artifact(conn, business_id, row["master_json_artifact"])
    path = config.artifacts_dir / artifact["sha256"][:2] / artifact["sha256"]
    return geo.from_json(json.loads(path.read_bytes())["geometry"])


# ------------------------------------------------------------------ trace job


def cache_key(business_id: str, sha256: str, engine: str, version: str, settings_hash: str) -> str:
    raw = f"{business_id}|{sha256}|{engine}|{version}|{settings_hash}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _load_source_bytes(ctx: "JobContext", source: sqlite3.Row) -> bytes:
    """Bytes are fetched once per snapshot and cached by SHA-256 on disk."""
    config = ctx.config
    if source["byte_sha256"]:
        cached = config.sources_dir / source["byte_sha256"][:2] / source["byte_sha256"]
        if cached.exists():
            data = cached.read_bytes()
            if hashlib.sha256(data).hexdigest() == source["byte_sha256"]:
                return data
            log.warning("cached source %s failed its hash check; refetching", source["byte_sha256"])
    fetched = ctx.fetcher.fetch(source["original_url"])
    # Re-check what any fetcher returns; tests inject fetchers.
    checked = inspect_image(fetched.data, config.max_source_pixels)
    path = config.sources_dir / checked.sha256[:2] / checked.sha256
    if not path.exists():
        write_atomic(path, checked.data, tmp_dir=config.tmp_dir, min_free_bytes=config.min_free_bytes)
    with ctx.db.tx() as conn:
        conn.execute("UPDATE product_sources SET byte_sha256 = ?, width = ?, height = ?, format = ?, fetched_at = ?"
                     " WHERE id = ?", (checked.sha256, checked.width, checked.height, checked.format, utcnow(),
                                       source["id"]))
    return checked.data


def _link_product(conn: sqlite3.Connection, business_id: str, product_id: str, master_id: str,
                  source_id: str, job_id: str) -> None:
    state = _state(conn, business_id, product_id)
    link = conn.execute("SELECT revision FROM product_masters WHERE business_id = ? AND product_id = ? AND master_id = ?",
                        (business_id, product_id, master_id)).fetchone()
    if link is not None:
        revision = link["revision"]
    else:
        revision = _next_revision(conn, business_id, product_id)
        conn.execute("INSERT INTO product_masters (business_id, product_id, master_id, revision, source_id, created_at)"
                     " VALUES (?, ?, ?, ?, ?, ?)", (business_id, product_id, master_id, revision, source_id, utcnow()))
    if state is None or state["job_id"] == job_id:
        # A newer prepare superseded this job otherwise; never clobber its state.
        _upsert_state(conn, business_id, product_id, status="ready", active_master_id=master_id,
                      active_source_id=source_id, pending_source_id=None, revision=revision, error=None)


def _next_revision(conn: sqlite3.Connection, business_id: str, product_id: str) -> int:
    row = conn.execute("SELECT COALESCE(MAX(revision), 0) AS r FROM product_masters"
                       " WHERE business_id = ? AND product_id = ?", (business_id, product_id)).fetchone()
    return row["r"] + 1


def trace_failed(conn: sqlite3.Connection, job: sqlite3.Row, error: dict[str, Any]) -> None:
    payload = loads(job["payload"])
    conn.execute("DELETE FROM master_builds WHERE job_id = ?", (job["id"],))
    state = _state(conn, job["business_id"], payload["product_id"])
    if state is not None and state["job_id"] == job["id"]:
        _upsert_state(conn, job["business_id"], payload["product_id"], status="failed", pending_source_id=None,
                      error=dumps(error))


def _claim_build(ctx: "JobContext", business_id: str, key: str) -> sqlite3.Row | None:
    """Return an existing master for `key`, or claim the right to build it.

    Waits while another live job holds the claim; a claim held by a job that is
    no longer running (crashed, failed) is taken over.
    """
    while True:
        with ctx.db.tx() as conn:
            master = conn.execute("SELECT * FROM masters WHERE business_id = ? AND cache_key = ?",
                                  (business_id, key)).fetchone()
            if master is not None:
                return master
            claim = conn.execute("SELECT job_id FROM master_builds WHERE business_id = ? AND cache_key = ?",
                                 (business_id, key)).fetchone()
            holder = None
            if claim is not None and claim["job_id"] != ctx.job_id:
                holder = conn.execute("SELECT status FROM jobs WHERE id = ?", (claim["job_id"],)).fetchone()
            if claim is None or holder is None or holder["status"] != "running" or claim["job_id"] == ctx.job_id:
                conn.execute("INSERT OR REPLACE INTO master_builds (business_id, cache_key, job_id, created_at)"
                             " VALUES (?, ?, ?, ?)", (business_id, key, ctx.job_id, utcnow()))
                return None
        ctx.checkpoint(stage="waiting-for-identical-trace")
        time.sleep(BUILD_WAIT_POLL_S)


def run_trace_job(ctx: "JobContext") -> None:
    job = ctx.job
    business_id = job["business_id"]
    payload = loads(job["payload"])
    with ctx.db.tx() as conn:
        source = conn.execute("SELECT * FROM product_sources WHERE id = ? AND business_id = ?",
                              (payload["source_id"], business_id)).fetchone()
        if source is None:
            raise ServiceError("NOT_FOUND", "The source snapshot for this job no longer exists.", {})
        state = _state(conn, business_id, payload["product_id"])
        if state is not None and state["job_id"] == job["id"]:
            _upsert_state(conn, business_id, payload["product_id"], status="processing")

    ctx.checkpoint(0.05, "fetching-source")
    data = _load_source_bytes(ctx, source)
    sha = hashlib.sha256(data).hexdigest()

    tracer = get_tracer()
    settings = TraceSettings()
    settings_hash = settings.fingerprint()
    key = cache_key(business_id, sha, tracer.engine, tracer.version, settings_hash)
    ctx.checkpoint(0.15, "cache-lookup")
    existing = _claim_build(ctx, business_id, key)
    if existing is not None:
        with ctx.db.tx() as conn:
            _link_product(conn, business_id, payload["product_id"], existing["id"], source["id"], job["id"])
            ctx.complete(conn, {"master_id": existing["id"]}, cache_hit=True)
        return

    ctx.checkpoint(0.2, "tracing")
    result = tracer.trace(data, settings)
    ctx.checkpoint(0.85, "writing-artifacts")

    master_id = new_id()
    stem = f"master-{master_id[:12]}"
    document = result.master_document()
    document.update({"master_id": master_id, "source_sha256": sha, "trace_settings": settings.normalized(),
                     "diagnostics": result.diagnostics})
    files = [
        ("master_json", json.dumps(document, sort_keys=True).encode(), "json", f"{stem}.json"),
        ("master_svg", result.svg.encode(), "svg", f"{stem}.svg"),
        ("overlay_png", result.overlay_png, "png", f"{stem}-overlay.png"),
        ("solid_png", result.solid_png, "png", f"{stem}-solid.png"),
    ]
    # Write all files before the publishing transaction (content-addressed,
    # atomic renames); the rows referencing them commit together below.
    for _kind, content, _ext, _name in files:
        ctx.store.write_bytes(content)
    ctx.checkpoint(0.95, "publishing")
    with ctx.db.tx() as conn:
        artifact_ids = {kind: ctx.store.put(conn, business_id, content, kind=kind, ext=ext, filename=name)
                        for kind, content, ext, name in files}
        revision = _next_revision(conn, business_id, payload["product_id"])
        conn.execute(
            "INSERT INTO masters (id, business_id, cache_key, product_id, revision, source_id, source_sha256,"
            " trace_engine, trace_version, settings_hash, trace_settings, aspect_ratio, normalized_bounds,"
            " components, holes, vertex_count, diagnostics, transform, master_json_artifact, master_svg_artifact,"
            " overlay_png_artifact, solid_png_artifact, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (master_id, business_id, key, payload["product_id"], revision, source["id"], sha, tracer.engine,
             tracer.version, settings_hash, dumps(settings.normalized()), result.aspect_ratio,
             dumps(list(result.geometry.bounds)), len(result.components), result.holes, result.vertex_count,
             dumps(result.diagnostics), dumps(result.transform), artifact_ids["master_json"],
             artifact_ids["master_svg"], artifact_ids["overlay_png"], artifact_ids["solid_png"], utcnow()),
        )
        conn.execute("DELETE FROM master_builds WHERE business_id = ? AND cache_key = ?", (business_id, key))
        _link_product(conn, business_id, payload["product_id"], master_id, source["id"], job["id"])
        ctx.complete(conn, {"master_id": master_id}, cache_hit=False)
