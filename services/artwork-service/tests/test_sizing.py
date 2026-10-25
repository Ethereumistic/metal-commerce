from __future__ import annotations

import pytest
from shapely.geometry import MultiPolygon, Polygon, box

from artwork_service import geometry as geo
from artwork_service import sizing
from artwork_service.errors import ServiceError

STOCK = {"width_mm": 1500, "height_mm": 3000, "margins_mm": {"left": 10, "right": 10, "bottom": 10, "top": 10},
         "gap_mm": 5, "max_sheets": 3}


def test_aspect_locked_modes() -> None:
    assert sizing.compute_size(2.0, "width", 600, None) == sizing.SizedPart(600, 300)
    assert sizing.compute_size(2.0, "height", None, 300) == sizing.SizedPart(600, 300)
    # Fit inside 600 x 600 never stretches a non-square part.
    assert sizing.compute_size(0.8, "fit", 600, 600) == sizing.SizedPart(480, 600)
    assert sizing.compute_size(1.25, "fit", 600, 600) == sizing.SizedPart(600, 480)


@pytest.mark.parametrize("args", [("width", None, 300), ("height", 300, None), ("fit", 600, None),
                                  ("width", -5, None), ("diagonal", 100, 100), ("width", 0.1, None)])
def test_invalid_size_requests(args) -> None:
    with pytest.raises(ServiceError) as exc:
        sizing.compute_size(1.0, *args)
    assert exc.value.code == "INVALID_DIMENSIONS"


def test_full_width_part_does_not_fit_sheet_with_margins() -> None:
    env = sizing.usable_envelope(STOCK)
    err = sizing.fit_check(sizing.SizedPart(1500, 400), env, [0, 90, 180, 270])
    # Rotated it would be 400 wide and 1500 tall, which fits: so restrict to 0/180.
    assert err is None
    err = sizing.fit_check(sizing.SizedPart(1500, 400), env, [0, 180])
    assert err["code"] == "PART_DOES_NOT_FIT"
    assert err["details"] == {"part_width_mm": 1500, "part_height_mm": 400, "usable_width_mm": 1480,
                              "usable_height_mm": 2980, "rotations_checked": [0, 180]}
    err = sizing.fit_check(sizing.SizedPart(1500, 1500), env, [0, 90, 180, 270])
    assert err["code"] == "PART_DOES_NOT_FIT"


def test_rotated_fit_is_considered() -> None:
    env = sizing.usable_envelope(STOCK)
    part = sizing.SizedPart(2000, 1000)
    assert sizing.fit_check(part, env, [0]) is not None
    assert sizing.fit_check(part, env, [90]) is None
    assert sizing.fit_check(sizing.SizedPart(1480, 2980), env, [0]) is None  # exactly the usable area


def test_margins_must_leave_usable_area() -> None:
    with pytest.raises(ServiceError) as exc:
        sizing.usable_envelope({**STOCK, "margins_mm": {"left": 800, "right": 800, "bottom": 0, "top": 0}})
    assert exc.value.code == "INVALID_DIMENSIONS"


def test_square_master_scales_exactly_without_retrace() -> None:
    hole = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)]
    master = geo.as_multipolygon([Polygon([(0, 0), (1, 0), (1, 1), (0, 1)], [hole])])
    for side in (600.0, 900.0, 1500.0):
        size = sizing.compute_size(1.0, "width", side, None)
        sized = sizing.sized_geometry(master, size)
        assert sized.bounds == pytest.approx((0, 0, side, side), abs=1e-9)
        assert sized.area == pytest.approx(side * side * (1 - 0.04), rel=1e-12)
        assert geo.topology_signature(sized) == (1, 1)
    assert sizing.part_key("m1", sizing.SizedPart(600, 600)) != sizing.part_key("m1", sizing.SizedPart(900, 900))
    assert sizing.part_key("m1", sizing.SizedPart(600, 600)) == sizing.part_key("m1", sizing.SizedPart(600, 600))


def test_feature_check_reports_unknown_pass_and_fail() -> None:
    # A 100 x 100 plate with a 1 mm wide tab and a 1 mm wide slot.
    plate = box(0, 0, 100, 100).union(box(100, 45, 130, 46)).difference(box(20, 20, 21, 80))
    part = MultiPolygon([plate])
    assert sizing.feature_check(part, None, None)["status"] == "unknown"
    assert sizing.feature_check(part, 0.5, 0.5)["status"] == "pass"
    narrow = sizing.feature_check(part, 2.0, None)
    assert narrow["status"] == "fail" and narrow["findings"][0]["code"] == "FEATURE_TOO_NARROW"
    slot = sizing.feature_check(part, None, 2.0)
    assert slot["status"] == "fail" and slot["findings"][0]["code"] == "OPENING_TOO_NARROW"
