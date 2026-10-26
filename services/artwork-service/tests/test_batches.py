"""Batch creation (sizing snapshot, fit pre-check, groups) and nest-job wiring."""

from __future__ import annotations

import io
import zipfile

import pytest

import stub_engine
from conftest import headers, prepare_ready

STOCK = {"width_mm": 1500, "height_mm": 3000, "margins_mm": {"left": 10, "right": 10, "bottom": 10, "top": 10},
         "gap_mm": 5, "max_sheets": 10, "label": "current 1500x3000"}


def line(line_id, pid, master, *, width=200.0, qty=1, material="steel", thickness=2.0, rotations=None,
         mode="width", height=None):
    return {"line_id": line_id, "product_id": pid, "master_id": master,
            "size": {"mode": mode, "width_mm": width, "height_mm": height}, "quantity": qty, "material": material,
            "thickness_mm": thickness, "allowed_rotations": rotations or [0, 90, 180, 270], "variant_id": None}


def batch(lines, stock=None, budget=10):
    return {"name": "test", "lines": lines, "stock": stock or STOCK,
            "optimization": {"time_budget_s": budget, "seed": 1}, "export": {"chord_tolerance_mm": 0.05}}


@pytest.fixture
def masters(client, worker, fetcher):
    return {"star": prepare_ready(client, worker, fetcher, "star", "l_with_hole"),
            "art": prepare_ready(client, worker, fetcher, "art", "ring")}


def test_batch_snapshot_sizes_and_groups(client, masters) -> None:
    r = client.post("/v1/batches", json=batch([
        line("a", "star", masters["star"], width=400, qty=44),
        line("b", "art", masters["art"], mode="fit", width=600, height=300, qty=10),
        line("c", "star", masters["star"], width=150, qty=2, material="aluminium", thickness=3),
    ]), headers=headers())
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "draft"
    lines = {line["line_id"]: line for line in body["lines"]}
    assert lines["a"]["actual_width_mm"] == 400 and lines["a"]["actual_height_mm"] == pytest.approx(300, abs=1.5)
    assert lines["b"]["actual_width_mm"] == pytest.approx(300, abs=1.5) and lines["b"]["actual_height_mm"] == 300
    assert all(line["fits"] and not line["errors"] for line in lines.values())
    assert lines["a"]["feature_check"]["status"] == "unknown"
    groups = {g["group_key"]: g for g in body["groups"]}
    assert groups["steel/2mm"]["line_ids"] == ["a", "b"] and groups["steel/2mm"]["instance_count"] == 54
    assert groups["aluminium/3mm"]["instance_count"] == 2
    view = client.get(f"/v1/batches/{body['batch_id']}", headers=headers()).json()
    assert view["status"] == "draft" and view["request"]["lines"][0]["quantity"] == 44
    assert view["snapshot"]["lines"][0]["master"]["master_id"] == masters["star"]
    assert view["artifacts"]["zip"] is None
    assert client.get(f"/v1/batches/{body['batch_id']}", headers=headers("biz-b")).status_code == 404


def test_part_that_cannot_fit_fails_before_nesting(client, masters) -> None:
    r = client.post("/v1/batches", json=batch([
        line("wide", "star", masters["star"], width=1500, rotations=[0, 180]),
        line("ok", "art", masters["art"], width=300),
    ]), headers=headers())
    body = r.json()
    assert body["status"] == "invalid"
    wide = body["lines"][0]
    assert not wide["fits"] and wide["errors"][0]["code"] == "PART_DOES_NOT_FIT"
    assert wide["errors"][0]["details"]["usable_width_mm"] == 1480
    assert wide["errors"][0]["details"]["part_width_mm"] == 1500
    r = client.post(f"/v1/batches/{body['batch_id']}/nest", headers=headers())
    assert r.status_code == 409


def test_unknown_or_foreign_master_is_a_line_error(client, masters, worker, fetcher) -> None:
    other = prepare_ready(client, worker, fetcher, "other", "ring", business="biz-b")
    r = client.post("/v1/batches", json=batch([
        line("x", "star", "no-such-master"),
        line("y", "star", other),
        line("z", "art", masters["star"]),  # exists, but belongs to another product
    ]), headers=headers())
    codes = [line["errors"][0]["code"] for line in r.json()["lines"]]
    assert codes == ["NOT_FOUND", "NOT_FOUND", "VALIDATION_ERROR"]


def test_batch_request_bounds_are_validated(client, masters) -> None:
    bad = batch([line("a", "star", masters["star"], qty=0)])
    assert client.post("/v1/batches", json=bad, headers=headers()).status_code == 422
    bad = batch([line("a", "star", masters["star"], rotations=[45])])
    assert client.post("/v1/batches", json=bad, headers=headers()).status_code == 422
    bad = batch([line("a", "star", masters["star"], qty=3000), line("b", "art", masters["art"], qty=3000)])
    assert client.post("/v1/batches", json=bad, headers=headers()).status_code == 422
    bad = batch([line("a", "star", masters["star"])], budget=45)
    assert client.post("/v1/batches", json=bad, headers=headers()).status_code == 422


def test_resizing_reuses_master_without_retracing(client, masters, worker, fetcher) -> None:
    fetch_calls = len(fetcher.calls)
    jobs_before = len(client.get("/v1/jobs?kind=trace", headers=headers()).json()["items"])
    for side in (600, 900, 1400):
        r = client.post("/v1/batches", json=batch([line("a", "art", masters["art"], width=side)]), headers=headers())
        assert r.json()["lines"][0]["actual_width_mm"] == side
    assert worker.run_until_empty() == []
    assert len(fetcher.calls) == fetch_calls
    assert len(client.get("/v1/jobs?kind=trace", headers=headers()).json()["items"]) == jobs_before


def test_nest_job_completes_with_exact_counts(client, masters, worker, monkeypatch) -> None:
    stub_engine.install(monkeypatch)
    created = client.post("/v1/batches", json=batch([
        line("a", "star", masters["star"], width=120, qty=44),
        line("b", "art", masters["art"], width=250, qty=10),
        line("c", "art", masters["art"], width=100, qty=3, material="aluminium", thickness=3),
    ]), headers=headers()).json()
    batch_id = created["batch_id"]
    r = client.post(f"/v1/batches/{batch_id}/nest", headers=headers())
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    # Asking again while queued returns the same durable job.
    assert client.post(f"/v1/batches/{batch_id}/nest", headers=headers()).json()["job_id"] == job_id
    assert client.get(f"/v1/batches/{batch_id}", headers=headers()).json()["status"] == "queued"
    worker.run_until_empty()

    job = client.get(f"/v1/jobs/{job_id}", headers=headers()).json()
    assert job["status"] == "succeeded" and job["result"] == {"batch_id": batch_id}
    assert job["product_id"] is None and job["product_name"] is None  # nest jobs have no single product
    view = client.get(f"/v1/batches/{batch_id}", headers=headers()).json()
    assert view["status"] == "completed"
    assert view["totals"]["requested"] == view["totals"]["placed"] == 57 and view["totals"]["unplaced"] == 0
    instances = [p["instance_id"] for s in view["sheets"] for p in s["placements"]]
    assert len(instances) == len(set(instances)) == 57
    assert sum(1 for i in instances if i.startswith("a#")) == 44
    assert sum(1 for i in instances if i.startswith("b#")) == 10
    assert {s["group_key"] for s in view["sheets"]} == {"steel/2mm", "aluminium/3mm"}
    assert 0 < view["totals"]["utilization"] < 1
    # Additive metrics: engine and leftover usable area per group, per sheet and in total.
    totals = view["totals"]
    assert totals["engine_by_group"] == {"steel/2mm": "stub-shelf", "aluminium/3mm": "stub-shelf"}
    per_sheet = [s["metrics"]["leftover_usable_area_mm2"] for s in view["sheets"]]
    assert all(v >= 0 for v in per_sheet)
    assert totals["leftover_usable_area_mm2"] == pytest.approx(sum(per_sheet), abs=0.01)
    assert sum(totals["leftover_usable_area_by_group_mm2"].values()) == pytest.approx(
        totals["leftover_usable_area_mm2"], abs=0.01)
    # Parts handed to the engine are sized from the master in mm with bbox origin at 0,0.
    star_part = next(p for c in stub_engine.calls for p in c["parts"] if p.line_id == "a")
    assert star_part.geometry.bounds[:2] == (0, 0) and star_part.geometry.bounds[2] == pytest.approx(120)
    assert star_part.instance_ids[0] == "a#0001" and len(star_part.instance_ids) == 44

    art = view["artifacts"]
    assert art["zip"] and art["manifest"] and all(s["dxf"] and s["svg"] for s in art["sheets"])
    z = client.get(f"/v1/artifacts/{art['zip']}", headers=headers())
    assert z.headers["content-type"] == "application/zip"
    assert f'filename="batch-{batch_id}.zip"' in z.headers["content-disposition"]
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert "manifest.json" in names and f"batch-{batch_id}-sheet-001-1500x3000mm.dxf" in names
    dxf = client.get(f"/v1/artifacts/{art['sheets'][0]['dxf']}", headers=headers())
    assert dxf.headers["content-type"] == "application/dxf"
    assert f'filename="batch-{batch_id}-sheet-001-1500x3000mm.dxf"' in dxf.headers["content-disposition"]
    # Completed batches are immutable.
    assert client.post(f"/v1/batches/{batch_id}/nest", headers=headers()).status_code == 409
    history = client.get("/v1/batches", headers=headers()).json()["items"]
    assert history[0]["batch_id"] == batch_id and history[0]["status"] == "completed"


def test_incomplete_nest_publishes_no_production_files(client, masters, worker, monkeypatch) -> None:
    stub_engine.install(monkeypatch)
    stock = {**STOCK, "max_sheets": 1}
    batch_id = client.post("/v1/batches", json=batch([line("a", "art", masters["art"], width=700, qty=20)], stock),
                           headers=headers()).json()["batch_id"]
    job_id = client.post(f"/v1/batches/{batch_id}/nest", headers=headers()).json()["job_id"]
    worker.run_until_empty()
    job = client.get(f"/v1/jobs/{job_id}", headers=headers()).json()
    assert job["status"] == "failed" and job["error"]["code"] == "NEST_INCOMPLETE"
    view = client.get(f"/v1/batches/{batch_id}", headers=headers()).json()
    assert view["status"] == "incomplete"
    t = view["totals"]
    assert t["requested"] == 20 and 0 < t["placed"] < 20 and t["unplaced"] == 20 - t["placed"]
    assert view["artifacts"]["zip"] is None
    assert all(s["dxf"] is None and s["svg"] for s in view["artifacts"]["sheets"])
    assert view["error"]["details"]["unplaced"] == t["unplaced"]


def test_cancelled_queued_nest_marks_batch_cancelled(client, masters, worker, monkeypatch) -> None:
    stub_engine.install(monkeypatch)
    batch_id = client.post("/v1/batches", json=batch([line("a", "art", masters["art"])]),
                           headers=headers()).json()["batch_id"]
    job_id = client.post(f"/v1/batches/{batch_id}/nest", headers=headers()).json()["job_id"]
    assert client.post(f"/v1/jobs/{job_id}/cancel", headers=headers()).json()["status"] == "cancelled"
    assert client.get(f"/v1/batches/{batch_id}", headers=headers()).json()["status"] == "cancelled"
    assert worker.run_until_empty() == []
    # A cancelled batch can be nested again.
    assert client.post(f"/v1/batches/{batch_id}/nest", headers=headers()).status_code == 202


def test_real_engine_end_to_end(client, masters, worker) -> None:
    """Runs only when the real nesting/export modules are installed."""
    pytest.importorskip("artwork_service.nesting")
    pytest.importorskip("artwork_service.dxf_export")
    stock = {**STOCK, "width_mm": 600, "height_mm": 600, "max_sheets": 4}
    batch_id = client.post("/v1/batches", json=batch([
        line("a", "star", masters["star"], width=120, qty=6),
        line("b", "art", masters["art"], width=100, qty=4),
    ], stock), headers=headers()).json()["batch_id"]
    client.post(f"/v1/batches/{batch_id}/nest", headers=headers())
    worker.run_until_empty()
    view = client.get(f"/v1/batches/{batch_id}", headers=headers()).json()
    assert view["status"] == "completed", view["error"]
    assert view["totals"]["placed"] == 10 and view["artifacts"]["zip"]
    totals = view["totals"]
    assert totals["engine_by_group"]["steel/2mm"] in ("packingsolver-irregular", "bbox-baseline")
    group = totals["groups"]["steel/2mm"]
    assert group["engine"] == totals["engine_by_group"]["steel/2mm"]
    assert group["metrics"]["leftover_usable_area_mm2"] == pytest.approx(totals["leftover_usable_area_mm2"], abs=0.01)
    assert "gap_fill_moves" in group["metrics"] and "gap_fill" in group["settings"]
