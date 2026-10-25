"""Read-back of exported packages through an independent JavaScript DXF reader.

The Python exporter writes with ezdxf and verifies with its own parser; this
test re-opens the same files with the third-party `dxf-parser` npm package
(tests/js/verify-dxf.mjs), as plan section 9 requires.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from artwork_service.dxf_export import PackageGroup, build_package
from artwork_service.nesting import bbox_baseline, layout_metrics
from artwork_service.nesting_types import NestOutcome

from nest_shapes import flag_shape, l_shape, part, plate_with_hole, sheet, two_component_part

JS_DIR = Path(__file__).resolve().parents[1] / "js"
VERIFY = JS_DIR / "verify-dxf.mjs"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; the JavaScript DXF read-back check cannot run")
    if not (JS_DIR / "node_modules" / "dxf-parser").is_dir():
        pytest.skip(f"dxf-parser is not installed; run `npm ci` in {JS_DIR}")
    return node


def run_js_verifier(package_dir: Path) -> tuple[int, dict]:
    proc = subprocess.run([_node(), str(VERIFY), str(package_dir)], capture_output=True, text=True, timeout=120,
                          check=False)
    if proc.returncode not in (0, 1):
        raise AssertionError(f"verify-dxf.mjs crashed ({proc.returncode}): {proc.stderr}")
    return proc.returncode, json.loads(proc.stdout)


def _outcome(parts, stock):
    sheets, unplaced = bbox_baseline(parts, stock)
    return NestOutcome(sheets=sheets, unplaced_instance_ids=unplaced, status="complete", engine="bbox-baseline",
                       engine_version="nesting-1.0.0", settings={}, runtime_s=0.0,
                       metrics=layout_metrics(sheets, unplaced, parts, stock), baseline_metrics={})


@pytest.fixture
def package_dir(tmp_path: Path) -> Path:
    steel = [part("A", l_shape(), 7, product_id="pa"), part("B", plate_with_hole(), 4, product_id="pb"),
             part("T", two_component_part(), 3, product_id="pt")]
    alu = [part("C", flag_shape(), 5, product_id="pc")]
    steel_stock, alu_stock = sheet(1000, 800), sheet(600, 600)
    result = build_package(
        "jscheck",
        [PackageGroup("steel/2mm", "steel", 2.0, steel, steel_stock, _outcome(steel, steel_stock)),
         PackageGroup("alu/3mm", "aluminium", 3.0, alu, alu_stock, _outcome(alu, alu_stock))],
        chord_tolerance_mm=0.05, context={}, created_at=datetime(2026, 10, 25, tzinfo=UTC))
    out = tmp_path / "pkg"
    with zipfile.ZipFile(io.BytesIO(result.zip_bytes)) as archive:
        archive.extractall(out)
    return out


def test_js_reader_accepts_exported_package(package_dir: Path) -> None:
    code, report = run_js_verifier(package_dir)
    assert code == 0, report
    assert report["valid"] and report["reader"].startswith("dxf-parser@")
    assert report["instances"] == 7 + 4 + 3 + 5
    manifest = json.loads((package_dir / "manifest.json").read_text())
    for sheet_report, sheet_manifest in zip(report["sheets"], manifest["sheets"], strict=True):
        assert sheet_report["errors"] == []
        assert sheet_report["insunits"] == 4 and sheet_report["layers"] == ["0"]
        assert sheet_report["entities"] == sheet_manifest["dxf_check"]["loop_count"]
    assert len(manifest["sheets"]) >= 2


def _rewrite(package_dir: Path, mutate) -> None:
    """Apply `mutate` to the first sheet's DXF text and refresh its manifest hash,
    so the reader's own checks (not the hash) must catch the change."""
    manifest_path = package_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    entry = manifest["sheets"][0]["dxf"]
    path = package_dir / entry["filename"]
    data = mutate(path.read_text()).encode()
    path.write_bytes(data)
    entry["sha256"] = hashlib.sha256(data).hexdigest()
    manifest_path.write_text(json.dumps(manifest))


def test_js_reader_rejects_entity_on_other_layer(package_dir: Path) -> None:
    def to_cut_layer(text: str) -> str:
        head, sep, tail = text.partition("LWPOLYLINE")
        return head + sep + re.sub(r"\n  8\n0\n", "\n  8\nCUT\n", tail, count=1)

    _rewrite(package_dir, to_cut_layer)
    code, report = run_js_verifier(package_dir)
    assert code == 1
    assert any("layer \"CUT\"" in e for e in report["sheets"][0]["errors"])


def test_js_reader_rejects_open_loop(package_dir: Path) -> None:
    def open_first(text: str) -> str:
        head, sep, tail = text.partition("LWPOLYLINE")
        return head + sep + re.sub(r"\n 70\n1\n", "\n 70\n0\n", tail, count=1)

    _rewrite(package_dir, open_first)
    code, report = run_js_verifier(package_dir)
    assert code == 1
    assert any("not closed" in e for e in report["sheets"][0]["errors"])


def test_js_reader_rejects_moved_placement(package_dir: Path) -> None:
    manifest_path = package_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sheets"][0]["placements"][0]["tx_mm"] += 5.0
    manifest_path.write_text(json.dumps(manifest))
    code, report = run_js_verifier(package_dir)
    assert code == 1
    assert any("not reproduced" in e for e in report["sheets"][0]["errors"])
