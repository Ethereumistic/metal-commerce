"""Regenerate the synthetic tracing fixtures (deterministic).

    uv run python tests/fixtures/make_synthetic.py

Shapes are drawn at 4x and downsampled with area averaging so edges are
anti-aliased like real photos. Known geometry (in output pixels, image Y-down)
is documented beside each shape and asserted by tests/test_tracing_synthetic.py.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

OUT = Path(__file__).parent / "synthetic"
SS = 4
BACKGROUND = 244
METAL = 22


def canvas(w: int, h: int, value: int = BACKGROUND) -> np.ndarray:
    return np.full((h * SS, w * SS), value, np.float32)


def poly(img: np.ndarray, pts: list[tuple[float, float]], value: float) -> None:
    arr = np.round(np.array(pts, np.float64) * SS).astype(np.int32)
    cv2.fillPoly(img, [arr], value)


def rect(img: np.ndarray, x0: float, y0: float, x1: float, y1: float, value: float) -> None:
    poly(img, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], value)


def circle(img: np.ndarray, cx: float, cy: float, r: float, value: float) -> None:
    cv2.circle(img, (round(cx * SS), round(cy * SS)), round(r * SS), value, -1, cv2.LINE_AA)


def finish(img: np.ndarray, name: str) -> None:
    h, w = img.shape
    small = cv2.resize(img, (w // SS, h // SS), interpolation=cv2.INTER_AREA)
    out = np.clip(small + 0.5, 0, 255).astype(np.uint8)
    rgb = np.dstack([out, out, np.clip(out.astype(np.int16) - 6, 0, 255).astype(np.uint8)])  # cream tint
    OUT.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT / f"{name}.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))


def l_with_hole() -> None:
    # Asymmetric L: tall leg on the left, foot to the right at the bottom.
    img = canvas(600, 400)
    poly(img, [(100, 50), (220, 50), (220, 270), (500, 270), (500, 350), (100, 350)], METAL)
    rect(img, 130, 90, 190, 200, BACKGROUND)  # hole in the upper part of the tall leg
    finish(img, "l_with_hole")


def ring() -> None:
    img = canvas(500, 500)
    circle(img, 250, 250, 180, METAL)
    circle(img, 250, 250, 90, BACKGROUND)
    finish(img, "ring")


def island_in_hole() -> None:
    img = canvas(500, 500)
    rect(img, 80, 80, 420, 420, METAL)
    rect(img, 140, 140, 360, 360, BACKGROUND)
    rect(img, 210, 210, 290, 290, METAL)  # free-standing island inside the hole
    finish(img, "island_in_hole")


def shadowed() -> None:
    img = canvas(600, 500)
    shadow = canvas(600, 500, 0)
    poly(shadow, [(120, 100), (420, 100), (420, 380), (120, 380)], 1.0)
    shadow = np.roll(shadow, (18 * SS, 22 * SS), axis=(0, 1))
    shadow = cv2.GaussianBlur(shadow, (0, 0), 8 * SS)
    img = img - shadow * (BACKGROUND - 165)  # soft grey shadow, lighter than metal
    poly(img, [(100, 80), (400, 80), (400, 360), (100, 360)], METAL)
    rect(img, 180, 160, 320, 280, BACKGROUND)
    finish(img, "shadowed")


def margin_heavy() -> None:
    img = canvas(1200, 900)
    poly(img, [(500, 400), (800, 400), (800, 600), (500, 600)], METAL)  # 300 x 200 object
    circle(img, 600, 500, 40, BACKGROUND)
    finish(img, "margin_heavy")


def clipped() -> None:
    img = canvas(500, 400)
    rect(img, 200, 100, 500, 300, METAL)  # runs off the right edge
    finish(img, "clipped")


def low_contrast() -> None:
    img = canvas(500, 400, 222)
    rect(img, 150, 100, 350, 300, 200)
    finish(img, "low_contrast")


def two_parts() -> None:
    img = canvas(700, 400)
    rect(img, 60, 80, 300, 320, METAL)
    poly(img, [(400, 80), (640, 200), (400, 320)], METAL)
    finish(img, "two_parts")


def noise_specks() -> None:
    img = canvas(600, 500)
    rect(img, 150, 120, 450, 380, METAL)
    rect(img, 250, 200, 350, 300, BACKGROUND)
    rng = np.random.default_rng(7)
    for _ in range(40):
        x, y = rng.uniform(20, 580), rng.uniform(20, 480)
        if 140 < x < 460 and 110 < y < 390:
            continue
        circle(img, x, y, rng.uniform(0.5, 1.2), METAL)
    finish(img, "noise_specks")


if __name__ == "__main__":
    for make in (l_with_hole, ring, island_in_hole, shadowed, margin_heavy, clipped, low_contrast, two_parts,
                 noise_specks):
        make()
    print(f"wrote fixtures to {OUT}")
