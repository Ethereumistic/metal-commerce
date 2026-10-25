"""HTTP API (see CONTRACT.md). Handlers are synchronous so FastAPI runs them in
its threadpool; CPU-heavy tracing and nesting run only in worker processes."""

from __future__ import annotations

import importlib.metadata
import json
import logging
import re
import time
from typing import Any, Callable

import anyio.to_thread
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth, batches, jobs, products
from .config import SERVICE_VERSION, Config
from .contracts import BatchRequest, PrepareRequest, StatusRequest
from .errors import ServiceError
from .storage import Database, get_artifact
from .tracing import TRACE_ENGINE, TRACE_VERSION

log = logging.getLogger(__name__)

WORKER_STALE_S = 30.0
SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]")


def _error_response(status: int, code: str, message: str, details: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message,
                                                               "details": details or {}}})


def _versions() -> dict[str, str | None]:
    try:
        solver = importlib.metadata.version("packingsolver")
    except importlib.metadata.PackageNotFoundError:
        solver = None
    try:
        from .dxf_export import EXPORTER_VERSION as exporter
    except ImportError:
        exporter = None
    return {"tracer_version": f"{TRACE_ENGINE}/{TRACE_VERSION}", "solver_version": solver,
            "exporter_version": exporter}


def create_app(config: Config) -> FastAPI:
    config.ensure_dirs()
    db = Database(config.db_path)
    db.init()
    app = FastAPI(title="Metal Craft artwork service", version=SERVICE_VERSION, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.config = config
    app.state.db = db

    @app.exception_handler(ServiceError)
    async def service_error(_request: Request, exc: ServiceError) -> JSONResponse:
        return _error_response(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return _error_response(422, "VALIDATION_ERROR", "The request is invalid.",
                               {"errors": _clean_errors(exc.errors())})

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND", 405: "NOT_FOUND"}.get(exc.status_code, "VALIDATION_ERROR")
        return _error_response(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def unexpected(_request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", exc_info=exc)
        return _error_response(500, "INTERNAL_ERROR", "Unexpected service error; see the service log.")

    def context(request: Request) -> auth.Context:
        return auth.authenticate(request, config.token)

    async def read_body(request: Request, model: type | None) -> tuple[Any, Any]:
        raw = await request.body()
        try:
            body = json.loads(raw) if raw else None
        except ValueError as exc:
            raise ServiceError("VALIDATION_ERROR", "The request body is not valid JSON.") from exc
        if model is None:
            return body, None
        try:
            return body, model.model_validate(body)
        except ValidationError as exc:
            raise ServiceError("VALIDATION_ERROR", "The request is invalid.",
                               {"errors": _clean_errors(exc.errors())}) from exc

    async def mutation(request: Request, model: type | None,
                       handler: Callable[[Any, auth.Context, Any], tuple[int, Any]]) -> JSONResponse:
        """Authenticate, require edit, enforce idempotency, then run `handler` in a transaction.

        The stored idempotent response commits in the same transaction as the
        mutation; a failed request releases its key so a retry can run.
        """
        ctx = context(request)
        auth.require_edit(ctx)
        key = auth.idempotency_key(request)
        body, parsed = await read_body(request, model)
        fp = auth.fingerprint(request.method, request.url.path, body)

        def run() -> tuple[int, Any, bool]:
            replay = auth.reserve(db, ctx, key, fp)
            if replay is not None:
                return replay.status_code, replay.body, True
            try:
                with db.tx() as conn:
                    status, payload = handler(conn, ctx, parsed)
                    auth.store_response(conn, ctx, key, status, payload)
            except BaseException:
                auth.release(db, ctx, key)
                raise
            return status, payload, False

        status, payload, replayed = await anyio.to_thread.run_sync(run)
        headers = {"Idempotent-Replay": "true"} if replayed else None
        return JSONResponse(status_code=status, content=payload, headers=headers)

    @app.get("/v1/health")
    def health(request: Request) -> dict[str, Any]:
        context(request)
        with db.read() as conn:
            queue = jobs.queue_counts(conn)
            fresh = conn.execute("SELECT COUNT(*) AS n FROM workers WHERE heartbeat_at > ?",
                                 (time.time() - WORKER_STALE_S,)).fetchone()["n"]
        return {"service_version": SERVICE_VERSION, "worker_ready": fresh > 0, "queue": queue, **_versions()}

    @app.post("/v1/prepare")
    async def prepare(request: Request) -> JSONResponse:
        return await mutation(request, PrepareRequest,
                              lambda conn, ctx, req: (200, products.prepare(conn, ctx.business_id, req, config)))

    @app.post("/v1/products/status")
    async def product_status(request: Request) -> dict[str, Any]:
        ctx = context(request)
        _body, req = await read_body(request, StatusRequest)

        def run() -> dict[str, Any]:
            with db.read() as conn:
                return products.status(conn, ctx.business_id, req)

        return await anyio.to_thread.run_sync(run)

    @app.get("/v1/masters/{master_id}")
    def get_master(request: Request, master_id: str) -> dict[str, Any]:
        ctx = context(request)
        with db.read() as conn:
            return products.master_view(conn, ctx.business_id, master_id)

    @app.post("/v1/batches")
    async def create_batch(request: Request) -> JSONResponse:
        return await mutation(request, BatchRequest, lambda conn, ctx, req: (
            201, batches.create_batch(conn, ctx.business_id, ctx.actor, req, config)))

    @app.post("/v1/batches/{batch_id}/nest")
    async def nest(request: Request, batch_id: str) -> JSONResponse:
        return await mutation(request, None, lambda conn, ctx, _req: (
            202, batches.request_nest(conn, ctx.business_id, batch_id, config)))

    @app.get("/v1/batches")
    def list_batches(request: Request, limit: int = 50) -> dict[str, Any]:
        ctx = context(request)
        with db.read() as conn:
            return batches.list_batches(conn, ctx.business_id, max(1, min(limit, 200)))

    @app.get("/v1/batches/{batch_id}")
    def get_batch(request: Request, batch_id: str) -> dict[str, Any]:
        ctx = context(request)
        with db.read() as conn:
            return batches.batch_view(conn, ctx.business_id, batch_id)

    @app.get("/v1/jobs")
    def list_jobs(request: Request, kind: str | None = None, limit: int = 50) -> dict[str, Any]:
        ctx = context(request)
        if kind is not None and kind not in ("trace", "nest"):
            raise ServiceError("VALIDATION_ERROR", "kind must be 'trace' or 'nest'.", {"kind": kind})
        limit = max(1, min(limit, 200))
        with db.read() as conn:
            if kind:
                rows = conn.execute("SELECT * FROM jobs WHERE business_id = ? AND kind = ?"
                                    " ORDER BY created_at DESC, id LIMIT ?", (ctx.business_id, kind, limit))
            else:
                rows = conn.execute("SELECT * FROM jobs WHERE business_id = ? ORDER BY created_at DESC, id LIMIT ?",
                                    (ctx.business_id, limit))
            return {"items": [jobs.job_view(r) for r in rows]}

    @app.get("/v1/jobs/{job_id}")
    def get_job(request: Request, job_id: str) -> dict[str, Any]:
        ctx = context(request)
        with db.read() as conn:
            return jobs.job_view(jobs.get_job(conn, ctx.business_id, job_id))

    @app.post("/v1/jobs/{job_id}/cancel")
    async def cancel_job(request: Request, job_id: str) -> JSONResponse:
        def handler(conn: Any, ctx: auth.Context, _req: Any) -> tuple[int, Any]:
            row = jobs.request_cancel(conn, ctx.business_id, job_id)
            if row["status"] == "cancelled":
                _after_cancel(conn, row)
            return 200, jobs.job_view(row)

        return await mutation(request, None, handler)

    @app.get("/v1/artifacts/{artifact_id}")
    def get_artifact_file(request: Request, artifact_id: str) -> FileResponse:
        ctx = context(request)
        with db.read() as conn:
            row = get_artifact(conn, ctx.business_id, artifact_id)
        path = config.artifacts_dir / row["sha256"][:2] / row["sha256"]
        if not path.is_file():
            raise ServiceError("NOT_FOUND", "The artifact file is missing from the data directory.",
                               {"artifact_id": artifact_id})
        filename = SAFE_FILENAME.sub("_", row["filename"])[:200] or "artifact"
        return FileResponse(path, media_type=row["content_type"],
                            headers={"Content-Disposition": f'attachment; filename="{filename}"',
                                     "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})

    return app


def _after_cancel(conn: Any, job: Any) -> None:
    """A queued job cancelled before it ran still has to settle its owner record."""
    error = {"code": "CANCELLED", "message": "The job was cancelled before it started.", "details": {}}
    if job["kind"] == "trace":
        products.trace_failed(conn, job, error)
    else:
        batches.nest_failed(conn, job, error, "cancelled")


def _clean_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")} for e in errors]
