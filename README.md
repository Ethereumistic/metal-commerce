# Metal Craft

pnpm + Turborepo monorepo for the Metal Craft shop on the Echoray platform. Both apps are TanStack Start and deploy as separate Cloudflare Workers.

| Path | Package | Purpose | Production |
| --- | --- | --- | --- |
| `apps/store` | `@metal/store` | Customer storefront ([README](apps/store/README.md)) | https://metal.echoray.cloud (Worker `metal-craft`) |
| `apps/admin` | `@metal/admin` | Back office for business operators | https://metal-admin.echoray.cloud (Worker `metal-admin`) |
| `packages/ui` | `@workspace/ui` | Shared shadcn/ui components, hooks and theme | — |
| `artifacts/` | — | Product design sources (zodiac icons, constellations, vector sets). The admin Studio reads its library from here. | — |

## Shared UI

`packages/ui` is the single home for shadcn/ui primitives. It uses the `base-nova` style, built on **Base UI** (`@base-ui/react`). Don't add Radix, `asChild` or `Slot`; compose with Base UI's `render` prop. Import components as `@workspace/ui/components/<name>`.

Add components from an app directory. The shadcn CLI reads that app's `components.json` and writes into `packages/ui`:

```sh
cd apps/admin
pnpm dlx shadcn@latest add <component>
```

The CLI may ask to overwrite components that already exist; answer no unless you want to replace them. Afterwards, check that new files import `cn` from `@workspace/ui/lib/utils`. The CLI has previously rewritten this import to the unrelated npm package `cn`.

The admin imports `@workspace/ui/globals.css`, which holds the stock shadcn neutral theme. The storefront keeps its own brand tokens in `apps/store/src/styles.css` and uses `@source` to scan `packages/ui`. Shared components take text through props (for example `closeLabel` on `DialogContent` and `SheetContent`), so each app supplies its own translations.

## Admin authentication

Operators sign in with their **Echoray platform account**, either with an email code or a password, against Echoray core (`https://convex.echoray.io`). The Worker runs the sign-in on the server and keeps the Echoray tokens in `HttpOnly` cookies. On every page load it checks `businesses.get` for `ADMIN_BUSINESS_ID` (`ks7edx6n4kr4zz1396yqy4deq18g0tkc`).

- An account that isn't an active member of that business is signed out again right away.
- Membership is managed in the Echoray dashboard, not in this repo.
- OAuth sign-in is not offered. Echoray core only allows OAuth redirects back to allowlisted origins (`convex/auth.ts` in echoray.io), and this origin isn't on that list.

## Admin design studio

`/studio` in the admin is a vector composition workspace for product artwork (`apps/admin/src/features/studio`).

- **Library.** The 12 Tabler zodiac icons and 12 constellation drawings come from `artifacts/zodiac-products`. You can also add text, circles, rings, rectangles and frames, or import an SVG. Imported SVGs are cleaned: scripts, event handlers and external references are removed.
- **Precise placement.** X/Y is the centre of the layer's *visible* artwork, stroke included. Size is its longest visible side. Alignment works against the artboard or another layer, with an edge margin. "Fit inside margin" scales to the safe padding (ellipse-aware for circles). Live readouts show the distance to each edge. Snapping covers edges, centres and padding; hold Alt to bypass. Arrow keys nudge by 1, Shift+arrow by 10 and Alt+arrow by 0.1.
- **Text.** Any Google Font, loaded through the Fontsource CDN. Text is converted to vector outlines with opentype.js. You can set letter spacing, case, kerning, arc text and the `{sign}`/`{dates}` tokens.
- **Design sign.** Layers set to "Follow design sign", and tokens in text, change with the design's sign. Export → "All 12 signs" produces a ZIP of every sign.
- **Export.** SVG output is vector-only, with no fonts, scripts or external links, and uses mm units when the design is set to millimetres. PNG output is at a chosen pixel width.
- **Sheet layout.** The artboard is the *product* (square or circle, in mm). "Sheet layout" nests it on the machine sheet: by default 1500 × 3000 mm with a 48 mm safety margin, giving 3 × 6 = 18 pieces of 468 mm. Sheet size and presets, margin, gap and leftover placement are adjustable. "Largest size that fits" sizes the product for N pieces across. Pieces can show the design sign or cycle through all 12. The sheet exports as a real-size SVG (mm) or PNG.
- **DXF for the laser.** Export → DXF (one product, or all 12 signs as a ZIP), or "DXF for the laser" in Sheet layout for the whole sheet. Files are real size in mm with the Y axis up. Layers:
  - `0`: everything the laser cuts, as the workshop expects.
    - Piece outlines: circles are true `CIRCLE` entities, and square grids with no gap use merged shared lines, so each edge is cut once.
    - Artwork openings as closed contours: strokes become their outlines, fills follow their fill rule, overlapping layers merge, and artwork in the background colour cuts back. Curves are flattened to ±0.02 mm by default.
  - `SHEET`: sheet edge and safety margin for reference, not cut. AutoCAD colour 4 (cyan). Included in sheet exports by default.
  - Built with svgpath, clipper-lib and @tarikjabiri/dxf (`apps/admin/src/features/studio/dxf.ts`).
- **Theme.** The admin has light, dark and system themes. The Studio canvas always stays light so artwork colours read true.
- **Storage.** Designs live in this browser's localStorage, not the database. "Save design file" and "Open design file" move the versioned JSON between machines. The format (`model.ts`, `DOCUMENT_VERSION`) is ready for server persistence later.

## Commands

```sh
pnpm install
pnpm dev:store         # http://localhost:3000
pnpm dev:admin         # http://localhost:3001
pnpm build
pnpm typecheck
VITE_SITE_URL=https://metal.echoray.cloud pnpm deploy:store
pnpm deploy:admin
```

Worker secrets are installed on Cloudflare and are kept across deploys. See `apps/store/README.md` for the storefront's protected bindings.
