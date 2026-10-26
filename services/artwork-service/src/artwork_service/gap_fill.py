"""Gap filling: move parts of a valid layout into free space between other parts.

The irregular solver minimises the sheet count and then the last sheet's
extent; it has no reason to tuck small parts into the pockets between large
ones, and the bounding-box fallback cannot. This pass takes a valid layout and
repeatedly moves single parts to the lowest free position (along the sheet's
long axis) on an earlier sheet, or lower on their own sheet:

- parts on the last sheet may go anywhere on earlier sheets (that is what can
  save the sheet or shorten it);
- every other move stays inside the target sheet's occupied box (from the
  usable origin to the farthest part on both axes), so the remnant strip and a
  free side column are never used up;
- parts on the last sheet go first, then small parts, then the rest; later
  sheets and farther parts first within each group.

Only filled outer contours are used, so nothing is ever placed inside a hole.

Free positions are found on a raster: each sheet's obstacles (filled outlines
grown by the gap) and each part (per rotation) are rasterised with a margin,
and one correlation (``cv2.filter2D``) gives every grid translation at which
the part's cells avoid all obstacle cells. Candidates found this way are then
checked exactly with Shapely (usable bounds, shell-to-shell distance >= gap),
and the caller re-validates the finished layout with ``validate_layout``, so
the raster only proposes positions and never decides validity.

Every accepted move lowers the moved part's (sheet index, far coordinate), so
the pass terminates; it also stops at the deadline or on cancellation.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import cv2
import numpy as np
import shapely
from shapely import affinity

from .nesting_types import PartSpec, Placement, StockSpec, filled_shell, rotate_about_origin

# Raster cell size: at least this many millimetres, and coarse enough that the
# sheet's long side has at most _MAX_CELLS cells (bounds the cost per search).
_MIN_CELL_MM = 2.5
_MAX_CELLS = 1200
# Exactly checked candidate positions per (part, sheet, rotation) before giving up.
_CANDIDATES_PER_ROTATION = 6
# Parts whose filled area is at most this share of the group's largest part are
# "small" and are offered the gaps before larger parts.
_SMALL_SHARE = 0.25
# Extra clearance on the exact check so accepted positions never sit on the
# validator's tolerance.
_SAFETY_MM = 1e-3


@dataclass
class FillResult:
    sheets: list[list[Placement]]
    moves: int
    searches: int
    runtime_s: float
    stopped: str  # "converged" | "deadline" | "cancelled"
    cell_mm: float


@dataclass(eq=False)
class _Shape:
    """One part at one rotation, in a frame with its bounding box at the origin."""

    offset: tuple[float, float]  # rotated geometry min x / min y (tx = grid x - offset x)
    width: float
    height: float
    shell: shapely.Geometry  # filled outline in the normalised frame
    kernel: np.ndarray  # float32 raster of the outline grown by the margin
    pad: int  # kernel cells below/left of the origin
    obstacle_rings: list[np.ndarray]  # outline grown by gap + margin, normalised frame
    inradius_cells: float


@dataclass(eq=False)  # identity: entries are moved between sheet lists
class _Entry:
    placement: Placement
    part: PartSpec
    shape: _Shape
    shell: shapely.Geometry  # world filled outline
    far: float  # farthest coordinate along the long axis
    cross: float  # farthest coordinate across it

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return self.shell.bounds


class _Filler:
    def __init__(self, parts: Sequence[PartSpec], stock: StockSpec):
        self.stock = stock
        self.long_y = stock.long_axis == "y"
        self.cell = max(_MIN_CELL_MM, max(stock.width_mm, stock.height_mm) / _MAX_CELLS)
        self.margin = 0.75 * self.cell  # > half a cell diagonal (0.707 cells)
        self.rows = math.ceil(stock.height_mm / self.cell)
        self.cols = math.ceil(stock.width_mm / self.cell)
        self.by_instance = {i: p for p in parts for i in p.instance_ids}
        self._shapes: dict[tuple[int, int], _Shape] = {}
        self._rotations: dict[int, tuple[int, ...]] = {}

    # -- geometry caches

    def shape(self, part: PartSpec, rotation: int) -> _Shape:
        key = (id(part), rotation)
        cached = self._shapes.get(key)
        if cached is not None:
            return cached
        rotated = filled_shell(rotate_about_origin(part.geometry, rotation))
        min_x, min_y, max_x, max_y = rotated.bounds
        shell = affinity.translate(rotated, -min_x, -min_y)
        # Simplify for rasterising only; growing by the simplification tolerance
        # keeps the raster outline outside the true one.
        tol = self.cell / 4.0
        coarse = shapely.simplify(shell, tol, preserve_topology=True)
        grown = coarse.buffer(self.margin + tol, join_style="mitre", mitre_limit=2.0)
        pad = math.ceil((self.margin + tol) / self.cell)
        width, height = max_x - min_x, max_y - min_y
        kernel = np.zeros(
            (math.ceil(height / self.cell) + 2 * pad + 1, math.ceil(width / self.cell) + 2 * pad + 1), np.uint8
        )
        _fill(kernel, _rings(grown), self.cell, (pad, pad))
        inradius = float(cv2.distanceTransform(np.pad(kernel, 1), cv2.DIST_L2, 5).max())
        obstacle = coarse.buffer(self.stock.gap_mm + self.margin + tol, join_style="mitre", mitre_limit=2.0)
        shape = _Shape(
            (min_x, min_y), width, height, shell, kernel.astype(np.float32), pad, _rings(obstacle), inradius
        )
        self._shapes[key] = shape
        return shape

    def rotations(self, part: PartSpec) -> tuple[int, ...]:
        """Allowed rotations, dropping those whose raster equals an earlier one's
        (symmetric parts): they would give the same candidate positions."""
        cached = self._rotations.get(id(part))
        if cached is None:
            seen: set[tuple] = set()
            kept = []
            for rotation in part.allowed_rotations:
                shape = self.shape(part, rotation)
                signature = (shape.kernel.shape, shape.kernel.tobytes(), round(shape.width, 3), round(shape.height, 3))
                if signature not in seen:
                    seen.add(signature)
                    kept.append(rotation)
            cached = self._rotations[id(part)] = tuple(kept)
        return cached

    def entry(self, placement: Placement) -> _Entry:
        part = self.by_instance[placement.instance_id]
        shape = self.shape(part, placement.rotation_deg)
        x0, y0 = placement.tx_mm + shape.offset[0], placement.ty_mm + shape.offset[1]
        shell = affinity.translate(shape.shell, x0, y0)
        return _Entry(placement, part, shape, shell, *self.reach(shape, x0, y0))

    def reach(self, shape: _Shape, x0: float, y0: float) -> tuple[float, float]:
        """(far, cross) coordinates of a shape whose bounding box starts at (x0, y0)."""
        if self.long_y:
            return y0 + shape.height, x0 + shape.width
        return x0 + shape.width, y0 + shape.height

    # -- raster search

    def obstacles(self, entries: Sequence[_Entry]) -> np.ndarray:
        mask = np.zeros((self.rows, self.cols), np.uint8)
        for e in entries:
            x0 = e.placement.tx_mm + e.shape.offset[0]
            y0 = e.placement.ty_mm + e.shape.offset[1]
            _fill(mask, [r + (x0, y0) for r in e.shape.obstacle_rings], self.cell, (0, 0))
        return mask

    def free_depth(self, mask: np.ndarray) -> float:
        """Largest distance (cells) from a free usable cell to any obstacle or the usable edge."""
        free = (mask == 0).astype(np.uint8)
        s = self.stock
        free[: max(0, math.ceil(s.usable_min_y / self.cell)), :] = 0
        free[min(self.rows, math.floor(s.usable_max_y / self.cell)) :, :] = 0
        free[:, : max(0, math.ceil(s.usable_min_x / self.cell))] = 0
        free[:, min(self.cols, math.floor(s.usable_max_x / self.cell)) :] = 0
        return float(cv2.distanceTransform(np.pad(free, 1), cv2.DIST_L2, 5).max())

    def candidates(self, mask: np.ndarray, shape: _Shape, limit: tuple[float, float]) -> list[tuple[float, float, int, int]]:
        """Grid positions (far, cross, i, j) whose raster is clear and whose far and
        cross coordinates stay within ``limit``, lowest first."""
        far_limit, cross_limit = limit
        x_limit, y_limit = (cross_limit, far_limit) if self.long_y else (far_limit, cross_limit)
        s, c, eps = self.stock, self.cell, 1e-9
        j_lo = math.ceil(s.usable_min_x / c - eps)
        j_hi = math.floor((min(s.usable_max_x, x_limit) - shape.width) / c + eps)
        i_lo = math.ceil(s.usable_min_y / c - eps)
        i_hi = math.floor((min(s.usable_max_y, y_limit) - shape.height) / c + eps)
        if i_hi < i_lo or j_hi < j_lo:
            return []
        # Only the window the kernel can reach matters; crop before correlating.
        k_rows, k_cols = shape.kernel.shape
        r0, r1 = max(0, i_lo - shape.pad), min(self.rows, i_hi - shape.pad + k_rows)
        c0, c1 = max(0, j_lo - shape.pad), min(self.cols, j_hi - shape.pad + k_cols)
        window = mask[r0:r1, c0:c1].astype(np.float32)
        hits = cv2.filter2D(window, cv2.CV_32F, shape.kernel, anchor=(shape.pad, shape.pad),
                            borderType=cv2.BORDER_CONSTANT)
        clear = hits[i_lo - r0 : i_hi - r0 + 1, j_lo - c0 : j_hi - c0 + 1] < 0.5
        cells = np.argwhere(clear if self.long_y else clear.T)[:_CANDIDATES_PER_ROTATION]
        out = []
        for a, b in cells.tolist():
            i, j = (a, b) if self.long_y else (b, a)
            i, j = i + i_lo, j + j_lo
            far, cross = self.reach(shape, j * c, i * c)
            out.append((far, cross, i, j))
        return out

    def fits(self, shell, others: Sequence[_Entry]) -> bool:
        """Exact check: shell-to-shell distance to every other part keeps the gap."""
        if not others:
            return True
        reach = self.stock.gap_mm + _SAFETY_MM
        min_x, min_y, max_x, max_y = shell.bounds
        bounds = np.array([o.bounds for o in others])
        near = (
            (bounds[:, 0] < max_x + reach)
            & (bounds[:, 2] > min_x - reach)
            & (bounds[:, 1] < max_y + reach)
            & (bounds[:, 3] > min_y - reach)
        )
        if not near.any():
            return True
        shells = np.array([o.shell for o, n in zip(others, near, strict=True) if n], dtype=object)
        return bool(shapely.distance(shell, shells).min() >= reach)


def fill_gaps(
    parts: Sequence[PartSpec],
    stock: StockSpec,
    sheets: Sequence[Sequence[Placement]],
    *,
    deadline: float,
    cancel: Callable[[], bool],
) -> FillResult:
    """Move parts into free space on earlier sheets or lower on their own sheet.

    ``sheets`` must be a valid layout whose last sheet is the remnant sheet;
    sheets keep their order and only empty sheets are dropped. Every placement
    keeps its instance id. Each pass visits parts in priority order: parts on
    the last sheet (they decide the sheet count and the last sheet's extent),
    then small parts (they fit the gaps), then the rest; within a group, later
    sheets and farther parts first. The caller must re-validate the result.
    """
    started = time.monotonic()
    filler = _Filler(parts, stock)
    layout = [[filler.entry(p) for p in sheet] for sheet in sheets]
    largest = max(e.shell.area for sheet in layout for e in sheet) if any(layout) else 0.0
    moves = 0
    searches = 0
    stopped = "converged"
    masks: dict[int, np.ndarray] = {}
    depths: dict[int, float] = {}
    # Per sheet: (part, rotation, limit) combinations already found full, and
    # parts that already failed to move lower; both valid until the sheet changes.
    full: dict[int, set[tuple]] = {}
    settled: dict[int, set[str]] = {}

    def invalidate(index: int) -> None:
        masks.pop(index, None)
        depths.pop(index, None)
        full.pop(index, None)
        settled.pop(index, None)

    def box(index: int) -> tuple[float, float]:
        """(far, cross) extent of the parts on a sheet: the occupied box."""
        sheet = layout[index]
        return max((e.far for e in sheet), default=0.0), max((e.cross for e in sheet), default=0.0)

    def try_move(entry: _Entry, k: int, last: int) -> bool:
        nonlocal moves, searches
        for target in range(k + 1):
            if target < k:
                # Parts may leave the last sheet for any free space; other parts
                # only fill gaps inside the target sheet's occupied box, so the
                # remnant strip and side column stay free.
                limit = usable_box if k == last else box(target)
                others = layout[target]
                if target not in masks:
                    masks[target] = filler.obstacles(others)
                    depths[target] = filler.free_depth(masks[target])
                mask, depth, known_full = masks[target], depths[target], full.setdefault(target, set())
            else:
                if entry.placement.instance_id in settled.get(k, ()):
                    return False
                # Strictly lower; off the last sheet also inside the occupied box,
                # so a part never slides sideways into a free side column.
                limit = (entry.far - filler.cell / 2.0, usable_box[1] if k == last else box(k)[1])
                others = [e for e in layout[k] if e is not entry]
                mask, depth, known_full = filler.obstacles(others), None, None
            searches += 1
            position = _search(filler, entry, others, mask, depth, limit, known_full)
            if position is None:
                if target == k:
                    settled.setdefault(k, set()).add(entry.placement.instance_id)
                continue
            layout[k].remove(entry)
            layout[target].append(position)
            invalidate(k)
            invalidate(target)
            moves += 1
            return True
        return False

    usable_box = (
        (stock.usable_max_y, stock.usable_max_x) if filler.long_y else (stock.usable_max_x, stock.usable_max_y)
    )
    improved = True
    while improved:
        improved = False
        last = max((i for i, s in enumerate(layout) if s), default=-1)

        def priority(item: tuple[int, _Entry], last: int = last) -> tuple[int, int, float]:
            k, e = item
            group = 0 if k == last else 1 if e.shell.area <= _SMALL_SHARE * largest else 2
            return (group, -k, -e.far)

        queue = sorted(((k, e) for k, sheet in enumerate(layout) for e in sheet), key=priority)
        for k, entry in queue:
            if cancel():
                stopped = "cancelled"
                break
            if time.monotonic() >= deadline:
                stopped = "deadline"
                break
            if entry in layout[k] and try_move(entry, k, last):
                improved = True
        if stopped != "converged":
            break

    out = [[e.placement for e in sheet] for sheet in layout if sheet]
    return FillResult(out, moves, searches, time.monotonic() - started, stopped, filler.cell)


def _search(filler: _Filler, entry: _Entry, others, mask, depth, limit, full) -> _Entry | None:
    """Best exactly-checked position for ``entry`` below ``limit`` on one sheet, or None."""
    best: tuple[float, float, _Entry] | None = None
    for rotation in filler.rotations(entry.part):
        shape = filler.shape(entry.part, rotation)
        key = (id(entry.part), rotation, tuple(round(v, 6) for v in limit))
        if full is not None and key in full:
            continue
        if depth is not None and shape.inradius_cells > depth + 1.5:
            full.add(key)
            continue
        found = False
        for far, cross, i, j in filler.candidates(mask, shape, limit):
            if best is not None and (far, cross) >= best[:2]:
                break
            x0, y0 = j * filler.cell, i * filler.cell
            shell = affinity.translate(shape.shell, x0, y0)
            if not filler.fits(shell, others):
                continue
            p = entry.placement
            placement = Placement(
                p.instance_id, p.part_key, p.line_id, p.product_id, rotation,
                x0 - shape.offset[0], y0 - shape.offset[1],
            )
            best = (far, cross, _Entry(placement, entry.part, shape, shell, far, cross))
            found = True
            break
        if not found and full is not None and best is None:
            full.add(key)
    return best[2] if best is not None else None


def _rings(geometry) -> list[np.ndarray]:
    polygons = getattr(geometry, "geoms", [geometry])
    return [np.asarray(p.exterior.coords)[:-1] for p in polygons if not p.is_empty]


def _fill(raster: np.ndarray, rings: Sequence[np.ndarray], cell: float, origin_cells: tuple[int, int]) -> None:
    """Mark every cell whose centre lies inside one of ``rings`` (mm, cell (0, 0) at ``origin_cells``)."""
    shift = 4
    scale = float(1 << shift)
    pts = [
        np.round(((r / cell) - 0.5 + np.asarray(origin_cells)) * scale).astype(np.int32)
        for r in rings
        if len(r) >= 3
    ]
    if pts:
        cv2.fillPoly(raster, pts, 1, cv2.LINE_8, shift)
