"""Benchmark nest_group against the bounding-box baseline on the acceptance fixtures.

Usage (from services/artwork-service):

    uv run python scripts/bench_nesting.py [--budget 10] [--seed 1] [--json]

Fixtures come from tests/nesting/nest_shapes.py so the benchmark and the tests
use the same known contours:
- mixed: 44 x L-bracket 300 x 300 mm + 10 x plate 200 x 120 mm with a hole,
  1500 x 3000 mm sheet, margins 10/15/20/25 mm (l/r/b/t), gap 5 mm;
- concave: 40 x comb 320 x 290 mm (6 teeth), rotations 0/180, same sheet.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "nesting"))

from nest_shapes import comb, mixed_batch, part, sheet  # noqa: E402

from artwork_service.nesting import nest_group  # noqa: E402

FIXTURES = {
    "mixed-54": lambda: (mixed_batch(), sheet()),
    "concave-combs-40": lambda: ([part("comb", comb(), 40, rotations=(0, 180))], sheet()),
}


def run(name: str, budget: float, seed: int) -> dict:
    parts, stock = FIXTURES[name]()
    started = time.monotonic()
    outcome = nest_group(
        parts, stock, time_budget_s=budget, seed=seed, cancel=lambda: False, progress=lambda _f, _s: None
    )
    wall = time.monotonic() - started
    m, b = outcome.metrics, outcome.baseline_metrics
    return {
        "fixture": name,
        "budget_s": budget,
        "status": outcome.status,
        "engine": outcome.engine,
        "requested": m["requested"],
        "placed": m["placed"],
        "sheets": m["sheet_count"],
        "utilization": round(m["utilization"], 4),
        "last_sheet_extent_mm": round(m["occupied_extent_mm"], 1),
        "runtime_s": round(wall, 2),
        "baseline_sheets": b["sheet_count"],
        "baseline_utilization": round(b["utilization"], 4),
        "baseline_last_sheet_extent_mm": round(b["occupied_extent_mm"], 1),
        "solver_attempts": [
            {k: a.get(k) for k in ("status", "valid", "sheet_count", "solutions_seen", "runtime_s")}
            for a in outcome.settings["attempts"]
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--budget", type=float, default=10.0)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--json", action="store_true", help="print raw JSON rows")
    parser.add_argument("--fixture", choices=sorted(FIXTURES), action="append")
    args = parser.parse_args()
    rows = [run(name, args.budget, args.seed) for name in (args.fixture or FIXTURES)]
    if args.json:
        print(json.dumps(rows, indent=2))
        return
    header = f"{'fixture':<18}{'engine':<25}{'placed':>8}{'sheets':>8}{'util':>8}{'extent':>9}{'time':>7}"
    print(header + "   | baseline sheets/util/extent")
    for r in rows:
        print(
            f"{r['fixture']:<18}{r['engine']:<25}{r['placed']:>4}/{r['requested']:<3}{r['sheets']:>8}"
            f"{r['utilization']:>8.3f}{r['last_sheet_extent_mm']:>9.1f}{r['runtime_s']:>7.2f}"
            f"   | {r['baseline_sheets']} / {r['baseline_utilization']:.3f} / {r['baseline_last_sheet_extent_mm']:.1f}"
        )


if __name__ == "__main__":
    main()
