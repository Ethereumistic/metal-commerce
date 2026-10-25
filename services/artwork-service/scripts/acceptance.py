"""Local end-to-end acceptance run (plan sections 12 and 13) over HTTP.

    uv run python scripts/acceptance.py [--data-dir DIR] [--port 8766]

The script owns the service process because some checks kill and restart it:
it creates a fresh data directory, generates a random token (never printed or
stored), starts `python -m artwork_service serve` bound to 127.0.0.1, and
drives it only through the public HTTP API, as the Metal Admin server does.

Real images reach the service through the test-only fixture source:
`ARTWORK_TEST_FIXTURE_DIR` is set for this run only, so `test-fixture://local/<name>`
source URLs are served from `<data-dir>/fixtures`. The setting is off by
default; without it such URLs fail like any other non-HTTPS URL. Every other
URL still goes through the normal HTTPS allowlist and SSRF checks, which the
disallowed-host checks exercise.

Writes `<data-dir>/acceptance-report.json` (results, metrics, versions) and the
downloaded packages under `<data-dir>/evidence/`. Exit status 1 if any check fails.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import platform
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

import ezdxf
import httpx
import shapely
from PIL import Image, ImageDraw

SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR / "src"))
sys.path.insert(0, str(SERVICE_DIR / "tests" / "nesting"))

from artwork_service import geometry as geo  # noqa: E402
from artwork_service import sizing  # noqa: E402
from nest_shapes import comb  # noqa: E402

REAL = SERVICE_DIR / "tests" / "fixtures" / "real"
SYNTHETIC = SERVICE_DIR / "tests" / "fixtures" / "synthetic"
JS_VERIFY = SERVICE_DIR / "tests" / "js" / "verify-dxf.mjs"
DEFAULT_DATA_DIR = Path.home() / ".local/share/metal-craft-artwork/acceptance"
BUSINESS = "biz-acceptance"
FOREIGN = "biz-foreign"
TERMINAL_JOB = ("succeeded", "failed", "cancelled")
TERMINAL_BATCH = ("completed", "incomplete", "failed", "cancelled", "invalid")
CURRENT_STOCK = {"width_mm": 1500, "height_mm": 3000, "margins_mm": {"left": 10, "right": 15, "bottom": 20, "top": 25},
                 "gap_mm": 5, "max_sheets": 10, "label": "Current machine 1500 x 3000"}


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


# ------------------------------------------------------------------ processes


def _proc_table() -> dict[int, tuple[int, int, int, str]]:
    """pid -> (ppid, session id, rss kB, cmdline) for every readable process."""
    table = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
            fields = stat[stat.rindex(")") + 2:].split()
            ppid, session = int(fields[1]), int(fields[3])
            rss = 0
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except (OSError, ValueError):
            continue
        table[pid] = (ppid, session, rss, cmd)
    return table


def process_group(session: int) -> dict[int, tuple[int, int, int, str]]:
    """Processes of a service run: its session (API and workers, which keep the
    session even when orphaned) plus all their descendants (solver children
    start their own sessions)."""
    table = _proc_table()
    members = {pid for pid, row in table.items() if row[1] == session}
    grew = True
    while grew:
        extra = {pid for pid, row in table.items() if row[0] in members and pid not in members}
        members |= extra
        grew = bool(extra)
    return {pid: table[pid] for pid in members}


class RssSampler:
    """Samples the summed RSS of the service's processes (API, workers and
    solver children) every 0.2 s; reports the peak per window."""

    def __init__(self) -> None:
        self.session: int | None = None
        self._peak = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(0.2):
            if self.session is None:
                continue
            total = sum(row[2] for row in process_group(self.session).values())
            with self._lock:
                self._peak = max(self._peak, total)

    def reset(self) -> None:
        with self._lock:
            self._peak = 0

    def peak_mb(self) -> float:
        with self._lock:
            return round(self._peak / 1024, 1)

    def stop(self) -> None:
        self._stop.set()


class Service:
    def __init__(self, data_dir: Path, port: int, token: str, fixture_dir: Path, log_path: Path) -> None:
        self.data_dir, self.port, self.token = data_dir, port, token
        self.fixture_dir, self.log_path = fixture_dir, log_path
        self.proc: subprocess.Popen | None = None

    def start(self, extra_env: dict[str, str] | None = None) -> None:
        env = {k: v for k, v in os.environ.items() if not k.startswith("ARTWORK_")}
        env.update({"ARTWORK_DATA_DIR": str(self.data_dir), "ARTWORK_SERVICE_TOKEN": self.token,
                    "ARTWORK_HOST": "127.0.0.1", "ARTWORK_PORT": str(self.port), "ARTWORK_WORKERS": "2",
                    "ARTWORK_TEST_FIXTURE_DIR": str(self.fixture_dir), **(extra_env or {})})
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                raise RuntimeError(f"port {self.port} is already in use; stop the other service first")
        out = self.log_path.open("ab")
        self.proc = subprocess.Popen([sys.executable, "-m", "artwork_service", "serve"], cwd=SERVICE_DIR, env=env,
                                     stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        out.close()

    @property
    def session(self) -> int:
        assert self.proc is not None
        return self.proc.pid  # start_new_session: the session id is the leader's pid

    def stop(self) -> None:
        if self.proc is None:
            return
        self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait()
        self.proc = None

    def kill9(self) -> int:
        """SIGKILL the service process only (workers are left to notice on their own)."""
        assert self.proc is not None
        pid = self.proc.pid
        os.kill(pid, signal.SIGKILL)
        self.proc.wait()
        self.proc = None
        return pid


# ---------------------------------------------------------------------- HTTP


class Api:
    def __init__(self, port: int, token: str) -> None:
        self.http = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60)
        self.token = token
        self.bodies: list[bytes] = []  # every response body, scanned for leaked credentials

    def headers(self, business: str = BUSINESS, *, token: str | None = None, edit: bool = True,
                key: str | None = None, mutation: bool = False) -> dict[str, str]:
        h = {"Authorization": f"Bearer {self.token if token is None else token}", "X-Artwork-Business-Id": business,
             "X-Artwork-Actor": "acceptance", "X-Artwork-Can-Edit": "true" if edit else "false"}
        if mutation:
            h["Idempotency-Key"] = key or f"acc-{uuid.uuid4().hex}"
        return h

    def call(self, method: str, path: str, body: Any = None, *, expect: int | None = 200, **kw: Any) -> httpx.Response:
        mutation = method == "POST" and path != "/v1/products/status"
        headers = kw.pop("headers", None) or self.headers(mutation=mutation, **kw)
        resp = self.http.request(method, path, json=body, headers=headers)
        self.bodies.append(resp.content)
        if expect is not None and resp.status_code != expect:
            raise AssertionError(f"{method} {path} -> {resp.status_code}, expected {expect}: {resp.text[:800]}")
        return resp

    def get(self, path: str, **kw: Any) -> Any:
        return self.call("GET", path, **kw).json()

    def post(self, path: str, body: Any = None, **kw: Any) -> Any:
        return self.call("POST", path, body, **kw).json()

    def wait_up(self, timeout: float = 90) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                resp = self.http.get("/v1/health", headers=self.headers())
                if resp.status_code == 200 and resp.json()["worker_ready"]:
                    return resp.json()
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        raise RuntimeError("the service did not become ready")

    def wait_job(self, job_id: str, timeout: float = 600) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.get(f"/v1/jobs/{job_id}")
            if job["status"] in TERMINAL_JOB:
                return job
            time.sleep(0.25)
        raise AssertionError(f"job {job_id} did not finish within {timeout} s")

    def wait_batch(self, batch_id: str, timeout: float = 900) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            batch = self.get(f"/v1/batches/{batch_id}")
            if batch["status"] in TERMINAL_BATCH:
                return batch
            time.sleep(0.5)
        raise AssertionError(f"batch {batch_id} did not finish within {timeout} s")

    def artifact(self, artifact_id: str) -> httpx.Response:
        return self.call("GET", f"/v1/artifacts/{artifact_id}")


# ------------------------------------------------------------------- helpers


def product(pid: str, fixture: str | None, *, identity: str | None = None, version: str = "v1",
            url: str | None = None) -> dict[str, Any]:
    source = None
    if fixture is not None or url is not None:
        source = {"gallery_index": 0, "source_identity": identity or f"lib:{pid}", "source_version": version,
                  "original_url": url or f"test-fixture://local/{fixture}", "width": None, "height": None}
    return {"product_id": pid, "product_revision": 1, "name": pid, "slug": pid, "source": source}


def line(line_id: str, master: dict[str, Any], quantity: int, *, width: float | None = None,
         height: float | None = None, mode: str = "width", material: str = "steel", thickness: float = 2.0,
         rotations: list[int] | None = None) -> dict[str, Any]:
    return {"line_id": line_id, "product_id": master["product_id"], "master_id": master["master_id"],
            "size": {"mode": mode, "width_mm": width, "height_mm": height}, "quantity": quantity,
            "material": material, "thickness_mm": thickness, "allowed_rotations": rotations or [0, 90, 180, 270],
            "variant_id": None}


def batch_body(name: str, lines: list[dict[str, Any]], stock: dict[str, Any] | None = None, *, budget: int = 10,
               seed: int = 1) -> dict[str, Any]:
    return {"name": name, "lines": lines, "stock": stock or CURRENT_STOCK,
            "optimization": {"time_budget_s": budget, "seed": seed}, "export": {"chord_tolerance_mm": 0.05}}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def solver_processes(session: int) -> list[int]:
    return [pid for pid, row in process_group(session).items() if "artwork_service.solver_adapter" in row[3]]


def make_fixtures(directory: Path) -> dict[str, Any]:
    """Copy the real/synthetic fixtures byte for byte and generate the special ones."""
    directory.mkdir(parents=True)
    info = {}
    for src in [*sorted(REAL.glob("*.png")), *sorted(SYNTHETIC.glob("*.png"))]:
        shutil.copyfile(src, directory / src.name)
        info[src.name] = {"sha256": sha256(src.read_bytes()), "bytes": src.stat().st_size,
                          "origin": str(src.relative_to(SERVICE_DIR))}
    # Engineered concave fixture: the comb from tests/nesting/nest_shapes.py
    # (320 x 290 mm, 6 teeth) drawn at 2 px/mm, anti-aliased like a photo.
    shape = comb()
    scale, pad, ss = 2.0, 60, 4
    minx, miny, maxx, maxy = shape.bounds
    w, h = int((maxx - minx) * scale + 2 * pad), int((maxy - miny) * scale + 2 * pad)
    big = Image.new("L", (w * ss, h * ss), 244)
    draw = ImageDraw.Draw(big)
    for poly in shape.geoms:
        pts = [((x - minx) * scale * ss + pad * ss, (maxy - y) * scale * ss + pad * ss) for x, y in poly.exterior.coords]
        draw.polygon(pts, fill=22)
    big.resize((w, h), Image.Resampling.BOX).convert("RGB").save(directory / "comb.png")
    # Malformed inputs.
    (directory / "malformed.png").write_bytes(b"\x89PNG\r\n\x1a\n" + secrets.token_bytes(2048))
    (directory / "not-an-image.png").write_bytes(b"<html>not an image</html>")
    flower = (REAL / "flower.png").read_bytes()
    (directory / "truncated.png").write_bytes(flower[: len(flower) // 3])
    for name in ("comb.png", "malformed.png", "not-an-image.png", "truncated.png"):
        data = (directory / name).read_bytes()
        info[name] = {"sha256": sha256(data), "bytes": len(data), "origin": "generated by scripts/acceptance.py"}
    return info


def cut_length_mm(geom: Any) -> float:
    return float(sum(p.exterior.length + sum(r.length for r in p.interiors) for p in geo.polygons_of(geom)))


# ----------------------------------------------------------------- the run


class Acceptance:
    def __init__(self, data_dir: Path, port: int) -> None:
        self.data_dir = data_dir
        self.evidence = data_dir / "evidence"
        self.fixtures = data_dir / "fixtures"
        self.token = secrets.token_urlsafe(32)
        self.results: list[dict[str, Any]] = []
        self.metrics: dict[str, Any] = {"fixtures": {}, "batches": {}}
        self.masters: dict[str, dict[str, Any]] = {}
        self.samples: dict[str, Any] = {}  # real responses, for the admin contract test
        self.service = Service(data_dir, port, self.token, self.fixtures, data_dir / "service.log")
        self.api = Api(port, self.token)
        self.sampler = RssSampler()

    # -- bookkeeping
    def sample(self, name: str, value: Any) -> Any:
        self.samples.setdefault(name, json.loads(json.dumps(value)))
        return value

    def check(self, check_id: str, plan: str, fn: Callable[[], Any]) -> None:
        log(f"check {check_id} ...")
        started = time.monotonic()
        try:
            details = fn() or {}
            status = "pass"
        except Exception as exc:  # a failed check must not stop the run
            details = {"error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(limit=6)}
            status = "fail"
        elapsed = round(time.monotonic() - started, 1)
        self.results.append({"id": check_id, "plan_check": plan, "status": status, "seconds": elapsed,
                             "details": details})
        log(f"check {check_id}: {status.upper()} ({elapsed} s){'  ' + details['error'] if status == 'fail' else ''}")

    def trace_job_count(self) -> int:
        jobs = self.api.get("/v1/jobs?kind=trace&limit=200")["items"]
        return sum(1 for j in jobs if j["status"] == "succeeded" and not j["cache_hit"])

    def prepare_and_wait(self, products: list[dict[str, Any]], *, reprocess: bool = False) -> list[dict[str, Any]]:
        body = self.api.post("/v1/prepare", {"products": products, "reprocess": reprocess})
        self.sample("prepare", body)
        items = body["items"]
        out = []
        for item in items:
            job = self.api.wait_job(item["job_id"]) if item["job_id"] else None
            if job is not None:
                self.sample(f"job_{job['kind']}_{job['status']}", job)
            out.append({"item": item, "job": job})
        return out

    def status(self, pid: str, identity: str, version: str = "v1") -> dict[str, Any]:
        body = self.api.post("/v1/products/status", {"products": [
            {"product_id": pid, "source_identity": identity, "source_version": version}]})
        item = body["items"][0]
        self.sample(f"status_{item['status']}", body)
        return item

    def master(self, key: str, pid: str, fixture: str) -> dict[str, Any]:
        """Prepare a product (if needed) and remember {product_id, master_id, view}."""
        if key not in self.masters:
            result = self.prepare_and_wait([product(pid, fixture)])[0]
            item = self.status(pid, f"lib:{pid}")
            assert item["status"] == "ready", (result, item)
            view = self.api.get(f"/v1/masters/{item['master_id']}")
            self.masters[key] = {"product_id": pid, "master_id": item["master_id"], "view": view}
        return self.masters[key]

    def run_batch(self, name: str, body: dict[str, Any], *, expect_status: str = "completed") -> dict[str, Any]:
        created = self.sample("batch_draft", self.api.post("/v1/batches", body, expect=201))
        assert created["status"] == "draft", created
        self.sampler.reset()
        started = time.monotonic()
        job_id = self.api.post(f"/v1/batches/{created['batch_id']}/nest", expect=202)["job_id"]
        job = self.sample(f"job_nest_{expect_status}", self.api.wait_job(job_id, timeout=900))
        wall = time.monotonic() - started
        batch = self.sample(f"batch_{expect_status}", self.api.get(f"/v1/batches/{created['batch_id']}"))
        assert batch["status"] == expect_status, {"batch": batch["status"], "error": batch["error"], "job": job}
        batch["_wall_s"] = round(wall, 2)
        batch["_peak_rss_mb"] = self.sampler.peak_mb()
        batch["_job"] = job
        return batch

    def verify_package(self, batch: dict[str, Any], label: str) -> dict[str, Any]:
        """Download the ZIP and every sheet DXF; verify with the Python and JS readers."""
        zip_id = batch["artifacts"]["zip"]
        assert zip_id, "completed batch has no ZIP artifact"
        resp = self.api.artifact(zip_id)
        assert resp.headers["content-type"] == "application/zip", resp.headers
        assert "attachment;" in resp.headers["content-disposition"]
        out = self.evidence / label
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        (out.parent / f"{label}.zip").write_bytes(resp.content)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as archive:
            names = archive.namelist()
            archive.extractall(out)
        manifest = json.loads((out / "manifest.json").read_text())
        dxf_names = sorted(n for n in names if n.endswith(".dxf"))
        assert len(dxf_names) == len(batch["sheets"]) == manifest["counts"]["sheets"], (dxf_names, len(batch["sheets"]))
        assert all(n.startswith(f"batch-{batch['batch_id']}-sheet-") for n in dxf_names)

        # Per-sheet downloads equal the ZIP entries.
        for sheet_art, sheet_manifest in zip(batch["artifacts"]["sheets"], manifest["sheets"], strict=True):
            dxf = self.api.artifact(sheet_art["dxf"])
            assert dxf.headers["content-type"].startswith("application/dxf") or "dxf" in dxf.headers["content-type"], \
                dxf.headers["content-type"]
            assert sha256(dxf.content) == sheet_manifest["dxf"]["sha256"]
            assert f'filename="{sheet_manifest["dxf"]["filename"]}"' in dxf.headers["content-disposition"]

        # Python read-back: ezdxf plus the exporter's own independent check recorded in the manifest.
        cut_length = 0.0
        entities = 0
        for sheet_manifest in manifest["sheets"]:
            assert sheet_manifest["dxf_check"]["valid"], sheet_manifest["dxf_check"]
            doc = ezdxf.readfile(out / sheet_manifest["dxf"]["filename"])
            assert doc.header["$INSUNITS"] == 4
            msp = list(doc.modelspace())
            assert {e.dxftype() for e in msp} == {"LWPOLYLINE"}, {e.dxftype() for e in msp}
            assert {e.dxf.layer for e in msp} == {"0"}
            assert all(e.closed and e.dxf.const_width == 0 for e in msp)
            entities += len(msp)
            for e in msp:
                pts = [(x, y) for x, y, *_ in e.get_points()]
                cut_length += shapely.LinearRing(pts).length
        # Independent JavaScript reader.
        js = subprocess.run(["node", str(JS_VERIFY), str(out)], capture_output=True, text=True, timeout=300,
                            check=False)
        js_report = json.loads(js.stdout) if js.stdout.strip() else {"valid": False, "stderr": js.stderr}
        assert js.returncode == 0 and js_report["valid"], {k: v for k, v in js_report.items() if k != "sheets"} | {
            "sheet_errors": [s["errors"][:3] for s in js_report.get("sheets", [])]}
        instance_ids = [p["instance_id"] for s in manifest["sheets"] for p in s["placements"]]
        assert len(instance_ids) == len(set(instance_ids)) == manifest["counts"]["requested"]
        return {"zip_bytes": len(resp.content), "zip_sha256": sha256(resp.content), "sheets": len(dxf_names),
                "dxf_bytes": [s["dxf"]["bytes"] for s in manifest["sheets"]],
                "svg_bytes": [s["svg"]["bytes"] for s in manifest["sheets"]],
                "manifest_bytes": (out / "manifest.json").stat().st_size, "dxf_entities": entities,
                "cut_length_m": round(cut_length / 1000, 3), "instances": len(instance_ids),
                "js_reader": js_report["reader"], "js_instances": js_report["instances"],
                "python_max_vertex_error_mm": max(s["dxf_check"]["max_vertex_error_mm"] or 0 for s in manifest["sheets"]),
                "manifest": manifest}

    @staticmethod
    def batch_summary(batch: dict[str, Any]) -> dict[str, Any]:
        totals = batch["totals"] or {}
        return {"batch_id": batch["batch_id"], "status": batch["status"], "requested": totals.get("requested"),
                "placed": totals.get("placed"), "unplaced": totals.get("unplaced"),
                "sheet_count": totals.get("sheet_count"), "utilization": totals.get("utilization"),
                "occupied_extent_mm": totals.get("occupied_extent_mm"), "solver_runtime_s": totals.get("runtime_s"),
                "job_wall_s": batch.get("_wall_s"), "peak_rss_mb": batch.get("_peak_rss_mb"),
                "engines": {k: g["engine"] for k, g in (totals.get("groups") or {}).items()},
                "baseline": {k: {"sheet_count": g["baseline_metrics"].get("sheet_count"),
                                 "occupied_extent_mm": g["baseline_metrics"].get("occupied_extent_mm"),
                                 "utilization": g["baseline_metrics"].get("utilization")}
                             for k, g in (totals.get("groups") or {}).items()}}

    # -- checks
    def c_auth(self) -> dict[str, Any]:
        h = self.api.headers()
        no_token = self.api.http.get("/v1/health", headers={"X-Artwork-Business-Id": BUSINESS})
        wrong = self.api.http.get("/v1/health", headers={**h, "Authorization": "Bearer " + "x" * 43})
        assert no_token.status_code == 401 and no_token.json()["error"]["code"] == "UNAUTHORIZED"
        assert wrong.status_code == 401 and wrong.json()["error"]["code"] == "UNAUTHORIZED"
        wrong_prepare = self.api.http.post("/v1/prepare", json={"products": [product("p-x", "ring.png")]},
                                           headers={**self.api.headers(mutation=True), "Authorization": "Bearer nope"})
        assert wrong_prepare.status_code == 401
        no_edit = self.api.call("POST", "/v1/prepare", {"products": [product("p-x", "ring.png")]}, expect=403,
                                edit=False)
        assert no_edit.json()["error"]["code"] == "FORBIDDEN"
        health = self.sample("health", self.api.get("/v1/health"))
        text = json.dumps(health)
        assert str(self.data_dir) not in text and self.token not in text
        return {"no_token": 401, "wrong_token": 401, "wrong_token_mutation": 401, "can_edit_false": 403,
                "health": health}

    def c_trace_real(self) -> dict[str, Any]:
        out = {}
        for name in ("flower", "trees", "motorcycle"):
            pid = f"p-{name}"
            self.sampler.reset()
            started = time.monotonic()
            result = self.prepare_and_wait([product(pid, f"{name}.png")])[0]
            wall = time.monotonic() - started
            job = result["job"]
            assert job["status"] == "succeeded" and not job["cache_hit"], job
            item = self.status(pid, f"lib:{pid}")
            assert item["status"] == "ready", item
            view = self.sample(f"master_{name}", self.api.get(f"/v1/masters/{item['master_id']}"))
            self.masters[name] = {"product_id": pid, "master_id": item["master_id"], "view": view}
            sizes = {kind: len(self.api.artifact(aid).content) for kind, aid in view["artifacts"].items()}
            doc = json.loads(self.api.artifact(view["artifacts"]["master_json"]).content)
            master_geom = geo.from_json(doc["geometry"])
            ref_width = {"flower": 300, "trees": 600, "motorcycle": 600}[name]
            sized = sizing.sized_geometry(master_geom, sizing.compute_size(view["aspect_ratio"], "width", ref_width, None))
            metrics = {
                "source_sha256": view["source"]["byte_sha256"], "source_px": [view["source"]["width"],
                                                                             view["source"]["height"]],
                "components": view["components"], "holes": view["holes"], "vertex_count": view["vertex_count"],
                "aspect_ratio": round(view["aspect_ratio"], 4), "threshold": view["diagnostics"]["threshold"],
                "warnings": [w["code"] for w in view["diagnostics"]["warnings"]],
                "trace_wall_s": round(wall, 2), "peak_rss_mb_service_tree": self.sampler.peak_mb(),
                "reference_width_mm": ref_width,
                "reference_size_mm": [round(sized.bounds[2] - sized.bounds[0], 3),
                                      round(sized.bounds[3] - sized.bounds[1], 3)],
                "cut_length_m_at_reference": round(cut_length_mm(sized) / 1000, 3),
                "metal_area_m2_at_reference": round(sized.area / 1e6, 4),
                "artifact_bytes": sizes, "master_id": item["master_id"], "trace_engine":
                    f"{view['trace_engine']}/{view['trace_version']}",
            }
            self.metrics["fixtures"][name] = metrics
            out[name] = {k: metrics[k] for k in ("components", "holes", "vertex_count", "trace_wall_s")}
        return out

    def c_repeat_cache(self) -> dict[str, Any]:
        before = self.trace_job_count()
        items = self.api.post("/v1/prepare", {"products": [product(f"p-{n}", f"{n}.png")
                                                            for n in ("flower", "trees", "motorcycle")]})["items"]
        for item, name in zip(items, ("flower", "trees", "motorcycle"), strict=True):
            assert item["status"] == "ready" and item["job_id"] is None, item
            assert item["master_id"] == self.masters[name]["master_id"]
        assert self.trace_job_count() == before
        return {"repeat_prepare": [i["status"] for i in items], "traces_before": before,
                "traces_after": self.trace_job_count()}

    def c_concurrent(self) -> dict[str, Any]:
        before = self.trace_job_count()

        def send(body: dict[str, Any]) -> dict[str, Any]:
            return self.api.post("/v1/prepare", body)

        # Fresh bytes (never traced in this data dir): one product sent four
        # times at once, a second product with identical bytes at the same time,
        # plus two new products pointing at the already-traced flower bytes.
        bodies = [{"products": [product("p-dup-a", "two_parts.png")]}] * 4 + [
            {"products": [product("p-dup-b", "two_parts.png")]},
            {"products": [product("p-flower-copy-1", "flower.png")]},
            {"products": [product("p-flower-copy-2", "flower.png")]},
        ]
        with concurrent.futures.ThreadPoolExecutor(len(bodies)) as pool:
            responses = list(pool.map(send, bodies))
        a_jobs = {r["items"][0]["job_id"] for r in responses[:4]}
        assert len(a_jobs) == 1, f"duplicate prepares created {len(a_jobs)} jobs"
        job_ids = [responses[0]["items"][0]["job_id"]] + [r["items"][0]["job_id"] for r in responses[4:]]
        jobs = [self.api.wait_job(j) for j in job_ids]
        assert all(j["status"] == "succeeded" for j in jobs), jobs
        two_a, two_b, copy1, copy2 = jobs
        assert two_a["result"]["master_id"] == two_b["result"]["master_id"]
        assert sorted([two_a["cache_hit"], two_b["cache_hit"]]) == [False, True], (two_a, two_b)
        assert copy1["cache_hit"] and copy2["cache_hit"]
        assert copy1["result"]["master_id"] == copy2["result"]["master_id"] == self.masters["flower"]["master_id"]
        after = self.trace_job_count()
        assert after == before + 1, (before, after)
        self.masters["two_parts"] = {"product_id": "p-dup-a", "master_id": two_a["result"]["master_id"],
                                     "view": self.api.get(f"/v1/masters/{two_a['result']['master_id']}")}
        return {"requests": len(bodies), "jobs_for_duplicate_product": len(a_jobs),
                "new_traces": after - before, "cache_hits": sum(j["cache_hit"] for j in jobs)}

    def c_square_sizes(self) -> dict[str, Any]:
        ring = self.master("ring", "p-ring", "ring.png")
        before = self.trace_job_count()
        stock = {"width_mm": 2000, "height_mm": 4000, "margins_mm": {"left": 10, "right": 10, "bottom": 10, "top": 10},
                 "gap_mm": 5, "max_sheets": 2, "label": "Custom 2000 x 4000 (size check only)"}
        lines = [line(f"ring-{w}", ring, 1, width=w) for w in (600, 900, 1500)]
        batch = self.run_batch("square sizes", batch_body("square sizes", lines, stock))
        pkg = self.verify_package(batch, "square-sizes")
        aspect = ring["view"]["aspect_ratio"]
        parts = {p["line_id"]: p for g in pkg["manifest"]["groups"] for p in g["parts"]}
        out = {"aspect_ratio": aspect}
        areas = {}
        for w in (600, 900, 1500):
            p = parts[f"ring-{w}"]
            assert abs(p["width_mm"] - w) <= 1e-6, p
            assert abs(p["height_mm"] - w / aspect) <= 1e-6, p
            areas[w] = p["metal_area_mm2"]
            out[f"{w}mm"] = [round(p["width_mm"], 4), round(p["height_mm"], 4)]
        for w in (900, 1500):
            ratio = areas[w] / areas[600]
            assert abs(ratio - (w / 600) ** 2) / (w / 600) ** 2 < 1e-9, (w, ratio)
        assert self.trace_job_count() == before, "resizing retraced"
        out["dxf_max_vertex_error_mm"] = pkg["python_max_vertex_error_mm"]
        out["retraces"] = 0
        return out

    def c_non_square(self) -> dict[str, Any]:
        lshape = self.master("l_with_hole", "p-l", "l_with_hole.png")
        flower = self.masters["flower"]
        lines = [line("l-fit", lshape, 1, mode="fit", width=600, height=600),
                 line("l-height", lshape, 1, mode="height", height=300),
                 line("flower-fit", flower, 1, mode="fit", width=600, height=600)]
        created = self.api.post("/v1/batches", batch_body("non-square", lines), expect=201)
        out = {}
        for lin, res in zip(lines, created["lines"], strict=True):
            aspect = (lshape if lin["product_id"] == "p-l" else flower)["view"]["aspect_ratio"]
            w, h = res["actual_width_mm"], res["actual_height_mm"]
            assert abs(w / h - aspect) < 1e-9, (lin["line_id"], w, h, aspect)
            if lin["size"]["mode"] == "fit":
                assert max(w - 600, h - 600) <= 1e-9 and (abs(w - 600) < 1e-9 or abs(h - 600) < 1e-9)
            assert res["feature_check"]["status"] == "unknown", res["feature_check"]
            out[lin["line_id"]] = {"requested": lin["size"], "actual_mm": [round(w, 3), round(h, 3)],
                                   "aspect_ratio": round(aspect, 4)}
        return out

    def c_does_not_fit(self) -> dict[str, Any]:
        ring = self.masters["ring"]
        stock = {**CURRENT_STOCK, "margins_mm": {"left": 10, "right": 10, "bottom": 10, "top": 10}}
        jobs_before = len(self.api.get("/v1/jobs?kind=nest&limit=200")["items"])
        created = self.api.post("/v1/batches", batch_body("too big", [line("ring-1500", ring, 1, width=1500)], stock),
                                expect=201)
        assert created["status"] == "invalid", created
        self.sample("batch_draft_invalid", created)
        err = created["lines"][0]["errors"][0]
        assert err["code"] == "PART_DOES_NOT_FIT", err
        refused = self.api.call("POST", f"/v1/batches/{created['batch_id']}/nest", expect=409)
        assert len(self.api.get("/v1/jobs?kind=nest&limit=200")["items"]) == jobs_before, "a nest job was queued"
        return {"error": err, "nest_request": refused.status_code}

    def c_mixed(self) -> dict[str, Any]:
        flower, moto = self.masters["flower"], self.masters["motorcycle"]
        lines = [line("flower-300", flower, 44, width=300), line("motorcycle-600", moto, 10, width=600)]
        batch = self.run_batch("44 flower + 10 motorcycle", batch_body("mixed 44+10", lines, budget=30))
        pkg = self.verify_package(batch, "mixed-44-10")
        totals = batch["totals"]
        assert totals["requested"] == totals["placed"] == 54 and totals["unplaced"] == 0, totals
        placed = [p["instance_id"] for s in batch["sheets"] for p in s["placements"]]
        assert len(placed) == len(set(placed)) == 54
        assert sum(1 for i in placed if i.startswith("flower-300#")) == 44
        assert sum(1 for i in placed if i.startswith("motorcycle-600#")) == 10
        assert all(v["valid"] for v in batch["validation"].values()), batch["validation"]
        parts = {p["line_id"]: p for g in pkg["manifest"]["groups"] for p in g["parts"]}
        summary = self.batch_summary(batch)
        summary.update({k: pkg[k] for k in ("zip_bytes", "sheets", "dxf_bytes", "svg_bytes", "manifest_bytes",
                                             "dxf_entities", "cut_length_m", "js_reader",
                                             "python_max_vertex_error_mm")})
        summary["parts"] = {k: {f: p[f] for f in ("width_mm", "height_mm", "quantity", "vertex_count", "hole_count",
                                                  "exterior_count")} for k, p in parts.items()}
        summary["total_vertices"] = sum(p["vertex_count"] * p["quantity"] for p in parts.values())
        summary["total_holes"] = sum(p["hole_count"] * p["quantity"] for p in parts.values())
        summary["total_components"] = sum(p["exterior_count"] * p["quantity"] for p in parts.values())
        summary["min_gap_mm"] = {k: v["min_gap_mm"] for k, v in batch["validation"].items()}
        self.metrics["batches"]["mixed_44_10"] = summary
        return {k: summary[k] for k in ("sheet_count", "placed", "utilization", "job_wall_s", "zip_bytes")}

    def c_insufficient_stock(self) -> dict[str, Any]:
        flower, moto = self.masters["flower"], self.masters["motorcycle"]
        lines = [line("flower-300", flower, 44, width=300), line("motorcycle-600", moto, 10, width=600)]
        stock = {**CURRENT_STOCK, "max_sheets": 1}
        batch = self.run_batch("insufficient stock", batch_body("insufficient", lines, stock), expect_status="incomplete")
        assert batch["error"]["code"] == "NEST_INCOMPLETE", batch["error"]
        assert batch["totals"]["unplaced"] > 0 and batch["error"]["details"]["unplaced"] == batch["totals"]["unplaced"]
        assert batch["artifacts"]["zip"] is None
        assert all(s["dxf"] is None for s in batch["artifacts"]["sheets"])
        assert batch["_job"]["status"] == "failed" and batch["_job"]["error"]["code"] == "NEST_INCOMPLETE"
        return {"placed": batch["totals"]["placed"], "unplaced": batch["totals"]["unplaced"],
                "zip": batch["artifacts"]["zip"], "job_status": batch["_job"]["status"]}

    def _simple_batch(self, label: str, lines: list[dict[str, Any]], **kw: Any) -> dict[str, Any]:
        batch = self.run_batch(label, batch_body(label, lines, **kw))
        pkg = self.verify_package(batch, label)
        expected = sum(lin["quantity"] for lin in lines)
        assert batch["totals"]["placed"] == expected and pkg["instances"] == expected
        summary = self.batch_summary(batch)
        summary.update({"zip_bytes": pkg["zip_bytes"], "cut_length_m": pkg["cut_length_m"]})
        self.metrics["batches"][label] = summary
        return {"instances": expected, "sheets": summary["sheet_count"], "groups": list(summary["engines"])}

    def c_repeated_only(self) -> dict[str, Any]:
        return self._simple_batch("repeated-only", [line("ring-200", self.masters["ring"], 30, width=200)])

    def c_all_different(self) -> dict[str, Any]:
        trees = self.masters["trees"]
        lines = [line("flower", self.masters["flower"], 1, width=250), line("trees", trees, 1, width=400),
                 line("moto", self.masters["motorcycle"], 1, width=350), line("ring", self.masters["ring"], 1, width=200),
                 line("l", self.masters["l_with_hole"], 1, width=300),
                 line("two", self.masters["two_parts"], 1, width=250)]
        return self._simple_batch("all-different", lines)

    def c_same_product_sizes(self) -> dict[str, Any]:
        f = self.masters["flower"]
        lines = [line("flower-200", f, 4, width=200), line("flower-300", f, 3, width=300),
                 line("flower-450", f, 2, width=450)]
        out = self._simple_batch("same-product-sizes", lines)
        manifest = json.loads((self.evidence / "same-product-sizes" / "manifest.json").read_text())
        widths = sorted(round(p["width_mm"]) for g in manifest["groups"] for p in g["parts"])
        assert widths == [200, 300, 450], widths
        out["part_widths_mm"] = widths
        return out

    def c_multi_material(self) -> dict[str, Any]:
        f, r = self.masters["flower"], self.masters["ring"]
        lines = [line("flower-steel", f, 4, width=300, material="steel", thickness=2),
                 line("flower-alu", f, 3, width=300, material="aluminium", thickness=3),
                 line("ring-ss", r, 5, width=200, material="stainless-304", thickness=1.5)]
        created_groups = self.api.post("/v1/batches", batch_body("groups preview", lines), expect=201)["groups"]
        assert len(created_groups) == 3, created_groups
        out = self._simple_batch("multi-material", lines)
        manifest = json.loads((self.evidence / "multi-material" / "manifest.json").read_text())
        for sheet in manifest["sheets"]:
            group = next(g for g in manifest["groups"] if g["group_key"] == sheet["group_key"])
            lines_in_group = {p["line_id"] for p in group["parts"]}
            assert {p["line_id"] for p in sheet["placements"]} <= lines_in_group
        out["groups"] = sorted(g["group_key"] for g in manifest["groups"])
        return out

    def c_concave(self) -> dict[str, Any]:
        combm = self.master("comb", "p-comb", "comb.png")
        aspect = combm["view"]["aspect_ratio"]
        stock = {**CURRENT_STOCK, "margins_mm": {"left": 10, "right": 10, "bottom": 10, "top": 10}}
        batch = self.run_batch("concave combs", batch_body("concave", [
            line("comb-320", combm, 40, width=320, rotations=[0, 180])], stock, budget=30))
        self.verify_package(batch, "concave-combs")
        group = next(iter(batch["totals"]["groups"].values()))
        m, b = group["metrics"], group["baseline_metrics"]
        improved_sheets = m["sheet_count"] < b["sheet_count"]
        improved_extent = m["sheet_count"] == b["sheet_count"] and m["occupied_extent_mm"] < b["occupied_extent_mm"]
        assert group["engine"] == "packingsolver-irregular", group["engine"]
        assert improved_sheets or improved_extent, {"solver": m, "baseline": b}
        summary = self.batch_summary(batch)
        summary["comb_aspect_ratio"] = round(aspect, 4)
        summary["comb_vertices"] = combm["view"]["vertex_count"]
        self.metrics["batches"]["concave_combs"] = summary
        return {"solver": {"sheets": m["sheet_count"], "extent_mm": round(m["occupied_extent_mm"], 1),
                           "utilization": round(m["utilization"], 4)},
                "bbox_baseline": {"sheets": b["sheet_count"], "extent_mm": round(b["occupied_extent_mm"], 1),
                                  "utilization": round(b["utilization"], 4)},
                "extent_reduction_pct": round(100 * (1 - m["occupied_extent_mm"] / b["occupied_extent_mm"]), 1)
                if m["sheet_count"] == b["sheet_count"] else None}

    def c_stale(self) -> dict[str, Any]:
        pid = "p-stale"
        first = self.prepare_and_wait([product(pid, "ring.png", identity="lib:img-1", version="v1")])[0]
        old_master = first["job"]["result"]["master_id"]
        assert self.status(pid, "lib:img-1", "v1")["status"] == "ready"
        reordered = self.status(pid, "lib:img-2", "v1")  # another image is now first
        new_version = self.status(pid, "lib:img-1", "v2")  # same image, replaced bytes
        assert reordered["status"] == "stale" and reordered["error"]["code"] == "MASTER_STALE", reordered
        assert new_version["status"] == "stale", new_version
        before = self.trace_job_count()
        second = self.prepare_and_wait([product(pid, "shadowed.png", identity="lib:img-2", version="v1")])[0]
        new_master = second["job"]["result"]["master_id"]
        assert new_master != old_master and self.trace_job_count() == before + 1
        assert self.status(pid, "lib:img-2", "v1")["status"] == "ready"
        old_view = self.api.get(f"/v1/masters/{old_master}")
        new_view = self.api.get(f"/v1/masters/{new_master}")
        # Same bytes under a new identity is a cache hit, not a retrace.
        third = self.prepare_and_wait([product("p-stale-2", "ring.png", identity="lib:img-9")])[0]
        assert third["job"]["cache_hit"], third
        return {"reordered": reordered["status"], "replaced_version": new_version["status"],
                "old_master_revision": old_view["revision"], "new_master_revision": new_view["revision"],
                "old_master_still_readable": True, "same_bytes_new_identity_cache_hit": True}

    def c_cancel(self) -> dict[str, Any]:
        combm = self.masters["comb"]
        created = self.api.post("/v1/batches", batch_body("cancel me", [
            line("comb-320", combm, 40, width=320, rotations=[0, 180])], budget=120), expect=201)
        job_id = self.api.post(f"/v1/batches/{created['batch_id']}/nest", expect=202)["job_id"]
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            job = self.api.get(f"/v1/jobs/{job_id}")
            if job["status"] == "running" and solver_processes(self.service.session):
                break
            time.sleep(0.2)
        else:
            raise AssertionError("the solver never started")
        time.sleep(3)
        requested_at = time.monotonic()
        first = self.api.post(f"/v1/jobs/{job_id}/cancel")
        job = self.api.wait_job(job_id, timeout=60)
        latency = time.monotonic() - requested_at
        again = self.api.post(f"/v1/jobs/{job_id}/cancel")
        batch = self.sample("batch_cancelled", self.api.get(f"/v1/batches/{created['batch_id']}"))
        self.sample("job_nest_cancelled", job)
        assert job["status"] == "cancelled" and job["error"]["code"] == "CANCELLED", job
        assert again["status"] == "cancelled"
        assert batch["status"] == "cancelled" and batch["artifacts"]["zip"] is None and batch["sheets"] == []
        time.sleep(1)
        leftover = solver_processes(self.service.session)
        assert not leftover, f"solver processes still running: {leftover}"
        return {"status_on_request": first["status"], "cancel_latency_s": round(latency, 2),
                "batch_status": batch["status"], "solver_processes_left": 0}

    def c_restart(self) -> dict[str, Any]:
        flower, moto = self.masters["flower"], self.masters["motorcycle"]
        lines = [line("flower-300", flower, 44, width=300), line("motorcycle-600", moto, 10, width=600)]
        created = self.api.post("/v1/batches", batch_body("restart", lines, budget=30), expect=201)
        job_id = self.api.post(f"/v1/batches/{created['batch_id']}/nest", expect=202)["job_id"]
        old_session = self.service.session
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if solver_processes(old_session):
                break
            time.sleep(0.2)
        else:
            raise AssertionError("the solver never started")
        time.sleep(4)
        killed = self.service.kill9()
        time.sleep(0.5)
        orphans_after_kill = sorted(process_group(old_session))
        self.service.start()
        self.sampler.session = self.service.session
        self.api.wait_up()
        job = self.api.wait_job(job_id, timeout=900)
        batch = self.api.get(f"/v1/batches/{created['batch_id']}")
        time.sleep(3)
        orphans_left = sorted(process_group(old_session))
        assert job["status"] in TERMINAL_JOB
        assert not orphans_left, f"processes of the killed service are still running: {orphans_left}"
        out = {"killed_pid": killed, "processes_alive_right_after_kill": len(orphans_after_kill),
               "job_status": job["status"], "attempts": job["attempts"], "batch_status": batch["status"],
               "placed": (batch["totals"] or {}).get("placed")}
        assert job["status"] == "succeeded" and batch["status"] == "completed", out | {"error": job["error"]}
        assert job["attempts"] >= 2, out
        self.verify_package(batch, "restart-recovered")
        return out

    def c_malformed(self) -> dict[str, Any]:
        cases = {"p-malformed": ("malformed.png", "UNSUPPORTED_FORMAT"),
                 "p-not-image": ("not-an-image.png", "UNSUPPORTED_FORMAT"),
                 "p-truncated": ("truncated.png", "UNSUPPORTED_FORMAT"),
                 "p-low-contrast": ("low_contrast.png", "LOW_CONTRAST"),
                 "p-clipped": ("clipped.png", "OBJECT_CLIPPED"),
                 "p-missing": ("does-not-exist.png", "SOURCE_UNAVAILABLE")}
        results = self.prepare_and_wait([product(pid, fx) for pid, (fx, _) in cases.items()]
                                        + [product("p-no-image", None)])
        out = {}
        for res in results:
            pid = res["item"]["product_id"]
            if pid == "p-no-image":
                assert res["item"]["status"] == "failed" and res["item"]["error"]["code"] == "NO_FIRST_IMAGE"
                out[pid] = "NO_FIRST_IMAGE"
                continue
            job = res["job"]
            assert job["status"] == "failed", job
            assert job["error"]["code"] == cases[pid][1], (pid, job["error"])
            item = self.status(pid, f"lib:{pid}")
            assert item["status"] == "failed" and item["error"]["code"] == cases[pid][1]
            out[pid] = job["error"]["code"]
        return out

    def c_disallowed_hosts(self) -> dict[str, Any]:
        urls = {"p-evil": "https://evil.example.com/a.png",
                "p-http": "http://convex.echoray.io/api/storage/abc",
                "p-metadata": "https://169.254.169.254/latest/meta-data",
                "p-path": "https://convex.echoray.io/admin/secret.png",
                "p-port": "https://convex.echoray.io:8443/api/storage/abc",
                "p-file": "file:///etc/passwd"}
        results = self.prepare_and_wait([product(pid, None, url=url) for pid, url in urls.items()])
        out = {}
        for res in results:
            job = res["job"]
            assert job["status"] == "failed" and job["error"]["code"] == "SOURCE_HOST_NOT_ALLOWED", job
            out[res["item"]["product_id"]] = job["error"]["code"]
        return out

    def c_scoping(self) -> dict[str, Any]:
        mixed = self.metrics["batches"]["mixed_44_10"]
        batch = self.api.get(f"/v1/batches/{mixed['batch_id']}")
        master_id = self.masters["flower"]["master_id"]
        zip_id = batch["artifacts"]["zip"]
        job_id = batch["job_id"]
        out = {}
        for label, path in {"master": f"/v1/masters/{master_id}", "batch": f"/v1/batches/{mixed['batch_id']}",
                            "job": f"/v1/jobs/{job_id}", "artifact": f"/v1/artifacts/{zip_id}"}.items():
            resp = self.api.call("GET", path, expect=404, business=FOREIGN)
            assert resp.json()["error"]["code"] == "NOT_FOUND"
            out[f"foreign_{label}"] = 404
        cancel = self.api.call("POST", f"/v1/jobs/{job_id}/cancel", expect=404, business=FOREIGN)
        out["foreign_cancel"] = cancel.status_code
        lst = self.api.get("/v1/batches", business=FOREIGN)
        assert lst["items"] == []
        self.sample("batches", self.api.get("/v1/batches?limit=5"))
        self.sample("jobs", self.api.get("/v1/jobs?limit=5"))
        self.sample("error_not_found", self.api.call("GET", f"/v1/batches/{mixed['batch_id']}", expect=404,
                                                     business=FOREIGN).json())
        created = self.api.post("/v1/batches", batch_body("foreign master", [
            line("x", self.masters["flower"], 1, width=300)]), expect=201, business=FOREIGN)
        assert created["status"] == "invalid" and created["lines"][0]["errors"][0]["code"] == "NOT_FOUND"
        self.sample("batch_draft_unknown_master", created)
        out["foreign_master_in_batch"] = "NOT_FOUND"
        for guess in (uuid.uuid4().hex, str(uuid.uuid4()), zip_id[:-1] + ("0" if zip_id[-1] != "0" else "1"),
                      "../../artwork.sqlite3", sha256(b"guess")):
            resp = self.api.http.get(f"/v1/artifacts/{guess}", headers=self.api.headers())
            assert resp.status_code == 404, (guess, resp.status_code)
        out["guessed_artifact_ids"] = 404
        return out

    def c_idempotency(self) -> dict[str, Any]:
        key = f"acc-idem-{uuid.uuid4().hex}"
        body = {"products": [product("p-ring", "ring.png")]}
        first = self.api.call("POST", "/v1/prepare", body, key=key)
        replay = self.api.call("POST", "/v1/prepare", body, key=key)
        conflict = self.api.call("POST", "/v1/prepare", {"products": [product("p-l", "l_with_hole.png")]}, key=key,
                                 expect=409)
        assert replay.headers.get("idempotent-replay") == "true" and replay.json() == first.json()
        assert conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
        missing = self.api.call("POST", "/v1/prepare", body, expect=None,
                                headers={k: v for k, v in self.api.headers(mutation=True).items()
                                         if k != "Idempotency-Key"})
        assert missing.status_code in (400, 422), missing.status_code
        return {"replay": "Idempotent-Replay: true", "conflict": 409, "missing_key": missing.status_code}

    def c_insufficient_disk(self) -> dict[str, Any]:
        self.service.stop()
        self.service.start({"ARTWORK_MIN_FREE_BYTES": str(10**18)})
        self.sampler.session = self.service.session
        try:
            self.api.wait_up()
            res = self.prepare_and_wait([product("p-disk", "island_in_hole.png")])[0]
            job = res["job"]
            assert job["status"] == "failed" and job["error"]["code"] == "INSUFFICIENT_DISK", job
            item = self.status("p-disk", "lib:p-disk")
            assert item["status"] == "failed"
            health = self.api.get("/v1/health")
        finally:
            self.service.stop()
            self.service.start()
            self.sampler.session = self.service.session
            self.api.wait_up()
        retry = self.prepare_and_wait([product("p-disk", "island_in_hole.png")])[0]
        assert retry["job"]["status"] == "succeeded", retry
        return {"job_error": job["error"]["code"], "service_healthy_meanwhile": health["worker_ready"],
                "retry_after_space_freed": retry["job"]["status"]}

    def c_no_credentials(self) -> dict[str, Any]:
        leaked = sum(1 for body in self.api.bodies if self.token.encode() in body)
        data_dir = str(self.data_dir).encode()
        paths = sum(1 for body in self.api.bodies if data_dir in body)
        assert leaked == 0, f"{leaked} responses contain the service token"
        assert paths == 0, f"{paths} responses contain the private data directory path"
        return {"responses_scanned": len(self.api.bodies), "token_leaks": 0, "data_dir_leaks": 0}

    # -- driver
    def run(self) -> int:
        if self.data_dir.exists():
            marker = self.data_dir / "acceptance-report.json"
            if any(self.data_dir.iterdir()) and not marker.exists() and not (self.data_dir / "artwork.sqlite3").exists():
                raise SystemExit(f"{self.data_dir} is not an acceptance data directory; refusing to delete it")
            shutil.rmtree(self.data_dir)
        self.data_dir.mkdir(parents=True)
        fixtures = make_fixtures(self.fixtures)
        started_at = datetime.now(UTC).isoformat()
        self.service.start()
        self.sampler.session = self.service.session
        try:
            health = self.api.wait_up()
            log(f"service up: {health}")
            checks = [
                ("auth", "Unauthorized users are rejected", self.c_auth),
                ("trace-real-fixtures", "Three supplied examples produce verified masters", self.c_trace_real),
                ("repeat-prepare-cache", "Repeated prepare does not retrace", self.c_repeat_cache),
                ("concurrent-duplicates", "Simultaneous duplicate submissions do not trace twice", self.c_concurrent),
                ("square-600-900-1500", "Square master exports 600/900/1500 mm without retrace", self.c_square_sizes),
                ("non-square-ratio", "Non-square input preserves ratio and reports actual fit dimensions",
                 self.c_non_square),
                ("part-does-not-fit", "1500 mm part on 1500 mm sheet with margins fails before optimization",
                 self.c_does_not_fit),
                ("mixed-44-10", "44 x A + 10 x B gives exactly 54 instances across exported sheets", self.c_mixed),
                ("insufficient-stock", "Unavailable stock gives incomplete with unplaced counts and no ZIP",
                 self.c_insufficient_stock),
                ("repeated-only", "Repeated-only job", self.c_repeated_only),
                ("all-different", "All-different job", self.c_all_different),
                ("same-product-sizes", "Same product, different sizes", self.c_same_product_sizes),
                ("multi-material", "Multi-material job partitions sheet groups", self.c_multi_material),
                ("concave-interleave", "Concave fixture beats bounding-box packing", self.c_concave),
                ("stale-first-image", "Reordering/replacing the first image marks the master stale", self.c_stale),
                ("cancel-mid-nest", "Cancellation", self.c_cancel),
                ("restart-recovery", "Service restart during a running job", self.c_restart),
                ("malformed-images", "Malformed images produce explicit failures", self.c_malformed),
                ("disallowed-hosts", "Arbitrary fetch URLs are rejected", self.c_disallowed_hosts),
                ("business-scoping", "Foreign-business IDs and guessed artifact IDs are rejected", self.c_scoping),
                ("idempotency", "Idempotency keys replay or conflict", self.c_idempotency),
                ("insufficient-disk", "Insufficient disk space gives an explicit, recoverable state",
                 self.c_insufficient_disk),
                ("no-credentials-in-responses", "API responses contain no service credentials", self.c_no_credentials),
            ]
            for check_id, plan, fn in checks:
                self.check(check_id, plan, fn)
            health = self.api.get("/v1/health")
        finally:
            self.service.stop()
            self.sampler.stop()
        report = {
            "started_at": started_at, "finished_at": datetime.now(UTC).isoformat(),
            "host": {"platform": platform.platform(), "python": platform.python_version(),
                     "cpu": _cpu_model(), "cpus": os.cpu_count(),
                     "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()},
            "service": health, "fixture_source": "ARTWORK_TEST_FIXTURE_DIR (test-only, off by default)",
            "fixtures": fixtures, "results": self.results, "metrics": self.metrics,
        }
        (self.data_dir / "acceptance-report.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
        self.evidence.mkdir(parents=True, exist_ok=True)
        (self.evidence / "service-responses.json").write_text(json.dumps(self.samples, indent=2, sort_keys=True) + "\n")
        failed = [r["id"] for r in self.results if r["status"] != "pass"]
        log(f"{len(self.results) - len(failed)}/{len(self.results)} checks passed"
            + (f"; failed: {', '.join(failed)}" if failed else ""))
        log(f"report: {self.data_dir / 'acceptance-report.json'}")
        return 1 if failed else 0


def _cpu_model() -> str | None:
    try:
        for row in Path("/proc/cpuinfo").read_text().splitlines():
            if row.startswith("model name"):
                return row.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if shutil.which("node") is None:
        raise SystemExit("node is required for the JavaScript DXF read-back check")
    sys.exit(Acceptance(args.data_dir.expanduser().resolve(), args.port).run())


if __name__ == "__main__":
    main()
