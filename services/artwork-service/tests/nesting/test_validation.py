"""Independent layout validation catches every injected defect."""

from __future__ import annotations

from dataclasses import replace

from shapely.geometry import MultiPolygon, Polygon

from artwork_service.nesting_types import Placement
from artwork_service.validation import validate_layout

from nest_shapes import part, plate_with_hole, ring_part, sheet

PLATE = part("P", plate_with_hole(), 3)  # 200 x 120 with a 100 x 60 hole
STOCK = sheet(1000, 1000, margins=(10, 10, 10, 10), gap=5, max_sheets=2)


def _at(instance_id: str, tx: float, ty: float, rotation: int = 0, spec=PLATE) -> Placement:
    return Placement(instance_id, spec.part_key, spec.line_id, spec.product_id, rotation, tx, ty)


def _good_layout():
    return [[_at("P#0001", 10, 10), _at("P#0002", 215, 10), _at("P#0003", 10, 135)]]


def _codes(report):
    return {v.code for v in report.violations}


def test_good_layout_is_valid():
    report = validate_layout([PLATE], STOCK, _good_layout())
    assert report.valid, report.to_dict()
    assert report.placed == report.requested == 3
    assert report.min_gap_mm == 5.0


def test_overlap_is_caught():
    sheets = _good_layout()
    sheets[0][1] = _at("P#0002", 100, 10)
    report = validate_layout([PLATE], STOCK, sheets)
    assert "OVERLAP" in _codes(report)
    assert not report.valid


def test_gap_shortfall_is_caught():
    sheets = _good_layout()
    sheets[0][1] = _at("P#0002", 213, 10)  # 3 mm apart, 5 required
    report = validate_layout([PLATE], STOCK, sheets)
    assert _codes(report) == {"GAP_VIOLATION"}


def test_out_of_bounds_and_margin_are_caught():
    sheets = _good_layout()
    sheets[0][2] = _at("P#0003", 5, 135)  # inside the sheet but inside the 10 mm margin
    assert _codes(validate_layout([PLATE], STOCK, sheets)) == {"OUT_OF_BOUNDS"}
    sheets[0][2] = _at("P#0003", 900, 900)
    assert _codes(validate_layout([PLATE], STOCK, sheets)) == {"OUT_OF_BOUNDS"}


def test_rotation_moves_geometry_about_origin():
    # Rotated 90 degrees about the origin the plate spans x in [-120, 0]; tx must compensate.
    sheets = [[_at("P#0001", 130, 10, rotation=90), _at("P#0002", 215, 10), _at("P#0003", 10, 400)]]
    assert validate_layout([PLATE], STOCK, sheets).valid
    sheets[0][0] = _at("P#0001", 10, 10, rotation=90)
    assert "OUT_OF_BOUNDS" in _codes(validate_layout([PLATE], STOCK, sheets))


def test_duplicate_and_missing_instances_are_caught():
    sheets = _good_layout()
    sheets[0][2] = _at("P#0001", 10, 135)
    report = validate_layout([PLATE], STOCK, sheets)
    assert {"DUPLICATE_INSTANCE", "MISSING_INSTANCE"} <= _codes(report)
    assert report.unplaced_instance_ids == ["P#0003"]
    # Duplicates across sheets count too.
    report = validate_layout([PLATE], STOCK, [_good_layout()[0], [_at("P#0002", 10, 10)]])
    assert "DUPLICATE_INSTANCE" in _codes(report)


def test_missing_allowed_when_explicitly_incomplete():
    sheets = [_good_layout()[0][:2]]
    report = validate_layout([PLATE], STOCK, sheets, allow_unplaced=True)
    assert report.valid and report.unplaced_instance_ids == ["P#0003"]
    assert not validate_layout([PLATE], STOCK, sheets).valid


def test_unknown_instance_identity_and_rotation_are_caught():
    sheets = _good_layout()
    sheets[0].append(_at("P#9999", 500, 500))
    assert "UNKNOWN_INSTANCE" in _codes(validate_layout([PLATE], STOCK, sheets))
    restricted = replace(PLATE, allowed_rotations=(0,))
    sheets = _good_layout()
    sheets[0][0] = _at("P#0001", 130, 10, rotation=90)
    assert "ROTATION_NOT_ALLOWED" in _codes(validate_layout([restricted], STOCK, sheets))
    sheets = _good_layout()
    sheets[0][0] = replace(sheets[0][0], product_id="other")
    assert "IDENTITY_MISMATCH" in _codes(validate_layout([PLATE], STOCK, sheets))


def test_too_many_sheets_is_caught():
    sheets = [[_at("P#0001", 10, 10)], [_at("P#0002", 10, 10)], [_at("P#0003", 10, 10)]]
    assert "TOO_MANY_SHEETS" in _codes(validate_layout([PLATE], STOCK, sheets))


def test_part_inside_another_parts_hole_is_rejected():
    ring = part("O", ring_part(radius=100, hole_radius=60), 1)
    pin = part("x", MultiPolygon([Polygon([(0, 0), (20, 0), (20, 20), (0, 20)])]), 1)
    sheets = [
        [
            Placement("O#0001", "O", "O", ring.product_id, 0, 100, 100),
            Placement("x#0001", "x", "x", pin.product_id, 0, 190, 190),  # centred in the hole, far from metal
        ]
    ]
    report = validate_layout([ring, pin], STOCK, sheets)
    assert _codes(report) == {"INSIDE_HOLE"}


def test_zero_gap_allows_touching_but_not_overlap():
    stock = replace(STOCK, gap_mm=0.0)
    touching = [[_at("P#0001", 10, 10), _at("P#0002", 210, 10), _at("P#0003", 10, 130)]]
    assert validate_layout([PLATE], stock, touching).valid
    touching[0][1] = _at("P#0002", 209, 10)
    assert "OVERLAP" in _codes(validate_layout([PLATE], stock, touching))
