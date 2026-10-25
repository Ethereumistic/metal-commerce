"""Trace-once caching, durable job recovery, cancellation and failure states."""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import replace

import pytest

from artwork_service import jobs, products
from artwork_service.storage import Database
from artwork_service.tracing import get_tracer
from artwork_service.worker import Worker

from conftest import headers, prepare_ready, product, synthetic


class CountingTracer:
    def __init__(self, delay: float = 0.0) -> None:
        self.inner = get_tracer()
        self.engine, self.version = self.inner.engine, self.inner.version
        self.calls = 0
        self.delay = delay
        self.lock = threading.Lock()

    def trace(self, data, settings):
        with self.lock:
            self.calls += 1
        time.sleep(self.delay)
        return self.inner.trace(data, settings)


@pytest.fixture
def tracer(monkeypatch) -> CountingTracer:
    counting = CountingTracer(delay=0.4)
    monkeypatch.setattr(products, "get_tracer", lambda: counting)
    return counting


def status_item(client, pid, identity=None, business="biz-a"):
    r = client.post("/v1/products/status", json={"products": [
        {"product_id": pid, "source_identity": identity or f"lib:{pid}", "source_version": "v1"}]},
        headers=headers(business))
    return r.json()["items"][0]


def test_concurrent_duplicate_prepares_trace_once(client, config, fetcher, tracer) -> None:
    data = synthetic("l_with_hole")
    urls = [fetcher.add(f"copy-{i}", data) for i in range(2)]
    body = {"products": [product("p1", urls[0]), product("p2", urls[1])]}
    r = client.post("/v1/prepare", json=body, headers=headers())
    assert [i["status"] for i in r.json()["items"]] == ["queued", "queued"]
    # The same product submitted again while queued converges on the same job.
    again = client.post("/v1/prepare", json={"products": [product("p1", urls[0])]}, headers=headers())
    assert again.json()["items"][0]["job_id"] == r.json()["items"][0]["job_id"]

    workers = [Worker(config, fetcher=fetcher, worker_id=f"w{i}") for i in range(2)]
    threads = [threading.Thread(target=w.run_once) for w in workers]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert tracer.calls == 1
    m1, m2 = status_item(client, "p1")["master_id"], status_item(client, "p2")["master_id"]
    assert m1 == m2 is not None
    job_list = client.get("/v1/jobs?kind=trace", headers=headers()).json()["items"]
    assert sorted(j["cache_hit"] for j in job_list) == [False, True]
    assert all(j["status"] == "succeeded" for j in job_list)
    # Product associations stay per product even though the master is shared.
    with Database(config.db_path).read() as conn:
        links = conn.execute("SELECT product_id, revision FROM product_masters ORDER BY product_id").fetchall()
    assert [(row["product_id"], row["revision"]) for row in links] == [("p1", 1), ("p2", 1)]


def test_reprocess_with_unchanged_bytes_reuses_master(client, worker, fetcher, tracer) -> None:
    master_id = prepare_ready(client, worker, fetcher, "p1", "ring")
    url = next(iter(fetcher.data))
    r = client.post("/v1/prepare", json={"products": [product("p1", url)], "reprocess": True}, headers=headers())
    assert r.json()["items"][0]["status"] == "queued"
    worker.run_until_empty()
    assert tracer.calls == 1  # bytes were refetched, the cache key matched, nothing retraced
    assert len(fetcher.calls) == 2
    assert status_item(client, "p1")["master_id"] == master_id


def test_restart_recovers_abandoned_job(client, config, worker, fetcher) -> None:
    url = fetcher.add("p1", synthetic("ring"))
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    db = Database(config.db_path)
    # A worker leased the job and died without finishing it.
    dead = jobs.lease_next(db, "dead-worker", lease_seconds=60)
    assert dead["status"] == "running" and dead["attempts"] == 1
    assert worker.run_once() is None  # lease still valid: nobody else may run it
    with db.tx() as conn:
        assert jobs.recover_expired(conn, all_running=True) == 1  # service start
    row = client.get(f"/v1/jobs/{dead['id']}", headers=headers()).json()
    assert row["status"] == "queued"
    assert worker.run_once() == dead["id"]
    row = client.get(f"/v1/jobs/{dead['id']}", headers=headers()).json()
    assert row["status"] == "succeeded" and row["attempts"] == 2
    assert status_item(client, "p1")["status"] == "ready"


def test_expired_lease_is_recovered_and_attempts_are_bounded(client, config, fetcher) -> None:
    url = fetcher.add("p1", synthetic("ring"))
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    db = Database(config.db_path)
    for attempt in range(1, config.max_attempts + 1):
        job = jobs.lease_next(db, f"crashy-{attempt}", lease_seconds=-1)  # lease already expired
        assert job["attempts"] == attempt
    with db.tx() as conn:
        jobs.recover_expired(conn)
    row = client.get(f"/v1/jobs/{job['id']}", headers=headers()).json()
    assert row["status"] == "failed" and row["error"]["code"] == "TIMEOUT"


def test_cancel_queued_job_is_immediate_and_idempotent(client, worker, fetcher) -> None:
    url = fetcher.add("p1", synthetic("ring"))
    job_id = client.post("/v1/prepare", json={"products": [product("p1", url)]},
                         headers=headers()).json()["items"][0]["job_id"]
    for _ in range(2):
        r = client.post(f"/v1/jobs/{job_id}/cancel", headers=headers())
        assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert worker.run_once() is None
    item = status_item(client, "p1")
    assert item["status"] == "failed" and item["error"]["code"] == "CANCELLED"


def test_cancel_running_job_at_checkpoint(client, config, fetcher, monkeypatch) -> None:
    url = fetcher.add("p1", synthetic("ring"))
    job_id = client.post("/v1/prepare", json={"products": [product("p1", url)]},
                         headers=headers()).json()["items"][0]["job_id"]
    started = threading.Event()

    class SlowTracer(CountingTracer):
        def trace(self, data, settings):
            started.set()
            time.sleep(0.5)
            return super().trace(data, settings)

    monkeypatch.setattr(products, "get_tracer", lambda: SlowTracer())
    w = Worker(config, fetcher=fetcher, worker_id="w-cancel")
    t = threading.Thread(target=w.run_once)
    t.start()
    assert started.wait(10)
    r = client.post(f"/v1/jobs/{job_id}/cancel", headers=headers())
    assert r.json()["status"] == "running"  # honoured at the next checkpoint
    t.join(30)
    row = client.get(f"/v1/jobs/{job_id}", headers=headers()).json()
    assert row["status"] == "cancelled" and row["error"]["code"] == "CANCELLED"
    with Database(config.db_path).read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM masters").fetchone()[0] == 0  # nothing half-published
        assert conn.execute("SELECT COUNT(*) FROM master_builds").fetchone()[0] == 0


def test_malformed_image_fails_explicitly(client, worker, fetcher) -> None:
    data = synthetic("ring")
    url = fetcher.add("broken", data[: len(data) // 3])
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    worker.run_until_empty()
    item = status_item(client, "p1")
    assert item["status"] == "failed" and item["error"]["code"] == "UNSUPPORTED_FORMAT"


def test_trace_failure_codes_reach_the_product(client, worker, fetcher) -> None:
    url = fetcher.add("clipped", synthetic("clipped"))
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    worker.run_until_empty()
    item = status_item(client, "p1")
    assert item["status"] == "failed" and item["error"]["code"] == "OBJECT_CLIPPED"


def test_insufficient_disk_fails_without_partial_master(client, config, fetcher) -> None:
    url = fetcher.add("p1", synthetic("ring"))
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    full = Worker(replace(config, min_free_bytes=1 << 62), fetcher=fetcher, worker_id="w-full")
    full.run_until_empty()
    item = status_item(client, "p1")
    assert item["status"] == "failed" and item["error"]["code"] == "INSUFFICIENT_DISK"
    with Database(config.db_path).read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM masters").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 0
    assert not any(p.suffix == ".tmp" for p in config.tmp_dir.iterdir())


def test_job_state_machine_is_enforced_by_database(client, config, worker, fetcher) -> None:
    prepare_ready(client, worker, fetcher, "p1", "ring")
    with Database(config.db_path).tx() as conn:
        job_id = conn.execute("SELECT id FROM jobs").fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE jobs SET status = 'running' WHERE id = ?", (job_id,))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE jobs SET status = 'queued' WHERE id = ?", (job_id,))


def test_disk_full_while_writing_artifacts(client, config, worker, fetcher, monkeypatch) -> None:
    import errno

    from artwork_service import storage

    def enospc(final, data, *, tmp_dir, min_free_bytes):
        raise storage.InsufficientDisk("The artwork data disk is full; free space and retry.",
                                       {"errno": errno.ENOSPC})

    # Source bytes are cached through products.write_atomic; only artifact writes fail.
    monkeypatch.setattr(storage, "write_atomic", enospc)
    url = fetcher.add("p1", synthetic("ring"))
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    worker.run_until_empty()
    item = status_item(client, "p1")
    assert item["status"] == "failed" and item["error"]["code"] == "INSUFFICIENT_DISK"
    with Database(config.db_path).read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM masters").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM master_builds").fetchone()[0] == 0
    # After space is freed, preparing again succeeds.
    monkeypatch.undo()
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    worker.run_until_empty()
    assert status_item(client, "p1")["status"] == "ready"
