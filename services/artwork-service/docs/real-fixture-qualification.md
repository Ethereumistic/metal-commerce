# Real fixture tracing qualification

Tracer `opencv-contours` 1.0.0 with default `TraceSettings`. The fixtures are the
owner's three product photos, copied byte for byte into `tests/fixtures/real/`.
Reproduce with:

```sh
uv run pytest -q -s tests/test_tracing_real.py            # assertions and metrics
uv run python -m artwork_service trace-file tests/fixtures/real/flower.png /tmp/out   # overlays
```

Measured on the Omarchy PC (i9-7900X), one fixture per process (`trace-file`),
2026-10-25. Peak RSS is dominated by the 4× supersampled boundary refinement
(bounded by `max_supersampled_side_px`).

| Fixture | SHA-256 | Result | Components | Islands in holes | Holes | Vertices | Aspect (w/h) | Threshold | Runtime | Peak RSS | SVG |
|---|---|---|---|---|---|---|---|---|---|---|---|
| flower.png 1254×1254 | `def78de9…1b5da` | master | 1 | 0 | 22 | 4 969 | 0.919 | 96 | 4.4 s | 811 MB | 84 KB |
| trees.png 1600×1600 | `a420e83b…d69` | master | 1 | 0 | 140 | 9 630 | 2.550 | 115 | 3.9 s | 786 MB | 162 KB |
| motorcycle.png 1254×1254 | `74613ebc…7e4` | master | 3 | 2 | 191 | 10 575 | 1.434 | 122 | 1.8 s | 554 MB | 179 KB |

All three produce verified masters: the geometry is valid, the vector topology
(components, holes) equals the segmented raster topology exactly, sub-pixel
refinement succeeded without fallback, and the simplification changed area by
less than 0.1 %.

## What was inspected

Overlays (`*-overlay.png`, contours drawn on the washed-out photo: red = outer
contours, blue = holes) and zoomed crops were compared with the photos.

- **Flower.** One piece, 22 openings: every visible window, hexagon cell and
  lens-shaped petal slit is outlined in the overlay. Soft offset shadows inside the
  windows are excluded; the contour follows the metal edge, with a few small
  bumps of at most ~1 px where shadow meets an edge near petal tips.
- **Trees.** One piece including the frame (the frame is artwork, not
  background). Branches stay connected; 140 openings including the narrow gaps
  between grass blades and canopy openings.
- **Motorcycle.** Three pieces: the motorcycle and mountain base (one piece) and
  two free-standing hub discs inside the wheel-hub openings, kept as islands.
  Spokes, fork slots and the narrow curved slots are preserved as holes.

## Remaining visual ambiguity (not exact reconstruction)

- The photos are of physical cut-outs under directional light. Shadow falls
  through openings onto the wall, so very small openings appear mid-grey rather
  than white. Openings smaller than the noise limit (12 px ≈ 3×4 px) are filled
  and reported with the `SMALL_OPENINGS_FILLED` warning: flower 17 px total,
  trees 175 px, motorcycle 86 px. These are mostly tiny canopy openings (trees)
  and brake-disc holes (motorcycle).
- Hole counts depend on the threshold for the trees (158 holes at a darker
  threshold, 123 at Otsu): the darker thresholds open shadow-filled canopy
  gaps, the lighter ones close them. The selected candidate is the most stable
  one when judged against both neighbouring thresholds; every candidate is
  listed in the master's `diagnostics.candidates`.
- Geometry precision cannot exceed the source: at 600 mm width one source pixel
  is about 0.4–0.5 mm. The contours are sub-pixel interpolated from grey levels,
  not invented detail.
- Feature widths are not qualified against a fabrication profile (no workshop
  limits exist yet); batch lines report `feature_check.status = "unknown"`.

## Pipeline changes made during qualification

The first draft traced the flower and motorcycle but failed the trees with
`INVALID_CONTOURS`, and fell back to staircase pixel contours for the flower.
Root causes and fixes:

1. Diagonal-only pixel joints produced self-touching rings that split into
   extra pieces or merged holes with the outside. They are now resolved by the
   grey level at the shared corner before any topology analysis.
2. Cubic supersampling created detached sub-pixel specks and occasionally
   broke a 1-px neck or wall. Refinement is now constrained to the native
   topology, reverting only the disagreeing regions locally.
3. OpenCV contours through pixel centres gave one-pixel necks zero width; the
   contour is traced on a 2× nearest upsample so every feature keeps a width.
4. Otsu's threshold was off by one against this module's `gray < t`
   convention, and candidate stability is now normalized per grid step and
   judged in both directions (a candidate next to a near-identical threshold
   no longer looks artificially stable).
