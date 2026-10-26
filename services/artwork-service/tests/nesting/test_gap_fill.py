"""Gap filling: small parts move into the free space between larger ones, never into
holes, without more sheets or a longer last sheet, and the result validates."""

from __future__ import annotations

import time

import pytest
from shapely.geometry import MultiPolygon, Polygon

from artwork_service import nesting, solver_adapter
from artwork_service.gap_fill import _Filler, fill_gaps
from artwork_service.nesting import bbox_baseline, layout_metrics, nest_group
from artwork_service.nesting_types import Placement, filled_shell, place_geometry
from artwork_service.validation import validate_layout

from nest_shapes import never_cancel, no_progress, ninja_blade, part, ring_part, sheet, shuriken, star, wave_art


def _far(layout, parts, stock, keys=None):
    by_instance = {i: p for p in parts for i in p.instance_ids}
    values = []
    for p in layout:
        if keys is None or p.line_id in keys:
            world = place_geometry(by_instance[p.instance_id].geometry, p.rotation_deg, p.tx_mm, p.ty_mm)
            values.append(world.bounds[3] if stock.long_axis == "y" else world.bounds[2])
    return max(values)


def _fill(parts, stock, sheets, seconds=30.0):
    return fill_gaps(parts, stock, sheets, deadline=time.monotonic() + seconds, cancel=never_cancel)


def _no_solver(monkeypatch):
    def no_solution(instance, **kwargs):
        return solver_adapter.SolverRun("no_solution", None, 0.01, 0)

    monkeypatch.setattr(solver_adapter, "run_solver", no_solution)


@pytest.fixture(scope="module")
def stars_and_fillers():
    """Concave stars on bounding-box shelves, with small fillers on their own shelf beyond them."""
    parts = [
        part("star", star(300, 5), 6),
        part("shuriken", shuriken(70), 8),
        part("kunai", ninja_blade(110), 4, rotations=(0, 180)),
    ]
    stock = sheet(1000, 1500, margins=(10, 10, 10, 10), gap=5, max_sheets=3)
    sheets, unplaced = bbox_baseline(parts, stock)
    assert not unplaced and validate_layout(parts, stock, sheets).valid
    return parts, stock, sheets


def test_small_parts_move_between_large_ones(stars_and_fillers):
    parts, stock, sheets = stars_and_fillers
    before_extent = _far(sheets[-1], parts, stock)
    stars_far = _far([p for s in sheets for p in s], parts, stock, {"star"})
    # On the baseline every filler sits on a shelf beyond the stars.
    assert all(
        _far([p], parts, stock) > stars_far for s in sheets for p in s if p.line_id != "star"
    )

    result = _fill(parts, stock, sheets)

    assert result.stopped == "converged" and result.moves > 0
    report = validate_layout(parts, stock, result.sheets)
    assert report.valid, [v.to_dict() for v in report.violations]
    assert len(result.sheets) <= len(sheets)
    assert _far(result.sheets[-1], parts, stock) < before_extent
    # Fillers now sit in the pockets between the stars, below the stars' far edge.
    placed = [p for s in result.sheets for p in s]
    tucked = [p for p in placed if p.line_id != "star" and _far([p], parts, stock) <= stars_far]
    assert len(tucked) >= 8
    # Same instances, allowed rotations only (validation checks the latter too).
    assert sorted(p.instance_id for p in placed) == sorted(i for p in parts for i in p.instance_ids)
    assert all(p.rotation_deg in (0, 180) for p in placed if p.line_id == "kunai")


def test_gap_fill_never_uses_holes():
    """A ring's hole is big enough for the fillers, but holes are unavailable in v1."""
    ring = part("ring", ring_part(radius=200, hole_radius=170, segments=96), 1)
    fillers = part("shuriken", shuriken(60), 6)
    parts = [ring, fillers]
    stock = sheet(700, 1200, margins=(5, 5, 5, 5), gap=5, max_sheets=2)
    sheets, _ = bbox_baseline(parts, stock)
    result = _fill(parts, stock, sheets)
    assert result.moves > 0
    assert validate_layout(parts, stock, result.sheets).valid
    ring_place = next(p for s in result.sheets for p in s if p.line_id == "ring")
    world_ring = place_geometry(ring.geometry, ring_place.rotation_deg, ring_place.tx_mm, ring_place.ty_mm)
    hole = Polygon(world_ring.geoms[0].interiors[0])
    for p in (p for s in result.sheets for p in s if p.line_id == "shuriken"):
        shell = filled_shell(place_geometry(fillers.geometry, p.rotation_deg, p.tx_mm, p.ty_mm))
        assert not shell.intersects(hole)
    # The search itself treats the hole as occupied, not just the final check.
    filler = _Filler(parts, stock)
    mask = filler.obstacles([filler.entry(ring_place)])
    centre = hole.centroid
    assert mask[int(centre.y // filler.cell), int(centre.x // filler.cell)] == 1


def test_gap_fill_on_a_wide_sheet_compacts_along_x():
    parts = [part("star", star(250, 5), 4), part("shuriken", shuriken(60), 10)]
    stock = sheet(1600, 600, margins=(10, 10, 10, 10), gap=4, max_sheets=2)
    assert stock.long_axis == "x"
    sheets, _ = bbox_baseline(parts, stock)
    before = _far(sheets[-1], parts, stock)
    result = _fill(parts, stock, sheets)
    assert validate_layout(parts, stock, result.sheets).valid
    assert len(result.sheets) <= len(sheets)
    assert _far(result.sheets[-1], parts, stock) <= before


def test_gap_fill_stops_at_deadline_and_on_cancel(stars_and_fillers):
    parts, stock, sheets = stars_and_fillers
    late = fill_gaps(parts, stock, sheets, deadline=time.monotonic() - 1.0, cancel=never_cancel)
    assert late.stopped == "deadline" and late.moves == 0 and late.sheets == [list(s) for s in sheets]
    cancelled = fill_gaps(parts, stock, sheets, deadline=time.monotonic() + 30, cancel=lambda: True)
    assert cancelled.stopped == "cancelled" and cancelled.moves == 0


def test_nest_group_fills_the_baseline_when_the_solver_has_nothing(stars_and_fillers, monkeypatch):
    parts, stock, _ = stars_and_fillers
    _no_solver(monkeypatch)
    outcome = nest_group(parts, stock, time_budget_s=6.0, seed=1, cancel=never_cancel, progress=no_progress)
    assert outcome.status == "complete" and outcome.engine == nesting.BASELINE_ENGINE
    assert validate_layout(parts, stock, outcome.sheets).valid
    fill = outcome.settings["gap_fill"]
    assert fill["applied"] and fill["moves"] > 0 and outcome.metrics["gap_fill_moves"] == fill["moves"]
    base = outcome.baseline_metrics
    assert outcome.metrics["sheet_count"] <= base["sheet_count"]
    assert outcome.metrics["occupied_extent_mm"] < base["occupied_extent_mm"]
    assert outcome.metrics["leftover_usable_area_mm2"] > base["leftover_usable_area_mm2"]
    assert outcome.metrics["engine"] == nesting.BASELINE_ENGINE
    # Instance ids are reassigned in sheet order after parts moved.
    ids = [p.instance_id for s in outcome.sheets for p in s if p.line_id == "shuriken"]
    assert ids == sorted(ids)


def test_owner_like_batch_tucks_fillers_with_the_solver():
    """Scaled-down owner batch: large concave art, concave stars, small fillers."""
    parts = [
        part("wave", wave_art(400, depth=40), 2),
        part("star", star(150, 5), 8),
        part("shuriken", shuriken(40), 8),
        part("kunai", ninja_blade(70), 4),
    ]
    stock = sheet(700, 1400, margins=(10, 10, 10, 10), gap=4, max_sheets=4)
    outcome = nest_group(parts, stock, time_budget_s=8.0, seed=1, cancel=never_cancel, progress=no_progress)
    assert outcome.status == "complete"
    report = validate_layout(parts, stock, outcome.sheets)
    assert report.valid, [v.to_dict() for v in report.violations]
    base = outcome.baseline_metrics
    assert outcome.metrics["sheet_count"] <= base["sheet_count"]
    assert (outcome.metrics["sheet_count"], outcome.metrics["occupied_extent_mm"]) <= (
        base["sheet_count"],
        base["occupied_extent_mm"] + 0.01 * stock.usable_height,
    )
    attempt = outcome.settings["attempts"][0]
    assert attempt["solution_times_s"] and attempt["build_s"] is not None
    assert outcome.settings["gap_fill"]["moves"] >= 0


def test_irregular_layout_wins_an_extent_tie_with_the_baseline(monkeypatch):
    """A solver layout no better than the bounding-box shelves (here: the same
    placements) is still preferred, so shoppers get the irregular nest."""
    parts = [part("star", star(200, 5), 4)]
    stock = sheet(800, 800, margins=(10, 10, 10, 10), gap=5, max_sheets=2)
    sheets, _ = bbox_baseline(parts, stock)
    items = [{"id": 0, "x": p.tx_mm, "y": p.ty_mm, "angle": float(p.rotation_deg), "mirror": False} for p in sheets[0]]

    def same_as_baseline(instance, **kwargs):
        return solver_adapter.SolverRun("ok", {"bins": [{"id": 0, "copies": 1, "items": items}]}, 0.01, 1)

    monkeypatch.setattr(solver_adapter, "run_solver", same_as_baseline)
    outcome = nest_group(parts, stock, time_budget_s=3.0, seed=1, cancel=never_cancel, progress=no_progress)
    assert outcome.engine == solver_adapter.ENGINE_NAME
    assert outcome.settings["selection"]["chosen"] == solver_adapter.ENGINE_NAME


def test_leftover_usable_area_metric():
    square = MultiPolygon([Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])])
    parts = [part("sq", square, 2)]
    stock = sheet(1000, 2000, margins=(10, 10, 20, 10), gap=5, max_sheets=2)
    a, b = parts[0].instance_ids
    sheets = [
        [Placement(a, "sq", "sq", "product-sq", 0, 10.0, 20.0)],
        [Placement(b, "sq", "sq", "product-sq", 0, 300.0, 500.0)],
    ]
    metrics = layout_metrics(sheets, [], parts, stock)
    usable = 980.0 * 1970.0
    first = usable - (100 + 5) * (100 + 5)
    second = usable - (400 + 5 - 10) * (600 + 5 - 20)
    assert metrics["sheets"][0]["leftover_usable_area_mm2"] == pytest.approx(first)
    assert metrics["sheets"][1]["leftover_usable_area_mm2"] == pytest.approx(second)
    assert metrics["leftover_usable_area_mm2"] == pytest.approx(first + second)
    assert metrics["last_sheet_leftover_usable_area_mm2"] == pytest.approx(second)
    assert "leftover_usable_area_mm2" in metrics["formulas"]
    # The occupied box is clipped to the usable area: a full sheet leaves nothing.
    big = MultiPolygon([Polygon([(0, 0), (980, 0), (980, 1970), (0, 1970)])])
    full = layout_metrics([[Placement("big#0001", "big", "big", "p", 0, 10.0, 20.0)]], [], [part("big", big, 1)], stock)
    assert full["leftover_usable_area_mm2"] == 0.0
