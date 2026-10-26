"""Synthetic part geometry with known contours for nesting/export tests.

All shapes are Y-up millimetres with their bounding box at the origin, matching
the contract. Several are deliberately asymmetric so a mirror cannot hide
behind symmetry.
"""

from __future__ import annotations

import math

from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon

from artwork_service.nesting_types import PartSpec, StockSpec


def l_shape(size: float = 300.0, arm: float = 80.0) -> MultiPolygon:
    return MultiPolygon([Polygon([(0, 0), (size, 0), (size, arm), (arm, arm), (arm, size), (0, size)])])


def plate_with_hole(width: float = 200.0, height: float = 120.0) -> MultiPolygon:
    hole = [(50, 30), (50, 90), (150, 90), (150, 30)]
    return MultiPolygon([Polygon([(0, 0), (width, 0), (width, height), (0, height)], [hole])])


def flag_shape() -> MultiPolygon:
    """An 'F': asymmetric under every mirror and every non-zero quarter turn."""
    return MultiPolygon(
        [
            Polygon(
                [
                    (0, 0),
                    (40, 0),
                    (40, 100),
                    (120, 100),
                    (120, 130),
                    (40, 130),
                    (40, 160),
                    (100, 160),
                    (100, 190),
                    (0, 190),
                ]
            )
        ]
    )


def comb(
    teeth: int = 6, pitch: float = 60.0, tooth_w: float = 20.0, tooth_h: float = 260.0, back: float = 30.0
) -> MultiPolygon:
    """A comb whose teeth can interleave with a 180-degree-rotated copy."""
    width = (teeth - 1) * pitch + tooth_w
    top = back + tooth_h
    coords = [(0.0, 0.0), (width, 0.0)]
    for k in range(teeth - 1, -1, -1):
        left = k * pitch
        coords += (
            [(left + tooth_w, top), (left, top)]
            if k == teeth - 1
            else [
                (left + tooth_w, back),
                (left + tooth_w, top),
                (left, top),
            ]
        )
        if k:
            coords.append((left, back))
    return MultiPolygon([Polygon(coords)])


def ring_part(radius: float = 100.0, hole_radius: float = 50.0, segments: int = 64) -> MultiPolygon:
    def circle(r: float) -> list[tuple[float, float]]:
        return [
            (radius + r * math.cos(2 * math.pi * k / segments), radius + r * math.sin(2 * math.pi * k / segments))
            for k in range(segments)
        ]

    return MultiPolygon([Polygon(circle(radius), [circle(hole_radius)])])


def two_component_part() -> MultiPolygon:
    """Disconnected material (two islands) that must travel together."""
    return MultiPolygon(
        [
            Polygon([(0, 0), (60, 0), (60, 40), (0, 40)], [[(20, 10), (20, 30), (40, 30), (40, 10)]]),
            Polygon([(80, 0), (140, 0), (110, 70)]),
        ]
    )


def _at_origin(polygon: Polygon) -> MultiPolygon:
    min_x, min_y, _, _ = polygon.bounds
    return MultiPolygon([affinity.translate(polygon, -min_x, -min_y)])


def wave_art(size: float = 800.0, waves: int = 3, depth: float = 70.0, steps: int = 48) -> MultiPolygon:
    """Near-square wall art whose four edges dip inward in waves (concave outer outline).

    Mimics the owner's large "wave" pieces: the bounding box is a full square, but
    every edge has ``waves`` pockets up to ``depth`` mm deep that small parts can use.
    Two interior cut-outs make it a realistic part with holes.
    """
    edge = []
    for k in range(steps):
        t = k / steps
        inset = depth * 0.5 * (1 - math.cos(2 * math.pi * waves * t))
        edge.append((t * size, inset))
    coords = []
    for quarter in range(4):
        for x, y in edge:
            # Rotate the bottom edge onto each side of the square (CCW).
            if quarter == 0:
                coords.append((x, y))
            elif quarter == 1:
                coords.append((size - y, x))
            elif quarter == 2:
                coords.append((size - x, size - y))
            else:
                coords.append((y, size - x))
    c = size / 2
    holes = [
        [(c - 150, c - 40), (c - 40, c - 40), (c - 40, c + 40), (c - 150, c + 40)],
        [(c + 40, c - 40), (c + 150, c - 40), (c + 150, c + 40), (c + 40, c + 40)],
    ]
    return _at_origin(Polygon(coords, holes))


def star(size: float = 300.0, points: int = 5, inner: float = 0.42) -> MultiPolygon:
    """A star with deep concave pockets between the arms."""
    coords = []
    for k in range(2 * points):
        r = 1.0 if k % 2 == 0 else inner
        t = math.pi / 2 + math.pi * k / points
        coords.append((r * math.cos(t), r * math.sin(t)))
    poly = Polygon(coords)
    min_x, min_y, max_x, max_y = poly.bounds
    factor = size / max(max_x - min_x, max_y - min_y)
    return _at_origin(affinity.scale(poly, factor, factor, origin=(0, 0)))


def shuriken(size: float = 100.0) -> MultiPolygon:
    """Four-blade throwing star with a round centre hole."""
    blade = star(size, points=4, inner=0.3).geoms[0]
    c = size / 2
    hole = Polygon([(c + 0.12 * size * math.cos(a), c + 0.12 * size * math.sin(a)) for a in
                    (2 * math.pi * k / 16 for k in range(16))])
    return MultiPolygon([Polygon(blade.exterior, [hole.exterior])])


def ninja_blade(length: float = 150.0) -> MultiPolygon:
    """Kunai: a long diamond blade on a thin grip with a ring pommel."""
    w = length * 0.2
    coords = [
        (0, w / 2), (length * 0.55, 0), (length * 0.62, w * 0.35), (length * 0.85, w * 0.4),
        (length, w / 2), (length * 0.85, w * 0.6), (length * 0.62, w * 0.65), (length * 0.55, w),
    ]
    return _at_origin(Polygon(coords))


def owner_batch(*, fillers: bool) -> list[PartSpec]:
    """The owner's reported batch: 10 large wave pieces at 800 mm and 44 concave stars
    near 300 mm, optionally with 30 small shurikens and blades (60-150 mm) as fillers."""
    parts = [
        part("wave", wave_art(), 10),
        part("star5", star(300, 5), 24),
        part("star6", star(280, 6, inner=0.5), 20),
    ]
    if fillers:
        parts += [
            part("shuriken-100", shuriken(100), 12),
            part("shuriken-60", shuriken(60), 10),
            part("kunai-150", ninja_blade(150), 8),
        ]
    return parts


def scaled(geometry: MultiPolygon, factor: float) -> MultiPolygon:
    return affinity.scale(geometry, factor, factor, origin=(0, 0))


def part(
    key: str,
    geometry: MultiPolygon,
    quantity: int,
    *,
    product_id: str | None = None,
    rotations: tuple[int, ...] = (0, 90, 180, 270),
) -> PartSpec:
    return PartSpec(
        part_key=key,
        geometry=geometry,
        instance_ids=tuple(f"{key}#{n:04d}" for n in range(1, quantity + 1)),
        line_id=key,
        product_id=product_id or f"product-{key}",
        allowed_rotations=rotations,
    )


def sheet(
    width: float = 1500.0,
    height: float = 3000.0,
    *,
    margins=(10.0, 15.0, 20.0, 25.0),
    gap: float = 5.0,
    max_sheets: int = 10,
) -> StockSpec:
    left, right, bottom, top = margins
    return StockSpec(width, height, left, right, bottom, top, gap, max_sheets)


def mixed_batch() -> list[PartSpec]:
    """Plan acceptance case: 44 copies of product A plus 10 copies of product B."""
    return [part("A", l_shape(), 44), part("B", plate_with_hole(), 10)]


def never_cancel() -> bool:
    return False


def no_progress(_fraction: float, _stage: str) -> None:
    return None
