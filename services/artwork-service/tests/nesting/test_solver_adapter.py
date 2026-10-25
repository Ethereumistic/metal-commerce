"""PackingSolver adapter: instance format, collision contours, certificate mapping, process control."""

from __future__ import annotations

import math
import os
import time

import pytest
import shapely
from shapely.geometry import MultiPolygon, Polygon

from artwork_service import solver_adapter as sa
from artwork_service.nesting_types import filled_shell, place_geometry

from nest_shapes import comb, flag_shape, part, plate_with_hole, ring_part, sheet


def _detailed_outline(points: int = 3000) -> MultiPolygon:
    """A wavy blob with many vertices, like a traced master."""
    coords = []
    for k in range(points):
        t = 2 * math.pi * k / points
        r = 200 + 25 * math.sin(9 * t) + 6 * math.sin(41 * t)
        coords.append((r * math.cos(t), r * math.sin(t)))
    poly = Polygon(coords)
    min_x, min_y, _, _ = poly.bounds
    return MultiPolygon([shapely.affinity.translate(poly, -min_x, -min_y)])


def test_collision_contour_contains_original_and_is_bounded():
    geometry = _detailed_outline()
    contour = sa.collision_contour(geometry, tolerance_mm=0.05)
    hull = shapely.union_all(contour.polygons)
    assert hull.covers(filled_shell(geometry))
    assert contour.vertex_count <= sa.MAX_COLLISION_VERTICES
    assert contour.original_vertex_count >= 3000
    # Recorded error is real and small relative to the part.
    measured = shapely.hausdorff_distance(hull.boundary, filled_shell(geometry).boundary, densify=0.25)
    assert contour.max_error_mm == pytest.approx(measured)
    assert 0 < contour.max_error_mm < 5.0


def test_collision_contour_drops_holes():
    contour = sa.collision_contour(ring_part(), tolerance_mm=0.05)
    assert all(len(p.interiors) == 0 for p in contour.polygons)
    assert shapely.union_all(contour.polygons).covers(Polygon(ring_part().geoms[0].exterior))


def test_instance_uses_usable_bin_spacing_and_no_mirror():
    stock = sheet(1500, 3000, margins=(10, 15, 20, 25), gap=6, max_sheets=4)
    parts = [part("P", plate_with_hole(), 3, rotations=(0, 180))]
    instance = sa.build_instance(parts, stock, [sa.collision_contour(parts[0].geometry, tolerance_mm=0.05)])
    assert instance["objective"] == "bin-packing-with-leftovers"
    assert instance["parameters"] == {"item_item_minimum_spacing": 6, "leftover_mode": "bottom"}
    (bin_type,) = instance["bin_types"]
    assert (bin_type["x"], bin_type["y"], bin_type["width"], bin_type["height"]) == (10, 20, 1475, 2955)
    assert bin_type["copies"] == 4 and "item_bin_minimum_spacing" not in bin_type
    (item,) = instance["item_types"]
    assert item["copies"] == 3 and "profit" not in item
    assert item["allowed_rotations"] == [
        {"start": 0.0, "end": 0.0, "mirror": False},
        {"start": 180.0, "end": 180.0, "mirror": False},
    ]
    assert all("holes" not in shape for shape in item["shapes"])
    assert sa.leftover_mode(sheet(3000, 1500)) == "left"


def test_decode_expands_bin_copies_and_rejects_mirror():
    parts = [part("P", plate_with_hole(), 4)]
    certificate = {
        "bins": [{"id": 0, "copies": 2, "items": [{"id": 0, "x": 10, "y": 20, "angle": 90.0, "mirror": False}] * 2}]
    }
    sheets = sa.decode_certificate(certificate, parts)
    assert len(sheets) == 2 and all(len(s) == 2 for s in sheets)
    assert sheets[0][0] == sa.RawPlacement(0, 90, 10.0, 20.0)
    certificate["bins"][0]["items"] = [{"id": 0, "x": 0, "y": 0, "angle": 0.0, "mirror": True}]
    with pytest.raises(sa.CertificateError):
        sa.decode_certificate(certificate, parts)
    with pytest.raises(sa.CertificateError):
        sa.decode_certificate({"bins": [{"id": 0, "items": [{"id": 3, "x": 0, "y": 0, "angle": 0}]}]}, parts)


def test_certificate_transform_matches_contract_transform():
    """Our rotate-about-origin + translate must reproduce the solver's own transformed outlines."""
    geometry = flag_shape()
    parts = [part("F", geometry, 5, rotations=(0, 90, 180, 270))]
    stock = sheet(600, 500, margins=(10, 20, 30, 40), gap=5, max_sheets=3)
    contour = sa.collision_contour(geometry, tolerance_mm=0.05)
    run = sa.run_solver(
        sa.build_instance(parts, stock, [contour]), time_limit_s=2, hard_timeout_s=20, cancel=lambda: False
    )
    assert run.status == "ok" and run.certificate
    hull = shapely.union_all(contour.polygons)
    checked = 0
    for bin_ in run.certificate["bins"]:
        for item in bin_["items"]:
            ours = place_geometry(hull, item["angle"], item["x"], item["y"])
            for shape in item["item_shapes"]:
                theirs = Polygon([(e["xs"], e["ys"]) for e in shape["shape"]])
                assert shapely.hausdorff_distance(ours.boundary, theirs.boundary) < 1e-6
                checked += 1
    assert checked == 5


def test_cancel_kills_solver_process():
    parts = [part("C", comb(), 60)]
    stock = sheet()
    instance = sa.build_instance(parts, stock, [sa.collision_contour(parts[0].geometry, tolerance_mm=0.05)])
    started = time.monotonic()
    run = sa.run_solver(instance, time_limit_s=60, hard_timeout_s=60, cancel=lambda: time.monotonic() - started > 1.0)
    assert run.status == "cancelled" and run.certificate is None
    assert run.runtime_s < 3.0
    with pytest.raises(ProcessLookupError):
        os.kill(run.pid, 0)


def test_hard_timeout_kills_solver_and_keeps_best_so_far():
    parts = [part("C", comb(), 60)]
    stock = sheet()
    instance = sa.build_instance(parts, stock, [sa.collision_contour(parts[0].geometry, tolerance_mm=0.05)])
    run = sa.run_solver(instance, time_limit_s=60, hard_timeout_s=4.0, cancel=lambda: False)
    assert run.status in ("timeout", "ok")  # "ok" only if the solver proved optimality first
    assert run.runtime_s < 6.0
    with pytest.raises(ProcessLookupError):
        os.kill(run.pid, 0)
    if run.status == "timeout" and run.solutions_seen:
        assert run.certificate and run.certificate["bins"]


def test_solver_error_is_reported():
    instance = {"objective": "no-such-objective", "parameters": {}, "bin_types": [], "item_types": []}
    run = sa.run_solver(instance, time_limit_s=1, hard_timeout_s=20, cancel=lambda: False)
    assert run.status == "error" and run.error
