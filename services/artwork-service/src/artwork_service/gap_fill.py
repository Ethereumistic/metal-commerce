"""Gap filling: move parts of a valid layout into free space between other parts.

The irregular solver minimises the sheet count and then the last sheet's
extent; it has no reason to tuck small parts into the pockets between large
ones, and the bounding-box fallback cannot. This pass takes a valid layout and
improves it in two phases.

**Filler placement.** When the group has a clear tier of small parts
("fillers", see ``filler_parts``), all of them are lifted off the layout and
placed again one by one, largest first, into the free space among the other
parts: the earliest sheet that has room for the filler *inside its occupied
box* (from the usable origin to the farthest part on both axes) wins, and on
that sheet the position with the most contact with neighbouring parts (the
tightest pocket) is chosen. Only when no occupied box has room does a filler
go to the lowest free position anywhere (earliest sheet first), and failing
that back where it was. A solver layout tends to put small parts together in
a strip of their own; this phase puts them between the large parts instead,
so that strip is freed for the compaction below.

**Compaction.** Single parts repeatedly move to the lowest free position
(along the sheet's long axis) on an earlier sheet, or lower on their own sheet:

- parts on the last sheet may go anywhere on earlier sheets (that is what can
  save the sheet or shorten it);
- every other move stays inside the target sheet's occupied box, so the
  remnant strip and a free side column are never used up;
- parts on the last sheet go first, then small parts, then the rest; later
  sheets and farther parts first within each group;
- fillers placed by the first phase stay where they are (moving them to the
  lowest position would pull them back into a strip of their own).

Only filled outer contours are used, so nothing is ever placed inside a hole.

Free positions are found on a raster: each sheet's obstacles (filled outlines
grown by the gap) and each part (per rotation) are rasterised with a margin,
and one correlation (``cv2.filter2D``) gives every grid translation at which
the part's cells avoid all obstacle cells; a second correlation with a band
around the part counts the obstacle cells next to it (its contact). Candidates
found this way are then checked exactly with Shapely (usable bounds,
shell-to-shell distance >= gap), and the caller re-validates the finished
layout with ``validate_layout``, so the raster only proposes positions and
never decides validity.

Every accepted compaction move lowers the moved part's (sheet index, far
coordinate), so the pass terminates; it also stops at the deadline or on
cancellation. The filler phase places each filler once; if it is interrupted,
the layout it started from is used unchanged.
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
# Fillers: the part sizes below the first jump of at least this factor in filled
# area (smallest parts first), e.g. 70-100 mm parts next to 300 mm parts.
_FILLER_AREA_JUMP = 4.0
# ... and only while all fillers together cover at most this share of the
# other parts' filled area: the free space among parts is a fraction of their
# area, and placing a whole tier of mid-size parts by contact spreads them out.
_FILLER_TOTAL_SHARE = 0.1
# Width of the band around a part whose obstacle cells count as its contact.
_CONTACT_MM = 10.0
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
    # Filler phase: "applied", "none" (no filler tier, or skipped by the caller)
    # or "abandoned: <reason>" (the layout it started from was kept).
    filler_phase: str = "none"
    fillers: int = 0  # filler parts placed by the filler phase
    fillers_tucked: int = 0  # of those, placed inside a sheet's occupied box


@dataclass(eq=False)
class _Shape:
    """One part at one rotation, in a frame with its bounding box at the origin."""

    offset: tuple[float, float]  # rotated geometry min x / min y (tx = grid x - offset x)
    width: float
    height: float
    shell: shapely.Geometry  # filled outline in the normalised frame
    kernel: np.ndarray  # float32 raster of the outline grown by the margin
    pad: int  # kernel cells below/left of the origin
    band: np.ndarray  # float32 raster of the _CONTACT_MM band around the kernel
    band_pad: int  # band cells below/left of the origin
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


def filler_parts(parts: Sequence[PartSpec]) -> list[PartSpec]:
    """The group's filler tier: the smallest parts, up to a jump of at least
    ``_FILLER_AREA_JUMP`` times in filled area to the next part size, whose copies
    together cover at most ``_FILLER_TOTAL_SHARE`` of the other parts' area (only
    then can the gaps among those parts take them). The largest such tier wins;
    empty when there is none, e.g. when all parts are of similar size."""
    areas = {id(p): filled_shell(p.geometry).area for p in parts}
    by_area = sorted(parts, key=lambda p: areas[id(p)])
    for n in range(len(by_area) - 2, -1, -1):
        if areas[id(by_area[n + 1])] >= _FILLER_AREA_JUMP * areas[id(by_area[n])]:
            small = sum(areas[id(p)] * len(p.instance_ids) for p in by_area[: n + 1])
            rest = sum(areas[id(p)] * len(p.instance_ids) for p in by_area[n + 1 :])
            if small <= _FILLER_TOTAL_SHARE * rest:
                return by_area[: n + 1]
    return []


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
        reach = max(1, math.ceil(_CONTACT_MM / self.cell))
        padded = np.pad(kernel, reach)
        disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1))
        band = cv2.dilate(padded, disk) - padded
        obstacle = coarse.buffer(self.stock.gap_mm + self.margin + tol, join_style="mitre", mitre_limit=2.0)
        shape = _Shape(
            (min_x, min_y), width, height, shell, kernel.astype(np.float32), pad, band.astype(np.float32),
            pad + reach, _rings(obstacle), inradius,
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

    def _grid(self, shape: _Shape, limit: tuple[float, float]) -> tuple[int, int, int, int] | None:
        """Grid index ranges (i_lo, i_hi, j_lo, j_hi) that keep the shape inside the
        usable area and its far and cross coordinates within ``limit``."""
        far_limit, cross_limit = limit
        x_limit, y_limit = (cross_limit, far_limit) if self.long_y else (far_limit, cross_limit)
        s, c, eps = self.stock, self.cell, 1e-9
        j_lo = math.ceil(s.usable_min_x / c - eps)
        j_hi = math.floor((min(s.usable_max_x, x_limit) - shape.width) / c + eps)
        i_lo = math.ceil(s.usable_min_y / c - eps)
        i_hi = math.floor((min(s.usable_max_y, y_limit) - shape.height) / c + eps)
        if i_hi < i_lo or j_hi < j_lo:
            return None
        return i_lo, i_hi, j_lo, j_hi

    def _correlate(self, mask: np.ndarray, kernel: np.ndarray, pad: int, grid: tuple[int, int, int, int]) -> np.ndarray:
        """Obstacle cells under ``kernel`` (anchored at ``pad``) for every grid
        position in ``grid``; only the window the kernel can reach is correlated."""
        i_lo, i_hi, j_lo, j_hi = grid
        k_rows, k_cols = kernel.shape
        r0, r1 = max(0, i_lo - pad), min(self.rows, i_hi - pad + k_rows)
        c0, c1 = max(0, j_lo - pad), min(self.cols, j_hi - pad + k_cols)
        window = mask[r0:r1, c0:c1].astype(np.float32)
        hits = cv2.filter2D(window, cv2.CV_32F, kernel, anchor=(pad, pad), borderType=cv2.BORDER_CONSTANT)
        return hits[i_lo - r0 : i_hi - r0 + 1, j_lo - c0 : j_hi - c0 + 1]

    def candidates(self, mask: np.ndarray, shape: _Shape, limit: tuple[float, float]) -> list[tuple[float, float, int, int]]:
        """Grid positions (far, cross, i, j) whose raster is clear and whose far and
        cross coordinates stay within ``limit``, lowest first."""
        grid = self._grid(shape, limit)
        if grid is None:
            return []
        clear = self._correlate(mask, shape.kernel, shape.pad, grid) < 0.5
        cells = np.argwhere(clear if self.long_y else clear.T)[:_CANDIDATES_PER_ROTATION]
        out = []
        for a, b in cells.tolist():
            i, j = (a, b) if self.long_y else (b, a)
            out.append(self._position(shape, i + grid[0], j + grid[2]))
        return out

    def tight_candidates(
        self, mask: np.ndarray, anchors: np.ndarray, shape: _Shape, limit: tuple[float, float]
    ) -> list[tuple[float, float, float, int, int]]:
        """Clear grid positions within ``limit`` with the most contact (cells of
        ``anchors`` in the band around the shape) first, then lowest first, as
        (contact, far, cross, i, j)."""
        grid = self._grid(shape, limit)
        if grid is None:
            return []
        clear = self._correlate(mask, shape.kernel, shape.pad, grid) < 0.5
        if not clear.any():
            return []
        contact = self._correlate(anchors, shape.band, shape.band_pad, grid)
        rows, cols = np.nonzero(clear)
        touch = contact[rows, cols]
        # Lowest along the long axis breaks contact ties (lexsort: last key first).
        far_index, cross_index = (rows, cols) if self.long_y else (cols, rows)
        order = np.lexsort((cross_index, far_index, -touch))[:_CANDIDATES_PER_ROTATION]
        out = []
        for n in order.tolist():
            far, cross, i, j = self._position(shape, int(rows[n]) + grid[0], int(cols[n]) + grid[2])
            out.append((float(touch[n]), far, cross, i, j))
        return out

    def _position(self, shape: _Shape, i: int, j: int) -> tuple[float, float, int, int]:
        far, cross = self.reach(shape, j * self.cell, i * self.cell)
        return far, cross, i, j

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

    def moved(self, entry: _Entry, shape: _Shape, rotation: int, i: int, j: int) -> tuple[_Entry, shapely.Geometry]:
        """``entry`` at grid position (i, j) and ``rotation``, and its world outline."""
        x0, y0 = j * self.cell, i * self.cell
        shell = affinity.translate(shape.shell, x0, y0)
        p = entry.placement
        placement = Placement(
            p.instance_id, p.part_key, p.line_id, p.product_id, rotation, x0 - shape.offset[0], y0 - shape.offset[1]
        )
        return _Entry(placement, entry.part, shape, shell, *self.reach(shape, x0, y0)), shell


class _Layout:
    """Sheets of entries plus per-sheet search caches, valid until a sheet changes."""

    def __init__(self, filler: _Filler, sheets: Sequence[Sequence[Placement]]):
        self.filler = filler
        self.sheets = [[filler.entry(p) for p in sheet] for sheet in sheets]
        s = filler.stock
        self.usable_box = (s.usable_max_y, s.usable_max_x) if filler.long_y else (s.usable_max_x, s.usable_max_y)
        self.moves = 0
        self.searches = 0
        self._masks: dict[int, np.ndarray] = {}
        self._depths: dict[int, float] = {}
        # Per sheet: (part, rotation, limit) combinations already found full, and
        # parts that already failed to move lower.
        self._full: dict[int, set[tuple]] = {}
        self._settled: dict[int, set[str]] = {}

    def placements(self) -> list[list[Placement]]:
        return [[e.placement for e in sheet] for sheet in self.sheets if sheet]

    def invalidate(self, index: int) -> None:
        for cache in (self._masks, self._depths, self._full, self._settled):
            cache.pop(index, None)

    def box(self, index: int) -> tuple[float, float]:
        """(far, cross) extent of the parts on a sheet: the occupied box."""
        sheet = self.sheets[index]
        return max((e.far for e in sheet), default=0.0), max((e.cross for e in sheet), default=0.0)

    def last(self) -> int:
        return max((i for i, s in enumerate(self.sheets) if s), default=-1)

    def cached(self, index: int) -> tuple[np.ndarray, float, set[tuple]]:
        if index not in self._masks:
            self._masks[index] = self.filler.obstacles(self.sheets[index])
            self._depths[index] = self.filler.free_depth(self._masks[index])
        return self._masks[index], self._depths[index], self._full.setdefault(index, set())

    def put(self, entry: _Entry, index: int) -> None:
        self.sheets[index].append(entry)
        self.invalidate(index)

    def take(self, entry: _Entry, index: int) -> None:
        self.sheets[index].remove(entry)
        self.invalidate(index)

    # -- filler phase

    def place_fillers(
        self, fillers: Sequence[PartSpec], settle_by: float, deadline: float, cancel: Callable[[], bool]
    ) -> tuple[str, int, int]:
        """Lift every filler, compact the other parts until ``settle_by`` and place
        the fillers again (see the module docstring).

        Returns (stopped, placed, tucked); on anything but "converged" the
        layout is incomplete and must be discarded by the caller.
        """
        wanted = {id(p) for p in fillers}
        lifted = []
        for k, sheet in enumerate(self.sheets):
            for e in [e for e in sheet if id(e.part) in wanted]:
                self.take(e, k)
                lifted.append((k, e))
        lifted.sort(key=lambda item: (-item[1].shell.area, item[1].placement.instance_id))
        settled = self.compact(settle_by, cancel, frozen=set())
        if settled == "cancelled":
            return settled, 0, 0
        # Contact counts the parts that stay (not other fillers), so fillers seek
        # the pockets between large parts instead of clustering with each other.
        anchors = [self.filler.obstacles(sheet) for sheet in self.sheets]
        placed = tucked = 0
        for home, entry in lifted:
            if cancel():
                return "cancelled", placed, tucked
            if time.monotonic() >= deadline:
                return "deadline", placed, tucked
            spot, inside = self._tuck(entry, home, anchors)
            if spot is None:
                return "no position", placed, tucked
            target, moved = spot
            self.put(moved, target)
            placed += 1
            tucked += inside
            if (target, moved.placement) != (home, entry.placement):
                self.moves += 1
        return "converged", placed, tucked

    def _tuck(self, entry: _Entry, home: int, anchors: list[np.ndarray]) -> tuple[tuple[int, _Entry] | None, bool]:
        """Where a lifted filler goes: the tightest spot inside the occupied box of
        the earliest sheet that has one, else the lowest spot on the earliest
        sheet with room, else its old position. ((sheet, entry) | None, inside)."""
        used = [k for k, sheet in enumerate(self.sheets) if sheet]
        for k in used:
            mask, _, _ = self.cached(k)
            self.searches += 1
            moved = _tight_search(self.filler, entry, self.sheets[k], mask, anchors[k], self.box(k))
            if moved is not None:
                return (k, moved), True
        for k in used:
            mask, depth, full = self.cached(k)
            self.searches += 1
            moved = _search(self.filler, entry, self.sheets[k], mask, depth, self.usable_box, full)
            if moved is not None:
                return (k, moved), False
        if self.filler.fits(entry.shell, self.sheets[home]):
            return (home, entry), False
        return None, False

    # -- compaction

    def compact(self, deadline: float, cancel: Callable[[], bool], frozen: set[int]) -> str:
        """Move single parts lower or to earlier sheets until nothing moves; parts
        whose ``id(part)`` is in ``frozen`` stay put. Returns how it stopped."""
        largest = max((e.shell.area for sheet in self.sheets for e in sheet), default=0.0)
        improved = True
        while improved:
            improved = False
            last = self.last()

            def priority(item: tuple[int, _Entry], last: int = last) -> tuple[int, int, float]:
                k, e = item
                group = 0 if k == last else 1 if e.shell.area <= _SMALL_SHARE * largest else 2
                return (group, -k, -e.far)

            queue = sorted(
                ((k, e) for k, sheet in enumerate(self.sheets) for e in sheet if id(e.part) not in frozen),
                key=priority,
            )
            for k, entry in queue:
                if cancel():
                    return "cancelled"
                if time.monotonic() >= deadline:
                    return "deadline"
                if entry in self.sheets[k] and self._try_move(entry, k, last):
                    improved = True
        return "converged"

    def _try_move(self, entry: _Entry, k: int, last: int) -> bool:
        for target in range(k + 1):
            if target < k:
                # Parts may leave the last sheet for any free space; other parts
                # only fill gaps inside the target sheet's occupied box, so the
                # remnant strip and side column stay free.
                limit = self.usable_box if k == last else self.box(target)
                others = self.sheets[target]
                mask, depth, known_full = self.cached(target)
            else:
                if entry.placement.instance_id in self._settled.get(k, ()):
                    return False
                # Strictly lower; off the last sheet also inside the occupied box,
                # so a part never slides sideways into a free side column.
                limit = (entry.far - self.filler.cell / 2.0, self.usable_box[1] if k == last else self.box(k)[1])
                others = [e for e in self.sheets[k] if e is not entry]
                mask, depth, known_full = self.filler.obstacles(others), None, None
            self.searches += 1
            position = _search(self.filler, entry, others, mask, depth, limit, known_full)
            if position is None:
                if target == k:
                    self._settled.setdefault(k, set()).add(entry.placement.instance_id)
                continue
            self.take(entry, k)
            self.put(position, target)
            self.moves += 1
            return True
        return False


def fill_gaps(
    parts: Sequence[PartSpec],
    stock: StockSpec,
    sheets: Sequence[Sequence[Placement]],
    *,
    deadline: float,
    cancel: Callable[[], bool],
    fillers_placed: bool = False,
) -> FillResult:
    """Place fillers among the larger parts, then move parts into free space on
    earlier sheets or lower on their own sheet.

    ``sheets`` must be a valid layout whose last sheet is the remnant sheet;
    sheets keep their order and only empty sheets are dropped. Every placement
    keeps its instance id. ``fillers_placed`` says that ``sheets`` already went
    through the filler phase (a continued fill): it is not repeated and the
    fillers stay frozen. The caller must re-validate the result.
    """
    started = time.monotonic()
    filler = _Filler(parts, stock)
    fillers = filler_parts(parts)
    layout = _Layout(filler, sheets)
    phase, placed, tucked = "none", 0, 0
    frozen: set[int] = set()
    if fillers and fillers_placed:
        frozen = {id(p) for p in fillers}
    elif fillers:
        # The larger parts first settle into the space the lifted fillers leave;
        # half the remaining time at most, so the fillers can still be placed.
        stopped, placed, tucked = layout.place_fillers(
            fillers, started + 0.5 * (deadline - started), deadline, cancel
        )
        if stopped == "converged":
            phase, frozen = "applied", {id(p) for p in fillers}
        else:
            phase, placed, tucked = f"abandoned: {stopped}", 0, 0
            searches = layout.searches
            layout = _Layout(filler, sheets)
            layout.searches = searches
    stopped = layout.compact(deadline, cancel, frozen)
    return FillResult(
        layout.placements(), layout.moves, layout.searches, time.monotonic() - started, stopped, filler.cell,
        phase, placed, tucked,
    )


def _search(filler: _Filler, entry: _Entry, others, mask, depth, limit, full) -> _Entry | None:
    """Lowest exactly-checked position for ``entry`` below ``limit`` on one sheet, or None."""
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
            moved, shell = filler.moved(entry, shape, rotation, i, j)
            if not filler.fits(shell, others):
                continue
            best = (far, cross, moved)
            found = True
            break
        if not found and full is not None and best is None:
            full.add(key)
    return best[2] if best is not None else None


def _tight_search(filler: _Filler, entry: _Entry, others, mask, anchors, limit) -> _Entry | None:
    """Exactly-checked position for ``entry`` within ``limit`` on one sheet with the
    most contact with its neighbours (lowest first among equals), or None."""
    options = []
    for rotation in filler.rotations(entry.part):
        shape = filler.shape(entry.part, rotation)
        for contact, far, cross, i, j in filler.tight_candidates(mask, anchors, shape, limit):
            options.append((-contact, far, cross, rotation, i, j))
    for _, _, _, rotation, i, j in sorted(options):
        moved, shell = filler.moved(entry, filler.shape(entry.part, rotation), rotation, i, j)
        if filler.fits(shell, others):
            return moved
    return None


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
