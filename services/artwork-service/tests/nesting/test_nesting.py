"""nest_group behaviour: complete coverage, pre-fit, baseline fallback, budget and cancellation."""

from __future__ import annotations

import dataclasses
import time

import pytest
from shapely.geometry import MultiPolygon, Polygon

from artwork_service import nesting, solver_adapter
from artwork_service.nesting import bbox_baseline, nest_group
from artwork_service.nesting_types import NestingError
from artwork_service.validation import validate_layout

from nest_shapes import (
    comb,
    flag_shape,
    l_shape,
    mixed_batch,
    never_cancel,
    no_progress,
    part,
    plate_with_hole,
    ring_part,
    scaled,
    sheet,
    two_component_part,
)


def _nest(parts, stock, budget=4.0, **kwargs):
    return nest_group(
        parts,
        stock,
        time_budget_s=budget,
        seed=kwargs.pop("seed", 7),
        cancel=kwargs.pop("cancel", never_cancel),
        progress=kwargs.pop("progress", no_progress),
    )


def _placed_ids(outcome):
    return [p.instance_id for s in outcome.sheets for p in s]


def _assert_complete(outcome, parts, stock):
    expected = sorted(i for p in parts for i in p.instance_ids)
    assert outcome.status == "complete"
    assert outcome.unplaced_instance_ids == []
    assert sorted(_placed_ids(outcome)) == expected
    report = validate_layout(parts, stock, outcome.sheets)
    assert report.valid, [v.to_dict() for v in report.violations]


@pytest.fixture(scope="module")
def mixed_outcome():
    parts, stock = mixed_batch(), sheet()
    return parts, stock, _nest(parts, stock, budget=6.0)


def test_mixed_batch_places_exactly_54_independent_instances(mixed_outcome):
    parts, stock, outcome = mixed_outcome
    _assert_complete(outcome, parts, stock)
    ids = _placed_ids(outcome)
    assert len(ids) == 54 and len(set(ids)) == 54
    assert sum(1 for i in ids if i.startswith("A#")) == 44
    assert sum(1 for i in ids if i.startswith("B#")) == 10
    assert outcome.metrics["requested"] == outcome.metrics["placed"] == 54


def test_mixed_batch_metrics_and_settings_are_recorded(mixed_outcome):
    parts, stock, outcome = mixed_outcome
    metal = 44 * parts[0].geometry.area + 10 * parts[1].geometry.area
    assert outcome.metrics["metal_area_mm2"] == pytest.approx(metal)
    sheet_area = outcome.metrics["sheet_count"] * stock.width_mm * stock.height_mm
    assert outcome.metrics["utilization"] == pytest.approx(metal / sheet_area)
    assert outcome.metrics["extent_axis"] == "y"
    assert outcome.baseline_metrics["valid"] is True
    assert outcome.settings["seed"] == 7 and outcome.settings["seed_applied"] is False
    assert outcome.settings["attempts"][0]["engine_version"] == "0.1.1218"
    assert outcome.runtime_s > 0
    # Never worse than the bounding-box reference.
    assert outcome.metrics["sheet_count"] <= outcome.baseline_metrics["sheet_count"]


def test_repeated_only_single_part():
    parts, stock = [part("R", flag_shape(), 30)], sheet(1000, 1000, max_sheets=5)
    _assert_complete(_nest(parts, stock, budget=3.0), parts, stock)


def test_all_different_parts():
    parts = [
        part("L", l_shape(250, 60), 1),
        part("P", plate_with_hole(), 1),
        part("F", flag_shape(), 1),
        part("C", comb(4), 1),
        part("O", ring_part(), 1),
        part("T", two_component_part(), 1),
    ]
    stock = sheet(1000, 1000, max_sheets=3)
    _assert_complete(_nest(parts, stock, budget=3.0), parts, stock)


def test_same_product_different_sizes_stay_separate_lines():
    small = part("flower-300", scaled(flag_shape(), 1.5), 4, product_id="flower")
    large = part("flower-600", scaled(flag_shape(), 3.0), 2, product_id="flower")
    parts, stock = [small, large], sheet(1500, 3000)
    outcome = _nest(parts, stock, budget=3.0)
    _assert_complete(outcome, parts, stock)
    by_line = {}
    for placement in (p for s in outcome.sheets for p in s):
        by_line.setdefault(placement.line_id, []).append(placement)
    assert {k: len(v) for k, v in by_line.items()} == {"flower-300": 4, "flower-600": 2}
    assert all(p.product_id == "flower" for v in by_line.values() for p in v)


def test_multi_material_is_two_independent_groups():
    steel = [part("S", l_shape(), 6)]
    alu = [part("A", plate_with_hole(), 6)]
    steel_stock, alu_stock = sheet(1000, 2000, gap=5), sheet(1250, 2500, gap=8)
    a, b = _nest(steel, steel_stock, budget=2.0), _nest(alu, alu_stock, budget=2.0)
    _assert_complete(a, steel, steel_stock)
    _assert_complete(b, alu, alu_stock)
    assert not set(_placed_ids(a)) & set(_placed_ids(b))


def test_rotations_restricted_to_allowed_set():
    parts = [part("F0", flag_shape(), 8, rotations=(0,)), part("F90", flag_shape(), 8, rotations=(90, 270))]
    stock = sheet(1000, 1000)
    outcome = _nest(parts, stock, budget=3.0)
    _assert_complete(outcome, parts, stock)
    for placement in (p for s in outcome.sheets for p in s):
        allowed = (0,) if placement.line_id == "F0" else (90, 270)
        assert placement.rotation_deg in allowed


def test_concave_interleaving_beats_bbox_baseline():
    """Combs interleave tooth-into-gap; bounding boxes cannot. 8 combs on a 700 mm sheet."""
    parts = [part("comb", comb(), 8, rotations=(0, 180))]
    stock = sheet(700, 700, margins=(10, 10, 10, 10), gap=5, max_sheets=4)
    outcome = _nest(parts, stock, budget=10.0)
    _assert_complete(outcome, parts, stock)
    base = outcome.baseline_metrics
    assert base["sheet_count"] == 2
    assert outcome.engine == solver_adapter.ENGINE_NAME
    improved = (outcome.metrics["sheet_count"], outcome.metrics["occupied_extent_mm"]) < (
        base["sheet_count"],
        base["occupied_extent_mm"],
    )
    assert improved, (outcome.metrics["sheet_count"], base["sheet_count"])


def test_part_too_big_fails_before_optimisation(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("solver must not run when a part cannot fit")

    monkeypatch.setattr(solver_adapter, "run_solver", forbidden)
    square = MultiPolygon([Polygon([(0, 0), (1500, 0), (1500, 1500), (0, 1500)])])
    parts = [part("big", square, 1)]
    with pytest.raises(NestingError) as exc:
        _nest(parts, sheet(1500, 3000, margins=(5, 5, 5, 5)))
    assert exc.value.code == "PART_DOES_NOT_FIT"
    detail = exc.value.details["parts"][0]
    assert detail["part_width_mm"] == 1500 and detail["usable_envelope"]["width_mm"] == 1490


def test_part_fits_only_rotated_passes_prefit():
    long_bar = MultiPolygon([Polygon([(0, 0), (1800, 0), (1800, 100), (0, 100)])])
    parts = [part("bar", long_bar, 2, rotations=(90,))]
    stock = sheet(1500, 3000)
    _assert_complete(_nest(parts, stock, budget=2.0), parts, stock)
    with pytest.raises(NestingError):
        _nest([part("bar0", long_bar, 1, rotations=(0,))], stock)


def test_stock_limit_reports_unplaced_explicitly():
    parts = [part("P", plate_with_hole(), 12)]
    stock = sheet(450, 300, margins=(5, 5, 5, 5), gap=5, max_sheets=1)
    outcome = _nest(parts, stock, budget=2.0)
    assert outcome.status == "incomplete"
    placed = _placed_ids(outcome)
    assert outcome.unplaced_instance_ids and len(placed) + len(outcome.unplaced_instance_ids) == 12
    assert not set(placed) & set(outcome.unplaced_instance_ids)
    assert len(outcome.sheets) <= 1
    assert outcome.metrics["unplaced"] == len(outcome.unplaced_instance_ids)
    assert validate_layout(parts, stock, outcome.sheets, allow_unplaced=True).valid


def test_invalid_solver_layout_is_retried_then_falls_back_to_baseline(monkeypatch):
    parts, stock = [part("P", plate_with_hole(), 3)], sheet(1000, 1000)
    calls = []

    def stacked(instance, **kwargs):
        calls.append(instance)
        # Every copy on the same spot: overlapping, must be rejected.
        items = [{"id": 0, "x": 100.0, "y": 100.0, "angle": 0.0, "mirror": False}] * 3
        return solver_adapter.SolverRun("ok", {"bins": [{"id": 0, "copies": 1, "items": items}]}, 0.01, 1)

    monkeypatch.setattr(solver_adapter, "run_solver", stacked)
    outcome = _nest(parts, stock, budget=3.0)
    assert len(calls) == 2  # first attempt plus one safer retry
    assert outcome.engine == nesting.BASELINE_ENGINE
    assert [a["valid"] for a in outcome.settings["attempts"]] == [False, False]
    assert outcome.settings["attempts"][1]["safety_offset_mm"] > 0
    _assert_complete(outcome, parts, stock)


def test_timeout_returns_validated_layout_within_budget():
    parts = [part("F", flag_shape(), 60), part("C", comb(), 10)]
    stock = sheet(1500, 3000)
    started = time.monotonic()
    outcome = _nest(parts, stock, budget=1.5)
    elapsed = time.monotonic() - started
    assert elapsed < 1.5 + 2.0  # budget plus validation/selection slack
    _assert_complete(outcome, parts, stock)
    assert outcome.engine in (solver_adapter.ENGINE_NAME, nesting.BASELINE_ENGINE)


def test_cancellation_stops_the_nest():
    parts, stock = mixed_batch(), sheet()
    started = time.monotonic()
    outcome = _nest(parts, stock, budget=30.0, cancel=lambda: time.monotonic() - started > 1.0)
    assert outcome.status == "cancelled"
    assert time.monotonic() - started < 5.0
    assert outcome.sheets == []
    assert len(outcome.unplaced_instance_ids) == 54


def test_progress_is_reported_monotonically(mixed_outcome):
    seen = []
    parts, stock = [part("F", flag_shape(), 4)], sheet(1000, 1000)
    _nest(parts, stock, budget=1.5, progress=lambda f, s: seen.append((f, s)))
    fractions = [f for f, _ in seen]
    assert fractions == sorted(fractions) and fractions[0] == 0.0 and fractions[-1] == 1.0
    assert {"prefit", "baseline", "done"} <= {s for _, s in seen}


def test_bbox_baseline_is_valid_on_its_own():
    parts, stock = mixed_batch(), sheet()
    sheets, unplaced = bbox_baseline(parts, stock)
    assert unplaced == []
    assert validate_layout(parts, stock, sheets).valid


@pytest.mark.parametrize(
    "changes",
    [{"gap_mm": -1.0}, {"margin_left": 800.0, "margin_right": 800.0}, {"max_sheets": 0}, {"width_mm": float("nan")}],
)
def test_invalid_stock_is_rejected(changes):
    with pytest.raises(NestingError) as exc:
        _nest([part("F", flag_shape(), 1)], dataclasses.replace(sheet(1500, 3000), **changes))
    assert exc.value.code == "INVALID_DIMENSIONS"


def test_geometry_must_be_bbox_normalised():
    shifted = MultiPolygon([Polygon([(5, 5), (50, 5), (50, 50), (5, 50)])])
    with pytest.raises(NestingError) as exc:
        _nest([part("S", shifted, 1)], sheet())
    assert exc.value.code == "INVALID_CONTOURS"
