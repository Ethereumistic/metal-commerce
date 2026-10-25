"""Geometric assertions on synthetic fixtures with known contours (see fixtures/make_synthetic.py)."""

from __future__ import annotations

import io

import pytest
from PIL import Image
from shapely.geometry import Point

from artwork_service import geometry as geo
from artwork_service.tracing import TraceError, trace_image

from conftest import synthetic

# Normalized tolerance: about one source pixel on a 300-400 px object.
TOL = 0.006


def trace(name: str):
    return trace_image(synthetic(name))


def test_l_with_hole_keeps_hole_aspect_and_orientation() -> None:
    r = trace("l_with_hole")
    g = r.geometry
    assert len(g.geoms) == 1 and r.holes == 1
    # Object is 400 x 300 px: longest side normalizes to 1.
    assert r.aspect_ratio == pytest.approx(400 / 300, rel=0.005)
    minx, miny, maxx, maxy = g.bounds
    assert (minx, miny) == pytest.approx((0, 0), abs=1e-9)
    assert maxx == pytest.approx(1.0, abs=1e-9)
    assert maxy == pytest.approx(0.75, abs=TOL)
    # Y-up and not mirrored: the foot (image bottom-right) is at low y / high x;
    # the tall leg's top (image top-left) is at high y / low x.
    assert g.contains(Point(0.9, 0.1))       # foot
    assert not g.contains(Point(0.9, 0.6))   # empty above the foot
    assert g.contains(Point(0.1, 0.7))       # top of the tall leg
    # The hole (image x 130-190, y 90-200) -> normalized x 0.075-0.225, y 0.375-0.65.
    hole = g.geoms[0].interiors[0]
    hx0, hy0, hx1, hy1 = hole.bounds
    assert (hx0, hy0, hx1, hy1) == pytest.approx((0.075, 0.375, 0.225, 0.65), abs=TOL)
    assert not g.contains(Point(0.15, 0.5))
    # Area: 120*300 + 280*80 - 60*110 = 51 800 px² over 400² px².
    assert g.area == pytest.approx(51_800 / 400**2, rel=0.01)


def test_ring_is_one_component_with_round_hole() -> None:
    r = trace("ring")
    assert len(r.geometry.geoms) == 1 and r.holes == 1
    assert r.aspect_ratio == pytest.approx(1.0, abs=0.005)
    ring = r.geometry.geoms[0]
    # Radii 180 and 90 px: inner/outer area ratio 0.25.
    inner = ring.interiors[0]
    from shapely.geometry import Polygon
    assert Polygon(inner).area / Polygon(ring.exterior).area == pytest.approx(0.25, rel=0.02)
    assert not r.geometry.contains(Point(0.5, 0.5))


def test_island_inside_hole_is_kept() -> None:
    r = trace("island_in_hole")
    assert len(r.components) == 2 and r.holes == 1
    island = [c for c in r.components if c["island_of"] is not None]
    assert len(island) == 1
    assert r.geometry.contains(Point(0.5, 0.5))          # island centre
    assert not r.geometry.contains(Point(0.5, 0.27))     # gap between frame and island
    assert any(w["code"] == "MULTIPLE_COMPONENTS" for w in r.diagnostics["warnings"])


def test_shadow_is_not_traced_as_metal() -> None:
    r = trace("shadowed")
    assert len(r.geometry.geoms) == 1 and r.holes == 1
    # The object is 300 x 280 px; the shadow extends it by ~20 px if captured.
    assert r.aspect_ratio == pytest.approx(300 / 280, rel=0.01)
    ox0, oy0, ox1, oy1 = r.diagnostics["object_bbox_px"]
    assert (ox1 - ox0, oy1 - oy0) == pytest.approx((300, 280), abs=2)


def test_white_margins_do_not_affect_size() -> None:
    r = trace("margin_heavy")
    assert r.aspect_ratio == pytest.approx(1.5, rel=0.005)
    assert r.geometry.bounds == pytest.approx((0, 0, 1, 2 / 3), abs=TOL)
    assert r.transform["source_bounds_px"] == pytest.approx([500, 400, 800, 600], abs=1)


def test_two_large_parts_are_both_kept() -> None:
    r = trace("two_parts")
    assert len(r.components) == 2
    areas = sorted(c["area"] for c in r.components)
    # Rectangle 240x240 and triangle 240x240/2 in a 580 px wide object.
    assert areas[0] / areas[1] == pytest.approx(0.5, rel=0.02)


def test_noise_specks_are_removed_but_part_is_kept() -> None:
    r = trace("noise_specks")
    assert len(r.components) == 1 and r.holes == 1
    assert r.diagnostics["noise_removed_area_px"] > 0
    assert r.aspect_ratio == pytest.approx(300 / 260, rel=0.005)


def test_clipped_object_is_rejected() -> None:
    with pytest.raises(TraceError) as exc:
        trace("clipped")
    assert exc.value.code == "OBJECT_CLIPPED"
    assert exc.value.details["edges"] == ["right"]


def test_low_contrast_is_rejected() -> None:
    with pytest.raises(TraceError) as exc:
        trace("low_contrast")
    assert exc.value.code == "LOW_CONTRAST"


def test_malformed_and_tiny_images_are_rejected() -> None:
    data = synthetic("ring")
    with pytest.raises(TraceError) as exc:
        trace_image(data[: len(data) // 2])
    assert exc.value.code == "UNSUPPORTED_FORMAT"
    with pytest.raises(TraceError) as exc:
        trace_image(b"GIF89a" + b"\0" * 100)
    assert exc.value.code == "UNSUPPORTED_FORMAT"
    buf = io.BytesIO()
    Image.new("RGB", (100, 80), (240, 240, 240)).save(buf, "PNG")
    with pytest.raises(TraceError) as exc:
        trace_image(buf.getvalue())
    assert exc.value.code == "SOURCE_TOO_SMALL"


def test_exif_orientation_and_alpha_are_applied() -> None:
    img = Image.open(io.BytesIO(synthetic("l_with_hole"))).convert("RGBA")
    # Rotate pixels by 90° and declare EXIF orientation 6 (rotate 90° CW to view):
    # the traced result must equal the upright original.
    rotated = img.transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    rotated.convert("RGB").save(buf, "JPEG", quality=95, exif=exif.tobytes())
    r = trace_image(buf.getvalue())
    assert r.aspect_ratio == pytest.approx(400 / 300, rel=0.01)
    assert r.geometry.contains(Point(0.9, 0.1)) and not r.geometry.contains(Point(0.9, 0.6))
    assert r.transform["exif_orientation"] == 6

    # Transparent background composites onto white (not black).
    rgba = Image.new("RGBA", img.size, (0, 0, 0, 0))
    rgba.paste(img, mask=img.convert("L").point(lambda v: 255 if v < 128 else 0))
    buf = io.BytesIO()
    rgba.save(buf, "PNG")
    r2 = trace_image(buf.getvalue())
    assert r2.holes == 1 and r2.transform["alpha_composited_on_white"]
    assert r2.aspect_ratio == pytest.approx(400 / 300, rel=0.01)


def test_master_round_trips_through_json_and_scales_exactly() -> None:
    r = trace("l_with_hole")
    again = geo.from_json(r.master_document()["geometry"])
    assert geo.topology_signature(again) == geo.topology_signature(r.geometry)
    # Coordinates are stored rounded to 8 decimals.
    assert again.symmetric_difference(r.geometry).area < 1e-7
    sized = geo.scale_master(again, 800.0, 600.0)
    assert sized.bounds == pytest.approx((0, 0, 800, 600), abs=1e-6)
