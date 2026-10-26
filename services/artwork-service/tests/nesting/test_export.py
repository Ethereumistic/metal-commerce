"""DXF/SVG export, independent DXF read-back, and the production package."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import UTC, datetime

import ezdxf
import pytest
import shapely
from shapely import affinity
from shapely.geometry import LinearRing, Polygon

from artwork_service.dxf_export import (
    PackageGroup,
    build_package,
    export_sheet_dxf,
    export_sheet_svg,
    verify_dxf,
)
from artwork_service.nesting import bbox_baseline, layout_metrics
from artwork_service.nesting_types import NestingError, NestOutcome, Placement, place_geometry

from nest_shapes import flag_shape, l_shape, part, plate_with_hole, sheet, two_component_part

CREATED = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
TOL = 0.05


def _outcome(parts, stock, status="complete"):
    sheets, unplaced = bbox_baseline(parts, stock)
    return NestOutcome(
        sheets=sheets,
        unplaced_instance_ids=unplaced,
        status=status,
        engine="bbox-baseline",
        engine_version="nesting-1.0.0",
        settings={"seed": 1},
        runtime_s=0.01,
        metrics=layout_metrics(sheets, unplaced, parts, stock),
        baseline_metrics={},
    )


def _modelspace(dxf_bytes):
    return ezdxf.read(io.StringIO(dxf_bytes.decode())).modelspace()


@pytest.fixture
def layout():
    parts = [part("F", flag_shape(), 3), part("P", plate_with_hole(), 2), part("T", two_component_part(), 1)]
    stock = sheet(1000, 1000)
    placements = [
        Placement("F#0001", "F", "F", "product-F", 0, 20, 30),
        Placement("F#0002", "F", "F", "product-F", 90, 400, 30),
        Placement("F#0003", "F", "F", "product-F", 270, 450, 400),
        Placement("P#0001", "P", "P", "product-P", 180, 800, 300),
        Placement("P#0002", "P", "P", "product-P", 90, 900, 500),
        Placement("T#0001", "T", "T", "product-T", 0, 50, 700),
    ]
    return parts, stock, placements


def test_dxf_is_layer0_closed_lwpolylines_in_mm(layout):
    parts, stock, placements = layout
    dxf = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL)
    doc = ezdxf.read(io.StringIO(dxf.decode()))
    assert doc.dxfversion == "AC1024"  # R2010
    assert doc.header["$INSUNITS"] == 4
    entities = list(doc.modelspace())
    assert {e.dxftype() for e in entities} == {"LWPOLYLINE"}
    assert {e.dxf.layer for e in entities} == {"0"}
    assert all(e.closed and e.dxf.const_width == 0 for e in entities)
    # 3 flags + 2 plates (+2 holes) + two-component part (2 islands + 1 hole); no sheet rectangle.
    assert len(entities) == 3 + 4 + 3
    xs = [x for e in entities for x, *_ in e.get_points()]
    ys = [y for e in entities for _, y, *_ in e.get_points()]
    assert min(xs) >= stock.margin_left and max(xs) <= stock.width_mm - stock.margin_right
    assert min(ys) >= stock.margin_bottom and max(ys) <= stock.height_mm - stock.margin_top


def test_verify_dxf_passes_on_export(layout):
    parts, stock, placements = layout
    dxf = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL)
    report = verify_dxf(dxf, parts, placements, TOL)
    assert report.valid, [v.to_dict() for v in report.violations]
    assert report.insunits == 4 and report.layers == ["0"]
    assert report.loop_count == report.expected_loop_count == 10
    assert report.max_vertex_error_mm <= TOL
    assert report.ezdxf_audit_errors == 0


def test_holes_are_exported_and_move_with_parent(layout):
    parts, stock, placements = layout
    plate = parts[1]
    dxf = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL)
    loops = [Polygon([(x, y) for x, y, *_ in e.get_points()]) for e in _modelspace(dxf)]
    for placement in placements[3:5]:
        world = place_geometry(plate.geometry, placement.rotation_deg, placement.tx_mm, placement.ty_mm)
        expected_hole = Polygon(world.geoms[0].interiors[0])
        outer = Polygon(world.geoms[0].exterior)
        matches = [lp for lp in loops if shapely.hausdorff_distance(lp.boundary, expected_hole.boundary) < 1e-6]
        assert len(matches) == 1 and outer.contains(matches[0])


def test_asymmetric_part_is_rotated_not_mirrored(layout):
    parts, stock, placements = layout
    flag = parts[0].geometry
    dxf = export_sheet_dxf(parts, stock, placements[:3], chord_tolerance_mm=TOL)
    loops = [LinearRing([(x, y) for x, y, *_ in e.get_points()]) for e in _modelspace(dxf)]
    for placement, loop in zip(placements[:3], loops, strict=True):
        rotated = place_geometry(flag, placement.rotation_deg, placement.tx_mm, placement.ty_mm).geoms[0].exterior
        mirrored_src = affinity.scale(flag, -1, 1, origin=(0, 0))
        mirrored = place_geometry(mirrored_src, placement.rotation_deg, 0, 0).geoms[0]
        # Align the mirrored candidate to the same bbox so only the shape can differ.
        dx = rotated.bounds[0] - mirrored.bounds[0]
        dy = rotated.bounds[1] - mirrored.bounds[1]
        mirrored = affinity.translate(mirrored, dx, dy).exterior
        assert shapely.hausdorff_distance(loop, rotated) < 1e-6
        assert shapely.hausdorff_distance(loop, mirrored) > 10


def test_verify_dxf_catches_tampering(layout):
    parts, stock, placements = layout
    dxf = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL)
    doc = ezdxf.read(io.StringIO(dxf.decode()))
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (1000, 0), (1000, 1000), (0, 1000)], close=True, dxfattribs={"layer": "SHEET"})
    first = next(iter(msp))
    points = list(first.get_points("xy"))
    points[0] = (points[0][0] + 1.0, points[0][1])
    first.set_points(points, format="xy")
    stream = io.StringIO()
    doc.write(stream)
    report = verify_dxf(stream.getvalue().encode(), parts, placements, TOL)
    codes = {v.code for v in report.violations}
    assert {"DXF_LAYER", "DXF_LOOP_COUNT", "DXF_GEOMETRY_MISMATCH"} <= codes
    assert not report.valid


def test_verify_dxf_catches_wrong_units_and_open_loop(layout):
    parts, stock, placements = layout
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 1
    doc.modelspace().add_lwpolyline([(0, 0), (1, 0), (1, 1)], close=False)
    stream = io.StringIO()
    doc.write(stream)
    codes = {v.code for v in verify_dxf(stream.getvalue().encode(), parts, placements, TOL).violations}
    assert {"DXF_UNITS", "DXF_OPEN_LOOP", "DXF_LOOP_COUNT"} <= codes


# A 9 x 4 mm hole from the traced "trees" fixture at 300 mm. GEOS' topology-
# preserving simplifier moves it by 0.066 mm at a 0.05 mm tolerance, which made
# the DXF fail read-back (EXPORT_INVALID) for the whole batch.
_TRACED_HOLE = [
    (6.605133, 3.836058), (7.062411, 4.039293), (7.189434, 3.963078), (7.189434, 3.836058), (6.986199, 3.607419),
    (6.935388, 3.429588), (7.341858, 3.175545), (8.332629, 2.870691), (8.535864, 2.921502), (8.815311, 3.175545),
    (8.993142, 3.226353), (9.018546, 2.97231), (8.63748, 2.489628), (8.205606, 2.235582), (6.452706, 0.660513),
    (5.792193, 0.457278), (4.801422, 0.304851), (4.623594, 0.203235), (3.302568, 0.0), (1.854519, 0.0),
    (0.127023, 0.254043), (0.0, 0.381066), (0.0, 0.508086), (0.330258, 0.838344), (0.965367, 1.295622),
    (1.7529, 2.057754), (1.930731, 2.108562), (2.210178, 2.362605), (2.591244, 2.464221), (2.819883, 2.616648),
    (4.521975, 3.073926), (4.852233, 3.277161), (5.792193, 3.531204), (6.122451, 3.734439),
]


def test_simplification_never_moves_a_contour_beyond_the_tolerance():
    hole = affinity.translate(LinearRing(_TRACED_HOLE), 5, 5)
    assert shapely.hausdorff_distance(
        shapely.simplify(Polygon(hole), TOL, preserve_topology=True).exterior, hole, densify=0.25
    ) > TOL  # the GEOS behaviour this guards against
    geometry = shapely.MultiPolygon([Polygon([(0, 0), (20, 0), (20, 14), (0, 14)], [hole])])
    parts = [part("T", geometry, 3)]
    stock = sheet(200, 200)
    placements = [
        Placement(i, "T", "T", "product-T", rotation, 40.0 + 40 * n, 60.0)
        for n, (i, rotation) in enumerate(zip(parts[0].instance_ids, (0, 90, 180), strict=True))
    ]
    dxf = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL)
    report = verify_dxf(dxf, parts, placements, TOL + 1e-6)
    assert report.valid, [v.to_dict() for v in report.violations]
    assert report.loop_count == 6 and report.max_vertex_error_mm <= TOL


def test_dxf_is_reproducible_with_fixed_timestamp(layout):
    parts, stock, placements = layout
    a = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL, created_at=CREATED)
    b = export_sheet_dxf(parts, stock, placements, chord_tolerance_mm=TOL, created_at=CREATED)
    assert a == b


def test_svg_preview_has_sheet_margins_and_numbers(layout):
    parts, stock, placements = layout
    svg = export_sheet_svg(parts, stock, placements, title="Sheet 1", labels={"product-F": "Flag <F>"})
    assert svg.startswith("<svg") and svg.count("<path") == len(placements)
    assert 'width="1000" height="1000"' in svg  # sheet outline
    assert "stroke-dasharray" in svg  # margin guide
    assert ">6</text>" in svg and "Flag &lt;F&gt;" in svg
    assert 'data-instance="P#0002"' in svg


def test_build_package_two_material_groups():
    steel_parts = [part("A", l_shape(), 5, product_id="pa"), part("B", plate_with_hole(), 3, product_id="pb")]
    alu_parts = [part("C", flag_shape(), 4, product_id="pc")]
    steel_stock, alu_stock = sheet(1500, 3000), sheet(1000, 1000)
    groups = [
        PackageGroup(
            "steel-2", "steel", 2.0, steel_parts, steel_stock, _outcome(steel_parts, steel_stock), "1500x3000"
        ),
        PackageGroup("alu-3", "aluminium", 3.0, alu_parts, alu_stock, _outcome(alu_parts, alu_stock)),
    ]
    context = {"profile_revision": 3, "masters": {"pa": {"master_id": "m1", "revision": 2, "source_sha256": "ab"}}}
    result = build_package(
        "b123",
        groups,
        chord_tolerance_mm=TOL,
        context=context,
        created_at=CREATED,
        versions={"tracer": "t-1"},
        product_labels={"pa": "Flower"},
    )
    again = build_package(
        "b123",
        groups,
        chord_tolerance_mm=TOL,
        context=context,
        created_at=CREATED,
        versions={"tracer": "t-1"},
        product_labels={"pa": "Flower"},
    )
    assert result.zip_bytes == again.zip_bytes  # deterministic

    archive = zipfile.ZipFile(io.BytesIO(result.zip_bytes))
    names = archive.namelist()
    assert names[0] == "manifest.json"
    assert "batch-b123-sheet-001-1500x3000mm.dxf" in names
    assert "batch-b123-sheet-002-1000x1000mm.dxf" in names
    assert "batch-b123-sheet-002-1000x1000mm.svg" in names
    assert len([n for n in names if n.endswith(".dxf")]) == 2

    manifest = json.loads(archive.read("manifest.json"))
    assert manifest["counts"] == {"requested": 12, "placed": 12, "unplaced": 0, "sheets": 2}
    assert manifest["created_at"] == "2026-10-25T12:00:00Z"
    assert manifest["context"] == context
    assert manifest["versions"]["tracer"] == "t-1" and manifest["versions"]["packingsolver"] == "0.1.1218"
    assert [g["material"] for g in manifest["groups"]] == ["steel", "aluminium"]
    assert manifest["groups"][0]["validation"]["valid"] is True
    assert manifest["groups"][0]["stock"]["margins_mm"] == {"left": 10, "right": 15, "bottom": 20, "top": 25}
    placed_ids = sorted(p["instance_id"] for s in manifest["sheets"] for p in s["placements"])
    assert placed_ids == sorted(i for p in steel_parts + alu_parts for i in p.instance_ids)
    for sheet_entry in manifest["sheets"]:
        dxf = archive.read(sheet_entry["dxf"]["filename"])
        assert hashlib.sha256(dxf).hexdigest() == sheet_entry["dxf"]["sha256"]
        assert sheet_entry["dxf_check"]["valid"] is True


def test_build_package_refuses_incomplete_or_invalid():
    parts, stock = [part("A", l_shape(), 2)], sheet(1000, 1000)
    incomplete = _outcome(parts, stock, status="incomplete")
    with pytest.raises(NestingError) as exc:
        build_package(
            "b1",
            [PackageGroup("g", "steel", 2, parts, stock, incomplete)],
            chord_tolerance_mm=TOL,
            context={},
            created_at=CREATED,
        )
    assert exc.value.code == "NEST_INCOMPLETE"

    broken = _outcome(parts, stock)
    first = broken.sheets[0][0]
    broken.sheets[0][1] = Placement(
        broken.sheets[0][1].instance_id,
        first.part_key,
        first.line_id,
        first.product_id,
        first.rotation_deg,
        first.tx_mm,
        first.ty_mm,
    )
    with pytest.raises(NestingError) as exc:
        build_package(
            "b1",
            [PackageGroup("g", "steel", 2, parts, stock, broken)],
            chord_tolerance_mm=TOL,
            context={},
            created_at=CREATED,
        )
    assert exc.value.code == "LAYOUT_INVALID"

    with pytest.raises(NestingError):
        build_package(
            "../evil",
            [PackageGroup("g", "steel", 2, parts, stock, _outcome(parts, stock))],
            chord_tolerance_mm=TOL,
            context={},
            created_at=CREATED,
        )
