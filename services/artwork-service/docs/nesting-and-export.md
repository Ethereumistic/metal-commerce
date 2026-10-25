# Nesting, layout validation and production export

Modules: `nesting_types.py` (contract types), `solver_adapter.py` (PackingSolver),
`nesting.py` (`nest_group`, bbox baseline, metrics), `validation.py`
(`validate_layout`), `dxf_export.py` (`export_sheet_dxf`, `export_sheet_svg`,
`verify_dxf`, `build_package`). Plan sections 8, 9 and 13.

## Geometry convention

Shapely, millimetres, Y-up, part origin at the lower-left of its un-rotated
bounding box. A placement is `world = translate(rotate_ccw(part, rotation_deg,
origin=(0, 0)), tx_mm, ty_mm)` in sheet coordinates (lower-left origin). Quarter
turns use exact matrices. Mirroring is never applied. The image Y-down to Y-up
flip happens once, upstream, in the tracer; nothing here flips Y.

## Nesting flow (`nest_group`)

1. Validate the request (finite non-negative stock numbers, usable area > 0,
   `max_sheets >= 1`, bbox-normalised valid geometry, unique instance ids,
   whole-degree rotations).
2. **Pre-fit**: every part must fit the usable envelope at one or more allowed
   rotations, otherwise `NestingError("PART_DOES_NOT_FIT")` with the part's size
   and usable envelope, before any optimisation. A 1500 mm part on a 1500 mm
   sheet with positive side margins fails here.
3. **Baseline**: first-fit-decreasing shelves over rotated bounding boxes,
   stacked along the sheet's long axis. Always computed and reported as
   `baseline_metrics`; it is the fallback and the comparison point.
4. **Solver** (PackingSolver irregular) inside the time budget: the first
   attempt gets 70 % of the budget; if its layout fails validation it is rerun
   once with a safer contour (extra outward offset `max(0.25, 0.1 * gap)` mm)
   in the remaining time. No usable solution (error, timeout before the first
   solution) means fall back to the baseline straight away.
5. Validate every candidate with `validate_layout` against the **original**
   geometry, holes included. Keep the better valid one, ranked by (unplaced
   count, sheet count, last-sheet extent). The solver's own flags are never
   trusted.
6. Status is `complete` only when every instance is placed on a valid layout;
   `incomplete` lists `unplaced_instance_ids` (for example when `max_sheets` is
   too small); `cancelled` returns no sheets. Only profit-free objectives are
   used, so the solver never drops parts on purpose.

Instance ids are assigned per part in sheet order (sheets sorted fullest
first, placements by y then x), taking the caller's `instance_ids` in order.

## Solver integration

- Pinned PyPI wheel `packingsolver==0.1.1218` (`packingsolver.irregular`
  bindings, HiGHS backend), not a native CLI build.
- Runs as `python -m artwork_service.solver_adapter <workdir> <time_limit>` in a
  child process (own session). The parent polls every 50 ms and kills the
  child on cancellation or when the hard wall-clock limit is reached. The
  solver's `time_limit` is set to 80 % of the attempt budget because it
  excludes instance construction. Each improving solution is written
  atomically to `best.json` from the solver callback, so a killed run still
  returns its best certificate.
- Objective `bin-packing-with-leftovers`. `leftover_mode` is `bottom` for tall
  sheets (minimise last-sheet y extent) and `left` for wide sheets.
- **Gap**: applied once, by the adapter. Each collision contour is inflated by
  `gap_mm / 2` (its `clearance_mm`) and `item_item_minimum_spacing` is 0, so
  two disjoint contours keep the original parts at least `gap_mm` apart. The
  solver's own spacing is not used: on some traced contours (near-degenerate
  chamfers at concave corners, e.g. a traced comb on a 1500 x 3000 mm sheet)
  PackingSolver 0.1.1218 fails while building the instance with "face area is
  not positive", and the job silently fell back to bounding boxes. A
  regression test (`test_traced_comb_instance_builds_and_solves`) keeps that
  contour. `build_instance` refuses contours whose clearance is not `gap / 2`.
- **Margins**: one rectangular bin type equal to the usable area grown by
  `gap / 2` on every side (the clearance must not eat into the margins),
  positioned with the bin's `x`/`y`, so the certificate is already in sheet
  coordinates. Per-side margins need no `item_bin_minimum_spacing`, which is
  not set (its CLI flag is a no-op upstream anyway).
- **Stock**: bin `copies = max_sheets`. Certificate bins with `copies: n` are
  expanded into n separate physical sheets.
- **Holes**: never sent. The solver sees outer contours only, so no part can
  be placed inside another part's hole in v1. Holes stay in the export.
- **Rotations**: one `{start: a, end: a, mirror: false}` entry per allowed angle.
  Certificates with `mirror: true`, non-integer angles or unknown item ids are
  rejected.
- **Transform mapping**: the certificate transform is mirror, then rotate CCW
  about the origin, then translate by `(x, y)`. With mirroring off, this is the
  contract transform, so `x`/`y` map directly to `tx_mm`/`ty_mm`. A test checks
  this against the solver's own transformed outlines.
- **Collision contour**: the filled outline is buffered outward by `clearance +
  2 * tol + safety` (mitre joins), then Douglas-Peucker simplified at `tol`.
  The simplification moves the boundary by at most `tol`, so the result stays
  outside the original grown by the clearance. Containment of that clearance
  zone is checked with `covers`. The tolerance
  starts at `max(0.05, 0.0005 * part size)` mm and doubles until the contour
  has at most 300 vertices (solver preprocessing cost grows steeply with vertex
  count). The Hausdorff error beyond the clearance zone is recorded per part in
  `settings.attempts[].collision_contours[].max_error_mm`.
- **Seed**: the requested seed is recorded, but `seed_applied: false`. The
  0.1.1218 Python bindings do not expose a seed. The native CLI does (`--seed`),
  but it is not shipped in the wheel. In practice, repeated runs of the
  benchmark fixtures produced identical layouts (seeds 1 and 2, and 10 s vs 30 s
  budgets). This is not guaranteed, because results are time-bounded.

## Validation (`validate_layout`)

Independent of the solver. It recomputes everything from the original
geometry and the placements:

- requested ids are unique, and each is placed at most once (`DUPLICATE_INSTANCE`);
- each id is placed exactly once (`MISSING_INSTANCE` unless `allow_unplaced`);
- placed ids are known and carry the right part/line/product;
- rotation is in the allowed set; translations are finite;
- each transformed part's bounds lie inside the usable rectangle, within
  1e-6 mm (`OUT_OF_BOUNDS`);
- sheet count is at most `max_sheets`;
- pairwise distance between the actual parts (holes included) is at least
  `gap - 1e-6`. Candidate pairs come from an STRtree `dwithin` query on the
  filled outlines (`OVERLAP`, `GAP_VIOLATION`). With zero gap, touching is
  allowed and overlapping area is not;
- the filled outlines must also keep the gap, so a part inside another part's
  hole is rejected (`INSIDE_HOLE`).

## Metrics

- `metal_area_mm2` = sum of nominal part areas, holes excluded.
- `sheet_area_mm2` = full sheet width x height x used sheets.
- `utilization` = metal_area / sheet_area. This is retained-metal utilisation,
  not bounding-box coverage.
- `occupied_extent_mm` = furthest part coordinate along the sheet's long axis
  on the last sheet, measured from the sheet origin. It is also reported per
  sheet.
- `unused_area_mm2` = sheet_area - metal_area. It is not claimed as reusable
  stock.

## DXF export

- ezdxf R2010, `$INSUNITS = 4` (mm), `$MEASUREMENT = 1`. Only modelspace
  entities: one closed, zero-width `LWPOLYLINE` per exterior and per hole, all
  on layer `0`. No sheet rectangle, margins, labels or text.
- Coordinates are sheet lower-left, Y-up. Exteriors are CCW and holes CW.
- Input contours are already polylines, so `chord_tolerance_mm` (default
  0.05) only bounds the cleanup. Duplicate vertices (< 1e-6 mm) are removed,
  then rings are simplified with topology preserved at the tolerance. If
  simplification would change topology or validity, the cleaned original ring
  is kept.
- Passing `created_at` fixes the header timestamps, the GUIDs and ezdxf's
  metadata stamp, so the bytes are reproducible.

`verify_dxf` uses its own group-code parser (not ezdxf). It checks `$INSUNITS`,
that every entity is an `LWPOLYLINE` on layer `0`, closure, zero widths, no
bulges, declared versus actual vertex counts, no geometry in blocks, loop count
= exteriors + holes, overall bounds, and that every loop matches exactly one
expected contour within tolerance (Hausdorff, sampled at quarter segments and
measured point-to-segment through an STRtree; candidates whose bounds differ
by more than the tolerance are skipped, since bounds differ by at most the
Hausdorff distance). It records the maximum error. It then runs `ezdxf.read`
plus `audit()` as a second opinion.

`tests/js/verify-dxf.mjs` re-reads every DXF of an extracted package with the
third-party JavaScript reader `dxf-parser` 1.1.2 (installed in `tests/js` with
`npm ci`), independent of both the exporter's parser and ezdxf. Against
`manifest.json` it checks SHA-256, `$INSUNITS = 4`, only closed zero-width
bulge-free `LWPOLYLINE`s on layer `0`, nothing inside blocks, exterior (CCW)
and hole (CW) loop counts, signed area against placed metal area, every vertex
inside the usable area, overall bounds, and that each placement's transformed
bounding box is reproduced by the loops inside it.
`tests/nesting/test_js_dxf_reader.py` runs it (skipped with a message when
node or the package is missing), and `scripts/acceptance.py` runs it on every
downloaded package.

## Package (`build_package`)

Input: one `PackageGroup` per material/thickness group. It refuses
incomplete nests (`NEST_INCOMPLETE`), layouts that fail re-validation
(`LAYOUT_INVALID`) and DXFs that fail read-back (`EXPORT_INVALID`). Sheets are
numbered consecutively across groups:
`batch-<id>-sheet-001-1500x3000mm.dxf` plus a matching `.svg` preview (sheet
outline, dashed margin guide, per-product colours, instance numbers, optional
legend). Repeated sheets are written as separate files.

`manifest.json` contains:

- `context`: the caller's frozen batch, profile and master revisions, source
  hashes and requested sizes, copied verbatim;
- versions: tracer and service from the caller, plus exporter, ezdxf, shapely
  and packingsolver;
- export settings;
- per group: material, thickness, stock with margins, gap, part list with
  sizes, counts and rotations, nesting engine, settings, metrics, baseline
  metrics and the validation report;
- per sheet: placements with transforms, DXF/SVG filenames, SHA256 and sizes,
  and the DXF check;
- totals and the `created_at` timestamp.

The ZIP is deterministic: fixed entry dates, fixed order and permissions, and
deflate level 9.

## Benchmarks

`uv run python scripts/bench_nesting.py --budget 10` (fixtures from
`tests/nesting/nest_shapes.py`, 1500 x 3000 mm sheet, margins l/r/b/t
10/15/20/25 mm, gap 5 mm). Recorded 2026-10-25 on the Omarchy workstation:

| fixture | engine | placed | sheets | utilization | last-sheet extent | wall time | bbox baseline (sheets / util / extent) |
|---|---|---|---|---|---|---|---|
| mixed 44 x L 300 mm + 10 x plate with hole | packingsolver | 54/54 | **1** | 0.447 | 1713.9 mm | 6.0 s | 2 / 0.223 / 625.0 mm |
| concave 40 x comb 320 x 290 mm (0/180) | packingsolver | 40/40 | 1 | 0.363 | **1931.1 mm** | 6.0 s | 1 / 0.363 / 2965.0 mm |

- Mixed batch: one sheet instead of two. L-brackets interlock, which bounding
  boxes cannot do.
- Concave combs: the same sheet count, but the occupied length is 1034 mm
  (35 %) shorter, because the teeth interleave.
- A 30 s budget gave identical layouts for both fixtures, and so did seed 2.
- Wall time is about 60 % of the budget: the first attempt gets 70 % of the
  budget, the rest is held back for the safer-contour retry, and the solver
  stopped at its own time limit.
- The unit test `test_concave_interleaving_beats_bbox_baseline` puts 8 combs
  on a 700 x 700 mm sheet. That takes 1 sheet instead of the baseline's 2.

These are time-bounded heuristics on synthetic fixtures. They are not
optimality claims or runtime guarantees.

## Known limits

- No nesting inside holes, no common-line cutting, no tabs (v1 scope).
- Seed is not applied (see above).
- If the solver needs more than the hard limit just to build the instance,
  the result is the baseline. This can happen with very many distinct part
  types, because each type is bounded at 300 collision vertices.
