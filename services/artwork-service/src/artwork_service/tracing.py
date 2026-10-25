"""Deterministic raster-to-vector tracing of product artwork.

Dark pixels are retained metal, light pixels are empty space. The tracer sits
behind a small adapter (`get_tracer`) so another engine can be added later and
must pass the same fixtures.

Pipeline ("opencv-contours"):
1. Decode, apply EXIF orientation, composite alpha onto white, take luminance.
2. Optionally flatten slow background illumination (quadratic fit to the
   light class) so vignetting does not move the threshold.
3. Estimate the metal and background luminance modes. Evaluate a bounded set
   of thresholds between them (fractions of the mode gap plus Otsu). Each
   candidate's instability is its area + topology change against both
   neighbours, normalized per grid step; the most stable candidate wins, ties
   going to the preferred (darker) fraction: soft shadows are lighter than
   metal, so a darker threshold excludes them.
4. Resolve diagonal-only pixel joints ("pinches") by the grayscale value at
   the shared corner, so every contour is a simple ring.
5. Remove only tiny noise: metal components and openings smaller than the
   noise limit `max(noise_min_px, noise_image_fraction × pixels)` (12 px for
   the supplied 1254-1600 px photos); filled openings are reported as a
   warning. Components stable across the neighbouring thresholds are kept as
   real material, however small. Unstable specks up to
   `speck_max_noise_multiple × noise limit` that vanish at the darker
   neighbour are shadow specks and are dropped (counted). Larger unstable
   components are ambiguous and fail (DISCONNECTED_MATERIAL, or
   AMBIGUOUS_SEGMENTATION when the main body is affected).
6. Reject objects touching the image edge (OBJECT_CLIPPED); crop to the
   object bounds and record the transform so white margins never enter sizes.
7. Refine boundaries on a supersampled crop of the grayscale image within one
   native pixel of the chosen mask. Refinement may only move boundaries: any
   region where it splits, merges, invents or deletes a component or hole is
   reverted locally to the native mask, and the result must match the native
   topology exactly (else the whole mask is used, with a warning).
8. Extract the full contour hierarchy (outer boundaries, holes, islands in
   holes), repair invalid rings, simplify within `simplify_tolerance_px` and
   re-validate topology/area after every step.
9. Normalize so the longest side is 1, Y-up, bbox lower-left at (0, 0).
"""

from __future__ import annotations

import hashlib
import io
import json
import time
from dataclasses import asdict, dataclass
from typing import Any, Protocol

import cv2
import numpy as np
import shapely
from PIL import Image, ImageOps, UnidentifiedImageError
from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon

from . import geometry as geo
from .errors import ServiceError

TRACE_ENGINE = "opencv-contours"
TRACE_VERSION = "1.0.0"

SUPPORTED_FORMATS = {"PNG", "JPEG", "WEBP"}


@dataclass(frozen=True)
class TraceSettings:
    # Threshold candidates as fractions of the gap between metal and
    # background luminance modes (Otsu is always added as a candidate).
    candidate_fractions: tuple[float, ...] = (0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5)
    preferred_fraction: float = 0.25
    min_mode_separation: int = 60
    min_source_side_px: int = 256
    min_object_side_px: int = 160
    max_source_pixels: int = 60_000_000
    # Noise limit: max(noise_min_px, noise_image_fraction * image pixels).
    # 12 px on a 1254 px square (~0.6 mm² on a 600 mm part).
    noise_min_px: int = 12
    noise_image_fraction: float = 4e-6
    speck_max_noise_multiple: int = 4
    clip_border_px: int = 1
    flatten_background: bool = True
    supersample: int = 4
    max_supersampled_side_px: int = 8000
    simplify_tolerance_px: float = 0.25
    max_simplify_area_change: float = 0.005
    max_vertices: int = 400_000

    def normalized(self) -> dict[str, Any]:
        data = asdict(self)
        data["candidate_fractions"] = [round(f, 6) for f in self.candidate_fractions]
        return data

    def fingerprint(self) -> str:
        canon = json.dumps(self.normalized(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canon.encode()).hexdigest()


class TraceError(ServiceError):
    pass


@dataclass
class TraceResult:
    geometry: MultiPolygon
    aspect_ratio: float
    image_width: int
    image_height: int
    transform: dict[str, Any]
    components: list[dict[str, Any]]
    holes: int
    vertex_count: int
    diagnostics: dict[str, Any]
    svg: str
    overlay_png: bytes
    solid_png: bytes

    def master_document(self) -> dict[str, Any]:
        return {
            "format": "artwork-master",
            "format_version": 1,
            "trace_engine": TRACE_ENGINE,
            "trace_version": TRACE_VERSION,
            "units": "normalized-longest-side",
            "axis": "y-up",
            "aspect_ratio": self.aspect_ratio,
            "normalized_bounds": list(self.geometry.bounds),
            "transform": self.transform,
            "components": self.components,
            "holes": self.holes,
            "vertex_count": self.vertex_count,
            "geometry": geo.to_json(self.geometry),
        }


class Tracer(Protocol):
    engine: str
    version: str

    def trace(self, data: bytes, settings: TraceSettings) -> TraceResult: ...


class OpenCvContourTracer:
    engine = TRACE_ENGINE
    version = TRACE_VERSION

    def trace(self, data: bytes, settings: TraceSettings) -> TraceResult:
        return trace_image(data, settings)


def get_tracer(engine: str = TRACE_ENGINE) -> Tracer:
    if engine == TRACE_ENGINE:
        return OpenCvContourTracer()
    raise ValueError(f"unknown trace engine {engine!r}")


# --------------------------------------------------------------------------- decode


@dataclass
class Decoded:
    rgb: np.ndarray
    gray: np.ndarray
    exif_orientation: int
    had_alpha: bool
    format: str


def decode_image(data: bytes, settings: TraceSettings) -> Decoded:
    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format or ""
        if fmt not in SUPPORTED_FORMATS:
            raise TraceError("UNSUPPORTED_FORMAT",
                             f"Image format {fmt or 'unknown'} is not supported; use PNG, JPEG or WebP.",
                             {"format": fmt})
        w, h = img.size
        if w * h > settings.max_source_pixels:
            raise TraceError("SOURCE_TOO_LARGE",
                             f"Image is {w}×{h} px, above the {settings.max_source_pixels} pixel limit.",
                             {"width": w, "height": h})
        orientation = int(img.getexif().get(0x0112, 1) or 1)
        img.load()
        img = ImageOps.exif_transpose(img)
    except TraceError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise TraceError("UNSUPPORTED_FORMAT", "The image could not be decoded; it may be corrupt or truncated.",
                         {"reason": type(exc).__name__}) from exc

    had_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    if img.mode.startswith("I"):
        # 16/32-bit grayscale: scale to 8 bits rather than letting Pillow clip.
        arr = np.asarray(img).astype(np.float64)
        peak = 65535.0 if arr.max() > 255 else 255.0
        gray8 = np.clip(arr / peak * 255.0 + 0.5, 0, 255).astype(np.uint8)
        rgb = np.dstack([gray8] * 3)
    elif had_alpha:
        rgba = img.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        rgb = np.asarray(Image.alpha_composite(white, rgba).convert("RGB"))
    else:
        rgb = np.asarray(img.convert("RGB"))
    rgb = np.ascontiguousarray(rgb)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return Decoded(rgb=rgb, gray=gray, exif_orientation=orientation, had_alpha=had_alpha, format=fmt)


# ----------------------------------------------------------------- segmentation


@dataclass
class Segmentation:
    threshold: int
    fraction: float | None
    mask: np.ndarray
    labels: np.ndarray
    component_areas: np.ndarray  # index = label - 1
    hole_count: int
    metal_area: int
    noise_removed_px: int
    holes_filled_px: int
    holes_filled_count: int = 0
    pinches_resolved: int = 0
    score: float = 0.0

    @property
    def component_count(self) -> int:
        return int(len(self.component_areas))

    def summary(self) -> "Segmentation":
        """Drop the image-sized arrays, keeping the statistics used for scoring."""
        self.mask = self.labels = None  # type: ignore[assignment]
        return self


def _otsu(gray: np.ndarray) -> int:
    """Otsu threshold in this module's convention: metal is `gray < threshold`.

    OpenCV classifies `gray > t` as foreground, so its dark class is `<= t`.
    """
    t, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return int(t) + 1


def _flatten_background(gray: np.ndarray, otsu: int) -> tuple[np.ndarray, bool]:
    """Divide out a quadratic illumination model fitted to the light class."""
    light = (gray > otsu).astype(np.uint8)
    light = cv2.erode(light, np.ones((5, 5), np.uint8))
    h, w = gray.shape
    step = max(1, int(np.sqrt(h * w / 40_000)))
    ys, xs = np.nonzero(light[::step, ::step])
    if len(xs) < 1000:
        return gray, False
    vals = gray[::step, ::step][ys, xs].astype(np.float64)
    xn, yn = xs * step / w - 0.5, ys * step / h - 0.5
    basis = np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn], axis=1)
    coef, *_ = np.linalg.lstsq(basis, vals, rcond=None)
    gx = (np.arange(w, dtype=np.float32) / w - 0.5)[None, :]
    gy = (np.arange(h, dtype=np.float32) / h - 0.5)[:, None]
    c = coef.astype(np.float32)
    model = c[0] + c[1] * gx + c[2] * gy + c[3] * gx * gx + c[4] * gx * gy + c[5] * gy * gy
    if float(model.min()) < 64.0:
        return gray, False
    target = float(np.median(vals))
    out = np.clip(gray.astype(np.float32) * (target / model), 0, 255)
    return (out + 0.5).astype(np.uint8), True


def _modes(gray: np.ndarray, otsu: int) -> tuple[int, int]:
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    hist = np.convolve(hist, np.ones(5) / 5.0, mode="same")
    lo = max(otsu, 1)
    metal = int(np.argmax(hist[:lo]))
    background = int(lo + np.argmax(hist[lo:]))
    return metal, background


def _resolve_pinches(mask: np.ndarray, gray: np.ndarray, threshold: float, max_iter: int = 16) -> int:
    """Remove diagonal-only pixel joints in place; returns the number resolved.

    A 2×2 block where metal touches only across a diagonal is ambiguous: as a
    vector ring it self-touches at a point, which is neither a real connection
    nor a real gap. The grayscale value at the shared corner (mean of the four
    pixels, i.e. the bilinear sample there) decides: darker than the threshold
    joins the diagonal with the darker background pixel, otherwise the lighter
    metal pixel is cleared. After this, 8- and 4-connectivity agree, so every
    contour is a simple ring.
    """
    resolved = 0
    g = gray.astype(np.float32)
    for _ in range(max_iter):
        a, b = mask[:-1, :-1], mask[1:, 1:]
        c, d = mask[:-1, 1:], mask[1:, :-1]
        main = (a & b & (1 - c) & (1 - d)).astype(bool)   # metal on the "\" diagonal
        anti = (c & d & (1 - a) & (1 - b)).astype(bool)   # metal on the "/" diagonal
        ys, xs = np.nonzero(main | anti)
        if len(ys) == 0:
            break
        for y, x in zip(ys.tolist(), xs.tolist()):
            block = mask[y:y + 2, x:x + 2]
            if block.sum() != 2 or block[0, 0] == block[0, 1]:
                continue  # already changed by a neighbouring fix this round
            gb = g[y:y + 2, x:x + 2]
            if block[0, 0]:
                metal = [(0, 0), (1, 1)]
                empty = [(0, 1), (1, 0)]
            else:
                metal = [(0, 1), (1, 0)]
                empty = [(0, 0), (1, 1)]
            if float(gb.mean()) < threshold:
                dy, dx = min(empty, key=lambda p: (gb[p], p))
                mask[y + dy, x + dx] = 1
            else:
                dy, dx = max(metal, key=lambda p: (gb[p], p))
                mask[y + dy, x + dx] = 0
            resolved += 1
    return resolved


def _segment(gray: np.ndarray, threshold: int, fraction: float | None, noise: int) -> Segmentation:
    raw = (gray < threshold).astype(np.uint8)
    pinches = _resolve_pinches(raw, gray, threshold)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(raw, connectivity=8)
    areas = stats[:, cv2.CC_STAT_AREA]
    keep = areas >= noise
    keep[0] = False
    noise_removed = int(areas[1:][~keep[1:]].sum())
    mask = keep[labels].astype(np.uint8)

    # Holes: 4-connected background regions not touching the border
    # (4-connected background is the topological dual of 8-connected metal).
    inv = (mask == 0).astype(np.uint8)
    hn, hlabels, hstats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    h, w = gray.shape
    x, y = hstats[:, cv2.CC_STAT_LEFT], hstats[:, cv2.CC_STAT_TOP]
    hw, hh = hstats[:, cv2.CC_STAT_WIDTH], hstats[:, cv2.CC_STAT_HEIGHT]
    touches = (x == 0) | (y == 0) | (x + hw == w) | (y + hh == h)
    is_hole = ~touches
    is_hole[0] = False
    small_hole = is_hole & (hstats[:, cv2.CC_STAT_AREA] < noise)
    holes_filled = int(hstats[small_hole, cv2.CC_STAT_AREA].sum())
    if holes_filled:
        mask[small_hole[hlabels]] = 1
    hole_count = int((is_hole & ~small_hole).sum())

    # Relabel the cleaned mask so labels match the kept components exactly.
    cn, clabels, cstats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    return Segmentation(
        threshold=threshold, fraction=fraction, mask=mask, labels=clabels,
        component_areas=cstats[1:, cv2.CC_STAT_AREA].astype(np.int64),
        hole_count=hole_count, metal_area=int(mask.sum()),
        noise_removed_px=noise_removed, holes_filled_px=holes_filled,
        holes_filled_count=int(small_hole.sum()), pinches_resolved=pinches,
    )


def _instability(seg: Segmentation, neighbours: list[Segmentation], step: float) -> float:
    """Relative area + topology change against the neighbouring candidates,
    normalized to one nominal grid `step` of luminance so a candidate that
    happens to sit next to a near-identical threshold (Otsu beside a grid
    point) does not look artificially stable."""
    if len(neighbours) < 2 or seg.metal_area == 0:
        # Stability is judged in both directions; the ends of the range cannot be.
        return float("inf")
    denom = max(1, seg.component_count + seg.hole_count)
    changes = []
    for n in neighbours:
        area = abs(seg.metal_area - n.metal_area) / seg.metal_area
        topo = (abs(seg.component_count - n.component_count) + abs(seg.hole_count - n.hole_count)) / denom
        changes.append((area + topo) * step / max(1, abs(seg.threshold - n.threshold)))
    return float(np.mean(changes))


def _match_components(seg: Segmentation, other: Segmentation) -> tuple[np.ndarray, np.ndarray]:
    """For each component of `seg`, the best-overlapping label in `other` (0 = none)
    and the area ratio other/seg; also flags merges (two seg comps -> one other)."""
    a = seg.labels.ravel()
    b = other.labels.ravel()
    both = (a > 0) & (b > 0)
    nb = int(other.labels.max()) + 1
    codes = a[both].astype(np.int64) * nb + b[both]
    uniq, counts = np.unique(codes, return_counts=True)
    ca, cb = uniq // nb, uniq % nb
    k = seg.component_count
    best = np.zeros(k + 1, dtype=np.int64)
    best_overlap = np.zeros(k + 1, dtype=np.int64)
    for la, lb, cnt in zip(ca, cb, counts):
        if cnt > best_overlap[la]:
            best_overlap[la] = cnt
            best[la] = lb
    ratio = np.zeros(k + 1)
    for la in range(1, k + 1):
        if best[la]:
            ratio[la] = other.component_areas[best[la] - 1] / seg.component_areas[la - 1]
    return best, ratio


def _stable_components(seg: Segmentation, neighbours: list[Segmentation]) -> np.ndarray:
    """Boolean per label (index 0 unused): present with similar area at every
    neighbour and never merged with another component of `seg`."""
    stable = np.ones(seg.component_count + 1, dtype=bool)
    stable[0] = False
    for other in neighbours:
        best, ratio = _match_components(seg, other)
        present = (best > 0) & (ratio >= 0.5) & (ratio <= 2.0)
        stable &= present
        matched = best[1:][best[1:] > 0]
        uniq, counts = np.unique(matched, return_counts=True)
        merged = set(uniq[counts > 1].tolist())
        for la in range(1, seg.component_count + 1):
            if best[la] in merged:
                stable[la] = False
    return stable


def _drop_labels(seg: Segmentation, drop: list[int]) -> Segmentation:
    keep = np.ones(seg.component_count + 1, dtype=bool)
    keep[0] = False
    keep[drop] = False
    mask = keep[seg.labels].astype(np.uint8)
    cn, clabels, cstats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    seg.mask, seg.labels = mask, clabels
    seg.component_areas = cstats[1:, cv2.CC_STAT_AREA].astype(np.int64)
    seg.metal_area = int(mask.sum())
    return seg


# ------------------------------------------------------------------ refinement


def _count_topology(mask: np.ndarray) -> tuple[int, int]:
    n, _ = cv2.connectedComponents(mask, connectivity=8)
    inv = (mask == 0).astype(np.uint8)
    hn, _, hstats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    h, w = mask.shape
    x, y = hstats[1:, cv2.CC_STAT_LEFT], hstats[1:, cv2.CC_STAT_TOP]
    hw, hh = hstats[1:, cv2.CC_STAT_WIDTH], hstats[1:, cv2.CC_STAT_HEIGHT]
    touches = (x == 0) | (y == 0) | (x + hw == w) | (y + hh == h)
    return n - 1, int((~touches).sum())


def _constrain_to_native(refined: np.ndarray, native: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Keep refinement a boundary adjustment only: it may not invent or delete regions.

    Refined metal components that do not overlap native metal (cubic overshoot
    specks) are dropped, refined holes with no native background are filled, and
    any native hole the refinement closed is restored from the native mask.
    """
    native_up = cv2.resize(native, size, interpolation=cv2.INTER_NEAREST)
    _, labels = cv2.connectedComponents(refined, connectivity=8)
    overlapping = np.unique(labels[(native_up > 0) & (labels > 0)])
    keep = np.zeros(int(labels.max()) + 1, dtype=bool)
    keep[overlapping] = True
    out = keep[labels].astype(np.uint8)

    h, w = out.shape
    _, hl, hs, _ = cv2.connectedComponentsWithStats((out == 0).astype(np.uint8), connectivity=4)
    x, y = hs[:, cv2.CC_STAT_LEFT], hs[:, cv2.CC_STAT_TOP]
    touches = (x == 0) | (y == 0) | (x + hs[:, cv2.CC_STAT_WIDTH] == w) | (y + hs[:, cv2.CC_STAT_HEIGHT] == h)
    has_native_bg = np.zeros(len(hs), dtype=bool)
    has_native_bg[np.unique(hl[native_up == 0])] = True
    fill = ~touches & ~has_native_bg
    fill[0] = False
    out[fill[hl]] = 1

    nh, nl, ns, _ = cv2.connectedComponentsWithStats((native == 0).astype(np.uint8), connectivity=4)
    nl_up = cv2.resize(nl.astype(np.int32), size, interpolation=cv2.INTER_NEAREST)
    surviving = np.zeros(nh, dtype=bool)
    surviving[np.unique(nl_up[out == 0])] = True
    lost = ~surviving
    lost[0] = False
    if lost.any():
        out[lost[nl_up]] = 0
    return out


def _lookup(ids: np.ndarray, size: int) -> np.ndarray:
    table = np.zeros(size, dtype=bool)
    table[ids] = True
    return table


def _minor_pieces(owner: np.ndarray, piece: np.ndarray, areas: np.ndarray) -> np.ndarray:
    """Pieces that are not the largest piece of their owner (owner/piece label pairs)."""
    if owner.size == 0:
        return np.zeros(0, dtype=np.int64)
    base = int(piece.max()) + 1
    codes = np.unique(owner.astype(np.int64) * base + piece)
    pairs = np.stack([codes // base, codes % base])
    order = np.lexsort((-areas[pairs[1]], pairs[0]))
    pairs = pairs[:, order]
    first = np.ones(pairs.shape[1], dtype=bool)
    first[1:] = pairs[0, 1:] != pairs[0, :-1]
    return pairs[1][~first]


def _merged_pieces(owner: np.ndarray, piece: np.ndarray) -> np.ndarray:
    """Pieces that overlap more than one owner (owner/piece label pairs)."""
    if owner.size == 0:
        return np.zeros(0, dtype=np.int64)
    base = int(owner.max()) + 1
    codes = np.unique(piece.astype(np.int64) * base + owner)
    pieces, counts = np.unique(codes // base, return_counts=True)
    return pieces[counts > 1]


def _topology_mismatch_region(refined: np.ndarray, native: np.ndarray, k: int,
                              size: tuple[int, int], grow: int) -> np.ndarray:
    """Supersampled region where refined and native topology disagree.

    Covers the minor fragments of native metal components or holes that
    refinement split, the pixels that merged separate native components or
    holes, and refined holes carved out of the outside background, each
    grown by `grow` native pixels. Reverting only these regions keeps sub-pixel edges elsewhere.
    """
    bad = np.zeros(refined.shape, dtype=bool)

    _, cl = cv2.connectedComponents(native, connectivity=8)
    cl_up = cv2.resize(cl.astype(np.int32), size, interpolation=cv2.INTER_NEAREST)
    rn, rl, rs, _ = cv2.connectedComponentsWithStats(refined, connectivity=8)
    sel = (rl > 0) & (cl_up > 0)
    minor = _minor_pieces(cl_up[sel], rl[sel], rs[:, cv2.CC_STAT_AREA])
    if len(minor):
        bad |= _lookup(minor, rn)[rl]
    merged = _merged_pieces(cl_up[sel], rl[sel])
    if len(merged):
        # Only the refined metal that was native background joined the pieces.
        bad |= _lookup(merged, rn)[rl] & (cl_up == 0)

    h, w = native.shape
    nh, nl, ns, _ = cv2.connectedComponentsWithStats((native == 0).astype(np.uint8), connectivity=4)
    x, y = ns[:, cv2.CC_STAT_LEFT], ns[:, cv2.CC_STAT_TOP]
    outer = (x == 0) | (y == 0) | (x + ns[:, cv2.CC_STAT_WIDTH] == w) | (y + ns[:, cv2.CC_STAT_HEIGHT] == h)
    nl_up = cv2.resize(nl.astype(np.int32), size, interpolation=cv2.INTER_NEAREST)
    hh, ww = refined.shape
    rh, rhl, rhs, _ = cv2.connectedComponentsWithStats((refined == 0).astype(np.uint8), connectivity=4)
    rx, ry = rhs[:, cv2.CC_STAT_LEFT], rhs[:, cv2.CC_STAT_TOP]
    r_outer = (rx == 0) | (ry == 0) | (rx + rhs[:, cv2.CC_STAT_WIDTH] == ww) | (ry + rhs[:, cv2.CC_STAT_HEIGHT] == hh)
    native_bg = native == 0
    native_bg_up = cv2.resize(native_bg.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST) > 0
    sel = (rhl > 0) & native_bg_up & ~r_outer[rhl]
    owners, pieces = nl_up[sel], rhl[sel]
    from_outside = outer[owners]
    carved = np.unique(pieces[from_outside])
    if len(carved):
        bad |= _lookup(carved, rh)[rhl]
    inner = ~from_outside
    minor = _minor_pieces(owners[inner], pieces[inner], rhs[:, cv2.CC_STAT_AREA])
    if len(minor):
        bad |= _lookup(minor, rh)[rhl]
    merged = _merged_pieces(owners, pieces)
    if len(merged):
        bad |= _lookup(merged, rh)[rhl] & ~native_bg_up

    if not bad.any():
        return bad
    radius = grow * k
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    return cv2.dilate(bad.astype(np.uint8), kernel) > 0


def _refine(gray: np.ndarray, mask: np.ndarray, threshold: int, crop: tuple[int, int, int, int],
            settings: TraceSettings) -> tuple[np.ndarray, int, str]:
    x0, y0, x1, y1 = crop
    g = gray[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    ch, cw = m.shape
    k = max(1, min(settings.supersample, settings.max_supersampled_side_px // max(ch, cw)))
    expected = _count_topology(m)
    size = (cw * k, ch * k)
    nearest = lambda a: cv2.resize(a, size, interpolation=cv2.INTER_NEAREST)  # noqa: E731
    if k == 1:
        return m.copy(), 1, "mask"
    up = cv2.resize(g.astype(np.float32), size, interpolation=cv2.INTER_CUBIC)
    kernel = np.ones((3, 3), np.uint8)
    lo = nearest(cv2.erode(m, kernel))
    hi = nearest(cv2.dilate(m, kernel))
    refined = (((up < threshold) & (hi > 0)) | (lo > 0)).astype(np.uint8)
    _resolve_pinches(refined, up, threshold)
    refined = _constrain_to_native(refined, m, size)
    native_up = nearest(m)
    for grow in (1, 2, 3, 5):
        if _count_topology(refined) == expected:
            return refined, k, "grayscale-supersampled"
        region = _topology_mismatch_region(refined, m, k, size, grow)
        if not region.any():
            break
        refined[region] = native_up[region]
        _resolve_pinches(refined, up, threshold)
        refined = _constrain_to_native(refined, m, size)
    if _count_topology(refined) == expected:
        return refined, k, "grayscale-supersampled"
    return native_up, k, "mask"


# ------------------------------------------------------------------- contours


def _contours_to_polygons(binary: np.ndarray, k: int, offset: tuple[int, int]) -> list[Polygon]:
    # OpenCV contours run through boundary pixel centres, which gives a
    # one-pixel-wide neck zero width (and splits the part). Tracing a 2x
    # nearest upsample keeps every pixel-wide feature at positive width and
    # puts the contour a quarter pixel inside the true pixel edge.
    doubled = cv2.resize(binary, (binary.shape[1] * 2, binary.shape[0] * 2), interpolation=cv2.INTER_NEAREST)
    contours, hierarchy = cv2.findContours(doubled, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hier = hierarchy[0]
    ox, oy = offset
    scale = 2 * k

    def to_native(c: np.ndarray) -> np.ndarray:
        pts = c.reshape(-1, 2).astype(np.float64)
        # Pixel u of the doubled supersampled crop covers native [u, u + 1) / scale.
        return np.column_stack(((pts[:, 0] + 0.5) / scale + ox, (pts[:, 1] + 0.5) / scale + oy))

    polys: list[Polygon] = []
    for i, (_nxt, _prv, child, parent) in enumerate(hier):
        if parent != -1:
            continue
        shell = to_native(contours[i])
        if len(shell) < 3:
            continue
        holes = []
        c = child
        while c != -1:
            ring = to_native(contours[c])
            if len(ring) >= 3:
                holes.append(ring)
            c = hier[c][0]
        poly = Polygon(shell, holes)
        if not poly.is_valid:
            # 8-connected pinch points make self-touching rings; split them.
            polys.extend(p for p in geo.polygons_of(shapely.make_valid(poly)) if p.area > 0)
        elif poly.area > 0:
            polys.append(poly)
    return polys


def _simplify(polys: list[Polygon], tolerance: float, max_change: float) -> tuple[MultiPolygon, float, float]:
    raw = MultiPolygon(polys)
    tol = tolerance
    while tol >= tolerance / 8:
        simplified = [p.simplify(tol, preserve_topology=True) for p in polys]
        cand = MultiPolygon([p for p in simplified if not p.is_empty])
        if (geo.is_valid(cand)
                and geo.topology_signature(cand) == geo.topology_signature(raw)
                and geo.relative_area_change(raw, cand) <= max_change):
            return cand, tol, geo.relative_area_change(raw, cand)
        tol /= 2
    if not geo.is_valid(raw):
        raise TraceError("INVALID_CONTOURS",
                         "Traced contours are self-intersecting or overlap and could not be repaired.",
                         {"reason": shapely.is_valid_reason(raw)})
    return raw, 0.0, 0.0


# -------------------------------------------------------------------- previews


def _png(arr: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", arr)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return buf.tobytes()


def _render_overlay(rgb: np.ndarray, geom_px: MultiPolygon, crop: tuple[int, int, int, int]) -> bytes:
    x0, y0, x1, y1 = crop
    img = cv2.cvtColor(rgb[y0:y1, x0:x1], cv2.COLOR_RGB2BGR)
    scale = min(1.0, 1600 / max(img.shape[:2]))
    if scale < 1.0:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    img = (img.astype(np.float32) * 0.55 + 255 * 0.45).astype(np.uint8)  # wash out for contrast

    def draw(ring: Any, color: tuple[int, int, int]) -> None:
        pts = (np.asarray(ring.coords)[:, :2] - (x0, y0)) * scale
        cv2.polylines(img, [np.round(pts * 4).astype(np.int32)], True, color, 1, cv2.LINE_AA, shift=2)

    for p in geom_px.geoms:
        draw(p.exterior, (0, 0, 220))
        for r in p.interiors:
            draw(r, (220, 90, 0))
    return _png(img)


def _render_solid(geom: MultiPolygon, size_px: int = 1200) -> bytes:
    minx, miny, maxx, maxy = geom.bounds
    span = max(maxx - minx, maxy - miny)
    s = (size_px - 20) / span
    w = int(np.ceil((maxx - minx) * s)) + 20
    h = int(np.ceil((maxy - miny) * s)) + 20
    img = np.full((h, w), 255, np.uint8)

    def pts(ring: Any) -> np.ndarray:
        c = np.asarray(ring.coords)[:, :2]
        x = (c[:, 0] - minx) * s + 10
        y = (maxy - c[:, 1]) * s + 10  # Y-up geometry -> Y-down raster
        return np.round(np.column_stack((x, y)) * 16).astype(np.int32)

    for p in geom.geoms:
        cv2.fillPoly(img, [pts(p.exterior)], 0, cv2.LINE_AA, shift=4)
        for r in p.interiors:
            cv2.fillPoly(img, [pts(r)], 255, cv2.LINE_AA, shift=4)
    # Islands sit inside holes of other components: paint them again on top.
    for p in sorted(geom.geoms, key=lambda q: q.area):
        cv2.fillPoly(img, [pts(p.exterior)], 0, cv2.LINE_AA, shift=4)
        for r in p.interiors:
            cv2.fillPoly(img, [pts(r)], 255, cv2.LINE_AA, shift=4)
    return _png(img)


# ----------------------------------------------------------------------- trace


def _components(geom: MultiPolygon) -> list[dict[str, Any]]:
    polys = list(geom.geoms)
    hole_polys = [(i, j, Polygon(r)) for i, p in enumerate(polys) for j, r in enumerate(p.interiors)]
    out = []
    for i, p in enumerate(polys):
        island_of = None
        pt = p.representative_point()
        for owner, hole_idx, hp in hole_polys:
            if owner != i and hp.contains(pt):
                island_of = {"component": owner, "hole": hole_idx}
                break
        out.append({
            "index": i,
            "area": p.area,
            "holes": len(p.interiors),
            "bounds": list(p.bounds),
            "island_of": island_of,
        })
    return out


def trace_image(data: bytes, settings: TraceSettings | None = None) -> TraceResult:
    settings = settings or TraceSettings()
    started = time.perf_counter()
    dec = decode_image(data, settings)
    gray = dec.gray
    h, w = gray.shape
    if min(h, w) < settings.min_source_side_px:
        raise TraceError("SOURCE_TOO_SMALL",
                         f"Image is {w}×{h} px; at least {settings.min_source_side_px} px on the short side is required.",
                         {"width": w, "height": h, "min_side_px": settings.min_source_side_px})

    otsu = _otsu(gray)
    flattened = False
    if settings.flatten_background:
        gray, flattened = _flatten_background(gray, otsu)
        otsu = _otsu(gray)
    metal_mode, bg_mode = _modes(gray, otsu)
    separation = bg_mode - metal_mode
    dark_fraction = float((gray < otsu).mean())
    if separation < settings.min_mode_separation or dark_fraction < 0.001:
        raise TraceError("LOW_CONTRAST",
                         "The artwork does not separate clearly from the background; dark metal on a light "
                         "background is required.",
                         {"metal_luminance": metal_mode, "background_luminance": bg_mode,
                          "separation": separation, "min_separation": settings.min_mode_separation,
                          "dark_fraction": round(dark_fraction, 6)})

    noise = max(settings.noise_min_px, int(round(settings.noise_image_fraction * h * w)))
    candidates: dict[int, float | None] = {}
    for f in settings.candidate_fractions:
        t = int(round(metal_mode + f * separation))
        candidates.setdefault(t, f)
    candidates.setdefault(otsu, None)
    thresholds = sorted(candidates)
    # Score candidates on summary statistics only; full masks and label images
    # are rebuilt below for the chosen candidate and its neighbours, which
    # bounds memory to a few image-sized arrays whatever the candidate count.
    segs = [_segment(gray, t, candidates[t], noise).summary() for t in thresholds]
    # Nominal luminance spacing of the candidate grid, for instability normalization.
    fractions = sorted(settings.candidate_fractions)
    gaps = [b - a for a, b in zip(fractions, fractions[1:])]
    step = max(1.0, separation * min(gaps)) if gaps else 1.0
    for i, seg in enumerate(segs):
        seg.score = _instability(seg, segs[max(0, i - 1):i] + segs[i + 1:i + 2], step)

    def preference(i: int) -> tuple[float, float]:
        f = segs[i].fraction
        dist = abs(f - settings.preferred_fraction) if f is not None else 1.0
        return (round(segs[i].score, 4), dist)

    best_i = min(range(len(segs)), key=preference)

    def full(i: int) -> Segmentation:
        seg = _segment(gray, segs[i].threshold, segs[i].fraction, noise)
        seg.score = segs[i].score
        return seg

    chosen = full(best_i)
    darker = full(best_i - 1) if best_i > 0 else None
    lighter = full(best_i + 1) if best_i + 1 < len(segs) else None
    neighbours = [n for n in (darker, lighter) if n is not None]
    candidate_report = [
        {"threshold": s.threshold, "fraction": s.fraction, "metal_area_px": s.metal_area,
         "components": s.component_count, "holes": s.hole_count,
         "instability": None if not np.isfinite(s.score) else round(s.score, 5)}
        for s in segs
    ]
    if chosen.metal_area == 0:
        raise TraceError("LOW_CONTRAST", "No dark material was found in the image.", {"candidates": candidate_report})

    warnings: list[dict[str, Any]] = []
    stable = _stable_components(chosen, neighbours)
    unstable = [la for la in range(1, chosen.component_count + 1) if not stable[la]]
    largest = int(np.argmax(chosen.component_areas)) + 1
    specks: list[int] = []
    ambiguous: list[dict[str, Any]] = []
    for la in unstable:
        area = int(chosen.component_areas[la - 1])
        vanishes_darker = darker is not None and _match_components(chosen, darker)[0][la] == 0
        if la != largest and area <= settings.speck_max_noise_multiple * noise and vanishes_darker:
            specks.append(la)
            continue
        ys, xs = np.nonzero(chosen.labels == la)
        ambiguous.append({"area_px": area, "bbox_px": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                          "is_largest": la == largest})
    if ambiguous:
        code = "AMBIGUOUS_SEGMENTATION" if any(a["is_largest"] for a in ambiguous) else "DISCONNECTED_MATERIAL"
        raise TraceError(code,
                         "Some material separates or merges depending on the threshold, so its shape is ambiguous. "
                         "Use an image with clearer separation between pieces.",
                         {"threshold": chosen.threshold, "components": ambiguous, "candidates": candidate_report})
    speck_area = int(sum(chosen.component_areas[la - 1] for la in specks))
    if specks:
        chosen = _drop_labels(chosen, specks)
        warnings.append({"code": "SHADOW_SPECKS_REMOVED",
                         "message": f"Removed {len(specks)} faint specks that only appear at lighter thresholds.",
                         "details": {"count": len(specks), "area_px": speck_area}})

    if chosen.holes_filled_count:
        warnings.append({"code": "SMALL_OPENINGS_FILLED",
                         "message": f"Filled {chosen.holes_filled_count} openings smaller than the "
                                    f"{noise} px noise limit; inspect fine detail in the overlay.",
                         "details": {"count": chosen.holes_filled_count, "area_px": chosen.holes_filled_px,
                                     "noise_area_limit_px": noise}})

    mask = chosen.mask
    b = settings.clip_border_px
    edges = {"left": bool(mask[:, :b].any()), "right": bool(mask[:, w - b:].any()),
             "top": bool(mask[:b, :].any()), "bottom": bool(mask[h - b:, :].any())}
    if any(edges.values()):
        raise TraceError("OBJECT_CLIPPED",
                         "The artwork touches the image edge, so part of it may be cut off. Use an image with "
                         "background visible on every side.",
                         {"edges": [k for k, v in edges.items() if v], "threshold": chosen.threshold})

    ys, xs = np.nonzero(mask)
    obj = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    if max(obj[2] - obj[0], obj[3] - obj[1]) < settings.min_object_side_px:
        raise TraceError("SOURCE_TOO_SMALL",
                         f"The artwork spans only {max(obj[2] - obj[0], obj[3] - obj[1])} px; at least "
                         f"{settings.min_object_side_px} px is required for a usable outline.",
                         {"object_bbox_px": list(obj), "min_object_side_px": settings.min_object_side_px})

    pad = 3
    crop = (max(0, obj[0] - pad), max(0, obj[1] - pad), min(w, obj[2] + pad), min(h, obj[3] + pad))
    refined, k, method = _refine(gray, mask, chosen.threshold, crop, settings)
    if method == "mask" and k > 1:
        warnings.append({"code": "REFINEMENT_FALLBACK",
                         "message": "Sub-pixel refinement changed topology; the exact pixel boundary was used.",
                         "details": {}})
    polys = _contours_to_polygons(refined, k, (crop[0], crop[1]))
    if not polys:
        raise TraceError("INVALID_CONTOURS", "No closed contours could be extracted.", {})
    geom_px, tol_used, area_change = _simplify(polys, settings.simplify_tolerance_px,
                                               settings.max_simplify_area_change)
    expected_topology = (chosen.component_count, chosen.hole_count)
    if geo.topology_signature(geom_px) != expected_topology:
        # Pinch splits can only add components; anything else is a real mismatch.
        comps, holes = geo.topology_signature(geom_px)
        if holes != expected_topology[1] or comps < expected_topology[0]:
            raise TraceError("INVALID_CONTOURS",
                             "Vector contours do not match the segmented topology.",
                             {"expected": {"components": expected_topology[0], "holes": expected_topology[1]},
                              "actual": {"components": comps, "holes": holes}})
        warnings.append({"code": "PINCH_POINTS_SPLIT",
                         "message": "Diagonal pixel joints were split into separate pieces.",
                         "details": {"components": comps, "segmented_components": expected_topology[0]}})
    nverts = geo.vertex_count(geom_px)
    if nverts > settings.max_vertices:
        raise TraceError("INVALID_CONTOURS",
                         f"The outline has {nverts} vertices, above the {settings.max_vertices} limit.",
                         {"vertex_count": nverts, "max_vertices": settings.max_vertices})

    minx, miny, maxx, maxy = geom_px.bounds
    span = max(maxx - minx, maxy - miny)
    s = 1.0 / span
    # x' = (x - minx) / span ; y' = (maxy - y) / span  (image Y-down -> Y-up, once)
    norm = affinity.affine_transform(geom_px, [s, 0.0, 0.0, -s, -minx * s, maxy * s])
    norm = geo.as_multipolygon(geo.polygons_of(norm))
    if not geo.is_valid(norm):
        raise TraceError("INVALID_CONTOURS", "Normalized geometry is invalid.",
                         {"reason": shapely.is_valid_reason(norm)})

    components = _components(norm)
    islands = [c for c in components if c["island_of"] is not None]
    if len(components) > 1:
        warnings.append({"code": "MULTIPLE_COMPONENTS",
                         "message": f"The artwork has {len(components)} separate pieces of metal; all are kept.",
                         "details": {"components": len(components), "islands_in_holes": len(islands)}})
    nb = [n.hole_count for n in neighbours]
    if nb and chosen.hole_count and max(abs(n - chosen.hole_count) for n in nb) > 0.1 * chosen.hole_count:
        warnings.append({"code": "HOLES_THRESHOLD_SENSITIVE",
                         "message": "The number of small openings changes noticeably between neighbouring "
                                    "thresholds; inspect small holes in the overlay.",
                         "details": {"holes": chosen.hole_count, "neighbour_holes": nb}})

    aspect = (maxx - minx) / (maxy - miny)
    diagnostics = {
        "threshold": chosen.threshold,
        "candidates": candidate_report,
        "noise_area_limit_px": noise,
        "noise_removed_area_px": chosen.noise_removed_px + speck_area,
        "holes_filled_area_px": chosen.holes_filled_px,
        "luminance": {"metal_mode": metal_mode, "background_mode": bg_mode, "otsu": otsu,
                      "background_flattened": flattened},
        "refinement": {"method": method, "supersample": k},
        "simplification": {"tolerance_px": tol_used, "relative_area_change": area_change},
        "object_bbox_px": list(obj),
        "segmented_topology": {"components": expected_topology[0], "holes": expected_topology[1]},
        "warnings": warnings,
        "runtime_s": round(time.perf_counter() - started, 3),
    }
    transform = {
        "source_bounds_px": [minx, miny, maxx, maxy],
        "scale": s,
        "flip_y": True,
        "formula": "x_norm = (x_px - source_bounds_px[0]) * scale; y_norm = (source_bounds_px[3] - y_px) * scale",
        "image_size_px": [w, h],
        "exif_orientation": dec.exif_orientation,
        "alpha_composited_on_white": dec.had_alpha,
    }
    return TraceResult(
        geometry=norm,
        aspect_ratio=aspect,
        image_width=w,
        image_height=h,
        transform=transform,
        components=components,
        holes=geo.hole_count(norm),
        vertex_count=geo.vertex_count(norm),
        diagnostics=diagnostics,
        svg=geo.to_svg(norm),
        overlay_png=_render_overlay(dec.rgb, geom_px, crop),
        solid_png=_render_solid(norm),
    )
