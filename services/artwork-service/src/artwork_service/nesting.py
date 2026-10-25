"""Nest one material/thickness group of parts onto sheets.

Flow: validate input and pre-fit every part (fail before optimisation), compute
a bounding-box shelf baseline, run PackingSolver within the time budget, then
validate every candidate independently against the original geometry and keep
the better valid one. Callers group parts by material/thickness/profile and
call ``nest_group`` once per group.

Metric definitions (also in docs/nesting-and-export.md):
- metal_area_mm2: sum of nominal part areas, holes excluded;
- sheet_area_mm2: full sheet width x height per used sheet;
- utilization = metal_area_mm2 / sheet_area_mm2 (not bounding-box coverage);
- occupied_extent_mm: furthest coordinate reached by any part along the sheet's
  long axis, measured from the sheet origin; the totals report it for the last
  sheet, which is the only one whose leftover is optimised.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .nesting_types import (
    GEOMETRY_EPS_MM,
    NestingError,
    NestOutcome,
    PartSpec,
    Placement,
    StockSpec,
    ValidationReport,
    as_multipolygon,
    rotate_about_origin,
)
from . import solver_adapter
from .validation import validate_layout

NESTING_VERSION = "nesting-1.0.0"
BASELINE_ENGINE = "bbox-baseline"
# Share of the time budget for the first solver attempt; the rest is reserved
# for one retry with a safer collision contour if the first layout is invalid.
_FIRST_ATTEMPT_SHARE = 0.7
_MIN_RETRY_S = 1.0


@dataclass
class _Candidate:
    engine: str
    sheets: list[list[Placement]]
    unplaced: list[str]
    report: ValidationReport


def check_parts_fit(parts: Sequence[PartSpec], stock: StockSpec) -> list[dict]:
    """Return one problem per part that fits the usable sheet at no allowed rotation."""
    problems = []
    for part in parts:
        fits = False
        for rotation in part.allowed_rotations:
            min_x, min_y, max_x, max_y = rotate_about_origin(part.geometry, rotation).bounds
            if (
                max_x - min_x <= stock.usable_width + GEOMETRY_EPS_MM
                and max_y - min_y <= stock.usable_height + GEOMETRY_EPS_MM
            ):
                fits = True
                break
        if not fits:
            min_x, min_y, max_x, max_y = part.geometry.bounds
            problems.append(
                {
                    "part_key": part.part_key,
                    "line_id": part.line_id,
                    "product_id": part.product_id,
                    "part_width_mm": max_x - min_x,
                    "part_height_mm": max_y - min_y,
                    "allowed_rotations": list(part.allowed_rotations),
                    "usable_envelope": stock.usable_envelope(),
                }
            )
    return problems


def nest_group(
    parts: list[PartSpec],
    stock: StockSpec,
    *,
    time_budget_s: float,
    seed: int,
    cancel: Callable[[], bool],
    progress: Callable[[float, str], None],
) -> NestOutcome:
    """Nest all instances of ``parts`` on sheets of ``stock``.

    Raises ``NestingError`` (VALIDATION_ERROR, INVALID_DIMENSIONS or
    PART_DOES_NOT_FIT) before any optimisation for malformed input or parts that
    cannot fit. Otherwise returns an outcome whose status is ``complete`` only
    when every instance is placed on an independently validated layout.
    """
    started = time.monotonic()
    _validate_request(parts, stock, time_budget_s)
    progress(0.0, "prefit")
    problems = check_parts_fit(parts, stock)
    if problems:
        raise NestingError(
            "PART_DOES_NOT_FIT",
            f"{len(problems)} part(s) do not fit the usable sheet area "
            f"{stock.usable_width:g} x {stock.usable_height:g} mm at any allowed rotation",
            {"parts": problems},
        )
    by_instance = {i: p for p in parts for i in p.instance_ids}

    progress(0.02, "baseline")
    baseline_sheets, baseline_unplaced = bbox_baseline(parts, stock)
    baseline = _candidate(BASELINE_ENGINE, baseline_sheets, parts, stock)
    baseline_metrics = layout_metrics(baseline.sheets, baseline.unplaced, parts, stock)
    baseline_metrics["valid"] = baseline.report.valid

    settings: dict = {
        "nesting_version": NESTING_VERSION,
        "time_budget_s": time_budget_s,
        "seed": seed,
        "seed_applied": False,
        "seed_note": "packingsolver 0.1.1218 python bindings do not expose a seed; runs are time-bounded "
        "and may differ between runs",
        "gap_mm": stock.gap_mm,
        "gap_handling": "solver item_item_minimum_spacing; collision contours are not inflated by the gap",
        "holes_in_solver": False,
        "mirror": False,
        "attempts": [],
    }

    best = baseline if baseline.report.valid else None
    if cancel():
        return _cancelled(parts, settings, started, baseline_metrics)

    solver_candidate = None
    deadline = started + time_budget_s
    for attempt, safety_offset in enumerate((0.0, max(0.25, 0.1 * stock.gap_mm))):
        remaining = deadline - time.monotonic()
        if attempt == 0:
            budget = max(_MIN_RETRY_S, remaining * _FIRST_ATTEMPT_SHARE)
        elif remaining >= _MIN_RETRY_S:
            budget = remaining
        else:
            settings["attempts"].append({"attempt": attempt, "skipped": "no time left for a safer retry"})
            break
        run, record = _solver_attempt(parts, stock, budget, safety_offset, cancel, progress)
        settings["attempts"].append(record)
        if run == "cancelled":
            return _cancelled(parts, settings, started, baseline_metrics)
        if run is not None and run.report.valid:
            solver_candidate = run
            break
        if run is None:
            # No usable solution (timeout without any, solver error); a safer
            # contour would not help, so fall back to the baseline.
            break

    progress(0.97, "select")
    if solver_candidate is not None and (
        best is None or _rank(solver_candidate, stock, by_instance) < _rank(best, stock, by_instance)
    ):
        best = solver_candidate
    if best is None:
        raise NestingError(
            "LAYOUT_INVALID",
            "no candidate layout passed independent validation",
            {"baseline_violations": [v.to_dict() for v in baseline.report.violations[:20]]},
        )

    metrics = layout_metrics(best.sheets, best.unplaced, parts, stock)
    status = "complete" if not best.unplaced else "incomplete"
    metrics["optimization_status"] = status
    metrics["runtime_s"] = time.monotonic() - started
    progress(1.0, "done")
    return NestOutcome(
        sheets=best.sheets,
        unplaced_instance_ids=list(best.unplaced),
        status=status,
        engine=best.engine,
        engine_version=solver_adapter.engine_version()
        if best.engine == solver_adapter.ENGINE_NAME
        else NESTING_VERSION,
        settings=settings,
        runtime_s=metrics["runtime_s"],
        metrics=metrics,
        baseline_metrics=baseline_metrics,
        validation=best.report,
    )


def _solver_attempt(parts, stock, budget, safety_offset, cancel, progress):
    """One solver run; returns (candidate | None | "cancelled", settings record)."""
    contours = [
        solver_adapter.collision_contour(
            p.geometry,
            tolerance_mm=solver_adapter.default_tolerance_mm(p.geometry),
            safety_offset_mm=safety_offset,
        )
        for p in parts
    ]
    instance = solver_adapter.build_instance(parts, stock, contours)
    # The solver's own limit excludes instance construction, so leave headroom
    # inside the hard wall-clock limit for preprocessing and process start-up.
    time_limit = max(0.5, budget * 0.8)
    run = solver_adapter.run_solver(
        instance,
        time_limit_s=time_limit,
        hard_timeout_s=budget,
        cancel=cancel,
        progress=lambda f: progress(0.05 + 0.9 * f, "solver"),
    )
    record = {
        **run.settings,
        "engine": solver_adapter.ENGINE_NAME,
        "engine_version": solver_adapter.engine_version(),
        "status": run.status,
        "runtime_s": run.runtime_s,
        "solutions_seen": run.solutions_seen,
        "safety_offset_mm": safety_offset,
        "collision_contours": [
            {
                "part_key": p.part_key,
                "line_id": p.line_id,
                "vertex_count": c.vertex_count,
                "original_vertex_count": c.original_vertex_count,
                "simplify_tolerance_mm": c.simplify_tolerance_mm,
                "offset_mm": c.offset_mm,
                "max_error_mm": c.max_error_mm,
            }
            for p, c in zip(parts, contours, strict=True)
        ],
    }
    if run.error:
        record["error"] = run.error[-2000:]
    if run.status == "cancelled":
        return "cancelled", record
    if run.certificate is None:
        return None, record
    try:
        raw = solver_adapter.decode_certificate(run.certificate, parts)
    except solver_adapter.CertificateError as exc:
        record["certificate_error"] = str(exc)
        return None, record
    sheets = _to_placements(raw, parts, stock)
    candidate = _candidate(solver_adapter.ENGINE_NAME, sheets, parts, stock)
    record["valid"] = candidate.report.valid
    record["sheet_count"] = len(candidate.sheets)
    record["unplaced"] = len(candidate.unplaced)
    if not candidate.report.valid:
        record["violations"] = [v.to_dict() for v in candidate.report.violations[:20]]
    return candidate, record


def _candidate(engine, sheets, parts, stock) -> _Candidate:
    report = validate_layout(parts, stock, sheets, allow_unplaced=True)
    return _Candidate(engine, sheets, list(report.unplaced_instance_ids), report)


def _rank(candidate: _Candidate, stock: StockSpec, by_instance) -> tuple[int, int, float]:
    last = _occupied_extent(candidate.sheets[-1], by_instance, stock) if candidate.sheets else 0.0
    return (len(candidate.unplaced), len(candidate.sheets), round(last, 6))


def _cancelled(parts, settings, started, baseline_metrics) -> NestOutcome:
    runtime = time.monotonic() - started
    return NestOutcome(
        sheets=[],
        unplaced_instance_ids=[i for p in parts for i in p.instance_ids],
        status="cancelled",
        engine=solver_adapter.ENGINE_NAME,
        engine_version=solver_adapter.engine_version(),
        settings=settings,
        runtime_s=runtime,
        metrics={"optimization_status": "cancelled", "runtime_s": runtime},
        baseline_metrics=baseline_metrics,
    )


def _validate_request(parts: Sequence[PartSpec], stock: StockSpec, time_budget_s: float) -> None:
    if not parts:
        raise NestingError("VALIDATION_ERROR", "a nesting group needs at least one part")
    numbers = {
        "width_mm": stock.width_mm,
        "height_mm": stock.height_mm,
        "margin_left": stock.margin_left,
        "margin_right": stock.margin_right,
        "margin_bottom": stock.margin_bottom,
        "margin_top": stock.margin_top,
        "gap_mm": stock.gap_mm,
    }
    for name, value in numbers.items():
        if not (value == value and value >= 0 and value != float("inf")):
            raise NestingError(
                "INVALID_DIMENSIONS", f"stock {name} must be a finite non-negative number", {name: value}
            )
    if stock.usable_width <= 0 or stock.usable_height <= 0:
        raise NestingError(
            "INVALID_DIMENSIONS", "sheet margins leave no usable area", {"usable_envelope": stock.usable_envelope()}
        )
    if stock.max_sheets < 1:
        raise NestingError("INVALID_DIMENSIONS", "max_sheets must be at least 1", {"max_sheets": stock.max_sheets})
    if not time_budget_s > 0:
        raise NestingError("VALIDATION_ERROR", "time_budget_s must be positive", {"time_budget_s": time_budget_s})
    seen: set[str] = set()
    for part in parts:
        geometry = as_multipolygon(part.geometry)
        if geometry.is_empty or not geometry.is_valid or geometry.area <= 0:
            raise NestingError("INVALID_CONTOURS", f"part {part.part_key} has invalid or empty geometry")
        min_x, min_y, _, _ = geometry.bounds
        if abs(min_x) > 1e-6 or abs(min_y) > 1e-6:
            raise NestingError(
                "INVALID_CONTOURS",
                f"part {part.part_key} geometry must have its bounding box at the origin",
                {"min_x": min_x, "min_y": min_y},
            )
        if not part.instance_ids:
            raise NestingError("VALIDATION_ERROR", f"part {part.part_key} has no instances")
        if not part.allowed_rotations or any(
            not isinstance(a, int) or not 0 <= a < 360 for a in part.allowed_rotations
        ):
            raise NestingError(
                "VALIDATION_ERROR",
                f"part {part.part_key} needs whole-degree rotations in [0, 360)",
                {"allowed_rotations": list(part.allowed_rotations)},
            )
        for instance_id in part.instance_ids:
            if instance_id in seen:
                raise NestingError("VALIDATION_ERROR", f"instance id {instance_id} is used twice")
            seen.add(instance_id)


def _to_placements(raw_sheets, parts: Sequence[PartSpec], stock: StockSpec) -> list[list[Placement]]:
    """Order sheets fullest-first and assign instance ids per part in sheet order."""
    by_part = {i: p for i, p in enumerate(parts)}

    def extent(sheet) -> float:
        return max((_raw_extent(r, by_part[r.part_index], stock) for r in sheet), default=0.0)

    ordered = sorted(
        (sorted(sheet, key=lambda r: (r.ty_mm, r.tx_mm, r.part_index)) for sheet in raw_sheets if sheet),
        key=lambda s: (-len(s), -extent(s)),
    )
    counters = [0] * len(parts)
    sheets: list[list[Placement]] = []
    for sheet in ordered:
        placements = []
        for r in sheet:
            part = parts[r.part_index]
            n = counters[r.part_index]
            counters[r.part_index] += 1
            if n >= len(part.instance_ids):
                # More copies than requested would be a solver contract breach;
                # surface it to validation as an unknown instance.
                instance_id = f"{part.line_id}#extra-{n:04d}"
            else:
                instance_id = part.instance_ids[n]
            placements.append(
                Placement(instance_id, part.part_key, part.line_id, part.product_id, r.rotation_deg, r.tx_mm, r.ty_mm)
            )
        sheets.append(placements)
    return sheets


def _raw_extent(r: solver_adapter.RawPlacement, part: PartSpec, stock: StockSpec) -> float:
    _, _, max_x, max_y = rotate_about_origin(part.geometry, r.rotation_deg).bounds
    return (max_y + r.ty_mm) if stock.long_axis == "y" else (max_x + r.tx_mm)


def _occupied_extent(sheet: Sequence[Placement], by_instance, stock: StockSpec) -> float:
    best = 0.0
    for p in sheet:
        part = by_instance.get(p.instance_id)
        if part is None:
            continue
        _, _, max_x, max_y = rotate_about_origin(part.geometry, p.rotation_deg).bounds
        best = max(best, (max_y + p.ty_mm) if stock.long_axis == "y" else (max_x + p.tx_mm))
    return best


def layout_metrics(
    sheets: Sequence[Sequence[Placement]], unplaced: Sequence[str], parts: Sequence[PartSpec], stock: StockSpec
) -> dict:
    by_instance = {i: p for p in parts for i in p.instance_ids}
    sheet_area = stock.width_mm * stock.height_mm
    per_sheet = []
    for index, sheet in enumerate(sheets):
        metal = sum(by_instance[p.instance_id].geometry.area for p in sheet if p.instance_id in by_instance)
        per_sheet.append(
            {
                "index": index,
                "placed": len(sheet),
                "metal_area_mm2": metal,
                "sheet_area_mm2": sheet_area,
                "unused_area_mm2": sheet_area - metal,
                "utilization": metal / sheet_area,
                "occupied_extent_mm": _occupied_extent(sheet, by_instance, stock),
            }
        )
    metal_total = sum(s["metal_area_mm2"] for s in per_sheet)
    sheet_total = sheet_area * len(per_sheet)
    requested = sum(len(p.instance_ids) for p in parts)
    return {
        "requested": requested,
        "placed": requested - len(unplaced),
        "unplaced": len(unplaced),
        "sheet_count": len(per_sheet),
        "metal_area_mm2": metal_total,
        "sheet_area_mm2": sheet_total,
        "unused_area_mm2": sheet_total - metal_total,
        "utilization": metal_total / sheet_total if sheet_total else 0.0,
        "occupied_extent_mm": per_sheet[-1]["occupied_extent_mm"] if per_sheet else 0.0,
        "extent_axis": stock.long_axis,
        "sheets": per_sheet,
        "formulas": {
            "utilization": "sum(nominal part area, holes excluded) / sum(full sheet area of used sheets)",
            "occupied_extent_mm": "max part coordinate along the sheet long axis on the last sheet, from the sheet origin",
            "unused_area_mm2": "sheet_area_mm2 - metal_area_mm2 (not claimed as reusable stock)",
        },
    }


def bbox_baseline(parts: Sequence[PartSpec], stock: StockSpec) -> tuple[list[list[Placement]], list[str]]:
    """Reference packer: first-fit-decreasing shelves over rotated bounding boxes.

    Shelves stack along the sheet's long axis and fill across the short axis,
    with ``gap`` between boxes, so any valid geometry layout follows from the
    boxes not overlapping. It is a fallback and comparison point, not the
    nesting feature.
    """
    long_is_y = stock.long_axis == "y"
    across = stock.usable_width if long_is_y else stock.usable_height
    along = stock.usable_height if long_is_y else stock.usable_width
    gap = stock.gap_mm
    eps = GEOMETRY_EPS_MM

    items = []
    for part in parts:
        options = []
        for rotation in part.allowed_rotations:
            min_x, min_y, max_x, max_y = rotate_about_origin(part.geometry, rotation).bounds
            w, h = max_x - min_x, max_y - min_y
            a, b = (w, h) if long_is_y else (h, w)  # (across-size, along-size)
            if a <= across + eps and b <= along + eps:
                options.append((rotation, a, b, min_x, min_y))
        for instance_id in part.instance_ids:
            items.append((part, instance_id, options))
    # Tallest-first by the smallest achievable shelf height, then stable by id.
    items.sort(key=lambda it: (-min(o[2] for o in it[2]), -max(o[1] for o in it[2]), it[1]))

    sheets: list[list[dict]] = []  # each shelf: {"pos", "height", "used"}
    placed: list[list[Placement]] = []
    unplaced: list[str] = []

    def place(sheet_i, shelf, option, part, instance_id):
        rotation, a, b, min_x, min_y = option
        u = shelf["used"]
        v = shelf["pos"]
        shelf["used"] = u + a + gap
        if long_is_y:
            tx = stock.usable_min_x + u - min_x
            ty = stock.usable_min_y + v - min_y
        else:
            tx = stock.usable_min_x + v - min_x
            ty = stock.usable_min_y + u - min_y
        placed[sheet_i].append(Placement(instance_id, part.part_key, part.line_id, part.product_id, rotation, tx, ty))

    for part, instance_id, options in items:
        done = False
        for sheet_i, shelves in enumerate(sheets):
            # Existing shelf: least wasted height among options that fit.
            best = None
            for shelf in shelves:
                for option in options:
                    if option[2] <= shelf["height"] + eps and shelf["used"] + option[1] <= across + eps:
                        waste = shelf["height"] - option[2]
                        if best is None or waste < best[0]:
                            best = (waste, shelf, option)
            if best is not None:
                place(sheet_i, best[1], best[2], part, instance_id)
                done = True
                break
            # New shelf on this sheet: lowest option height that fits the rest.
            top = shelves[-1]["pos"] + shelves[-1]["height"] + gap if shelves else 0.0
            fitting = [o for o in options if top + o[2] <= along + eps]
            if fitting:
                option = min(fitting, key=lambda o: (o[2], o[1]))
                shelf = {"pos": top, "height": option[2], "used": 0.0}
                shelves.append(shelf)
                place(sheet_i, shelf, option, part, instance_id)
                done = True
                break
        if done:
            continue
        if len(sheets) >= stock.max_sheets:
            unplaced.append(instance_id)
            continue
        option = min(options, key=lambda o: (o[2], o[1]))
        shelf = {"pos": 0.0, "height": option[2], "used": 0.0}
        sheets.append([shelf])
        placed.append([])
        place(len(sheets) - 1, shelf, option, part, instance_id)

    order = {i: n for p in parts for n, i in enumerate(p.instance_ids)}
    for sheet in placed:
        sheet.sort(key=lambda pl: (pl.ty_mm, pl.tx_mm, order[pl.instance_id]))
    return placed, unplaced
