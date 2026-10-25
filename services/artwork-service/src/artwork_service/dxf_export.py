"""Production DXF, SVG preview, read-back verification and ZIP packaging.

DXF files contain cutting geometry only: one closed zero-width LWPOLYLINE per
exterior and hole contour, all on layer ``0``, millimetres, sheet lower-left
origin, Y-up. Sheet outlines, margins, labels and numbering exist only in the
SVG previews and the manifest.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import io
import json
import math
import re
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from xml.sax.saxutils import escape

import ezdxf
import numpy as np
import shapely
from ezdxf import units
from shapely import STRtree
from shapely.geometry import LinearRing, Polygon
from shapely.geometry.polygon import orient

from .nesting_types import (
    DxfCheckReport,
    NestingError,
    NestOutcome,
    PartSpec,
    Placement,
    StockSpec,
    Violation,
    as_multipolygon,
    place_geometry,
)
from .validation import validate_layout

EXPORTER_VERSION = "artwork-dxf-1.0.0"
DXF_VERSION = "R2010"
INSUNITS_MM = 4
_DEDUPE_MM = 1e-6
_FIXED_GUID = "{00000000-0000-0000-0000-000000000000}"
_ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def export_sheet_dxf(
    parts: Sequence[PartSpec],
    stock: StockSpec,
    placements: Sequence[Placement],
    *,
    chord_tolerance_mm: float,
    created_at: datetime | None = None,
) -> bytes:
    """Write one physical sheet as DXF bytes.

    Input contours are already polylines, so the chord tolerance only bounds the
    simplification applied to them; a ring keeps its original vertices whenever
    simplifying would change its topology. Passing ``created_at`` fixes the DXF
    timestamps and GUIDs, making the output byte-for-byte reproducible.
    """
    if not chord_tolerance_mm > 0:
        raise ValueError("chord_tolerance_mm must be positive")
    doc = ezdxf.new(DXF_VERSION, setup=False)
    doc.units = units.MM
    doc.header["$MEASUREMENT"] = 1
    msp = doc.modelspace()
    for ring in sheet_rings(parts, placements, chord_tolerance_mm=chord_tolerance_mm):
        msp.add_lwpolyline(
            ring.coords[:-1],
            format="xy",
            close=True,
            dxfattribs={"layer": "0", "const_width": 0.0},
        )
    stream = io.StringIO()
    doc.write(stream)
    text = stream.getvalue()
    if created_at is not None:
        text = _fix_header_metadata(text, created_at)
    return text.encode("utf-8")


def sheet_rings(
    parts: Sequence[PartSpec], placements: Sequence[Placement], *, chord_tolerance_mm: float
) -> list[LinearRing]:
    """All cutting loops of a sheet (exteriors CCW, holes CW), in placement order."""
    by_instance = _by_instance(parts)
    rings: list[LinearRing] = []
    for placement in placements:
        part = by_instance[placement.instance_id]
        world = place_geometry(part.geometry, placement.rotation_deg, placement.tx_mm, placement.ty_mm)
        for polygon in as_multipolygon(world).geoms:
            polygon = orient(_simplify_polygon(polygon, chord_tolerance_mm), 1.0)
            rings.append(polygon.exterior)
            rings.extend(polygon.interiors)
    return rings


def export_sheet_svg(
    parts: Sequence[PartSpec],
    stock: StockSpec,
    placements: Sequence[Placement],
    *,
    title: str = "",
    labels: dict[str, str] | None = None,
) -> str:
    """Non-cutting preview: sheet outline, margin guide, numbered coloured parts.

    ``labels`` optionally maps product_id to a display name for the legend.
    """
    by_instance = _by_instance(parts)
    width, height = stock.width_mm, stock.height_mm
    colors = _product_colors(placements)
    stroke = max(width, height) / 1500.0
    font = max(width, height) / 90.0
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_n(-stroke * 4)} {_n(-stroke * 4)} '
        f'{_n(width + stroke * 8)} {_n(height + stroke * 8)}" width="{_n(width / 5)}mm" height="{_n(height / 5)}mm">',
        f"<title>{escape(title)}</title>" if title else "",
        f'<rect x="0" y="0" width="{_n(width)}" height="{_n(height)}" fill="#f7f7f5" stroke="#222" '
        f'stroke-width="{_n(stroke * 2)}"/>',
        f'<rect x="{_n(stock.margin_left)}" y="{_n(stock.margin_top)}" width="{_n(stock.usable_width)}" '
        f'height="{_n(stock.usable_height)}" fill="none" stroke="#c33" stroke-width="{_n(stroke)}" '
        f'stroke-dasharray="{_n(stroke * 6)} {_n(stroke * 4)}"/>',
        f'<g transform="matrix(1 0 0 -1 0 {_n(height)})">',
    ]
    label_positions = []
    for number, placement in enumerate(placements, start=1):
        part = by_instance[placement.instance_id]
        world = place_geometry(part.geometry, placement.rotation_deg, placement.tx_mm, placement.ty_mm)
        path = " ".join(_svg_ring(r) for p in as_multipolygon(world).geoms for r in (p.exterior, *p.interiors))
        out.append(
            f'<path d="{path}" fill="{colors[placement.product_id]}" fill-opacity="0.75" fill-rule="evenodd" '
            f'stroke="#111" stroke-width="{_n(stroke)}" data-instance="{escape(placement.instance_id, {chr(34): "&quot;"})}"/>'
        )
        point = world.representative_point()
        label_positions.append((number, point.x, point.y))
    out.append("</g>")
    for number, x, y in label_positions:
        out.append(
            f'<text x="{_n(x)}" y="{_n(height - y)}" font-size="{_n(font)}" font-family="sans-serif" '
            f'text-anchor="middle" dominant-baseline="middle" fill="#000">{number}</text>'
        )
    if labels:
        for row, product_id in enumerate(sorted(colors)):
            name = labels.get(product_id, product_id)
            y = font * (row + 1.5)
            out.append(
                f'<rect x="{_n(width - font * 12)}" y="{_n(y - font * 0.8)}" width="{_n(font)}" height="{_n(font)}" '
                f'fill="{colors[product_id]}"/>'
                f'<text x="{_n(width - font * 10.5)}" y="{_n(y)}" font-size="{_n(font)}" font-family="sans-serif" '
                f'fill="#000">{escape(name)}</text>'
            )
    out.append("</svg>")
    return "\n".join(line for line in out if line) + "\n"


def verify_dxf(
    dxf_bytes: bytes, parts: Sequence[PartSpec], placements: Sequence[Placement], tolerance_mm: float
) -> DxfCheckReport:
    """Re-read a DXF through an independent group-code parser and compare to the layout.

    Checks units, layers, entity types, closure, zero widths, absence of bulges,
    loop count (exteriors + holes), bounds, and the per-vertex (Hausdorff) error
    of every loop against the expected placed contour. ``ezdxf`` additionally
    re-opens and audits the file as a second opinion.
    """
    violations: list[Violation] = []
    by_instance = _by_instance(parts)
    expected: list[LinearRing] = []
    for placement in placements:
        part = by_instance[placement.instance_id]
        world = place_geometry(part.geometry, placement.rotation_deg, placement.tx_mm, placement.ty_mm)
        for polygon in as_multipolygon(world).geoms:
            expected.append(polygon.exterior)
            expected.extend(polygon.interiors)

    try:
        parsed = _parse_dxf(dxf_bytes)
    except ValueError as exc:
        violations.append(Violation("DXF_UNREADABLE", f"DXF could not be parsed: {exc}"))
        return DxfCheckReport(False, violations, None, [], 0, 0, len(expected), None, None, 0, 0)

    if parsed.insunits != INSUNITS_MM:
        violations.append(
            Violation("DXF_UNITS", f"$INSUNITS is {parsed.insunits}, expected {INSUNITS_MM} (millimetres)")
        )
    layers = sorted({e["layer"] for e in parsed.entities})
    for entity in parsed.entities:
        handle = entity.get("handle", "?")
        if entity["type"] != "LWPOLYLINE":
            violations.append(Violation("DXF_ENTITY_TYPE", f"unexpected {entity['type']} entity {handle}"))
            continue
        if entity["layer"] != "0":
            violations.append(Violation("DXF_LAYER", f"entity {handle} is on layer {entity['layer']!r}, expected '0'"))
        if not entity["closed"]:
            violations.append(Violation("DXF_OPEN_LOOP", f"LWPOLYLINE {handle} is not closed"))
        if entity["widths"]:
            violations.append(Violation("DXF_WIDTH", f"LWPOLYLINE {handle} has non-zero width"))
        if entity["bulges"]:
            violations.append(Violation("DXF_BULGE", f"LWPOLYLINE {handle} contains arc bulges"))
        if entity["count"] != len(entity["points"]):
            violations.append(
                Violation(
                    "DXF_VERTEX_COUNT",
                    f"LWPOLYLINE {handle} declares {entity['count']} vertices but has {len(entity['points'])}",
                )
            )
    if parsed.block_entities:
        violations.append(
            Violation("DXF_BLOCK_GEOMETRY", f"{parsed.block_entities} entities found inside block definitions")
        )
    loops = [e for e in parsed.entities if e["type"] == "LWPOLYLINE" and len(e["points"]) >= 3]
    if len(loops) != len(expected):
        violations.append(
            Violation(
                "DXF_LOOP_COUNT",
                f"DXF has {len(loops)} loops; layout has {len(expected)} exterior and hole contours",
                details={"dxf_loops": len(loops), "expected_loops": len(expected)},
            )
        )

    bounds = None
    max_error = None
    if loops:
        xs = [x for e in loops for x, _ in e["points"]]
        ys = [y for e in loops for _, y in e["points"]]
        bounds = (min(xs), min(ys), max(xs), max(ys))
        max_error = _match_loops(loops, expected, tolerance_mm, violations)

    audit_errors, audit_fixes = _ezdxf_audit(dxf_bytes, violations)
    return DxfCheckReport(
        valid=not violations,
        violations=violations,
        insunits=parsed.insunits,
        layers=layers,
        entity_count=len(parsed.entities),
        loop_count=len(loops),
        expected_loop_count=len(expected),
        max_vertex_error_mm=max_error,
        bounds=bounds,
        ezdxf_audit_errors=audit_errors,
        ezdxf_audit_fixes=audit_fixes,
    )


@dataclass(frozen=True)
class PackageGroup:
    """One nested material/thickness group to include in a batch package."""

    group_key: str
    material: str
    thickness_mm: float
    parts: Sequence[PartSpec]
    stock: StockSpec
    outcome: NestOutcome
    stock_label: str = ""


@dataclass(frozen=True)
class PackageFile:
    name: str
    kind: str  # "manifest" | "dxf" | "svg"
    content: bytes
    sha256: str
    group_key: str | None = None
    sheet_number: int | None = None


@dataclass(frozen=True)
class PackageResult:
    zip_bytes: bytes
    zip_sha256: str
    manifest: dict
    files: tuple[PackageFile, ...]


def build_package(
    batch_id: str,
    groups: Sequence[PackageGroup],
    *,
    chord_tolerance_mm: float,
    context: dict,
    created_at: datetime,
    versions: dict | None = None,
    product_labels: dict[str, str] | None = None,
) -> PackageResult:
    """Build DXFs, SVG previews, manifest.json and a deterministic ZIP for a batch.

    Every group must be a complete nest whose layout re-validates independently
    and whose DXFs pass read-back verification; otherwise ``NestingError`` is
    raised (NEST_INCOMPLETE, LAYOUT_INVALID or EXPORT_INVALID) and nothing is
    produced. ``context`` is copied into the manifest verbatim and should hold the
    frozen batch request: profile revision, master ids/revisions, source hashes,
    requested sizes. Sheets are numbered consecutively across groups.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", batch_id):
        raise NestingError("VALIDATION_ERROR", "batch_id must be 1-80 characters of [A-Za-z0-9_-]")
    if not groups:
        raise NestingError("VALIDATION_ERROR", "a package needs at least one group")
    if created_at.tzinfo is None:
        raise NestingError("VALIDATION_ERROR", "created_at must be timezone-aware")
    timestamp = created_at.astimezone(UTC).isoformat().replace("+00:00", "Z")

    files: list[PackageFile] = []
    manifest_groups = []
    manifest_sheets = []
    sheet_number = 0
    for group in groups:
        outcome = group.outcome
        if outcome.status != "complete" or outcome.unplaced_instance_ids:
            raise NestingError(
                "NEST_INCOMPLETE",
                f"group {group.group_key} is {outcome.status} with {len(outcome.unplaced_instance_ids)} unplaced "
                "instances; an incomplete nest cannot be packaged as a production batch",
                {"group_key": group.group_key, "unplaced": len(outcome.unplaced_instance_ids)},
            )
        report = validate_layout(group.parts, group.stock, outcome.sheets)
        if not report.valid:
            raise NestingError(
                "LAYOUT_INVALID",
                f"group {group.group_key} layout failed independent validation",
                {"group_key": group.group_key, "violations": [v.to_dict() for v in report.violations[:20]]},
            )
        manifest_groups.append(
            {
                "group_key": group.group_key,
                "material": group.material,
                "thickness_mm": group.thickness_mm,
                "stock": {**group.stock.to_dict(), "label": group.stock_label},
                "gap_mm": group.stock.gap_mm,
                "parts": [_part_manifest(p) for p in group.parts],
                "counts": {
                    "requested": report.requested,
                    "placed": report.placed,
                    "unplaced": len(report.unplaced_instance_ids),
                    "sheets": len(outcome.sheets),
                },
                "nesting": {
                    "engine": outcome.engine,
                    "engine_version": outcome.engine_version,
                    "settings": outcome.settings,
                    "runtime_s": outcome.runtime_s,
                    "metrics": outcome.metrics,
                    "baseline_metrics": outcome.baseline_metrics,
                },
                "validation": report.to_dict(),
            }
        )
        for group_sheet_index, placements in enumerate(outcome.sheets):
            sheet_number += 1
            stem = f"batch-{batch_id}-sheet-{sheet_number:03d}-{_dim(group.stock.width_mm)}x{_dim(group.stock.height_mm)}mm"
            dxf = export_sheet_dxf(
                group.parts, group.stock, placements, chord_tolerance_mm=chord_tolerance_mm, created_at=created_at
            )
            check = verify_dxf(dxf, group.parts, placements, chord_tolerance_mm + 1e-6)
            if not check.valid:
                raise NestingError(
                    "EXPORT_INVALID",
                    f"{stem}.dxf failed read-back verification",
                    {"sheet_number": sheet_number, "violations": [v.to_dict() for v in check.violations[:20]]},
                )
            svg = export_sheet_svg(
                group.parts,
                group.stock,
                placements,
                title=f"Batch {batch_id} sheet {sheet_number} ({group.material} {group.thickness_mm:g} mm)",
                labels=product_labels,
            ).encode("utf-8")
            dxf_file = PackageFile(f"{stem}.dxf", "dxf", dxf, _sha256(dxf), group.group_key, sheet_number)
            svg_file = PackageFile(f"{stem}.svg", "svg", svg, _sha256(svg), group.group_key, sheet_number)
            files.extend([dxf_file, svg_file])
            manifest_sheets.append(
                {
                    "sheet_number": sheet_number,
                    "group_key": group.group_key,
                    "group_sheet_index": group_sheet_index,
                    "width_mm": group.stock.width_mm,
                    "height_mm": group.stock.height_mm,
                    "dxf": {"filename": dxf_file.name, "sha256": dxf_file.sha256, "bytes": len(dxf)},
                    "svg": {"filename": svg_file.name, "sha256": svg_file.sha256, "bytes": len(svg)},
                    "placements": [p.to_dict() for p in placements],
                    "dxf_check": check.to_dict(),
                }
            )

    manifest = {
        "manifest_version": 1,
        "batch_id": batch_id,
        "created_at": timestamp,
        "context": context,
        "versions": {
            **(versions or {}),
            "exporter": EXPORTER_VERSION,
            "ezdxf": importlib.metadata.version("ezdxf"),
            "shapely": importlib.metadata.version("shapely"),
            "packingsolver": importlib.metadata.version("packingsolver"),
        },
        "export": {
            "dxf_version": DXF_VERSION,
            "units": "mm",
            "insunits": INSUNITS_MM,
            "layer": "0",
            "entity": "closed LWPOLYLINE, zero width",
            "origin": "sheet lower-left, Y-up",
            "chord_tolerance_mm": chord_tolerance_mm,
            "compensation": "none (nominal contours; kerf compensation is the CAM's job)",
            "transform": "world = translate(rotate_ccw(part, rotation_deg, origin=(0,0)), tx_mm, ty_mm); no mirroring",
        },
        "counts": {
            "requested": sum(g["counts"]["requested"] for g in manifest_groups),
            "placed": sum(g["counts"]["placed"] for g in manifest_groups),
            "unplaced": sum(g["counts"]["unplaced"] for g in manifest_groups),
            "sheets": sheet_number,
        },
        "groups": manifest_groups,
        "sheets": manifest_sheets,
    }
    manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True, default=_json_default) + "\n").encode("utf-8")
    manifest_file = PackageFile("manifest.json", "manifest", manifest_bytes, _sha256(manifest_bytes))
    all_files = (manifest_file, *files)
    zip_bytes = _deterministic_zip(all_files)
    return PackageResult(zip_bytes, _sha256(zip_bytes), manifest, all_files)


# --- helpers -----------------------------------------------------------------


def _by_instance(parts: Sequence[PartSpec]) -> dict[str, PartSpec]:
    return {i: p for p in parts for i in p.instance_ids}


def _simplify_polygon(polygon: Polygon, tolerance: float) -> Polygon:
    """Drop duplicate/zero-length segments and vertices within ``tolerance`` of the contour."""
    cleaned = Polygon(_dedupe(polygon.exterior.coords), [_dedupe(r.coords) for r in polygon.interiors])
    simplified = shapely.simplify(cleaned, tolerance, preserve_topology=True)
    if (
        isinstance(simplified, Polygon)
        and simplified.is_valid
        and len(simplified.interiors) == len(cleaned.interiors)
        and not simplified.is_empty
    ):
        return simplified
    return cleaned


def _dedupe(coords) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for x, y in coords:
        if not out or math.hypot(x - out[-1][0], y - out[-1][1]) > _DEDUPE_MM:
            out.append((x, y))
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= _DEDUPE_MM:
        out.pop()
    return out


def _fix_header_metadata(text: str, created_at: datetime) -> str:
    """Replace ezdxf's wall-clock timestamps and random GUIDs with fixed values."""
    julian = _julian_date(created_at.astimezone(UTC).replace(tzinfo=None))
    fixed = {
        "$TDCREATE": f"{julian:.10f}",
        "$TDUCREATE": f"{julian:.10f}",
        "$TDUPDATE": f"{julian:.10f}",
        "$TDUUPDATE": f"{julian:.10f}",
        "$FINGERPRINTGUID": _FIXED_GUID,
        "$VERSIONGUID": _FIXED_GUID,
    }
    lines = text.split("\n")
    end = next((i for i, line in enumerate(lines) if line.strip() == "ENDSEC"), len(lines))
    i = 0
    while i + 3 < end:
        if lines[i].strip() == "9" and lines[i + 1].strip() in fixed:
            lines[i + 3] = fixed[lines[i + 1].strip()]
            i += 4
        else:
            i += 2
    # ezdxf also stamps "<version> @ <write time>" into its EZDXF_META
    # dictionary variables in the OBJECTS section.
    meta_prefix = f"{ezdxf.__version__} @ "
    stamp = meta_prefix + created_at.astimezone(UTC).isoformat()
    lines = [stamp if line.startswith(meta_prefix) else line for line in lines]
    return "\n".join(lines)


def _julian_date(moment: datetime) -> float:
    return (
        moment.toordinal()
        + 1721424.5
        + (moment.hour * 3600 + moment.minute * 60 + moment.second + moment.microsecond / 1e6) / 86400.0
    )


@dataclass
class _ParsedDxf:
    insunits: int | None
    entities: list[dict]
    block_entities: int


def _parse_dxf(data: bytes) -> _ParsedDxf:
    """Minimal ASCII DXF reader: (group code, value) pairs, HEADER/BLOCKS/ENTITIES only."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("cp1252")
    lines = text.splitlines()
    if len(lines) % 2:
        lines = lines[:-1]
    pairs = []
    for k in range(0, len(lines), 2):
        try:
            pairs.append((int(lines[k].strip()), lines[k + 1].strip()))
        except ValueError as exc:
            raise ValueError(f"invalid group code at line {k + 1}") from exc

    insunits = None
    entities: list[dict] = []
    block_entities = 0
    section = None
    block_depth = False
    current: dict | None = None
    expect_section_name = False
    for idx, (code, value) in enumerate(pairs):
        if code == 0:
            if current is not None:
                entities.append(current)
                current = None
            if value == "SECTION":
                expect_section_name = True
                continue
            if value == "ENDSEC":
                section = None
                continue
            if section == "BLOCKS":
                if value == "BLOCK":
                    block_depth = True
                elif value == "ENDBLK":
                    block_depth = False
                elif block_depth:
                    block_entities += 1
                continue
            if section == "ENTITIES" and value != "EOF":
                current = {
                    "type": value,
                    "layer": None,
                    "closed": False,
                    "count": 0,
                    "points": [],
                    "widths": False,
                    "bulges": False,
                }
            continue
        if code == 2 and expect_section_name:
            section = value
            expect_section_name = False
            continue
        if section == "HEADER" and code == 9 and value == "$INSUNITS":
            next_code, next_value = pairs[idx + 1]
            if next_code == 70:
                insunits = int(next_value)
            continue
        if current is None:
            continue
        if code == 5:
            current["handle"] = value
        elif code == 8:
            current["layer"] = value
        elif code == 70:
            current["closed"] = bool(int(value) & 1)
        elif code == 90:
            current["count"] = int(value)
        elif code == 10:
            current["points"].append([float(value), None])
        elif code == 20:
            if not current["points"] or current["points"][-1][1] is not None:
                raise ValueError("Y coordinate without X coordinate")
            current["points"][-1][1] = float(value)
        elif code in (40, 41, 43):
            if abs(float(value)) > 0:
                current["widths"] = True
        elif code == 42:
            if abs(float(value)) > 0:
                current["bulges"] = True
    if current is not None:
        entities.append(current)
    for entity in entities:
        if any(p[1] is None for p in entity["points"]):
            raise ValueError(f"entity {entity.get('handle', '?')} has an X coordinate without Y")
        entity["points"] = [tuple(p) for p in entity["points"]]
        entity["layer"] = entity["layer"] if entity["layer"] is not None else "0"
    return _ParsedDxf(insunits, entities, block_entities)


def _match_loops(loops: list[dict], expected: list[LinearRing], tolerance: float, violations: list[Violation]) -> float:
    """Pair each DXF loop with an unused expected contour within tolerance; return max error."""
    tree = STRtree(expected)
    expected_bounds = shapely.bounds(expected)
    used: set[int] = set()
    max_error = 0.0
    for loop in loops:
        ring = LinearRing(loop["points"])
        candidates = tree.query(ring.envelope.buffer(tolerance * 2 + 1e-9))
        # Bounds differ by at most the Hausdorff distance, so contours whose
        # bounds differ by more than the tolerance cannot match; skipping them
        # avoids the (quadratic) Hausdorff computation for interleaved neighbours.
        bounds = np.asarray(ring.bounds)
        best = None
        for index in sorted(int(c) for c in candidates):
            if index in used or np.abs(expected_bounds[index] - bounds).max() > tolerance:
                continue
            error = _hausdorff(ring, expected[index])
            if error <= tolerance and (best is None or error < best[0]):
                best = (error, index)
        if best is None:
            violations.append(
                Violation(
                    "DXF_GEOMETRY_MISMATCH",
                    f"LWPOLYLINE {loop.get('handle', '?')} matches no expected contour within {tolerance} mm",
                    details={"bounds": list(ring.bounds)},
                )
            )
            continue
        used.add(best[1])
        max_error = max(max_error, best[0])
    missing = len(expected) - len(used)
    if missing:
        violations.append(Violation("DXF_MISSING_CONTOUR", f"{missing} expected contours are absent from the DXF"))
    return max_error


def _hausdorff(a: LinearRing, b: LinearRing, parts: int = 4) -> float:
    """Symmetric Hausdorff distance between two rings, sampled like GEOS with
    ``densify=1/parts`` but measured point-to-segment through a segment index,
    so large contours cost O(n log m) instead of O(n * m)."""
    return max(_directed_distance(a, b, parts), _directed_distance(b, a, parts))


def _directed_distance(a: LinearRing, b: LinearRing, parts: int) -> float:
    pa = shapely.get_coordinates(a)
    pb = shapely.get_coordinates(b)
    steps = np.arange(parts) / parts
    samples = (pa[:-1, None, :] + (pa[1:] - pa[:-1])[:, None, :] * steps[None, :, None]).reshape(-1, 2)
    segments = STRtree(shapely.linestrings(np.stack([pb[:-1], pb[1:]], axis=1)))
    _, distances = segments.query_nearest(shapely.points(samples), return_distance=True, all_matches=False)
    return float(distances.max())


def _ezdxf_audit(dxf_bytes: bytes, violations: list[Violation]) -> tuple[int, int]:
    try:
        doc = ezdxf.read(io.StringIO(dxf_bytes.decode("utf-8")))
    except (ezdxf.DXFError, UnicodeDecodeError) as exc:
        violations.append(Violation("DXF_EZDXF_READ", f"ezdxf could not read the DXF: {exc}"))
        return 0, 0
    auditor = doc.audit()
    if auditor.has_errors:
        violations.append(
            Violation(
                "DXF_EZDXF_AUDIT",
                f"ezdxf audit found {len(auditor.errors)} errors",
                details={"errors": [str(e.message) for e in auditor.errors[:20]]},
            )
        )
    return len(auditor.errors), len(auditor.fixes)


def _part_manifest(part: PartSpec) -> dict:
    geometry = as_multipolygon(part.geometry)
    min_x, min_y, max_x, max_y = geometry.bounds
    return {
        "part_key": part.part_key,
        "line_id": part.line_id,
        "product_id": part.product_id,
        "instance_ids": list(part.instance_ids),
        "quantity": len(part.instance_ids),
        "width_mm": max_x - min_x,
        "height_mm": max_y - min_y,
        "metal_area_mm2": geometry.area,
        "exterior_count": len(geometry.geoms),
        "hole_count": sum(len(p.interiors) for p in geometry.geoms),
        "vertex_count": int(shapely.get_num_coordinates(geometry)),
        "allowed_rotations": list(part.allowed_rotations),
    }


def _deterministic_zip(files: Sequence[PackageFile]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for f in files:
            info = zipfile.ZipInfo(f.name, date_time=_ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3
            archive.writestr(info, f.content, compresslevel=9)
    return buffer.getvalue()


def _product_colors(placements: Sequence[Placement]) -> dict[str, str]:
    palette = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#ff9da7", "#9c755f"]
    products = sorted({p.product_id for p in placements})
    return {pid: palette[n % len(palette)] for n, pid in enumerate(products)}


def _svg_ring(ring) -> str:
    coords = list(ring.coords)[:-1]
    return "M" + " L".join(f"{_n(x)} {_n(y)}" for x, y in coords) + " Z"


def _n(value: float) -> str:
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def _dim(value: float) -> str:
    return f"{value:g}" if float(value).is_integer() else f"{value:.1f}".rstrip("0").rstrip(".")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_default(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (set, tuple)):
        return list(value)
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")
