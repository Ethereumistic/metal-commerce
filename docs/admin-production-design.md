# Metal Admin · Production design plan

Scope: Studio › Production (Products › Batch › Sheets › Results), `/production`
history, and the parts of the admin shell that frame them. Written before the
design pass of 26 October 2026; the self-review at the end records what was
changed from the first draft and why.

## Subject, audience, job

- **Subject:** the back office of Metal Craft, a laser-cutting workshop that
  turns catalog artwork into steel and aluminium wall art.
- **Audience:** one operator at the workshop PC (often with gloves just off,
  glancing between the screen and the machine), and later an unattended
  system that calls a human only when something needs a decision.
- **Primary job:** turn a selection of products into cut-ready sheets in a
  few clicks, and when something is wrong, say exactly what and where so it
  is fixed in seconds.

## Direction: "the cutting table"

The storefront speaks neo-brutalist workshop: ink borders, hazard yellow,
temper blue, spark orange, stencilled Big Shoulders display type. The admin
inherits the *materials* of that identity but not its volume. Think of a
cutting table and a shop traveller (the paper that rides along with a job):
a cool steel-grey surface, ink hairlines, square corners, stencilled part and
sheet numbers, and a single hazard-yellow mark where a human is needed.

### Colour (tokens, scoped to `.workshop`)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--ws-surface` | `#E9ECEC` steel | `#151819` blued steel | Work surface behind panels and the sheet viewport |
| `--ws-panel` | `#F7F8F8` | `#1C2022` | Panels, rows |
| `--ws-ink` | `#16191C` | `#E6E9EA` | Text, rules, sheet outline |
| `--ws-temper` | `#2A4FD6` temper blue | `#8EA6FF` | Primary action, selection, focus |
| `--ws-hazard` | `#F5C022` hazard yellow | `#F5C022` | Only for "a human is needed here" (invalid field, unqualified check, step that needs attention) |
| `--ws-spark` | `#E2541B` spark orange | `#FF7A45` | Errors that block cutting |
| `--ws-cut` | `#1D7A4C` | `#5BD69A` | Geometry complete / placed |

Part colours on sheets use a fixed eight-colour categorical set tuned for both
themes (blue, orange, green, magenta, teal, ochre, violet, brick), assigned per
batch line in request order, the same in the viewport, the legend, and every
list. The hazard yellow never appears as a part colour.

### Type

- **Geist Variable** (already shipped with the admin) for all interface text,
  with `tabular-nums` on every measurement so columns of millimetres line up.
- **Big Shoulders Variable** (the storefront's display face) only for
  *identifiers a person reads across the room*: stage numerals, sheet numbers,
  and the big counts on the Results header (placed / sheets / utilisation).
  This is the one bold element; everything else stays quiet.
- Scale (px): 11 meta · 12 secondary · 13 body (dense tables) · 14 body ·
  16 section · 28/40 display numerals. Labels are sentence case, never
  tracked-out caps.

### Layout

```
┌ shell header: crumbs ─────────────────────────────── theme ┐
├ [Editor|Production]  ①Products ②Batch ③Sheets ④Results   ● service ┤
├──────────────────────────────────────────────┬───────────────┤
│ stage body (scrolls on its own)              │ stage rail    │
│                                              │ (summary +    │
│                                              │  primary act.)│
├──────────────────────────────────────────────┴───────────────┤
│ sticky action bar: status sentence ................ [Primary] │
└──────────────────────────────────────────────────────────────┘
```

- Left-aligned, ruled rather than carded: panels are separated by 1 px ink
  rules at 12–16 % opacity; radius 2 px on controls, 0 on panels.
- Each stage keeps its primary action in a sticky bar at the bottom or in the
  right rail, so at 1024 × 768 it is always visible.
- Results: the sheet viewport takes the remaining width; the right rail holds
  the "traveller": batch name, qualification, downloads, per-group engine and
  leftover, parts legend.
- Breakpoints: ≥ 1280 px sidebar open, rail 20 rem; 1024–1279 px sidebar
  collapses to icons, rail 17 rem, batch rows wrap their secondary controls
  onto a second line; nothing is wider than the viewport.

### Principles

1. **One number, one name.** A sheet is "Sheet 3" in the tab, the viewport,
   the file name and the manifest. A batch is shown by its operator name.
2. **Never change what the operator typed.** Invalid input stays visible,
   gets a hazard mark and a sentence that says how to fix it, and blocks the
   next step.
3. **Geometry is not qualification.** "All parts placed" and "ready to cut"
   are different claims; the Results rail states both separately.
4. **Every problem carries its fix.** An error names the product, the field,
   the limit, and offers the button that fixes it (focus the field, raise the
   limit and retry, reprocess the trace, repeat the batch).
5. **Motion only answers actions:** stage changes, cancelling, progress. All
   of it is disabled under `prefers-reduced-motion`.
6. **Fast by construction:** pan and zoom transform one wrapper element;
   contour artwork is drawn by the browser from cached SVG masks, never by
   re-rendering React per frame.

## Self-review against the brief

- *First draft* used hazard yellow as the primary button colour, copied from
  the storefront. Reviewed: in a back office that is used all day, a yellow
  primary button on every screen dilutes the one colour we need to mean
  "attention". Changed: primary is temper blue; yellow is reserved for
  "human needed".
- *First draft* put a stencil face on all headings. Reviewed: reads as a
  theme park of the storefront and hurts scanning of dense tables. Changed:
  the display face is only for numerals/identifiers.
- *First draft* had rounded summary cards in the Results rail. Reviewed: the
  SaaS-card default. Changed to a ruled "traveller" column with rows.
- Checked against generic defaults: no cream background, no acid-on-black,
  no all-caps eyebrows, no gradient washes, monospace not used for data
  labels (tabular Geist instead). The palette comes from the workshop's own
  safety markings and heat tint, so it is specific to this subject.
- Fit to brief: calm (one accent per meaning), dense (13 px rows, ruled
  layout), precise (tabular mm, one sheet number), workshop-like (steel
  surface, stencilled numerals), reuses packages/ui primitives and the
  existing light/dark theme switch.
