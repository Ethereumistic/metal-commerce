"""Shared types for nesting, layout validation and production export.

Geometry convention (fixed by the service contract): Shapely geometry in
millimetres, Y-up, with the part's reference origin at the lower-left corner of
its un-rotated bounding box (minx == miny == 0). A placement maps a part into
sheet coordinates (origin at the sheet's lower-left corner) as

    world = translate(rotate(geometry, rotation_deg, origin=(0, 0)), tx_mm, ty_mm)

Rotation is counter-clockwise; mirroring is never applied.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import shapely
from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

# Positional tolerance (mm) used by every geometric acceptance check. It only
# absorbs floating point noise; it is not a fabrication tolerance.
GEOMETRY_EPS_MM = 1e-6


class NestingError(Exception):
    """A request that cannot be nested, carrying a contract error code."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class PartSpec:
    part_key: str
    geometry: MultiPolygon
    instance_ids: tuple[str, ...]
    line_id: str
    product_id: str
    allowed_rotations: tuple[int, ...] = (0, 90, 180, 270)


@dataclass(frozen=True)
class StockSpec:
    width_mm: float
    height_mm: float
    margin_left: float
    margin_right: float
    margin_bottom: float
    margin_top: float
    gap_mm: float
    max_sheets: int

    @property
    def usable_min_x(self) -> float:
        return self.margin_left

    @property
    def usable_min_y(self) -> float:
        return self.margin_bottom

    @property
    def usable_max_x(self) -> float:
        return self.width_mm - self.margin_right

    @property
    def usable_max_y(self) -> float:
        return self.height_mm - self.margin_top

    @property
    def usable_width(self) -> float:
        return self.usable_max_x - self.usable_min_x

    @property
    def usable_height(self) -> float:
        return self.usable_max_y - self.usable_min_y

    @property
    def long_axis(self) -> str:
        """Axis along which the occupied extent of a sheet is measured."""
        return "y" if self.height_mm >= self.width_mm else "x"

    def usable_envelope(self) -> dict[str, float]:
        return {
            "min_x": self.usable_min_x,
            "min_y": self.usable_min_y,
            "max_x": self.usable_max_x,
            "max_y": self.usable_max_y,
            "width_mm": self.usable_width,
            "height_mm": self.usable_height,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "width_mm": self.width_mm,
            "height_mm": self.height_mm,
            "margins_mm": {
                "left": self.margin_left,
                "right": self.margin_right,
                "bottom": self.margin_bottom,
                "top": self.margin_top,
            },
            "gap_mm": self.gap_mm,
            "max_sheets": self.max_sheets,
        }


@dataclass(frozen=True)
class Placement:
    instance_id: str
    part_key: str
    line_id: str
    product_id: str
    rotation_deg: int
    tx_mm: float
    ty_mm: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "part_key": self.part_key,
            "line_id": self.line_id,
            "product_id": self.product_id,
            "rotation_deg": self.rotation_deg,
            "tx_mm": self.tx_mm,
            "ty_mm": self.ty_mm,
        }


@dataclass
class NestOutcome:
    sheets: list[list[Placement]]
    unplaced_instance_ids: list[str]
    status: str
    engine: str
    engine_version: str
    settings: dict
    runtime_s: float
    metrics: dict
    baseline_metrics: dict
    validation: "ValidationReport | None" = None


@dataclass(frozen=True)
class Violation:
    code: str
    message: str
    instance_ids: tuple[str, ...] = ()
    sheet_index: int | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "instance_ids": list(self.instance_ids),
            "sheet_index": self.sheet_index,
            "details": self.details,
        }


@dataclass
class ValidationReport:
    valid: bool
    violations: list[Violation]
    requested: int
    placed: int
    unplaced_instance_ids: list[str]
    sheet_count: int
    min_gap_mm: float | None
    gap_mm: float
    tolerance_mm: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "violations": [v.to_dict() for v in self.violations],
            "requested": self.requested,
            "placed": self.placed,
            "unplaced_instance_ids": list(self.unplaced_instance_ids),
            "sheet_count": self.sheet_count,
            "min_gap_mm": self.min_gap_mm,
            "gap_mm": self.gap_mm,
            "tolerance_mm": self.tolerance_mm,
        }


@dataclass
class DxfCheckReport:
    valid: bool
    violations: list[Violation]
    insunits: int | None
    layers: list[str]
    entity_count: int
    loop_count: int
    expected_loop_count: int
    max_vertex_error_mm: float | None
    bounds: tuple[float, float, float, float] | None
    ezdxf_audit_errors: int
    ezdxf_audit_fixes: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "violations": [v.to_dict() for v in self.violations],
            "insunits": self.insunits,
            "layers": list(self.layers),
            "entity_count": self.entity_count,
            "loop_count": self.loop_count,
            "expected_loop_count": self.expected_loop_count,
            "max_vertex_error_mm": self.max_vertex_error_mm,
            "bounds": list(self.bounds) if self.bounds else None,
            "ezdxf_audit_errors": self.ezdxf_audit_errors,
            "ezdxf_audit_fixes": self.ezdxf_audit_fixes,
        }


def as_multipolygon(geometry: BaseGeometry) -> MultiPolygon:
    if isinstance(geometry, MultiPolygon):
        return geometry
    if isinstance(geometry, Polygon):
        return MultiPolygon([geometry])
    raise TypeError(f"expected Polygon or MultiPolygon, got {geometry.geom_type}")


def rotate_about_origin(geometry: BaseGeometry, rotation_deg: float) -> BaseGeometry:
    """Rotate counter-clockwise about (0, 0), exactly for quarter turns."""
    quarter = {0: (1.0, 0.0), 90: (0.0, 1.0), 180: (-1.0, 0.0), 270: (0.0, -1.0)}
    angle = rotation_deg % 360
    if angle in quarter:
        cos_a, sin_a = quarter[int(angle)]
    else:
        cos_a, sin_a = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    return affinity.affine_transform(geometry, [cos_a, -sin_a, sin_a, cos_a, 0.0, 0.0])


def place_geometry(geometry: BaseGeometry, rotation_deg: float, tx_mm: float, ty_mm: float) -> BaseGeometry:
    """Apply the contract placement transform (rotate about origin, then translate)."""
    return affinity.translate(rotate_about_origin(geometry, rotation_deg), tx_mm, ty_mm)


def filled_shell(geometry: BaseGeometry) -> BaseGeometry:
    """The part's outer contours with holes filled (the v1 no-nesting-in-holes footprint)."""
    polygons = as_multipolygon(geometry).geoms
    return shapely.union_all([Polygon(p.exterior) for p in polygons])
