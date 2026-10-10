# MORIS Commerce catalog — 2026-10-06

Merchant: MORIS FURNITURE (`ks78yp26ch3085wpavqdwas6gs8fkdqa`). Storefront: https://echoray.cloud.

Products were created through the owner's signed-in Echoray Commerce browser session. Each is visible in Tables, offers Natural and Smoked matte oil at the same one-time EUR price, and is made to order with 30–60 day production. Production and reclaimed-grain FAQs are saved on each product.

| Product | Dimensions | Price | Gallery |
| --- | --- | --- | --- |
| Trestle | 220 × 95 × 75 cm | €4,800 | 6 images |
| Round | Ø120 × 75 cm | €3,900 | 6 images |
| Low | 120 × 65 × 38 cm | €3,000 | 6 images |

The gallery order is white studio, interior, top detail, support detail, interior, interior. Original generated PNGs are kept under each product's directory. Commerce uploaded full-size lossless WebP images. All images depict Natural oak; they are generated design visualizations, not photographs of manufactured samples.

The twelve hardcoded product fixtures were removed. The server validates Echoray contract version and configured storefront/business scope, then reads the paginated public catalog and individual products. Prices, options, descriptions, specifications, FAQs and image order are managed in Commerce. Editorial stories and stock room imagery remain separate content.

Product cards reveal the second image on hover or keyboard focus after it loads. Product galleries provide six thumbnails, previous/next, arrow/Home/End keys, horizontal swipe on the main stage, fullscreen viewing and zoom. Motion respects reduced-motion preferences. Commerce share links under /products redirect to localized /pieces URLs.

Framework RPC uses an explicit /_server transport path and bypasses language-document routing. This resolves the live-review issue where client-side product navigation was incorrectly treated as an HTML request.

Validation: production Vite build; live public catalog read showing all three products, 18 images, correct prices, two finishes and production FAQs; desktop fullscreen/keyboard/zoom/Escape and phone gallery review. Automated tests, typecheck and lint were not run under the Echoray skill's check-authorization rule. This release adds catalog presentation and galleries; cart/checkout remain outside this release.

Final deployed Cloudflare Worker version: `e871c3b1-f5d5-4fd1-9d0a-23539a9748b2`.
Final live review additionally confirmed collection-card → Round → homepage client navigation, Smoked finish selection, search for “oak” returning all three products, and actual pointer hover showing image 2 with opacity 1 after loading. Proof screenshots are under `proof/`.

## Gallery refinements — 2026-10-06

Deployed Worker version: `5ec6b9d2-c784-4ada-a326-ab003854e2a7`.

Desktop product galleries now use a viewport-sized main stage and a left thumbnail rail. The gallery sticks 16px below the pinned navigation; phones use a compact main stage and a horizontal thumbnail strip. Thumbnail corner numbers and the product-card hover overlay have been removed; the second-image reveal remains.

Fullscreen zoom uses a 2.25× image transform inside a fixed, clipped viewport. Pointer dragging pans within bounds computed from the image's actual contained dimensions, releases without toggling zoom, and changing images resets the zoom. Toolbar zoom starts centered; clicking an image zooms around the selected point.

The existing shadcn-style Base UI accordion now transitions the panel's measured `--accordion-panel-height` using Base UI starting/ending states. Its chevron rotates rather than swapping icons. Reduced-motion preferences disable those transitions.

Validation: production Vite build succeeded. Browser review covered 1900×913 and 1280×720 desktop layouts, sticky navigation clearance, six visible thumbnails, zoom/pan/navigation reset, and a 390×844 phone layout and zoom. Live review confirmed the new layout, no zoom scrollbars, no thumbnail numeric badges, measured accordion transition states, and product cards without an overlay while keyboard focus reveals the second image. Proof: `proof/gallery-layout-fixed.png`, `proof/zoom-fixed.png`, and `proof/hover-without-overlay.png`. Automated tests, typecheck and lint were not run.
