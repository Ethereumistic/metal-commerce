"""PackingSolver irregular adapter.

The solver runs in a separate ``python -m`` child process so the service can enforce a hard
wall-clock limit and cancel it by killing the process (the native optimize call
cannot be interrupted from Python, and its own time limit excludes instance
construction). Every improving solution is written atomically to a work file,
so a killed run still yields its best certificate so far.

Solver input choices (see docs/nesting-and-export.md):
- objective ``bin-packing-with-leftovers``: every item must be placed; fewer bins
  first, then the last bin's extent along the sheet's long axis
  (``leftover_mode`` ``bottom`` for tall sheets, ``left`` for wide sheets);
- one rectangular bin type equal to the *usable* sheet area, offset by the left
  and bottom margins via the bin's ``x``/``y`` so the certificate is already in
  sheet coordinates and per-side margins need no item-bin spacing;
- ``item_item_minimum_spacing`` = gap; collision contours are not inflated by
  the gap (only by the outward approximation error);
- outer contours only: holes are never sent, so nothing is nested in a hole;
- discrete rotations, mirroring disabled.
"""

from __future__ import annotations

import importlib.metadata
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import traceback
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import shapely
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.polygon import orient

from .nesting_types import PartSpec, StockSpec, as_multipolygon, filled_shell

ENGINE_NAME = "packingsolver-irregular"
MAX_COLLISION_VERTICES = 300
_POLL_INTERVAL_S = 0.05


def engine_version() -> str:
    return importlib.metadata.version("packingsolver")


@dataclass(frozen=True)
class CollisionContour:
    """Conservative (outward-only) outline used for optimisation only."""

    polygons: tuple[Polygon, ...]
    simplify_tolerance_mm: float
    offset_mm: float
    max_error_mm: float
    vertex_count: int
    original_vertex_count: int


@dataclass
class SolverRun:
    status: str  # "ok" | "timeout" | "cancelled" | "error" | "no_solution"
    certificate: dict | None
    runtime_s: float
    solutions_seen: int
    error: str | None = None
    settings: dict = field(default_factory=dict)
    pid: int | None = None  # child process id, for diagnostics and tests


@dataclass(frozen=True)
class RawPlacement:
    part_index: int
    rotation_deg: int
    tx_mm: float
    ty_mm: float


class CertificateError(Exception):
    """The solver certificate cannot be mapped to contract placements."""


def collision_contour(
    geometry: MultiPolygon,
    *,
    tolerance_mm: float,
    safety_offset_mm: float = 0.0,
    max_vertices: int = MAX_COLLISION_VERTICES,
) -> CollisionContour:
    """Build an outer-contour approximation that always contains the original.

    The filled outline is buffered outward by ``2 * tol + safety`` and then
    simplified with Douglas-Peucker at ``tol``; the simplification moves the
    boundary by at most ``tol``, so the result stays outside the original. The
    containment is verified rather than assumed, and the tolerance doubles until
    the vertex budget is met (solver preprocessing cost grows quickly with
    vertex count).
    """
    shell = filled_shell(geometry)
    original_vertices = int(shapely.get_num_coordinates(shell))
    tol = tolerance_mm
    for _ in range(24):
        offset = 2.0 * tol + safety_offset_mm
        buffered = shell.buffer(offset, join_style="mitre", mitre_limit=2.0)
        simplified = shapely.simplify(buffered, tol, preserve_topology=True)
        polygons = tuple(orient(Polygon(p.exterior), 1.0) for p in as_multipolygon(simplified).geoms if not p.is_empty)
        candidate = shapely.union_all(polygons)
        vertex_count = sum(len(p.exterior.coords) - 1 for p in polygons)
        if candidate.covers(shell) and vertex_count <= max_vertices:
            error = float(shapely.hausdorff_distance(candidate.boundary, shell.boundary, densify=0.25))
            return CollisionContour(polygons, tol, offset, error, vertex_count, original_vertices)
        tol *= 2.0
    raise ValueError("could not build a bounded conservative collision contour")


def default_tolerance_mm(geometry: MultiPolygon) -> float:
    min_x, min_y, max_x, max_y = geometry.bounds
    return max(0.05, 0.0005 * max(max_x - min_x, max_y - min_y))


def leftover_mode(stock: StockSpec) -> str:
    return "bottom" if stock.long_axis == "y" else "left"


def build_instance(parts: Sequence[PartSpec], stock: StockSpec, contours: Sequence[CollisionContour]) -> dict[str, Any]:
    item_types = []
    for part, contour in zip(parts, contours, strict=True):
        item_types.append(
            {
                "shapes": [
                    {"type": "polygon", "vertices": [{"x": x, "y": y} for x, y in p.exterior.coords[:-1]]}
                    for p in contour.polygons
                ],
                "copies": len(part.instance_ids),
                "allowed_rotations": [
                    {"start": float(a), "end": float(a), "mirror": False} for a in part.allowed_rotations
                ],
            }
        )
    return {
        "objective": "bin-packing-with-leftovers",
        "parameters": {
            "item_item_minimum_spacing": stock.gap_mm,
            "leftover_mode": leftover_mode(stock),
        },
        "bin_types": [
            {
                "type": "rectangle",
                "x": stock.usable_min_x,
                "y": stock.usable_min_y,
                "width": stock.usable_width,
                "height": stock.usable_height,
                "copies": stock.max_sheets,
            }
        ],
        "item_types": item_types,
    }


def run_solver(
    instance: dict[str, Any],
    *,
    time_limit_s: float,
    hard_timeout_s: float,
    cancel: Callable[[], bool],
    progress: Callable[[float], None] | None = None,
) -> SolverRun:
    """Run the solver in a killable child process and return its best certificate."""
    settings = {
        "time_limit_s": time_limit_s,
        "hard_timeout_s": hard_timeout_s,
        "objective": instance["objective"],
        "parameters": dict(instance["parameters"]),
        "process": "subprocess python -m artwork_service.solver_adapter",
    }
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="packingsolver-") as workdir:
        work = Path(workdir)
        (work / "instance.json").write_text(json.dumps(instance))
        with open(work / "child.log", "wb") as log:
            proc = subprocess.Popen(
                [sys.executable, "-m", __name__, workdir, repr(time_limit_s)],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        outcome = "ok"
        try:
            while True:
                try:
                    proc.wait(_POLL_INTERVAL_S)
                    break
                except subprocess.TimeoutExpired:
                    pass
                elapsed = time.monotonic() - started
                if cancel():
                    outcome = "cancelled"
                    break
                if elapsed >= hard_timeout_s:
                    outcome = "timeout"
                    break
                if progress is not None:
                    progress(min(1.0, elapsed / hard_timeout_s))
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        runtime = time.monotonic() - started
        solutions_seen = _read_count(work)
        if outcome == "cancelled":
            return SolverRun("cancelled", None, runtime, solutions_seen, settings=settings, pid=proc.pid)

        final = _read_json(work / "final.json")
        best = final if final is not None else _read_json(work / "best.json")
        if outcome == "ok" and proc.returncode != 0:
            error = _read_text(work / "error.txt") or _read_text(work / "child.log")
            return SolverRun(
                "error",
                best,
                runtime,
                solutions_seen,
                error or f"solver exited with code {proc.returncode}",
                settings,
                proc.pid,
            )
        if best is None or not best.get("bins"):
            status = "no_solution" if outcome == "ok" else outcome
            return SolverRun(status, None, runtime, solutions_seen, settings=settings, pid=proc.pid)
        return SolverRun(outcome, best, runtime, solutions_seen, settings=settings, pid=proc.pid)


def decode_certificate(certificate: dict, parts: Sequence[PartSpec]) -> list[list[RawPlacement]]:
    """Map certificate bins to physical sheets.

    A certificate bin with ``copies: n`` is one layout cut on n identical sheets;
    it is expanded into n separate sheets. The certificate transform is
    ``mirror -> rotate about origin -> translate``; with mirroring disabled this
    is exactly the contract placement, so ``x``/``y`` become ``tx``/``ty``.
    """
    sheets: list[list[RawPlacement]] = []
    for bin_ in certificate.get("bins") or []:
        layout = []
        for item in bin_.get("items") or []:
            index = int(item["id"])
            if not 0 <= index < len(parts):
                raise CertificateError(f"certificate references unknown item type {index}")
            if item.get("mirror"):
                raise CertificateError("certificate contains a mirrored item; mirroring is disabled")
            angle = float(item["angle"])
            if not math.isclose(angle, round(angle), abs_tol=1e-6):
                raise CertificateError(f"certificate angle {angle} is not a whole degree")
            rotation = int(round(angle)) % 360
            layout.append(RawPlacement(index, rotation, float(item["x"]), float(item["y"])))
        copies = int(bin_.get("copies", 1))
        if copies < 1:
            raise CertificateError(f"certificate bin has invalid copies {copies}")
        sheets.extend(list(layout) for _ in range(copies))
    return sheets


def _child_main(workdir: str, time_limit_s: float) -> None:
    """Child entry point (``python -m``): solve and write certificates into ``workdir``."""
    import io

    work = Path(workdir)
    try:
        import packingsolver.irregular as psi

        builder = psi.InstanceBuilder()
        builder.read(io.StringIO((work / "instance.json").read_text()))
        instance = builder.build()
        params = psi.OptimizeParameters()
        params.time_limit = time_limit_s
        params.verbosity_level = 0
        params.messages_to_stdout = False
        count = [0]

        def on_solution(output) -> None:
            count[0] += 1
            _write_certificate(work / "best.json", output.solution)
            _atomic_write(work / "count.txt", str(count[0]))

        params.new_solution_callback = on_solution
        output = psi.optimize(instance, params)
        _write_certificate(work / "final.json", output.solution)
    except BaseException:
        _atomic_write(work / "error.txt", traceback.format_exc())
        raise


def _write_certificate(path: Path, solution) -> None:
    import io

    stream = io.StringIO()
    solution.write(stream)
    _atomic_write(path, stream.getvalue())


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(errors="replace") or None
    except FileNotFoundError:
        return None


def _read_count(work: Path) -> int:
    try:
        return int((work / "count.txt").read_text())
    except (FileNotFoundError, ValueError):
        return 0


if __name__ == "__main__":
    _child_main(sys.argv[1], float(sys.argv[2]))
