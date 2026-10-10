# Metal Craft session handoff — 10 October 2026

## Current outcome

The session established Metal Craft's product direction, recorded workshop capacity, explored zodiac product mockups, and then replaced the inconsistent generated imagery with **24 deterministic SVG designs**. The latest zodiac deliverable is the vector set; the earlier generated wall mockups are retained as exploration and should not be treated as the accepted design reference.

The repository also contains the Metal Craft storefront connection and rebranding work documented earlier in this session. The owner requested that all current repository changes, including those storefront changes and the design artifacts, be committed and pushed together.

## Business and product direction

- The workshop laser-cuts sheet metal by following paths in DXF files.
- Sell ready designs, bounded personalization of existing templates, and custom projects.
- The proposed custom journey is: customer uploads an image or DXF, supplies dimensions and preferences, the drawing is checked and converted where needed, then the workshop produces, optionally paints, and ships the piece. This is a **planned workflow**, not a newly implemented upload or conversion service.
- Focus on substantial metal artwork, decorative silhouettes, metal pictures, and occasion gifts. Small products are technically possible but have lower commercial priority because of their margins.
- Initial ideas include zodiac designs, original sports-car silhouettes, original metal pictures, nature, geometry, decoration, and substantial gifts. Chairs and assembled furniture are a later possibility requiring additional construction validation.
- Use original or appropriately licensed artwork. Do not populate the premade catalog with Disney characters, other protected characters, copied artwork, brand logos, or recognizable protected designs without documented permission.
- Customer uploads do not automatically establish commercial rights or become reusable premade products.

Planning documents are under [docs/inventory/](docs/inventory/README.md):

| Document | Content |
| --- | --- |
| [Inventory overview](docs/inventory/README.md) | Ready, personalized, and custom offers; collection direction and release criteria. |
| [Product concepts](docs/inventory/product-concepts.md) | Twenty-four proposed product families, appearance, dimensions, construction, and priorities. |
| [Visual direction](docs/inventory/visual-direction.md) | Markdown sketches, retained metal/cutout examples, and display ideas. |
| [Production scale reference](docs/inventory/production-scale-reference.md) | Owner's actual manufactured gift and the scale clarification. |
| [Rights and custom boundaries](docs/inventory/rights-and-custom-boundaries.md) | Artwork rights, protected subject matter, and upload review. |

Concept sizes, prices, stock, and product availability must not be presented as confirmed operational facts. The zodiac square/circle direction below supersedes earlier animal-shaped zodiac proposals in the general concept notes.

## Machine specifications and manufactured reference

The central record is [docs/laser-machine-specs.md](docs/laser-machine-specs.md). All confirmed machine values below are owner-provided and expressed in millimeters.

| Capacity | Current machine | Incoming machine |
| --- | --- | --- |
| Maximum sheet size | 1500 × 3000 mm | 2000 × 4000 mm |
| Maximum steel thickness | 12 mm | 20 mm |
| Maximum aluminium thickness | 4 mm | 12 mm |
| Availability | Current workshop capacity | Expected December 2026; commissioning not confirmed |

The photographed stork-themed gift for a pregnant woman measures **300 mm wide × 600 mm high**. Its sheet thickness is approximately **2–2.5 mm**; exact gauge and material are unconfirmed. The shirt in the photo was a scale reference, not a source of inferred measurements.

Technical staff subsequently confirmed that detailed small items can be cut. The reported example was a circle of diameter “30,” with internal detail; the unit was not explicitly provided. This supersedes the earlier rough shuriken/kunai comparison as a supposed machine minimum. Prefer larger products for commercial reasons, while validating feature sizes by material, thickness, and setup.

## Zodiac design decisions

- Twelve signs: Aries, Taurus, Gemini, Cancer, Leo, Virgo, Libra, Scorpio, Sagittarius, Capricorn, Aquarius, Pisces.
- Product outline: square or circle with a 1:1 bounding box. Completed assets use squares.
- Finish direction: matte-black painted sheet metal.
- Icons: exactly the supplied `react-icons/tb` `TbZodiac[Sign]` geometry. Do not replace these with animal drawings or another icon family.
- Constellations: the owner's supplied SVGs, preserving their paths and proportions.
- A physical zodiac product size has not been approved. Canvas units are not millimeters.

### Sources and initial mockups

Assets are under [artifacts/zodiac-products/](artifacts/zodiac-products/BRIEF.md):

- `icons/zodiac-{sign}.svg`: twelve icon sources. The initial extraction was from react-icons 5.7.0; Tabler's license notice is retained.
- `constellations/{sign}.svg`: twelve supplied constellation sources.
- `source/`: initial extraction/provenance records and duplicate icon sources. Some early source notes still describe the original inaccessible Windows directory; the working sources are now the local folders above.
- `references/`: deterministic combined icon/constellation compositions, plus raster reference exports. These precede the final vector revision and contain raster constellation embeds.
- `renders/`: twelve generated PNG wall mockups, 1254 × 1254 pixels.
- `web/`: twelve WebP exports of those mockups.
- `GALLERY.md`, `RELEASE.md`, `PROMPTS.md`, and `zodiac-square-mockups.zip`: previews, release/provenance records, and the earlier image package.

The owner rejected the generated set because of substantial centering inconsistencies. Those images are exploration, not photographs of manufactured products, accepted geometry, or production-ready CAD.

### Latest deliverable: two complete SVG sets

See [vector-sets/README.md](artifacts/zodiac-products/vector-sets/README.md).

| Asset | Purpose |
| --- | --- |
| `vector-sets/icons/{sign}.svg` | Twelve icons, each exactly 1.5× its prior reference scale. |
| `vector-sets/constellations/{sign}.svg` | Twelve constellations sized to match each corresponding icon's longest visible dimension and minimum edge padding. |
| [Icon overview](artifacts/zodiac-products/vector-sets/icons-preview.svg) | Vector overview of all twelve icons. |
| [Constellation overview](artifacts/zodiac-products/vector-sets/constellations-preview.svg) | Vector overview of all twelve constellations. |
| [Measurements](artifacts/zodiac-products/vector-sets/measurements.json) | Bounds, scales, centers, individual margins, and source hashes. |
| [Generator](artifacts/zodiac-products/vector-sets/build.mjs) | Reproducible creation and geometric verification. |
| [SVG package](artifacts/zodiac-products/zodiac-vector-sets.zip) | All 24 individual SVGs, both overview SVGs, documentation, generator, measurements, and license. |

Each individual SVG uses a **704 × 704** canvas with matte black `#151515` background and white artwork representing openings. Visible bounds, including icon strokes, are centered at **(352, 352)**. Original source paths are preserved; there are no raster embeds or external assets.

The previous icon viewport was 260 units. The new scale is `260 × 1.5 / 24 = 16.25`, equivalent to a 390-unit icon viewport. Icons retain their source proportions and stroke relationships.

Padding is matched **within each corresponding icon/constellation pair on the limiting axis**. Their longest visible dimensions and minimum edge margins are equal. Shorter axes have extra space according to each design's original aspect ratio. All four margins are not forced equal through stretching, and different signs can have different margins because the icon scale is exactly 1.5× rather than individually normalized.

To rebuild from the repository root:

```sh
node artifacts/zodiac-products/vector-sets/build.mjs
```

The generator requires the existing Playwright dependency and Chromium at `/usr/bin/chromium`, or an executable specified by `ZODIAC_CHROMIUM`. It verifies centering to within 0.01 canvas units, exact enlargement, pair padding, source-path/transform preservation, vector-only output, and unchanged source files. The ZIP was separately checked for all 24 product SVGs and archive integrity. Rebuilding the SVGs does not automatically refresh the ZIP.

## Storefront work included in this session

Detailed deployment evidence is recorded in [docs/metal-craft-setup-2026-10-10.md](docs/metal-craft-setup-2026-10-10.md); operational setup is summarized in [README.md](README.md).

- Production origin: `https://metal.echoray.cloud`; separate Cloudflare Worker: `metal-craft`.
- Metal Craft business: `ks7edx6n4kr4zz1396yqy4deq18g0tkc`.
- Active storefront registration: `p172wsjnz491b5jj0cm3hh33sh8g15gp`.
- Recorded deployment: `48a77534-9e16-499c-9784-803c560f2a45`.
- Updated brand copy, localized titles/empty states, canonical origin, public configuration, diagnostic naming, and package identity.
- Isolated cart storage, locale cookies, session cookies, and the shopper request header under Metal Craft naming.
- Removed the inherited oak story from rendered home/about pages and furniture-specific collection ordering.
- Adapted isolated test fixtures to the new shop identity; retained the inherited frontend foundation.
- Protected credentials remain Worker secrets. No credential values belong in this handoff, committed environment files, browser configuration, or `VITE_*` variables.

The setup record reports successful challenge verification, an active integration, an empty categories response, and authentication configuration resolving for Metal Craft. The catalog is empty. Product discovery reported `UNAVAILABLE: Discovery migration in progress.` The recorded platform behavior initializes discovery when the first actual merchant product is saved; no fake products were created to bypass it.

The session's inventory and imagery work did not create live product listings or implement the proposed custom upload pipeline. Product artwork remains in the artifacts directory rather than being wired into storefront product records.

## Validation and remaining work

The earlier deployment record reports successful production builds, TypeScript checking, and six locale tests. Full inherited browser suites, customer account creation, email delivery, orders, and payments were not exercised. Browser screenshot capture timed out; SVG geometry was independently checked in Chromium, and both vector overviews loaded successfully in the browser.

Before this handoff commit, the production build with `VITE_SITE_URL=https://metal.echoray.cloud`, `npm run typecheck`, all six `npm run test:locale` tests, the 24-SVG generator's validation, and `git diff --check` passed again. These checks do not verify the unexercised live shopper/payment flows.

Before manufacturing or selling a zodiac design, prepare and review production DXF geometry, cutout bridges/retained metal, mounting, material and thickness, physical dimensions, finish, packaging, cost, and an actual sample. The SVGs are visual design assets, not approved cutting files.

For storefront launch, enter real collections/products, resolve discovery through actual product creation, confirm applicable tax settings and approved policies, configure delivery eligibility and the payment provider, and verify the shopper/cart/checkout flows. Do not publish inherited furniture claims or generated mockups as photographs of finished metal stock.

The owner has requested committing and pushing **all current changes** on the current `main` branch to `origin` (`Ethereumistic/metal-commerce`). A Git push is separate from a website deployment; this handoff/commit step does not redeploy the Worker.
