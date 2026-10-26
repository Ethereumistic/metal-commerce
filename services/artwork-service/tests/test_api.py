"""Auth, scoping, idempotency and the prepare -> master flow over HTTP."""

from __future__ import annotations

from conftest import TOKEN, headers, prepare_ready, product, synthetic


def test_health_requires_token_and_business(client) -> None:
    assert client.get("/v1/health").json()["error"]["code"] == "UNAUTHORIZED"
    r = client.get("/v1/health", headers={"Authorization": "Bearer wrong-token-xxxxxxxx", "X-Artwork-Business-Id": "b"})
    assert r.status_code == 401
    r = client.get("/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 401
    r = client.get("/v1/health", headers=headers())
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"service_version", "worker_ready", "queue", "tracer_version", "solver_version",
                         "exporter_version"}
    assert body["queue"] == {"queued": 0, "running": 0}
    assert TOKEN not in r.text


def test_unknown_routes_and_bad_bodies_use_error_envelope(client) -> None:
    r = client.get("/v1/nope", headers=headers())
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"
    r = client.post("/v1/prepare", json={"products": []}, headers=headers())
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"
    r = client.post("/v1/products/status", json={"products": [{"product_id": "x"}]})
    assert r.status_code == 401  # auth is checked before the body


def test_mutations_require_edit_and_idempotency_key(client, fetcher) -> None:
    body = {"products": [product("p1", fetcher.add("p1", synthetic("ring")))]}
    r = client.post("/v1/prepare", json=body, headers=headers(edit=False))
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"
    h = headers()
    del h["Idempotency-Key"]
    r = client.post("/v1/prepare", json=body, headers=h)
    assert r.status_code == 422 and "Idempotency-Key" in r.json()["error"]["message"]


def test_idempotent_replay_and_conflict(client, fetcher) -> None:
    body = {"products": [product("p1", fetcher.add("p1", synthetic("ring")))]}
    h = headers(key="prepare-key-0001")
    first = client.post("/v1/prepare", json=body, headers=h)
    again = client.post("/v1/prepare", json=body, headers=h)
    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()
    assert again.headers.get("Idempotent-Replay") == "true"
    changed = {"products": [product("p2", fetcher.add("p2", synthetic("ring")))]}
    r = client.post("/v1/prepare", json=changed, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    # Keys are scoped per business: another business may reuse the same key.
    r = client.post("/v1/prepare", json=changed, headers=headers("biz-b", key="prepare-key-0001"))
    assert r.status_code == 200
    jobs = client.get("/v1/jobs?kind=trace", headers=headers()).json()["items"]
    assert len(jobs) == 1  # the replay did not enqueue a second job


def test_prepare_trace_master_and_artifacts(client, worker, fetcher) -> None:
    master_id = prepare_ready(client, worker, fetcher, "p1", "l_with_hole")
    m = client.get(f"/v1/masters/{master_id}", headers=headers()).json()
    assert m["product_id"] == "p1" and m["revision"] == 1
    assert m["holes"] == 1 and m["components"] == 1
    assert abs(m["aspect_ratio"] - 400 / 300) < 0.01
    assert m["source"]["gallery_index"] == 0 and len(m["source"]["byte_sha256"]) == 64
    assert m["trace_engine"] == "opencv-contours"
    assert set(m["diagnostics"]) >= {"threshold", "candidates", "noise_removed_area_px", "warnings"}
    for kind, ctype in (("overlay_png", "image/png"), ("solid_png", "image/png"),
                        ("master_json", "application/json"), ("master_svg", "image/svg+xml")):
        r = client.get(f"/v1/artifacts/{m['artifacts'][kind]}", headers=headers())
        assert r.status_code == 200 and r.headers["content-type"].startswith(ctype)
        assert r.headers["content-disposition"].startswith("attachment; filename=")
    job = client.get("/v1/jobs?kind=trace", headers=headers()).json()["items"][0]
    assert job["status"] == "succeeded" and job["result"] == {"master_id": master_id}
    assert job["progress"] == 1 and job["attempts"] == 1


def test_other_business_cannot_see_anything(client, worker, fetcher) -> None:
    master_id = prepare_ready(client, worker, fetcher, "p1", "ring")
    m = client.get(f"/v1/masters/{master_id}", headers=headers()).json()
    job_id = client.get("/v1/jobs", headers=headers()).json()["items"][0]["id"]
    other = headers("biz-b")
    assert client.get(f"/v1/masters/{master_id}", headers=other).status_code == 404
    assert client.get(f"/v1/artifacts/{m['artifacts']['overlay_png']}", headers=other).status_code == 404
    assert client.get(f"/v1/jobs/{job_id}", headers=other).status_code == 404
    assert client.post(f"/v1/jobs/{job_id}/cancel", headers=other).status_code == 404
    assert client.get("/v1/jobs", headers=other).json()["items"] == []
    st = client.post("/v1/products/status", json={"products": [{"product_id": "p1", "source_identity": "lib:p1",
                                                                "source_version": "v1"}]}, headers=other)
    assert st.json()["items"][0]["status"] == "unprepared"
    assert client.get("/v1/artifacts/does-not-exist", headers=headers()).status_code == 404


def test_no_first_image_and_unavailable_source(client, worker, fetcher) -> None:
    r = client.post("/v1/prepare", json={"products": [product("p1", None),
                                                      product("p2", "https://convex.echoray.io/api/storage/missing")]},
                    headers=headers())
    items = {i["product_id"]: i for i in r.json()["items"]}
    assert items["p1"]["status"] == "failed" and items["p1"]["error"]["code"] == "NO_FIRST_IMAGE"
    assert items["p2"]["status"] == "queued"
    worker.run_until_empty()
    st = client.post("/v1/products/status", json={"products": [{"product_id": "p2", "source_identity": "lib:p2",
                                                                "source_version": "v1"}]}, headers=headers())
    item = st.json()["items"][0]
    assert item["status"] == "failed" and item["error"]["code"] == "SOURCE_UNAVAILABLE"


def test_ready_product_is_not_retraced_and_change_marks_stale(client, worker, fetcher) -> None:
    master_id = prepare_ready(client, worker, fetcher, "p1", "ring")
    url = next(iter(fetcher.data))
    r = client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    assert r.json()["items"][0] == {"product_id": "p1", "status": "ready", "master_id": master_id, "job_id": None,
                                    "error": None}
    assert worker.run_until_empty() == []
    # The first image was replaced in the catalog: status reports stale without enqueueing.
    st = client.post("/v1/products/status", json={"products": [{"product_id": "p1", "source_identity": "lib:other",
                                                                "source_version": "v1"}]}, headers=headers())
    item = st.json()["items"][0]
    assert item["status"] == "stale" and item["master_id"] == master_id
    assert item["error"]["code"] == "MASTER_STALE"
    assert client.get("/v1/jobs", headers=headers()).json()["items"][0]["kind"] == "trace"
    assert len(client.get("/v1/jobs", headers=headers()).json()["items"]) == 1
    # Preparing with the new image creates a new revision; the old master is preserved.
    new_url = fetcher.add("p1-new", synthetic("l_with_hole"))
    r = client.post("/v1/prepare", json={"products": [product("p1", new_url, identity="lib:other")]},
                    headers=headers())
    assert r.json()["items"][0]["status"] == "queued"
    worker.run_until_empty()
    st = client.post("/v1/products/status", json={"products": [{"product_id": "p1", "source_identity": "lib:other",
                                                                "source_version": "v1"}]}, headers=headers())
    new_master = st.json()["items"][0]["master_id"]
    assert new_master != master_id
    assert client.get(f"/v1/masters/{new_master}", headers=headers()).json()["revision"] == 2
    assert client.get(f"/v1/masters/{master_id}", headers=headers()).status_code == 200


def test_signed_url_query_is_not_exposed(client, worker, fetcher) -> None:
    url = fetcher.add("p1?token=secret-signature", synthetic("ring"))
    client.post("/v1/prepare", json={"products": [product("p1", url)]}, headers=headers())
    worker.run_until_empty()
    st = client.post("/v1/products/status", json={"products": [{"product_id": "p1", "source_identity": "lib:p1",
                                                                "source_version": "v1"}]}, headers=headers())
    m = client.get(f"/v1/masters/{st.json()['items'][0]['master_id']}", headers=headers())
    assert "secret-signature" not in m.text


def test_trace_jobs_keep_their_product_identity_after_a_retry(client, worker, fetcher) -> None:
    missing = "https://convex.echoray.io/api/storage/missing"
    first = {**product("p1", missing), "name": "Leaf Shuriken", "slug": "leaf-shuriken",
             "thumbnail_url": "https://convex.echoray.io/api/storage/thumb-1"}
    client.post("/v1/prepare", json={"products": [first]}, headers=headers())
    worker.run_until_empty()
    # The retry renames the product and points at a new image and thumbnail.
    retry = {**product("p1", fetcher.add("p1", synthetic("ring")), identity="lib:p1-new"),
             "name": "Leaf Four-Point Shuriken", "slug": "leaf-four-point",
             "thumbnail_url": "https://convex.echoray.io/api/storage/thumb-2"}
    client.post("/v1/prepare", json={"products": [retry]}, headers=headers())
    worker.run_until_empty()

    items = client.get("/v1/jobs?kind=trace", headers=headers()).json()["items"]
    by_status = {job["status"]: job for job in items}
    failed, succeeded = by_status["failed"], by_status["succeeded"]
    assert {k: failed[k] for k in ("product_id", "product_name", "product_slug", "product_thumbnail_url")} == {
        "product_id": "p1", "product_name": "Leaf Shuriken", "product_slug": "leaf-shuriken",
        "product_thumbnail_url": "https://convex.echoray.io/api/storage/thumb-1"}
    assert succeeded["product_name"] == "Leaf Four-Point Shuriken"
    assert succeeded["product_thumbnail_url"] == "https://convex.echoray.io/api/storage/thumb-2"
    single = client.get(f"/v1/jobs/{failed['id']}", headers=headers()).json()
    assert single["product_name"] == "Leaf Shuriken" and single["product_slug"] == "leaf-shuriken"


def test_trace_job_without_thumbnail_still_names_its_product(client, worker, fetcher) -> None:
    prepare_ready(client, worker, fetcher, "p1", "ring")
    job = client.get("/v1/jobs", headers=headers()).json()["items"][0]
    assert job["product_id"] == "p1" and job["product_name"] == "Product p1" and job["product_slug"] == "p1"
    assert job["product_thumbnail_url"] is None


def test_thumbnail_url_must_be_http(client, fetcher) -> None:
    body = {"products": [{**product("p1", fetcher.add("p1", synthetic("ring"))), "thumbnail_url": "javascript:x"}]}
    r = client.post("/v1/prepare", json=body, headers=headers())
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"
