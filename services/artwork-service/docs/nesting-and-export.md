# Nesting, layout validation and production export

Modules: `nesting_types.py` (contract types), `solver_adapter.py` (PackingSolver),
`nesting.py` (`nest_group`, bbox baseline, metrics), `gap_fill.py`
(`fill_gaps`), `validation.py`
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
   in the remaining time minus 10 % of the budget kept for gap filling. No
   usable solution (error, timeout before the first solution) means fall back
   to the baseline straight away. While the solver runs (in a helper thread
   that only waits on the child process), the calling thread already
   gap-fills the solver's newest valid solution (step 6); a newer solution
   interrupts that fill and restarts it on the newer layout.
5. **Select**: validate every candidate with `validate_layout` against the
   **original** geometry, holes included, and keep the better valid one:
   fewer unplaced, then fewer sheets, then shorter last-sheet extent, where the
   irregular layout wins any extent difference up to 1 % of the usable length
   (its conservative collision contours can leave it a millimetre or two above
   an otherwise equal bounding-box layout). The solver's own flags are never
   trusted. `settings.selection` records the choice.
6. **Gap fill** (`gap_fill.py`, below) on the selected layout until it
   converges or the budget ends, continuing the speculative fill of step 4
   when it ran on exactly this layout (its filler phase is not repeated). The
   filled layout is re-validated and kept only if it is valid and not worse
   by (unplaced, sheets, last-sheet extent); `settings.gap_fill` records
   moves, searches, runtime, how it stopped, whether it was applied or
   rejected, and `filler_phase: {status, fillers, tucked}`.
7. Status is `complete` only when every instance is placed on a valid layout;
   `incomplete` lists `unplaced_instance_ids` (for example when `max_sheets` is
   too small); `cancelled` returns no sheets. Only profit-free objectives are
   used, so the solver never drops parts on purpose.

Solver sheets are ordered by occupied extent, longest first (then fullest),
so the last sheet is the remnant sheet. Instance ids are assigned per part in
sheet order (placements by y then x), taking the caller's `instance_ids` in
order; after gap filling they are reassigned the same way.

`outcome.engine` names the engine that produced the layout
(`packingsolver-irregular` or `bbox-baseline`); gap filling does not change
it, its move count is `metrics.gap_fill_moves`.

## Gap filling (`gap_fill.py`)

PackingSolver's objective (fewest bins, then the shortest last bin) is
indifferent to where small parts sit on the earlier sheets, and the
bounding-box fallback cannot use concavities at all. The pass has two phases.

**1. Filler phase** (only when the group has a filler tier). Fillers
(`filler_parts`) are the smallest parts up to a jump of at least 4x in filled
area to the next part size, provided all their copies together cover at most
10 % of the other parts' filled area; the largest such tier wins. For the
owner's batch these are the 70 and 100 mm shurikens (not the 300 mm stars:
44 stars are 41 % of the wave pieces' area, far more than the gaps among
them can take). The phase:

1. lifts every filler off the layout;
2. compacts the remaining parts (phase 2 rules) until half of the remaining
   time, so the larger parts first settle into the strip the fillers leave;
3. places the fillers again, largest first: on the earliest sheet that has
   room for the filler **inside its occupied box** (so it never enlarges a
   sheet's envelope), at the position with the **most contact**: obstacle
   cells of the non-filler parts within 10 mm around the filler, one more
   `cv2.filter2D` correlation per rotation with a band kernel. Contact
   ignores other fillers and the sheet edge, so fillers seek the pockets
   between large parts (including outer concavities) instead of lining up
   with each other or along the margin; ties go to the lowest position. All
   allowed rotations are tried. Only when no occupied box has room does a
   filler go to the lowest free position on the earliest sheet with room,
   and failing that back where it was;
4. if it is cancelled, runs out of time or finds no position at all, the
   layout it started from is used unchanged (`status: "abandoned: ..."`).

`settings.gap_fill.filler_phase` reports `status` (`applied`, `none` or
`abandoned: <reason>`), `fillers` (parts placed) and `tucked` (of those,
placed inside an occupied box).

**2. Compaction.** Single parts move to the lowest free position along the
long axis:

- parts on the last sheet may go anywhere on earlier sheets (this can save the
  sheet or shorten it), or lower on the last sheet;
- every other part may only move to an earlier sheet or lower on its own
  sheet **inside that sheet's occupied box** (usable origin to the farthest
  part on both axes), so the remnant strip and a free side column stay intact;
- fillers placed by phase 1 stay where they are (moving them to the lowest
  position would pull them back into a strip of their own);
- order per pass: parts on the last sheet, then small parts (filled area at
  most 25 % of the largest part), then the rest; later sheets and farther
  parts first. Passes repeat until no part moves, the deadline, or cancel.

Search: obstacles (filled outlines grown by the gap) and each part at each
allowed rotation are rasterised at `max(2.5 mm, long side / 1200)` with a
0.75-cell margin (more than half a cell diagonal), so the raster is
conservative; one `cv2.filter2D` correlation per rotation gives every grid
translation where the part's cells miss all obstacle cells. Rotations whose
raster equals an earlier rotation's (symmetric parts) are skipped, and a
distance-transform bound skips parts too thick for the largest free disk.
Up to 6 best candidates per rotation (lowest, or most contact in phase 1)
are then checked **exactly** with Shapely (usable bounds, shell-to-shell
distance >= gap + 0.001 mm), and the finished layout is re-validated by
`validate_layout`. Holes are filled before rasterising and in the exact
check, so nothing lands in a hole (v1 rule).


## Solver integration

- Pinned PyPI wheel `packingsolver==0.1.1218` (`packingsolver.irregular`
  bindings, HiGHS backend), not a native CLI build.
- Runs as `python -m artwork_service.solver_adapter <workdir> <time_limit>` in a
  child process (own session). The parent polls every 50 ms and kills the
  child on cancellation or when the hard wall-clock limit is reached. The
  solver's `time_limit` is set to 80 % of the attempt budget because it
  excludes instance construction. Each improving solution is written
  atomically to `best.json` from the solver callback, so a killed run still
  returns its best certificate. The child also records the instance build
  time and the time of every improving solution; they are reported as
  `settings.attempts[].build_s` and `solution_times_s` (seconds since the child
  started). `run_solver(on_solution=...)` hands each improving certificate, and
  finally the run's own certificate if it differs, to the caller while the run
  continues (used for the speculative gap fill).
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
- `leftover_usable_area_mm2` (per sheet and summed; additive): the usable area
  outside the sheet's occupied box. The box runs from the usable origin
  corner to the farthest part plus the gap on both axes (clipped to the
  usable area), so the leftover is the uncut strip beyond the parts plus the
  free side column next to them: the part of the sheet that stays whole for a
  later job. Free space between parts is not counted.
  `last_sheet_leftover_usable_area_mm2` is the last sheet's value.
- `engine` (the engine that produced the layout) and `gap_fill_moves` (parts
  the gap-fill pass moved) are copied into the metrics for the UI.

The batch view (`GET /v1/batches/{id}`) adds, per sheet,
`metrics.leftover_usable_area_mm2`, and in `totals`:
`leftover_usable_area_mm2` (all groups), `leftover_usable_area_by_group_mm2`,
`engine_by_group` (`packingsolver-irregular` or `bbox-baseline` per group);
`totals.groups.<key>` carries the full group metrics and settings as before.

## DXF export

- ezdxf R2010, `$INSUNITS = 4` (mm), `$MEASUREMENT = 1`. Only modelspace
  entities: one closed, zero-width `LWPOLYLINE` per exterior and per hole, all
  on layer `0`. No sheet rectangle, margins, labels or text.
- Coordinates are sheet lower-left, Y-up. Exteriors are CCW and holes CW.
- Input contours are already polylines, so `chord_tolerance_mm` (default
  0.05) only bounds the cleanup. Duplicate vertices (< 1e-6 mm) are removed,
  then rings are simplified with topology preserved at the tolerance. If
  simplification would change topology or validity, the cleaned original
  polygon is kept. GEOS' topology-preserving simplifier can move a small ring
  by more than the tolerance (a 9 x 4 mm hole of the traced trees at 300 mm
  moved 0.066 mm at 0.05 mm, which failed read-back and so the whole package
  with `EXPORT_INVALID`), so every simplified ring is measured against its
  original with the same sampled Hausdorff check `verify_dxf` uses and the
  original ring is kept where it exceeds the tolerance.
- A part is simplified once per rotation in its own frame and translated to
  each placement (copies of a traced part are not simplified one by one).
- Passing `created_at` fixes the header timestamps, the GUIDs and ezdxf's
  metadata stamp, so the bytes are reproducible.

`verify_dxf` uses its own group-code parser (not ezdxf). It checks `$INSUNITS`,
that every entity is an `LWPOLYLINE` on layer `0`, closure, zero widths, no
bulges, declared versus actual vertex counts, no geometry in blocks, loop count
= exteriors + holes, overall bounds, and that every loop matches exactly one
expected contour within tolerance (Hausdorff, sampled at quarter segments and
measured point-to-segment; candidates whose bounds differ by more than the
tolerance are skipped, since bounds differ by at most the Hausdorff distance).
All candidate pairs of a sheet are measured in one batch: one envelope query of
the source segments, grown by the tolerance, against all target segments finds
every segment a sample could be within the tolerance of, and the distances
are plain vector arithmetic. It records the maximum error. It then runs
`ezdxf.read` plus `audit()` as a second opinion.

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
deflate level 6 (on traced sheets level 9 took about five times longer for
about 2.5 % smaller files).

## Benchmarks

`uv run python scripts/bench_nesting.py --budget 30 --package --real`
(fixtures from `tests/nesting/nest_shapes.py` and the traced photos in
`tests/fixtures/real`, 1500 x 3000 mm sheet, margins l/r/b/t 10/15/20/25 mm,
gap 5 mm; the script's docstring lists every fixture). `nest` is
`nest_group` wall time, `package` is `build_package` (DXF export and
read-back, SVG, manifest, ZIP), `total` = nest + package, i.e. a nest job
without database and file writes. Leftover is `leftover_usable_area_mm2` in
m². Recorded 2026-10-27 on the Omarchy workstation, 30 s budget, seed 1;
"before" is commit b175678 run from the same script. The machine was shared
with other jobs, so times vary by about +-10 %.

Before (b175678):

| fixture | engine | sheets (parts per sheet) | util | last-sheet extent | leftover | solver | nest | package | total |
|---|---|---|---|---|---|---|---|---|---|
| mixed-54 | irregular | 1 (54) | 0.447 | 1713.9 mm | 1.85 m² | 17.1 s | 17.2 s | 0.1 s | 17.2 s |
| concave-combs-40 | irregular | 1 (40) | 0.363 | 1931.1 mm | 1.67 m² | 17.2 s | 17.2 s | 0.1 s | 17.3 s |
| owner-54 | **bbox-baseline** | 4 (19/19/15/1) | 0.357 | 820.0 mm | 3.97 m² | 17.2 s | 17.3 s | 0.2 s | 17.4 s |
| owner-84 (+30 fillers) | **bbox-baseline** | 4 (23/23/36/2) | 0.359 | 820.0 mm | 3.72 m² | 17.3 s | 17.3 s | 0.2 s | 17.5 s |
| real-54 (traced) | irregular | 2 (35/19) | 0.319 | 2968.9 mm | 0.23 m² | 18.9 s | 19.3 s | **EXPORT_INVALID** after 15.6 s | 34.9 s |
| real-84 (traced, +30 fillers) | irregular | 2 (65/19) | 0.331 | 2952.4 mm | 0.03 m² | 18.9 s | 19.7 s | **EXPORT_INVALID** after 22.8 s | 42.5 s |

After (this version):

| fixture | engine | sheets (parts per sheet) | util | last-sheet extent | leftover | solver | gap-fill moves | nest | package | total |
|---|---|---|---|---|---|---|---|---|---|---|
| mixed-54 | irregular | 1 (54) | 0.447 | 1713.9 mm | 1.85 m² | 17.1 s | 0 | 17.2 s | 0.0 s | 17.3 s |
| concave-combs-40 | irregular | 1 (40) | 0.363 | 1931.1 mm | 1.67 m² | 17.2 s | 0 | 17.3 s | 0.1 s | 17.3 s |
| owner-54 | irregular | 4 (35/15/3/1) | 0.357 | 820.0 mm | **7.03 m²** | 17.2 s | 100 | 21.7 s | 0.1 s | 21.9 s |
| owner-84 (+30 fillers) | irregular | 4 (64/16/3/1) | 0.359 | 820.0 mm | **7.06 m²** | 17.2 s | 96 | 22.7 s | 0.2 s | 22.9 s |
| real-54 (traced) | irregular | 2 (22/32) | 0.319 | **2680.5 mm** | 0.43 m² | 18.8 s | 25 | 25.0 s | 15.0 s | 40.0 s |
| real-84 (traced, +30 fillers) | irregular | 2 (67/17) | 0.331 | 2917.5 mm | 0.08 m² | 19.0 s | 58 | 21.4 s | 18.7 s | 40.0 s |

- Sheet counts and last-sheet extents are never worse; utilisation is equal
  because it only depends on the sheet count.
- Owner batches: the irregular nest is now delivered instead of bounding-box
  shelves, and gap filling packs the stars and all 30 fillers onto the first
  sheet (64 parts) next to the wave pieces; sheet 3 keeps a clean 700 mm
  column beside its three wave pieces and the leftover usable area almost
  doubles (3.7 -> 7.1 m²).
- Traced batches now export (see "DXF export"), and gap filling shortened the
  last sheet of real-54 by 288 mm.
- Nest time: the solver still gets 70 % of the budget; gap filling runs during
  the solver's idle time (the owner batches' only solution came after 0.2 s
  and 0.7 s) and, if needed, in the remaining 30 %. Mixed/combs end when the
  solver ends because their fill converges at once.

Export stages on one fixed layout (bounding-box layout of real-84, 4 sheets,
`time_export`-style per-stage timing):

| stage | before | after |
|---|---|---|
| DXF write (4 sheets) | 6.7 s | 6.1 s |
| DXF read-back `verify_dxf` | 22.3 s | 8.8 s |
| SVG previews | 0.9 s | 0.9 s |
| full `build_package` incl. ZIP | fails (EXPORT_INVALID) | 17.9 s |

Earlier record (2026-10-25, 10 s budget, before gap filling): mixed-54 1
sheet / 1713.9 mm (baseline 2 sheets), concave combs 1 sheet / 1931.1 mm
(baseline 2965 mm); 30 s and seed 2 gave identical layouts. The unit test
`test_concave_interleaving_beats_bbox_baseline` puts 8 combs on a 700 x 700 mm
sheet in 1 sheet instead of the baseline's 2.

These are time-bounded heuristics on synthetic and three traced fixtures. They
are not optimality claims or runtime guarantees.

## Owner report 2026-10-26: empty space between the 300 mm parts

Reported: 10 wave-art parts at 800 x 800 mm + 44 parts near 300 x 300 mm on
1500 x 3000 mm sheets gave 4 sheets with visible empty space between the
300 mm parts where 50-150 mm parts would fit; QA saw ~38 s wall time for a
54-part job whose solver reported ~17.6 s. Reproduced with `owner-54` /
`owner-84` (synthetic: wave art with 70 mm deep wavy concave edges and two
cut-outs, five- and six-point stars, shurikens and kunai) and `real-54` /
`real-84` (traced flower, trees, motorcycle).

Root cause:

1. **The bounding-box fallback was delivered for the owner-type batch.** At
   most three 800 mm pieces fit on a 1475 mm wide sheet, so every layout needs
   4 sheets with one wave piece alone on the last sheet. The solver's layout
   was valid with 4 sheets, but the old ranking (unplaced, sheets, last-sheet
   extent) compared 821.x mm against the baseline's 820.0 mm: the collision
   contour (gap/2 + 2 x tol) lifts the solver's part about 1 mm, so the
   bounding-box shelves won. Those shelves are as tall as the wave pieces and
   hold stars two to a row in the 700 mm column beside them, with small parts
   on their own shelves: exactly the visible empty space.
2. **The solver had nothing left to optimise.** Its objective (fewest bins,
   then the shortest last bin) was met by its first solution (0.2-1.1 s,
   `solution_times_s`); it then ran idle to its 16.8 s limit, and the 30 %
   reserved for a safer-contour retry went unused. Even its own layout
   leaves small parts wherever the first solution put them, since earlier
   sheets do not count in its objective.
3. **Not the cause:** collision-contour coarseness (300-vertex contours are at
   most 3.2 mm outside the clearance for these parts; the 33.7 mm recorded for
   the traced motorcycle at 300 mm is a slot narrower than the clearance,
   closed on purpose), solver failures (none), leftover mode (the objective
   was met), item order or splitting identical parts into several item types
   (PackingSolver gave identical layouts and timings for 44 identical parts as
   1 or 4 item types).
4. **Wall time:** the non-solver ~20 s is `build_package` on traced
   geometry: DXF read-back (`verify_dxf`, one nearest-segment search per
   sample per contour) 22 s, DXF writing 7 s and ZIP level 9 about 5 s for 4
   sheets. And for traced trees at 300 mm the package failed outright:
   GEOS' topology-preserving simplification moved small holes up to 0.074 mm
   at a 0.05 mm tolerance, so read-back rejected the DXF (`EXPORT_INVALID`).

Changes: the irregular layout wins last-sheet extent ties within 1 % of the
usable length; gap filling (above) runs during the solver's idle time and in
the remaining budget, re-validated and kept only when not worse; new metrics
`leftover_usable_area_mm2` and per-group `engine`; simplified rings are
checked against the tolerance, simplification is cached per part and
rotation, read-back measures all contours of a sheet in one batch, and the
ZIP uses deflate level 6. Every validation step is unchanged.

Options evaluated and not adopted:

- Stop the solver at a proven sheet-count lower bound: the area bound is 2
  sheets for the owner batch (4 needed), and where it is met (mixed-54, 1
  sheet) the solver still shortened the last sheet after reaching it
  (solutions at 1.1 s and 2.8 s), so stopping would lose extent.
- Stop the solver after it stalls: real-54 improved after 6 s without a new
  solution (at 8.5 s and 15.0 s), so a stall rule would lose those.
- Finer or adaptive collision contours: the measured excess is <= 3.7 mm and
  only at sharp tips; gap filling places small parts with the exact gap.
- Several solver runs with other leftover modes: the owner batch already
  meets the objective; the seed is not exposed (see above).
- Parallel sheet export in threads: 2-4 threads gave 14 % (ezdxf is pure
  Python and holds the GIL); worker processes are daemonic and cannot spawn
  a process pool.


## Owner QA 2026-10-27: fillers in a strip of their own

Reported (browser QA, twice): the owner's real batch, 10 x Chromatic Waves at
800 mm + 44 x Starburst Compass at 300 mm + 20 x Leaf Four-Point Shuriken at
100 mm + 10 x Demon Wind Shuriken at 70 mm, steel 2 mm, 1500 x 3000 mm,
margins 10 mm, gap 5 mm, gave 84/84 on 4 sheets (55/25/3/1) with 126-205
gap-fill moves, but all 30 shurikens sat together in a strip at the bottom
of sheet 1 while the spaces among the stars stayed empty, at 30 s and at
120 s. An independent check found valid shuriken positions among the stars
with 6.9-9.7 mm clearance.

Root cause: compaction moves every part to the *lowest* free position. On a
solver layout whose bottom strip is free, the shurikens are already as low as
they can go, and a star cannot drop into the strip while they occupy it; no
single move improves anything, so the strip stays a filler strip. Moving a
shuriken up into a star pocket would only pay off after a star then takes its
place, which a one-part-at-a-time greedy pass never sees.

Change: the filler phase (see "Gap filling"): lift the fillers, let the
larger parts settle first, then put each filler into the tightest pocket
inside an occupied box, and keep the fillers there during compaction.
`fill_gaps(..., fillers_placed=True)` continues a fill without repeating the
phase. The owner's traced masters are now a fixture
(`tests/fixtures/real/owner-masters.json.gz`, geometry only, exported from
the dev catalogue) and a benchmark (`--owner-real`).

Benchmark, `uv run python scripts/bench_nesting.py --budget 30 --owner-real`
(2026-10-27, Omarchy workstation, seed 1; "before" is the previous gap fill,
commit d238783, run from the same script). The `owner-real-*` fixtures use the
owner's stock (1500 x 3000 mm, margins 10 mm, gap 5 mm); the others use the
benchmark stock above. "tucked" = fillers placed inside an occupied box by the
filler phase / fillers. Leftover is `leftover_usable_area_mm2` summed over
the sheets, in m².

| fixture | before: sheets (per sheet) / extent / leftover / moves / nest | after: sheets (per sheet) / extent / leftover / moves / tucked / nest |
|---|---|---|
| mixed-54 | 1 (54) / 1713.9 / 1.853 / 0 / 17.2 s | 1 (54) / 1713.9 / 1.853 / 0 / - / 17.2 s |
| concave-combs-40 | 1 (40) / 1931.1 / 1.667 / 0 / 17.2 s | 1 (40) / 1931.1 / 1.667 / 0 / - / 17.3 s |
| owner-54 | 4 (35/15/3/1) / 820.0 / 7.031 / 100 / 21.8 s | 4 (35/15/3/1) / 820.0 / 7.031 / 100 / - / 21.9 s |
| owner-84 | 4 (64/16/3/1) / 820.0 / 7.062 / 96 / 22.6 s | 4 (64/16/3/1) / 820.0 / **7.068** / 97 / **30/30** / 20.3 s |
| owner-real-54 | 4 (26/24/3/1) / 810.0 / 6.804 / 82 / 17.6 s | 4 (26/24/3/1) / 810.0 / 6.804 / 82 / - / 17.7 s |
| owner-real-84 | 4 (55/25/3/1) / 810.0 / 6.469 / 259 / **30.1 s (deadline)** | 4 (56/24/3/1) / 810.0 / **6.637** / 151 / **30/30** / 23.3 s |

Same fixtures at a 10 s budget (both stop at the deadline):

| fixture | before | after |
|---|---|---|
| owner-84 | 4 (63/17/3/1) / 820.0 / 7.062 | 4 (63/17/3/1) / 820.0 / 7.068, 30/30 tucked |
| owner-real-84 | 4 (53/27/3/1) / 810.0 / 6.287 | 4 (57/23/3/1) / 810.0 / **6.630**, 30/30 tucked |

At a 120 s budget, owner-real-84 after the change: 4 (57/23/3/1) / 810.0 mm
/ 6.640 m², 30/30 tucked, nest 69 s (the solver child ran 68 s). The QA
job with the same batch at 120 s before the change reported 4 (55/25/3/1) /
810.0 mm / 6.442 m² with every shuriken in the strip (service job, not this
script).

- Fixtures without a filler tier (mixed, combs, owner-54, owner-real-54) take
  exactly the previous path; their layouts are identical.
- owner-real-84: all 30 shurikens now sit among the stars on sheet 1 (none
  in a strip), a star from the top of sheet 2 took the freed space, and
  sheet 2's occupied extent drops from 2842.5 to 2727.3 mm, so its clear
  strip grows from 0.21 to 0.38 m². The 30 fillers now cost 0.17 m² of
  leftover against the same batch without them (owner-real-54, 6.804 m²),
  half of the 0.34 m² before. The fill also converges sooner (23 s instead of
  running into the 30 s deadline), because the shurikens no longer step
  down one move at a time.
- owner-84 (synthetic): all fillers move from the strip into the star pockets
  of sheet 1; the stars there were already packed, so leftover is equal.
- Sheet counts and last-sheet extents are unchanged everywhere; every layout
  passes `validate_layout`.

Options evaluated (owner-real-84 and owner-84 solver layouts, the same
saved layout for every variant, `fill_gaps` with a 60 s deadline):

| variant | owner-real-84 leftover | owner-84 leftover | fillers among parts |
|---|---|---|---|
| previous gap fill (lowest position only) | 6.470 m² | 7.062 m² | 0/30 (all in a strip) |
| early prototype: fillers placed before the larger parts settle, contact counts other fillers too (run on the already filled layout) | 6.469 m² | - | 17/30; 13 cluster in the old strip again |
| filler phase, lowest position inside the occupied box | 6.641 m² | 7.098 m² | 30/30, lined up along the column edges |
| filler phase, most contact inside the occupied box (adopted) | 6.641 m² | 7.098 m² | 30/30, in the pockets between stars |
| as adopted, but the 300 mm stars also treated as fillers | owner-real-54: 6.254 m² (was 6.804) | owner-54: 7.302 m² (was 7.031) | - |

- The tier rule's 10 % area share exists because of the last row: a whole
  tier of mid-size parts placed by contact spreads out on the traced stars
  and loses 0.55 m² of leftover, although it helps the synthetic stars.
- Moves beyond the occupied box only when they shrink the envelope: a move
  out of the box always grows that sheet's envelope; envelope-shrinking moves
  (lower inside the box, or onto an earlier sheet) are what compaction
  already does, so there is nothing to add.
- An objective that minimises the occupied envelope directly (instead of
  each part's position) is what the filler phase approximates: fillers never
  enlarge a box, and larger parts are compacted first. A global envelope
  search (moving several parts at once) was not tried.
- Candidate positions at concave vertices of neighbours: the contact score
  already ranks positions inside outer concavities and between neighbours
  highest; explicit vertex candidates were not added.

## Known limits

- No nesting inside holes, no common-line cutting, no tabs (v1 scope).
- Filler detection is a heuristic (4x size jump, 10 % area share); a group
  whose small parts do not meet it gets the plain compaction, and mid-size
  parts (the 300 mm stars) are never re-placed by contact. Fillers are
  frozen after the filler phase, so compaction does not move them again.
- Seed is not applied (see above).
- If the solver needs more than the hard limit just to build the instance,
  the result is the baseline. This can happen with very many distinct part
  types, because each type is bounded at 300 collision vertices.
- Gap filling moves one part at a time (no swaps), only to earlier sheets or
  lower on the same sheet, on a 2.5 mm grid: a moved part can sit up to about
  two cells further from its neighbours than the gap. It is time-bounded; on
  the owner batches it needs about 20 s of CPU to converge, so with a 10 s
  budget it stops early (in priority order) and the rest of the layout stays
  as the solver left it. It runs in the worker process while the solver child
  runs, so both compete for CPU.
- `collision_contours[].max_error_mm` also counts slots narrower than the
  clearance that the contour closes on purpose (33.7 mm for the traced
  motorcycle at 300 mm), so it can overstate the usable-space loss.
