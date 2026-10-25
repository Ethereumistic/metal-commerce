"""Shapely helpers shared by tracing, sizing and the nest job.

Conventions: master geometry is dimensionless, Y-up, bbox lower-left at (0, 0)
with the longest side equal to 1. Sized geometry is millimetres with the same
origin convention, so scaling is a plain multiplication (no retrace, no shift).
"""

from __future__ import annotations

import math
from typing import Any, Iterable

import shapely
from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.polygon import orient

# Bumped whenever sized geometry produced from the same master would change.
GEOMETRY_VERSION = "1"

COORD_DECIMALS = 8


def polygons_of(geom: Any) -> list[Polygon]:
    """Return the polygonal parts of any Shapely geometry (drops points/lines)."""
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, "geoms"):
        out: list[Polygon] = []
        for part in geom.geoms:
            out.extend(polygons_of(part))
        return out
    return []


def as_multipolygon(polys: Iterable[Polygon]) -> MultiPolygon:
    """Orient exteriors CCW / holes CW and wrap in a MultiPolygon."""
    return MultiPolygon([orient(p, sign=1.0) for p in polys if not p.is_empty])


def hole_count(geom: Any) -> int:
    return sum(len(p.interiors) for p in polygons_of(geom))


def vertex_count(geom: Any) -> int:
    # Rings are closed, so the repeated closing vertex is excluded.
    total = 0
    for p in polygons_of(geom):
        total += len(p.exterior.coords) - 1
        total += sum(len(r.coords) - 1 for r in p.interiors)
    return total


def _ring_list(ring: Any) -> list[list[float]]:
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in ring.coords]


def to_json(geom: MultiPolygon) -> dict[str, Any]:
    """GeoJSON-style MultiPolygon; polygon index is the component identity."""
    return {
        "type": "MultiPolygon",
        "coordinates": [
            [_ring_list(p.exterior)] + [_ring_list(r) for r in p.interiors]
            for p in geom.geoms
        ],
    }


def from_json(data: dict[str, Any]) -> MultiPolygon:
    if data.get("type") != "MultiPolygon":
        raise ValueError("expected a MultiPolygon geometry")
    polys = [Polygon(rings[0], rings[1:]) for rings in data["coordinates"]]
    return MultiPolygon(polys)


def scale_master(master: MultiPolygon, width: float, height: float) -> MultiPolygon:
    """Scale a normalized master to an exact physical box, keeping origin at (0, 0)."""
    minx, miny, maxx, maxy = master.bounds
    w, h = maxx - minx, maxy - miny
    if w <= 0 or h <= 0:
        raise ValueError("master geometry has a degenerate bounding box")
    moved = affinity.translate(master, -minx, -miny)
    scaled = affinity.scale(moved, width / w, height / h, origin=(0, 0))
    return as_multipolygon(polygons_of(scaled))


def to_svg(geom: MultiPolygon, *, size_px: int = 1000, fill: str = "#000") -> str:
    """Standalone SVG preview. SVG is Y-down, so Y is flipped exactly once here."""
    minx, miny, maxx, maxy = geom.bounds
    w, h = maxx - minx, maxy - miny
    scale = size_px / max(w, h) if max(w, h) > 0 else 1.0
    vw, vh = w * scale, h * scale

    def ring_path(ring: Any) -> str:
        pts = list(ring.coords)[:-1]
        if not pts:
            return ""
        cmds = [
            f"{(x - minx) * scale:.3f},{(maxy - y) * scale:.3f}" for x, y in pts
        ]
        return "M" + " L".join(cmds) + " Z"

    paths = []
    for p in geom.geoms:
        d = " ".join([ring_path(p.exterior)] + [ring_path(r) for r in p.interiors])
        paths.append(f'<path d="{d}"/>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vw:.3f} {vh:.3f}" '
        f'width="{vw:.0f}" height="{vh:.0f}">\n'
        f'<g fill="{fill}" fill-rule="evenodd" stroke="none">\n'
        + "\n".join(paths)
        + "\n</g>\n</svg>\n"
    )


def topology_signature(geom: Any) -> tuple[int, int]:
    """(component count, hole count) used to check repairs did not change topology."""
    polys = polygons_of(geom)
    return len(polys), sum(len(p.interiors) for p in polys)


def relative_area_change(before: Any, after: Any) -> float:
    a0 = before.area
    if a0 <= 0:
        return math.inf
    return abs(after.area - a0) / a0


def is_valid(geom: Any) -> bool:
    return bool(shapely.is_valid(geom))
