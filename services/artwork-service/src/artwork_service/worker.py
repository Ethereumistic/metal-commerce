"""CPU worker: leases jobs from the durable queue and runs them.

Workers run in their own processes (never in the API event loop). While a job
runs, a heartbeat thread extends its lease, flushes progress and picks up
cancellation requests; handlers call `checkpoint()` between stages, which
raises when the job was cancelled, timed out or lost its lease. A job's result
is published in the same transaction that marks it succeeded.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import signal
import socket
import sqlite3
import threading
import time
import traceback
from typing import Any, Callable

from . import jobs
from .catalog_source import HttpSourceFetcher, SourceFetcher
from .config import Config
from .errors import JobCancelled, JobTimeout, ServiceError
from .storage import ArtifactStore, Database, new_id, utcnow

log = logging.getLogger(__name__)


class JobContext:
    def __init__(self, db: Database, config: Config, store: ArtifactStore, fetcher: SourceFetcher,
                 job: sqlite3.Row, owner: str) -> None:
        self.db = db
        self.config = config
        self.store = store
        self.fetcher = fetcher
        self.job = job
        self.job_id: str = job["id"]
        self.owner = owner
        self.deadline = time.monotonic() + float(job["timeout_s"])
        self.completed = False
        self._cancel = bool(job["cancel_requested"])
        self._lease_lost = False
        self._progress: float | None = None
        self._stage: str | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._beat, name=f"heartbeat-{self.job_id[:8]}", daemon=True)

    # -- heartbeat thread
    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _beat(self) -> None:
        while not self._stop.wait(self.config.heartbeat_seconds):
            with self._lock:
                progress, stage = self._progress, self._stage
            try:
                cancel = jobs.heartbeat(self.db, self.job_id, self.owner, self.config.lease_seconds,
                                        progress=progress, stage=stage)
            except jobs.LeaseLost:
                self._lease_lost = True
                return
            except sqlite3.Error:
                log.exception("heartbeat for job %s failed; retrying", self.job_id)
                continue
            if cancel:
                self._cancel = True

    # -- handler API
    def report(self, progress: float, stage: str) -> None:
        """Record progress cheaply; the heartbeat thread persists it."""
        with self._lock:
            self._progress, self._stage = progress, stage

    def is_cancelled(self) -> bool:
        """Cancel callback for long-running engines (cancel, timeout or lost lease)."""
        return self._cancel or self._lease_lost or time.monotonic() > self.deadline

    def checkpoint(self, progress: float | None = None, stage: str | None = None) -> None:
        if self._lease_lost:
            raise jobs.LeaseLost(self.job_id)
        if time.monotonic() > self.deadline:
            raise JobTimeout(self.job_id)
        if progress is not None or stage is not None:
            with self._lock:
                if progress is not None:
                    self._progress = progress
                if stage is not None:
                    self._stage = stage
        cancel = jobs.heartbeat(self.db, self.job_id, self.owner, self.config.lease_seconds,
                                progress=progress, stage=stage)
        if cancel or self._cancel:
            raise JobCancelled(self.job_id)

    def complete(self, conn: sqlite3.Connection, result: dict[str, Any], *, cache_hit: bool = False) -> None:
        """Mark success inside the transaction that publishes the job's result."""
        jobs.finish(conn, self.job_id, self.owner, status="succeeded", result=result, cache_hit=cache_hit)
        self.completed = True


Handler = Callable[[JobContext], None]
FailureHook = Callable[[sqlite3.Connection, sqlite3.Row, dict[str, Any], str], None]


def _handlers() -> dict[str, tuple[Handler, FailureHook]]:
    from . import batches, products

    return {
        "trace": (products.run_trace_job, lambda conn, job, err, status: products.trace_failed(conn, job, err)),
        "nest": (batches.run_nest_job, batches.nest_failed),
    }


class Worker:
    def __init__(self, config: Config, *, fetcher: SourceFetcher | None = None, worker_id: str | None = None) -> None:
        self.config = config
        self.db = Database(config.db_path)
        self.store = ArtifactStore(config)
        self.fetcher = fetcher or HttpSourceFetcher(config)
        self.id = worker_id or f"{socket.gethostname()}:{os.getpid()}:{new_id()[:8]}"
        self.handlers = _handlers()

    def register(self) -> None:
        with self.db.tx() as conn:
            conn.execute("INSERT OR REPLACE INTO workers (id, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?)",
                         (self.id, os.getpid(), utcnow(), time.time()))

    def touch(self) -> None:
        with self.db.tx() as conn:
            conn.execute("UPDATE workers SET heartbeat_at = ? WHERE id = ?", (time.time(), self.id))

    def unregister(self) -> None:
        with self.db.tx() as conn:
            conn.execute("DELETE FROM workers WHERE id = ?", (self.id,))

    def run_once(self) -> str | None:
        """Lease and run one job; returns its id, or None when the queue is empty."""
        job = jobs.lease_next(self.db, self.id, self.config.lease_seconds)
        if job is None:
            return None
        self._run(job)
        return job["id"]

    def run_until_empty(self, limit: int = 100) -> list[str]:
        done = []
        for _ in range(limit):
            job_id = self.run_once()
            if job_id is None:
                break
            done.append(job_id)
        return done

    def _run(self, job: sqlite3.Row) -> None:
        handler, on_failure = self.handlers[job["kind"]]
        ctx = JobContext(self.db, self.config, self.store, self.fetcher, job, self.id)
        log.info("job %s (%s) started, attempt %s", job["id"], job["kind"], job["attempts"])
        ctx.start()
        try:
            handler(ctx)
            if not ctx.completed:
                raise RuntimeError(f"{job['kind']} handler returned without completing the job")
            log.info("job %s succeeded", job["id"])
        except jobs.LeaseLost:
            log.warning("job %s lost its lease; another worker or restart recovered it", job["id"])
        except JobCancelled:
            self._fail(job, on_failure, "cancelled", {"code": "CANCELLED", "message": "The job was cancelled.",
                                                      "details": {}})
        except JobTimeout:
            self._fail(job, on_failure, "failed", {
                "code": "TIMEOUT", "message": "The job exceeded its time limit.",
                "details": {"timeout_s": job["timeout_s"]}})
        except ServiceError as exc:
            self._fail(job, on_failure, "failed", exc.to_dict())
        except Exception:
            log.error("job %s crashed:\n%s", job["id"], traceback.format_exc())
            self._fail(job, on_failure, "failed", {
                "code": "INTERNAL_ERROR", "message": "The job failed unexpectedly; see the service log.",
                "details": {}})
        finally:
            ctx.stop()

    def _fail(self, job: sqlite3.Row, on_failure: FailureHook, status: str, error: dict[str, Any]) -> None:
        log.info("job %s %s: %s", job["id"], status, error.get("code"))
        try:
            with self.db.tx() as conn:
                jobs.finish(conn, job["id"], self.id, status=status, error=error)
                on_failure(conn, job, error, status)
        except jobs.LeaseLost:
            log.warning("job %s lost its lease before its failure could be recorded", job["id"])

    def run_forever(self, stop: Callable[[], bool]) -> None:
        self.register()
        try:
            while not stop():
                try:
                    if self.run_once() is None:
                        self.touch()
                        time.sleep(self.config.poll_seconds)
                except sqlite3.Error:
                    log.exception("worker %s database error; backing off", self.id)
                    time.sleep(2.0)
        finally:
            self.unregister()


def worker_main(config_data: dict[str, Any], stop_event: Any) -> None:
    """Entry point of a worker process (spawned by the supervisor)."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the supervisor coordinates shutdown
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s worker[%(process)d] %(name)s: %(message)s")
    parent = os.getppid()
    worker = Worker(Config.from_dict(config_data))
    # Also stop if the supervisor died without signalling (never orphan a worker).
    worker.run_forever(lambda: stop_event.is_set() or os.getppid() != parent)


class Supervisor:
    """Keeps `worker_concurrency` worker processes alive until stopped."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.ctx = multiprocessing.get_context("spawn")
        self.stop_event = self.ctx.Event()
        self.procs: list[Any] = []
        self._monitor: threading.Thread | None = None

    def _spawn(self) -> Any:
        proc = self.ctx.Process(target=worker_main, args=(self.config.to_dict(), self.stop_event),
                                name="artwork-worker", daemon=True)
        proc.start()
        return proc

    def start(self) -> None:
        self.procs = [self._spawn() for _ in range(self.config.worker_concurrency)]
        self._monitor = threading.Thread(target=self._watch, name="worker-monitor", daemon=True)
        self._monitor.start()

    def _watch(self) -> None:
        while not self.stop_event.wait(2.0):
            for i, proc in enumerate(self.procs):
                if not proc.is_alive():
                    log.warning("worker process %s exited with %s; restarting", proc.pid, proc.exitcode)
                    self.procs[i] = self._spawn()

    def stop(self, grace_s: float = 10.0) -> None:
        self.stop_event.set()
        deadline = time.monotonic() + grace_s
        for proc in self.procs:
            proc.join(timeout=max(0.0, deadline - time.monotonic()))
        for proc in self.procs:
            if proc.is_alive():
                # The running job keeps its lease and is requeued on next start.
                proc.terminate()
                proc.join(timeout=5)
