# Metal Admin: how it works

A guide for developers and agents who need to change or operate the Metal Craft
back office (`apps/admin`). It covers the app shell, sign-in, the design
Studio, the Production workspace that turns catalog products into laser-ready
DXF sheets, and the local artwork service behind it.

Metal Craft is a laser-cutting workshop that sells steel and aluminium wall art.
The laser follows closed paths in DXF files, so the admin's main job is to turn
artwork into correct, real-size cut paths on a machine sheet.

## Where things are

| Path | What it is |
|---|---|
| `apps/admin` | The admin app: TanStack Start (React 19) on a Cloudflare Worker, `@metal/admin` |
| `apps/admin/src/routes` | File routes (`_app.tsx` is the signed-in layout) |
| `apps/admin/src/lib` | Server-only code (`*.server.ts`), navigation, theme |
| `apps/admin/src/features/studio` | Studio editor: vector composition, sheet grid, DXF export in the browser |
| `apps/admin/src/features/production` | Production workspace and `/production` history UI |
| `apps/admin/tests` | `node --test` unit tests (Production only) |
| `packages/ui` | `@workspace/ui`: shared shadcn components on Base UI (`base-nova` style) |
| `services/artwork-service` | Python service on the workshop PC: tracing, sizing, nesting, DXF export |
| `artifacts/zodiac-products` | Zodiac icons and constellations used by the Studio library |

Related documents:

- [`services/artwork-service/README.md`](../services/artwork-service/README.md): run, configure and operate the service.
- [`services/artwork-service/CONTRACT.md`](../services/artwork-service/CONTRACT.md): the HTTP API between admin and service. It is the source of truth for request and response shapes.
- [`services/artwork-service/docs/nesting-and-export.md`](../services/artwork-service/docs/nesting-and-export.md): nesting, gap filling, validation and DXF rules.
- [`docs/admin-production-design.md`](admin-production-design.md): visual design system of the Production workspace.
- [`docs/artwork-production-acceptance.md`](artwork-production-acceptance.md): local acceptance evidence and known limitations.
- [`docs/laser-machine-specs.md`](laser-machine-specs.md): machine sheet sizes and material limits.
- `docs/artwork-production-implementation-plan.md` in the main checkout: the original feature plan (not tracked in git at the time of writing).

## Runtime picture

```
Browser (operator)
   │  HTTPS, HttpOnly session cookies
   ▼
metal-admin Worker  (apps/admin, Cloudflare)  ── Convex client ──▶ Echoray core (convex.echoray.io)
   │  server functions only (/_server/*)                              sign-in, membership, catalog
   │  bearer token + business/actor headers
   ▼
artwork service  (services/artwork-service, Omarchy PC, 127.0.0.1:8766)
   SQLite queue · worker processes · artifacts on disk
```

- The browser never talks to Convex or to the artwork service directly. Every
  call goes through a TanStack `createServerFn` on the Worker, which checks the
  session and membership first.
- Locally, the Worker dev runtime (`vite dev` on port 3001) reaches the service
  on loopback.
- Hosted (`https://metal-admin.echoray.cloud`), the Worker cannot reach the
  PC yet. The planned path is a Cloudflare Tunnel plus an Access service token
  to the PC; until then `ARTWORK_PRODUCTION_ENABLED` is `"false"` in
  `wrangler.jsonc`, and the Production workspace shows "Production processing
  is not enabled". The service is never deployed to the VPS.

## App shell

- **Worker entry** `src/server.ts`. Redirects plain HTTP to HTTPS on non-local
  hosts (session cookies use the `__Host-` prefix), and adds
  `Cache-Control: private, no-store`, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` and HSTS on HTTPS.
- **Router** `src/router.tsx`: generated `routeTree.gen.ts` (do not edit by
  hand; the Vite plugin rewrites it), intent preloading, scroll restoration.
  Routes can set `staticData.fullBleed` to fill the window with no padding.
- **Root** `routes/__root.tsx`: document head, inline theme script before
  hydration (no flash), tooltip provider, 404 page.
- **Signed-in layout** `routes/_app.tsx`: `beforeLoad` calls `getSession()`;
  no session redirects to `/login?next=<path>`. Renders the sidebar, a header
  with breadcrumb (business › page) and theme toggle. The sidebar is open at
  1280 px and wider, icons only below.
- **Navigation** `lib/navigation.ts`: Store (Overview, Orders, Products,
  Collections, Customers), Design (Studio), Operations (Inventory, Production,
  Analytics), Admin (Settings).
- **Theme** `lib/theme.ts`: light, dark or system, stored in localStorage
  `metal-admin-theme`, synced across tabs. The Studio canvas always stays light.

Real pages today: **Studio** (`/studio`) and **Production history**
(`/production`). Overview shows placeholder stat cards; Orders, Products,
Collections, Customers, Inventory, Analytics and Settings are "Coming soon"
placeholders (`components/placeholder-page.tsx`). Catalog editing happens in
the Echoray dashboard, not here.

## Sign-in and permissions

Files: `lib/auth.ts` (server functions the browser calls) and
`lib/auth.server.ts` (server only).

1. `/login` asks for an email, then either emails a 6-digit code
   (`requestCode` → `verifyCode`) or takes a password (`passwordSignIn`; Echoray
   may answer with an emailed verification code). OAuth is not offered because
   Echoray only redirects to allowlisted origins.
2. The Worker signs in against Echoray core (`ADMIN_CONVEX_URL`) and stores the
   tokens in `HttpOnly`, `SameSite=Lax` cookies (`__Host-metal-admin-token`,
   `__Host-metal-admin-refresh` on HTTPS), 30 days. Tokens never reach browser
   JavaScript.
3. On every request `operatorSession()` refreshes a token that expires within
   60 s, then checks `businesses.get(ADMIN_BUSINESS_ID)` and `users.me`. A user
   who is not an active member of that business is signed out. Network errors
   keep the cookies and report `unavailable`.
4. The session carries `business.role`, `owner` and `canEdit`. Production
   mutations (prepare, batch, nest, cancel) require `canEdit`; viewers can look
   but not change.
5. All Convex calls have a 15 s timeout (`CORE_TIMEOUT_MS`).

Membership is managed in the Echoray dashboard. `operatorClient()` returns a
Convex client acting as the operator; Production uses it to read the catalog.

## Configuration

`apps/admin/wrangler.jsonc` (Worker `metal-admin`, custom domain
`metal-admin.echoray.cloud`, `workers_dev: false`):

| Name | Kind | Meaning |
|---|---|---|
| `ADMIN_CONVEX_URL` | var | Echoray core, `https://convex.echoray.io` |
| `ADMIN_BUSINESS_ID` | var | Only members of this business may enter |
| `ADMIN_DASHBOARD_URL` | var | Echoray dashboard link (currently unused in `src`) |
| `ARTWORK_PRODUCTION_ENABLED` | var | `"true"` turns on Production; `"false"` in the hosted config |
| `ARTWORK_SERVICE_ORIGIN` | secret | Service URL; must be HTTPS, or HTTP on loopback |
| `ARTWORK_SERVICE_TOKEN` | secret | Same value as the service's `ARTWORK_SERVICE_TOKEN` |
| `ARTWORK_ACCESS_CLIENT_ID` / `_SECRET` | secret, optional | Cloudflare Access service token for the hosted path; set both or neither |

Locally, copy `apps/admin/.dev.vars.example` to `apps/admin/.dev.vars` (git
ignored) and set the token. A missing or inconsistent setting makes Production
return `PRODUCTION_MISCONFIGURED`.

## Studio editor

Route `routes/_app/studio.tsx` (`ssr: false`, full bleed), component
`features/studio/components/studio.tsx`. A segmented control at the top-left
switches between **Editor** and **Production** (`?workspace=production`). The
editor needs a screen at least `lg` wide.

What the editor is for: composing a single product's artwork (for example a
zodiac plaque), laying identical copies on a sheet, and exporting SVG, PNG or
DXF. It works entirely in the browser.

- **Library**: zodiac icons and constellations from `artifacts/zodiac-products`
  (loaded with `import.meta.glob`), plus text, circle, ring, rectangle, frame
  and imported SVG (under 1 MB, sanitised in `svg.ts`).
- **Layers**: drag to reorder, rename, lock, hide. Layers can "follow the
  design sign", and text supports `{sign}` and `{dates}` tokens, so one design
  exports as all 12 signs.
- **Inspector**: artboard (size, square or circle, padding, background, clip),
  laser bridges, and per-layer alignment, position, rotation and style. X/Y is
  the centre of the visible artwork; size is its longest visible side.
- **Text**: any Google font through Fontsource, converted to outlines with
  opentype.js (`fonts.ts`).
- **Sheet layout** (`sheet.ts`): a grid of identical pieces on the machine
  sheet (default 1500 × 3000 mm, 48 mm margin, 468 mm pieces, 3 × 6 = 18).
  This is a simple grid, unrelated to the Production nesting engine.
- **DXF** (`dxf.ts`, built on svgpath, clipper-lib and `@tarikjabiri/dxf`):
  geometry is flattened (±0.02 mm default), fills unioned, strokes outlined,
  background-coloured layers cut back, and enclosed islands get bridges. Cuts
  go on layer `0`; the sheet edge and margin go on layer `SHEET` (colour 4).
  Units are mm, Y up.
- **Storage**: designs live in localStorage (`metal-admin-studio`, zustand
  persist with immer). Undo history is in memory (150 steps). "Save design
  file" / "Open design file" move a versioned JSON (`model.ts`,
  `DOCUMENT_VERSION = 3`) between machines.
- **Shortcuts**: Ctrl/⌘+Z and Shift+Ctrl/⌘+Z or Ctrl/⌘+Y, Esc, Delete,
  Ctrl/⌘+D, arrows (1, Shift 10, Alt 0.1).

## Production workspace

Route `/studio?workspace=production`, component
`features/production/production-workspace.tsx`. It produces cut files for
catalog products whose artwork is a flat silhouette image.

### The flow

The workspace has four steps, kept in the URL (`stage=products|batch|sheets|results`,
plus `job`, `batch` and `q`), so a reload or a shared link resumes the same run.

```
Products ──▶ Batch ──▶ Sheets ──▶ Results
 pick and     sizes,     sheet       job progress, sheet viewer,
 trace        quantity,  size,       qualification, downloads
              material   margins,
                         gap, time
```

1. **Products**: search the Metal Craft catalog (read from Convex, 50 per
   page, `production-catalog.server.ts`). Selecting products and pressing
   **Prepare** sends each product's *first* catalog image to the service, which
   traces it into a vector **master** once and caches it. Each row shows status:
   `unprepared`, `queued`, `processing`, `ready`, `failed` (with a reason such
   as `LOW_CONTRAST` or `NO_FIRST_IMAGE`) or `stale` (the first image changed
   since the trace). A trace preview shows the source and the contour overlay.
   Only `ready` products can go into a batch.
2. **Batch**: one line per product with its thumbnail. Set size by width,
   height or fit (aspect ratio is locked to the master), quantity, material,
   thickness and allowed rotations. "Apply to all" copies a value to every line.
   Invalid input is never changed silently: it stays, gets a hazard mark and a
   sentence saying how to fix it, and blocks the next step.
3. **Sheets**: stock size (presets for the current 1500 × 3000 mm machine and
   the incoming 2000 × 4000 mm one), margins, gap between parts, maximum sheets,
   and time budget (10, 30 or 120 s per material group). **Create batch** asks
   the service to validate; a part that cannot fit the usable sheet fails here
   with its size and the usable envelope (`PART_DOES_NOT_FIT`). **Run nesting**
   starts a nest job.
4. **Results**: live job progress with **Cancel**; then the sheet viewer (pan,
   zoom, one colour per batch line), per-sheet tabs, totals (placed, sheets,
   utilisation, usable leftover), the engine used per group, the qualification
   checks, and downloads: per-sheet DXF and SVG, and the ZIP package (only when
   every part is placed and the layout and DXF passed validation).

Lines are grouped by material and thickness; each group nests on its own
sheets. "All parts placed" and "ready to cut" are separate claims in the
Results rail.

### Production history

`/production` (`features/production/history.tsx`) lists recent trace jobs and
batches, paged. A batch entry opens its results or **Repeat**s it, which copies
its lines and sheet settings into a new draft at the Sheets step
(`repeat.tsx`). A trace entry opens the Products step searched for that
product (`?q=`), where a failed trace can be reprocessed.

### Client state

- `store.ts`: zustand persisted to localStorage `metal-admin-production`,
  version 2 (`PRODUCTION_STORE_VERSION` in `batch-logic.ts`; v1 is migrated).
  It keeps the selection, batch draft, sheet settings, product names and
  thumbnails, and the active job. Writes are debounced
  (`persist-storage.ts`) and flushed when the step changes.
- Pure logic is kept out of components so it can be unit tested:
  `batch-logic.ts`, `results-logic.ts`, `history-logic.ts`, `validation.ts`,
  `sizing.ts`, `search.ts`.
- `hooks.ts`: `usePolling` (slows to 15 s or more in background tabs),
  `backoff`, `attempt` (wraps a server call into `ServiceResult`) and
  `useActionKey`, which keeps one idempotency key per user action so a retry
  never creates a duplicate batch or job.
- Polling: job progress, the preparation follower (2 s while something changes,
  backing off to 10 s) and service health (`service-status.tsx`, with backoff
  when offline).

### Server side

- `features/production/api.ts` declares the server functions the UI calls:
  `getHealth`, `listProducts`, `getProduct`, `prepareProducts`, `getMaster`,
  `createBatch`, `startNesting`, `getJob`, `getJobs`, `listJobs`, `cancelJob`,
  `getBatch`, `listBatches`. Inputs are validated there.
- `lib/production.server.ts` implements them. For each call it:
  1. reads the configuration (`serviceConfig()`), refusing with
     `PRODUCTION_DISABLED` or `PRODUCTION_MISCONFIGURED`;
  2. resolves the operator (session, membership, and `canEdit` for mutations);
  3. calls the service with `Authorization: Bearer`, `X-Artwork-Business-Id`,
     `X-Artwork-Actor`, `X-Artwork-Can-Edit`, the `Idempotency-Key` for
     mutations, and the Access headers when configured, with bounded timeouts;
  4. parses the response with the strict parsers in `contracts.ts` and returns
     a `ServiceResult<T>`: `{ ok: true, value }` or
     `{ ok: false, offline, error: { code, message } }`. `offline: true` means
     the outcome is uncertain (transport failure), which the UI shows
     differently from a definite refusal.
- For **Prepare**, the admin resolves each product's first image on the server
  (`resolveFirstImage` in `production-catalog.server.ts`) and sends the source
  identity, version and URL, so the service never reads the catalog itself.
- Downloads go through `routes/api/production/artifacts.$artifactId.ts`, a
  GET-only route that checks the session and membership and streams the
  service's artifact with its `Content-Disposition`. All mutations go through
  server functions, which carry TanStack's CSRF protection.

### The artwork service in brief

Python 3.12 (uv), FastAPI on `127.0.0.1:8766`, run on the Omarchy PC. Details
are in its README and CONTRACT; the essentials:

- **Queue**: SQLite (WAL) jobs with leases, heartbeats, attempts and
  cancellation, run by spawned worker processes. A restart requeues running
  jobs. Every row is scoped by business.
- **Tracing** (`tracing.py`, engine `opencv-contours`): threshold candidates on
  a 2× upsampled image, sub-pixel refinement, holes and islands kept, result
  normalised so the longest side is 1. Fetches only from allowlisted hosts
  (`ARTWORK_ALLOWED_SOURCES`) with SSRF protection. A master is reused until the
  source image changes (then the product is `stale`).
- **Sizing** (`sizing.py`): aspect-locked mm sizes and fit checks against the
  usable sheet.
- **Nesting** (`nesting.py`, `solver_adapter.py`, `gap_fill.py`): PackingSolver
  irregular nesting in a killable child process, compared with a bounding-box
  baseline; the better valid layout wins. Gap filling then compacts the layout
  and tucks small parts (fillers) between larger ones. The gap is applied by
  growing each contour by half the gap. `validation.py` re-checks every layout
  independently against the original geometry and never trusts solver flags.
- **Export** (`dxf_export.py`): ezdxf R2010, units mm (`INSUNITS=4`), layer `0`
  only, closed `LWPOLYLINE`s. Every DXF is read back and compared with the
  layout before the ZIP (deterministic, with `manifest.json`) is offered.

### Error codes the operator can see

From the service (full list in CONTRACT.md): `NO_FIRST_IMAGE`,
`SOURCE_UNAVAILABLE`, `SOURCE_TOO_SMALL`, `UNSUPPORTED_FORMAT`,
`SOURCE_HOST_NOT_ALLOWED`, `LOW_CONTRAST`, `AMBIGUOUS_SEGMENTATION`,
`DISCONNECTED_MATERIAL`, `OBJECT_CLIPPED`, `INVALID_CONTOURS`,
`PART_DOES_NOT_FIT`, `INVALID_DIMENSIONS`, `INSUFFICIENT_STOCK`,
`NEST_INCOMPLETE`, `LAYOUT_INVALID`, `EXPORT_INVALID`, `CANCELLED`, `TIMEOUT`,
`INSUFFICIENT_DISK`, `MASTER_STALE`, `IDEMPOTENCY_CONFLICT`. From the admin:
`PRODUCTION_DISABLED`, `PRODUCTION_MISCONFIGURED`, `REQUEST_FAILED` (transport).

### Products that cannot be traced

Tracing works only when the first catalog image is a flat, high-contrast
silhouette. **"Arc Log Cradle Firewood Rack"** has a real 3D product photo as
its first image and can never produce a DXF: never select, prepare, trace,
retry or batch it in tests, QA runs or demos. There is no "not for laser
production" mark yet; it is a planned improvement.

## Running it locally

From the repository root:

```sh
pnpm install
pnpm dev:admin                       # http://localhost:3001
pnpm --filter @metal/admin test      # node --test, Production logic
pnpm --filter @metal/admin typecheck
```

The artwork service (from `services/artwork-service`):

```sh
uv sync
set -a; . ~/.config/metal-craft-artwork/dev.env; set +a   # ARTWORK_SERVICE_TOKEN etc.
scripts/run-dev.sh                   # 127.0.0.1:8766, data in ~/.local/share/metal-craft-artwork/dev
uv run pytest -q                     # service tests
uv run python scripts/acceptance.py  # end-to-end acceptance; starts its own service on a fresh data dir
```

Stop the service with `SIGTERM` (`pgrep -f "[a]rtwork_service serve" | xargs -r kill -TERM`;
the bracket keeps `pgrep` from matching your own shell). Do not run two
services against one data directory.

## Deploying

```sh
pnpm deploy:admin    # vite build && wrangler deploy, Worker metal-admin
```

Secrets are stored on Cloudflare (`wrangler secret put <NAME>` from
`apps/admin`) and survive deploys. The hosted admin keeps Production disabled
until the tunnel exists. Enabling it means, in order: run `cloudflared` on the
PC with a tunnel to `127.0.0.1:8766`, protect the hostname with Cloudflare
Access and a service token, set `ARTWORK_SERVICE_ORIGIN`,
`ARTWORK_SERVICE_TOKEN`, `ARTWORK_ACCESS_CLIENT_ID` and
`ARTWORK_ACCESS_CLIENT_SECRET` as secrets, then set
`ARTWORK_PRODUCTION_ENABLED` to `"true"` and deploy. Each of those steps is
outward-facing; confirm with the owner first.

## Rules for changes

- Use `@workspace/ui` components (Base UI, compose with `render`, no Radix or
  `asChild`). Add new shadcn components from `apps/admin` so they land in
  `packages/ui`.
- Keep secrets and data out of git: `.dev.vars`, the service token, and the
  service data directory.
- Keep server-only code in `*.server.ts` and call it through server functions;
  the browser must never get the service token or Echoray tokens.
- When the service API changes, update `CONTRACT.md`, the parsers in
  `features/production/contracts.ts` and `tests/fixtures/service-responses.json`
  together (the fixture is captured by `scripts/acceptance.py`).
- Production UI follows `docs/admin-production-design.md`: hazard yellow only
  where a human is needed, temper blue for primary actions, tabular numbers for
  measurements, motion only in answer to actions and off under reduced motion.
- The Windows machine is a browser client only; processing runs on the Omarchy
  PC.
