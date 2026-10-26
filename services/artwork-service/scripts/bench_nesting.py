"""Benchmark nest_group (and optionally the production package) on fixed fixtures.

Usage (from services/artwork-service):

    uv run python scripts/bench_nesting.py [--budget 30] [--seed 1] [--fixture NAME ...]
                                           [--package] [--real] [--owner-real] [--json]

Fixtures come from tests/nesting/nest_shapes.py so the benchmark and the tests
use the same known contours; every one uses a 1500 x 3000 mm sheet, margins
10/15/20/25 mm (l/r/b/t) and a 5 mm gap:
- mixed-54: 44 x L-bracket 300 x 300 mm + 10 x plate 200 x 120 mm with a hole;
- concave-combs-40: 40 x comb 320 x 290 mm (6 teeth), rotations 0/180;
- owner-54: the owner's reported batch, 10 x concave wave art 800 x 800 mm +
  24 x five-point star 300 mm + 20 x six-point star 280 mm;
- owner-84: owner-54 plus 30 small fillers (12 x shuriken 100 mm, 10 x
  shuriken 60 mm, 8 x kunai 150 mm).
With ``--real`` the three traced photos in tests/fixtures/real are added:
- real-54: flower 800 mm x 10, trees 300 mm x 22, motorcycle 300 mm x 22;
- real-84: real-54 plus flower 120 mm x 15 and motorcycle 100 mm x 15.
With ``--owner-real`` the owner's own traced masters
(tests/fixtures/real/owner-masters.json.gz, exported from the dev catalogue)
are added on the owner's stock: 1500 x 3000 mm, margins 10 mm, gap 5 mm:
- owner-real-54: Chromatic Waves 800 mm x 10 + Starburst Compass 300 mm x 44;
- owner-real-84: owner-real-54 plus Leaf Four-Point Shuriken 100 mm x 20 and
  Demon Wind Shuriken 70 mm x 10 (the QA batch of 2026-10-27).

``--package`` also builds the production ZIP (DXF export and read-back, SVG,
manifest), the non-solver part of a nest job, and reports its time; the total
is nest + package, i.e. the job's wall time without database and file writes.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "nesting"))

from nest_shapes import comb, mixed_batch, owner_batch, part, sheet  # noqa: E402

from artwork_service import geometry as geo  # noqa: E402
from artwork_service.dxf_export import PackageGroup, build_package  # noqa: E402
from artwork_service.nesting import nest_group  # noqa: E402
from artwork_service.nesting_types import NestingError, rotate_about_origin  # noqa: E402

FIXTURES = {
    "mixed-54": lambda: mixed_batch(),
    "concave-combs-40": lambda: [part("comb", comb(), 40, rotations=(0, 180))],
    "owner-54": lambda: owner_batch(fillers=False),
    "owner-84": lambda: owner_batch(fillers=True),
}


def _real(fillers: bool) -> list:
    from artwork_service.tracing import trace_image  # noqa: PLC0415 - only with --real

    masters = {
        name: trace_image((ROOT / "tests" / "fixtures" / "real" / f"{name}.png").read_bytes()).geometry
        for name in ("flower", "trees", "motorcycle")
    }

    def sized(name: str, width: float):
        min_x, min_y, max_x, max_y = masters[name].bounds
        return geo.scale_master(masters[name], width, width * (max_y - min_y) / (max_x - min_x))

    parts = [part("flower", sized("flower", 800), 10), part("trees", sized("trees", 300), 22),
             part("moto", sized("motorcycle", 300), 22)]
    if fillers:
        parts += [part("flower-s", sized("flower", 120), 15), part("moto-s", sized("motorcycle", 100), 15)]
    return parts


def _owner_real(fillers: bool) -> list:
    data = json.loads(gzip.decompress((ROOT / "tests" / "fixtures" / "real" / "owner-masters.json.gz").read_bytes()))

    def sized(name: str, width: float):
        master = geo.from_json(data[name]["geometry"])
        min_x, min_y, max_x, max_y = master.bounds
        return geo.scale_master(master, width, width * (max_y - min_y) / (max_x - min_x))

    parts = [part("wave", sized("wave", 800), 10), part("star", sized("star", 300), 44)]
    if fillers:
        parts += [part("leaf", sized("leaf", 100), 20), part("demon", sized("demon", 70), 10)]
    return parts


OWNER_STOCK = {"margins": (10.0, 10.0, 10.0, 10.0), "gap": 5.0, "max_sheets": 6}


def leftover_m2(sheets, parts, stock) -> float:
    """Usable area outside each sheet's occupied box (see docs), summed; computed
    here so the number is comparable across service versions."""
    by_instance = {i: p for p in parts for i in p.instance_ids}
    usable = stock.usable_width * stock.usable_height
    total = 0.0
    for placements in sheets:
        max_x = max_y = float("-inf")
        for p in placements:
            _, _, x, y = rotate_about_origin(by_instance[p.instance_id].geometry, p.rotation_deg).bounds
            max_x, max_y = max(max_x, x + p.tx_mm), max(max_y, y + p.ty_mm)
        box_w = min(stock.usable_width, max_x + stock.gap_mm - stock.usable_min_x)
        box_h = min(stock.usable_height, max_y + stock.gap_mm - stock.usable_min_y)
        total += usable - box_w * box_h
    return total / 1e6


def run(name: str, parts: list, budget: float, seed: int, package: bool) -> dict:
    stock = sheet(**OWNER_STOCK) if name.startswith("owner-real") else sheet()
    started = time.monotonic()
    outcome = nest_group(
        parts, stock, time_budget_s=budget, seed=seed, cancel=lambda: False, progress=lambda _f, _s: None
    )
    nest_s = time.monotonic() - started
    package_s = package_error = None
    if package:
        began = time.monotonic()
        try:
            build_package(
                "bench", [PackageGroup("g", "steel", 2.0, parts, stock, outcome)], chord_tolerance_mm=0.05,
                context={}, created_at=datetime.now(UTC),
            )
        except NestingError as exc:
            package_error = exc.code
        package_s = time.monotonic() - began
    m, b = outcome.metrics, outcome.baseline_metrics
    attempts = outcome.settings["attempts"]
    fill = outcome.settings.get("gap_fill") or {}
    return {
        "fixture": name,
        "budget_s": budget,
        "status": outcome.status,
        "engine": outcome.engine,
        "requested": m["requested"],
        "placed": m["placed"],
        "sheets": m["sheet_count"],
        "per_sheet_parts": [len(s) for s in outcome.sheets],
        "utilization": round(m["utilization"], 4),
        "last_sheet_extent_mm": round(m["occupied_extent_mm"], 1),
        "leftover_m2": round(leftover_m2(outcome.sheets, parts, stock), 3),
        "solver_s": round(sum(a.get("runtime_s") or 0.0 for a in attempts), 2),
        "gap_fill_moves": fill.get("moves", 0) if fill.get("applied") else 0,
        "fillers_tucked": _tucked(fill),
        "nest_s": round(nest_s, 2),
        "package_s": round(package_s, 2) if package_s is not None else None,
        "package_error": package_error,
        "total_s": round(nest_s + (package_s or 0.0), 2),
        "baseline_sheets": b["sheet_count"],
        "baseline_utilization": round(b["utilization"], 4),
        "baseline_last_sheet_extent_mm": round(b["occupied_extent_mm"], 1),
        "solver_attempts": [
            {k: a.get(k) for k in ("status", "valid", "sheet_count", "solutions_seen", "solution_times_s", "runtime_s")}
            for a in attempts
        ],
        "gap_fill": fill,
    }


def _tucked(fill: dict) -> str:
    """'tucked/fillers' placed among other parts by the applied filler phase, or '-'."""
    phase = fill.get("filler_phase") or {}
    if not fill.get("applied") or phase.get("status") != "applied":
        return "-"
    return f"{phase['tucked']}/{phase['fillers']}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget", type=float, default=30.0)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--json", action="store_true", help="print raw JSON rows")
    parser.add_argument("--package", action="store_true", help="also time the production package")
    parser.add_argument("--real", action="store_true", help="add the traced real-photo fixtures")
    parser.add_argument("--owner-real", action="store_true", help="add the owner's traced catalogue masters")
    parser.add_argument(
        "--fixture", choices=sorted([*FIXTURES, "real-54", "real-84", "owner-real-54", "owner-real-84"]),
        action="append",
    )
    args = parser.parse_args()
    fixtures = dict(FIXTURES)
    if args.real or any(f.startswith("real") for f in args.fixture or []):
        fixtures["real-54"] = lambda: _real(False)
        fixtures["real-84"] = lambda: _real(True)
    if args.owner_real or any(f.startswith("owner-real") for f in args.fixture or []):
        fixtures["owner-real-54"] = lambda: _owner_real(False)
        fixtures["owner-real-84"] = lambda: _owner_real(True)
    rows = [run(name, fixtures[name](), args.budget, args.seed, args.package) for name in (args.fixture or fixtures)]
    if args.json:
        print(json.dumps(rows, indent=2))
        return
    print(
        f"{'fixture':<18}{'engine':<25}{'placed':>8}{'sheets':>7}{'util':>7}{'extent':>8}{'left m2':>9}"
        f"{'solver':>8}{'moves':>6}{'tucked':>8}{'nest':>7}{'pkg':>7}{'total':>7}   | baseline sheets/util/extent"
    )
    for r in rows:
        pkg = f"{r['package_s']:>7.2f}" if r["package_s"] is not None else f"{'-':>7}"
        if r["package_error"]:
            pkg += f" ({r['package_error']})"
        print(
            f"{r['fixture']:<18}{r['engine']:<25}{r['placed']:>4}/{r['requested']:<3}{r['sheets']:>7}"
            f"{r['utilization']:>7.3f}{r['last_sheet_extent_mm']:>8.1f}{r['leftover_m2']:>9.3f}"
            f"{r['solver_s']:>8.2f}{r['gap_fill_moves']:>6}{r['fillers_tucked']:>8}{r['nest_s']:>7.2f}{pkg}"
            f"{r['total_s']:>7.2f}"
            f"   | {r['baseline_sheets']} / {r['baseline_utilization']:.3f} / {r['baseline_last_sheet_extent_mm']:.1f}"
        )


if __name__ == "__main__":
    main()
