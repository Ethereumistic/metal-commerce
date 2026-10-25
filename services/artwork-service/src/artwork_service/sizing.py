"""Physical sizing of normalized masters and pre-optimization fit checks.

Sizes always derive from the master (never from another sized copy) and keep
the master's aspect ratio: nonuniform scaling is outside the MVP. Nothing here
invokes the tracer.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any

from shapely.geometry import MultiPolygon

from . import geometry as geo
from .errors import ServiceError

MAX_PART_MM = 20_000.0
MIN_PART_MM = 1.0
# Fit comparisons absorb float noise only; this is not a fabrication tolerance.
FIT_EPS_MM = 1e-6


@dataclass(frozen=True)
class SizedPart:
    width_mm: float
    height_mm: float


def compute_size(aspect_ratio: float, mode: str, width_mm: float | None, height_mm: float | None) -> SizedPart:
    """Actual dimensions for a size request; `aspect_ratio` is width / height."""
    if not (aspect_ratio > 0 and math.isfinite(aspect_ratio)):
        raise ServiceError("INVALID_DIMENSIONS", "The master has an invalid aspect ratio.",
                           {"aspect_ratio": aspect_ratio})
    if mode == "width":
        _require(width_mm, "width_mm", mode)
        w, h = width_mm, width_mm / aspect_ratio
    elif mode == "height":
        _require(height_mm, "height_mm", mode)
        w, h = height_mm * aspect_ratio, height_mm
    elif mode == "fit":
        _require(width_mm, "width_mm", mode)
        _require(height_mm, "height_mm", mode)
        # Largest aspect-locked size inside width × height.
        if width_mm / height_mm <= aspect_ratio:
            w, h = width_mm, width_mm / aspect_ratio
        else:
            w, h = height_mm * aspect_ratio, height_mm
    else:
        raise ServiceError("INVALID_DIMENSIONS", f"Unknown size mode {mode!r}.", {"mode": mode})
    for name, value in (("width_mm", w), ("height_mm", h)):
        if not (MIN_PART_MM <= value <= MAX_PART_MM):
            raise ServiceError("INVALID_DIMENSIONS",
                               f"The resulting {name.split('_')[0]} {value:.3f} mm is outside "
                               f"{MIN_PART_MM:g}–{MAX_PART_MM:g} mm.",
                               {"actual_width_mm": w, "actual_height_mm": h})
    return SizedPart(round(w, 6), round(h, 6))


def _require(value: float | None, name: str, mode: str) -> None:
    if value is None or not math.isfinite(value) or value <= 0:
        raise ServiceError("INVALID_DIMENSIONS", f"Size mode '{mode}' requires a positive {name}.",
                           {"field": name, "mode": mode})


def part_key(master_id: str, size: SizedPart) -> str:
    """Sized-geometry identity: master revision + exact dimensions + algorithm version."""
    raw = f"{master_id}|{size.width_mm:.6f}|{size.height_mm:.6f}|{geo.GEOMETRY_VERSION}"
    return "pk_" + hashlib.sha256(raw.encode()).hexdigest()[:32]


def sized_geometry(master: MultiPolygon, size: SizedPart) -> MultiPolygon:
    return geo.scale_master(master, size.width_mm, size.height_mm)


@dataclass(frozen=True)
class Envelope:
    width_mm: float
    height_mm: float


def usable_envelope(stock: dict[str, Any]) -> Envelope:
    m = stock["margins_mm"]
    w = stock["width_mm"] - m["left"] - m["right"]
    h = stock["height_mm"] - m["bottom"] - m["top"]
    if w <= 0 or h <= 0:
        raise ServiceError("INVALID_DIMENSIONS", "The sheet margins leave no usable area.",
                           {"usable_width_mm": w, "usable_height_mm": h})
    return Envelope(w, h)


def fit_check(size: SizedPart, envelope: Envelope, rotations: list[int]) -> dict[str, Any] | None:
    """None when the part fits in at least one allowed rotation, else a PART_DOES_NOT_FIT error."""
    upright = any(r in (0, 180) for r in rotations)
    turned = any(r in (90, 270) for r in rotations)
    if upright and size.width_mm <= envelope.width_mm + FIT_EPS_MM and size.height_mm <= envelope.height_mm + FIT_EPS_MM:
        return None
    if turned and size.height_mm <= envelope.width_mm + FIT_EPS_MM and size.width_mm <= envelope.height_mm + FIT_EPS_MM:
        return None
    return {
        "code": "PART_DOES_NOT_FIT",
        "message": (f"A {size.width_mm:g} × {size.height_mm:g} mm part does not fit the usable sheet area of "
                    f"{envelope.width_mm:g} × {envelope.height_mm:g} mm in any allowed rotation."),
        "details": {
            "part_width_mm": size.width_mm,
            "part_height_mm": size.height_mm,
            "usable_width_mm": envelope.width_mm,
            "usable_height_mm": envelope.height_mm,
            "rotations_checked": sorted(rotations),
        },
    }


def unknown_feature_check() -> dict[str, Any]:
    return {"status": "unknown", "min_feature_mm": None, "min_hole_mm": None,
            "message": "The fabrication profile has no feature limits; feature widths were not qualified."}


def feature_check(geom_mm: MultiPolygon, min_feature_mm: float | None, min_hole_mm: float | None) -> dict[str, Any]:
    """Check metal features and openings against profile limits at the requested size.

    A morphological opening (erode then dilate by half the limit) removes metal
    narrower than the limit; a closing fills openings narrower than it. Only
    removed regions at least as large as a limit × limit square count: rounding
    a sharp corner removes about 5% of that, so corners are not reported as
    narrow features. Unknown limits are reported as unknown, never as a pass.
    """
    if min_feature_mm is None and min_hole_mm is None:
        return unknown_feature_check()
    out: dict[str, Any] = {"min_feature_mm": min_feature_mm, "min_hole_mm": min_hole_mm}
    findings: list[dict[str, Any]] = []
    if min_feature_mm is not None:
        r = min_feature_mm / 2
        opened = geom_mm.buffer(-r, quad_segs=8).buffer(r, quad_segs=8)
        finding = _significant(geom_mm.difference(opened), min_feature_mm, "FEATURE_TOO_NARROW")
        if finding:
            findings.append(finding)
    if min_hole_mm is not None:
        r = min_hole_mm / 2
        closed = geom_mm.buffer(r, quad_segs=8).buffer(-r, quad_segs=8)
        finding = _significant(closed.difference(geom_mm), min_hole_mm, "OPENING_TOO_NARROW")
        if finding:
            findings.append(finding)
    out["status"] = "fail" if findings else "pass"
    out["findings"] = findings
    return out


def _significant(removed: Any, limit: float, code: str) -> dict[str, Any] | None:
    pieces = [p for p in geo.polygons_of(removed) if p.area >= limit * limit]
    if not pieces:
        return None
    return {"code": code, "regions": len(pieces), "area_mm2": round(sum(p.area for p in pieces), 4),
            "example_bounds_mm": [round(v, 3) for v in max(pieces, key=lambda p: p.area).bounds]}
