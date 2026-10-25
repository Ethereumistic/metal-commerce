from __future__ import annotations

import itertools
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from artwork_service.api import create_app
from artwork_service.catalog_source import FetchedSource, inspect_image
from artwork_service.config import Config
from artwork_service.errors import ServiceError
from artwork_service.storage import Database
from artwork_service.worker import Worker

FIXTURES = Path(__file__).parent / "fixtures"
SYNTHETIC = FIXTURES / "synthetic"
REAL = FIXTURES / "real"
TOKEN = "test-token-0123456789abcdef"
MEDIA = "https://convex.echoray.io/api/storage/"


class DictFetcher:
    """Test-only fetcher: serves registered bytes by URL (never used in production)."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.calls: list[str] = []

    def add(self, name: str, data: bytes) -> str:
        url = MEDIA + name
        self.data[url] = data
        return url

    def fetch(self, url: str) -> FetchedSource:
        self.calls.append(url)
        if url not in self.data:
            raise ServiceError("SOURCE_UNAVAILABLE", "The image host answered HTTP 404.", {"status": 404})
        return inspect_image(self.data[url], 60_000_000)


@pytest.fixture
def config(tmp_path: Path) -> Config:
    cfg = Config(data_dir=tmp_path / "data", token=TOKEN, lease_seconds=5, heartbeat_seconds=0.1,
                 poll_seconds=0.02, min_free_bytes=0)
    cfg.ensure_dirs()
    Database(cfg.db_path).init()
    return cfg


@pytest.fixture
def fetcher() -> DictFetcher:
    return DictFetcher()


@pytest.fixture
def worker(config: Config, fetcher: DictFetcher) -> Worker:
    return Worker(config, fetcher=fetcher, worker_id="test-worker")


@pytest.fixture
def client(config: Config) -> TestClient:
    return TestClient(create_app(config))


_keys = itertools.count()


def headers(business: str = "biz-a", *, edit: bool = True, key: str | None = None,
            token: str = TOKEN) -> dict[str, str]:
    h = {"Authorization": f"Bearer {token}", "X-Artwork-Business-Id": business, "X-Artwork-Actor": "user-1",
         "X-Artwork-Can-Edit": "true" if edit else "false"}
    h["Idempotency-Key"] = key or f"test-key-{next(_keys):06d}"
    return h


def product(pid: str, url: str | None, identity: str | None = None, version: str | None = "v1") -> dict[str, Any]:
    return {
        "product_id": pid, "product_revision": 1, "name": f"Product {pid}", "slug": pid,
        "source": None if url is None else {"gallery_index": 0, "source_identity": identity or f"lib:{pid}",
                                            "source_version": version, "original_url": url,
                                            "width": None, "height": None},
    }


def synthetic(name: str) -> bytes:
    return (SYNTHETIC / f"{name}.png").read_bytes()


def prepare_ready(client: TestClient, worker: Worker, fetcher: DictFetcher, pid: str, fixture: str,
                  business: str = "biz-a") -> str:
    """Prepare one product end to end and return its master id."""
    url = fetcher.add(f"{pid}-{fixture}", synthetic(fixture))
    r = client.post("/v1/prepare", json={"products": [product(pid, url)]}, headers=headers(business))
    assert r.status_code == 200, r.text
    worker.run_until_empty()
    r = client.post("/v1/products/status", json={"products": [
        {"product_id": pid, "source_identity": f"lib:{pid}", "source_version": "v1"}]}, headers=headers(business))
    item = r.json()["items"][0]
    assert item["status"] == "ready", item
    return item["master_id"]
