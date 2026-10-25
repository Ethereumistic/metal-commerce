"""Independent layout validation.

Every check here is recomputed from the original part geometry (with holes) and
the placement transforms. Nothing reported by the solver is trusted.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Sequence

import shapely
from shapely import STRtree

from .nesting_types import (
    GEOMETRY_EPS_MM,
    PartSpec,
    Placement,
    StockSpec,
    ValidationReport,
    Violation,
    filled_shell,
    place_geometry,
)


def validate_layout(
    parts: Sequence[PartSpec],
    stock: StockSpec,
    sheets: Sequence[Sequence[Placement]],
    *,
    allow_unplaced: bool = False,
    tolerance_mm: float = GEOMETRY_EPS_MM,
) -> ValidationReport:
    """Check sheet bounds, pairwise clearance, rotations and instance coverage.

    With ``allow_unplaced`` a layout that omits requested instances can still be
    geometrically valid; the omissions are listed in ``unplaced_instance_ids``.
    Without it every requested instance must be placed exactly once.
    """
    violations: list[Violation] = []
    by_instance: dict[str, PartSpec] = {}
    for part in parts:
        for instance_id in part.instance_ids:
            if instance_id in by_instance:
                violations.append(
                    Violation("DUPLICATE_REQUEST", f"instance {instance_id} is requested twice", (instance_id,))
                )
            by_instance[instance_id] = part

    if len(sheets) > stock.max_sheets:
        violations.append(
            Violation(
                "TOO_MANY_SHEETS",
                f"layout uses {len(sheets)} sheets but only {stock.max_sheets} are available",
                details={"sheet_count": len(sheets), "max_sheets": stock.max_sheets},
            )
        )

    seen = Counter(p.instance_id for sheet in sheets for p in sheet)
    for instance_id, count in sorted(seen.items()):
        if count > 1:
            violations.append(
                Violation("DUPLICATE_INSTANCE", f"instance {instance_id} is placed {count} times", (instance_id,))
            )
    unplaced = [i for part in parts for i in part.instance_ids if i not in seen]
    if unplaced and not allow_unplaced:
        violations.append(
            Violation(
                "MISSING_INSTANCE",
                f"{len(unplaced)} requested instances are not placed",
                tuple(unplaced),
            )
        )

    min_gap: float | None = None
    for sheet_index, sheet in enumerate(sheets):
        placed = _check_placements(sheet, sheet_index, by_instance, stock, tolerance_mm, violations)
        sheet_min_gap = _check_clearance(placed, sheet_index, stock.gap_mm, tolerance_mm, violations)
        if sheet_min_gap is not None:
            min_gap = sheet_min_gap if min_gap is None else min(min_gap, sheet_min_gap)

    return ValidationReport(
        valid=not violations,
        violations=violations,
        requested=len(by_instance),
        placed=sum(1 for i in seen if i in by_instance),
        unplaced_instance_ids=unplaced,
        sheet_count=len(sheets),
        min_gap_mm=min_gap,
        gap_mm=stock.gap_mm,
        tolerance_mm=tolerance_mm,
    )


def _check_placements(sheet, sheet_index, by_instance, stock, tolerance, violations):
    """Validate each placement on one sheet; return the transformed parts that are checkable."""
    placed = []
    for placement in sheet:
        part = by_instance.get(placement.instance_id)
        if part is None:
            violations.append(
                Violation(
                    "UNKNOWN_INSTANCE",
                    f"instance {placement.instance_id} was not requested",
                    (placement.instance_id,),
                    sheet_index,
                )
            )
            continue
        if (placement.part_key, placement.line_id, placement.product_id) != (
            part.part_key,
            part.line_id,
            part.product_id,
        ):
            violations.append(
                Violation(
                    "IDENTITY_MISMATCH",
                    f"instance {placement.instance_id} carries the wrong part/line/product identity",
                    (placement.instance_id,),
                    sheet_index,
                )
            )
        if placement.rotation_deg not in part.allowed_rotations:
            violations.append(
                Violation(
                    "ROTATION_NOT_ALLOWED",
                    f"instance {placement.instance_id} is rotated {placement.rotation_deg} degrees; "
                    f"allowed: {list(part.allowed_rotations)}",
                    (placement.instance_id,),
                    sheet_index,
                )
            )
        if not (math.isfinite(placement.tx_mm) and math.isfinite(placement.ty_mm)):
            violations.append(
                Violation(
                    "INVALID_TRANSFORM",
                    f"instance {placement.instance_id} has a non-finite translation",
                    (placement.instance_id,),
                    sheet_index,
                )
            )
            continue

        world = place_geometry(part.geometry, placement.rotation_deg, placement.tx_mm, placement.ty_mm)
        min_x, min_y, max_x, max_y = world.bounds
        if (
            min_x < stock.usable_min_x - tolerance
            or min_y < stock.usable_min_y - tolerance
            or max_x > stock.usable_max_x + tolerance
            or max_y > stock.usable_max_y + tolerance
        ):
            violations.append(
                Violation(
                    "OUT_OF_BOUNDS",
                    f"instance {placement.instance_id} extends outside the usable sheet area",
                    (placement.instance_id,),
                    sheet_index,
                    {"bounds": [min_x, min_y, max_x, max_y], "usable": stock.usable_envelope()},
                )
            )
        placed.append((placement.instance_id, world))
    return placed


def _check_clearance(placed, sheet_index, gap_mm, tolerance, violations) -> float | None:
    """Pairwise clearance between parts; also forbids any part inside another part's hole."""
    if len(placed) < 2:
        return None
    shells = [filled_shell(world) for _, world in placed]
    tree = STRtree(shells)
    # Candidate pairs: anything whose filled outline comes within the gap.
    left, right = tree.query(shells, predicate="dwithin", distance=max(gap_mm, 0.0) + tolerance)
    min_gap: float | None = None
    for i, j in zip(left.tolist(), right.tolist(), strict=True):
        if i >= j:
            continue
        id_i, world_i = placed[i]
        id_j, world_j = placed[j]
        distance = float(shapely.distance(world_i, world_j))
        shell_distance = float(shapely.distance(shells[i], shells[j]))
        min_gap = distance if min_gap is None else min(min_gap, distance)
        if gap_mm > tolerance:
            gap_ok = distance >= gap_mm - tolerance
        else:
            gap_ok = float(shapely.area(shapely.intersection(world_i, world_j))) <= tolerance
        if not gap_ok:
            violations.append(
                Violation(
                    "GAP_VIOLATION" if distance > 0 else "OVERLAP",
                    f"instances {id_i} and {id_j} are {distance:.4f} mm apart; required {gap_mm} mm",
                    (id_i, id_j),
                    sheet_index,
                    {"distance_mm": distance, "gap_mm": gap_mm},
                )
            )
        elif shell_distance < gap_mm - tolerance or (
            gap_mm <= tolerance and _shells_overlap(shells[i], shells[j], tolerance)
        ):
            violations.append(
                Violation(
                    "INSIDE_HOLE",
                    f"instances {id_i} and {id_j} nest inside one another's hole, which v1 does not allow",
                    (id_i, id_j),
                    sheet_index,
                    {"shell_distance_mm": shell_distance},
                )
            )
    return min_gap


def _shells_overlap(a, b, tolerance) -> bool:
    return float(shapely.area(shapely.intersection(a, b))) > tolerance
