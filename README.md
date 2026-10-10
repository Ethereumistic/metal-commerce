# MORIS

A luxury furniture frontend built with TanStack Start, React, Tailwind CSS, and shadcn/ui using **Base UI**. Configured for Cloudflare Workers.

The visual direction takes inspiration from Poliform and Castlery: architectural room photography, clear collection navigation, generous spacing, quiet surfaces, and a restrained Manrope type system.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Entry URLs redirect to the appropriate language.

For the production build running in the local Workers runtime:

```sh
npm run build
npm run preview
```

## Frontend scope

- Responsive home, collection, piece detail, and our story pages.
- An interactive Bulgarian oak story on the homepage and About page: three chapters on dense grain, natural patina and a second life, with responsive photography and accessible image enlargement. All copy is available in English, French and German; motion respects the visitor's reduced-motion preference.
- Categories are loaded on the server from MORIS FURNITURE’s published Echoray collections. Initial categories: tables, chairs, desks, lamps, sideboards, mirrors, benches. Category visibility, descriptions and covers are managed in Commerce → Collections.
- Products, finish options, prices, production times, descriptions, specifications, FAQs and ordered photo galleries come from Echoray Commerce. Home, collection, search and detail pages share the live catalog.
- Product cards reveal image 2 on hover and keyboard focus after it loads. Product galleries support thumbnails, previous/next, arrow/Home/End keys, horizontal swipe, fullscreen and detail zoom.
- Backend token/prefix search, global material/category filters, bounded page navigation, sorting, and mobile navigation.
- Catalog integration through scoped server loaders, `GET /api/categories`, and `GET /api/products`.
- Bag, accounts and checkout review through the same-origin `POST /api/shop` gateway (`src/lib/shop.server.ts`). The browser never contacts the commerce backend; the Worker holds the integration secret and keeps guest/shopper credentials in HttpOnly `__Host-moris-*` cookies. The bag is a zustand store (`src/lib/cart-store.ts`) with queued optimistic edits; the server cart stays authoritative and a guest bag merges into the account on sign-in. Adding a piece flies its photo into the header bag.
- MORIS accounts are identifier-first: the shopper enters an email, then signs in with a password, creates one (verified by emailed code), or receives a one-time code, depending on the methods enabled in Echoray Commerce → Auth. The same flow runs on `/account` and in the checkout dialog. Signed-in shoppers save name, phone, shipping (address 0) and billing (address 1) on `/account`.
- Checkout asks "guest or account", then a shipping address saved on the bag (optionally to the account), then the review. It pauses before payment; no payment is taken in this release.
- All twelve product fixtures have been removed. The initial merchant catalog contains Trestle (€4,800; 220 × 95 × 75 cm), Round (€3,900; Ø120 × 75 cm) and Low (€3,000; 120 × 65 × 38 cm), each with Natural and Smoked matte oil options, six generated design images and a 30–60 day production FAQ.
- Commerce `/products/{slug}` share links redirect to the corresponding localized `/pieces/{slug}` route. Unknown/unpublished products resolve to 404; backend failures render an unavailable state without sample products.
- Responsive, locally served WebP images; self-hosted font files; reduced-motion support; keyboard focus and accessible Base UI dialogs.

## Public catalog gateway adoption

The version 1 SDK now supplies navigation bootstrap, four home cards, globally
filtered card pages and detail with at most four related cards. Gallery previews,
category covers and card hover views use published derivatives; zoom keeps originals.
Route reuse retains original receipt times (30 seconds, 15 for search), with focus
refresh and explicit no-store for dynamic responses. `STOREFRONT_CATALOG_ADAPTER`
selects `gateway` or an explicit `direct` rollback; failures never switch automatically.

See the [implementation checklist](docs/commerce-caching-plan.md) and
[adoption/verification record](docs/commerce-catalog-adoption-2026-10-07.md).
The gateway blocker is fixed and this implementation is **deployed at 100%** on
https://echoray.cloud. Shared native catalog and media caching is enabled after
deployed expiry/failure acceptance. The release record includes canary evidence,
protected backup location, prior versions and explicit rollback commands.

## Internationalization

Paraglide compiles **messages/en.json**, **messages/fr.json**, and **messages/de.json** into typed, tree-shakeable messages. Its Vite plugin runs during development and production builds.

Every public route has a language prefix:

| Language | Example URL    |
| -------- | -------------- |
| English  | /en/collection |
| French   | /fr/collection |
| German   | /de/collection |

Resolution order:

1. An explicit /en, /fr, or /de URL always wins.
2. For an unprefixed URL, a saved MORIS_LOCALE language choice wins.
3. On a first visit, Cloudflare request.cf.country selects French for FR, German for DE, and English for every other country. CF-IPCountry is a fallback when the native country metadata is unavailable.
4. Missing country metadata falls back to English.

The language selector uses flagcdn.com/gb.svg, flagcdn.com/fr.svg, and flagcdn.com/de.svg. It preserves the page and query parameters and saves the explicit language preference.

**src/server.ts** performs country-based entry redirects before Paraglide's request-scoped middleware. Redirects use private, no-store to prevent another user's geography or saved preference from being cached. Assets and framework transport are excluded. TanStack Router's URL rewrites keep one shared route tree for all languages.

Local Cloudflare simulation supplies its own country metadata, which can take priority over an injected CF-IPCountry header. The country-routing tests use simulated native request.cf.country values. The deployed Worker uses Cloudflare's country metadata on real visitor traffic.

The document language, titles, descriptions, canonical links, and alternate language links are localized. Set **VITE_SITE_URL** to the final HTTPS origin **before building** to generate absolute canonical and hreflang URLs. Without it, the local preview uses relative URLs.

## Checks

```sh
npm run build
npm run typecheck
npm run test:locale
npm run test:catalog
# Historical fixture-era suites: npm run test:e2e
npx wrangler deploy --dry-run
```

The browser suite covers responsive layouts, language switching and persistence, translated search, collection filters, sorting, empty states, mobile navigation, image enlargement, concurrent SSR, localized 404s, and automated WCAG A/AA scans. The oak story checks cover chapter selection by touch and keyboard, all three languages, dialog focus restoration, reduced motion and every chapter at phone, tablet and desktop widths.

Playwright uses /usr/bin/chromium on this machine. On another machine, set PLAYWRIGHT_CHROMIUM_EXECUTABLE to its Chromium executable. The tests start a production preview on port 5173; run the build first.

## Cloudflare deployment

The Cloudflare Vite plugin builds the application for the Workers runtime. **wrangler.jsonc** points to the custom server entry required for locale detection. Its compatibility date matches the installed workerd runtime.

The design preview is deployed to **https://echoray.cloud** as the **moris** Worker. The custom domain is managed in **wrangler.jsonc**; Cloudflare provisions its DNS record and HTTPS certificate.

For subsequent deployments, authenticate with the configured Cloudflare account, ensure **.env.production** contains the public origin below, and run:

```dotenv
VITE_SITE_URL=https://echoray.cloud
```

```sh
npm run deploy
```

The environment file is local and ignored by version control; **.env.example** provides the same public setting. Public category bindings are configured in **wrangler.jsonc**. Categories require a published catalog and an active storefront registration for the exact production origin.

Previous design release verification: 35 browser checks and six locale unit tests passed before the category integration. These results do not verify this release. For the categories-first integration, the check-free Vite production build completed and Wrangler deployed to echoray.cloud. Tests, typechecks and lint were not run under the Echoray integration skill’s constraints.

## Echoray categories setup

Activation verified on 2026-10-04: `resolveStorefront` resolves https://echoray.cloud to MORIS FURNITURE, the published catalog uses external website content, and `/api/categories` returns HTTP 200 with all seven categories. English, French and German live pages return HTTP 200 without the unavailable state. All seven production category images loaded in the Codex browser. The challenge URL returns exact plain text with no redirect and no-store caching. Three protected Worker bindings were saved. No payment/account/cart flows were exercised.

The business is **MORIS FURNITURE**, ID `ks78yp26ch3085wpavqdwas6gs8fkdqa`, in the linked dev.echoray.io dashboard. Seven collections were recreated through that dashboard with their original English descriptions and uploaded site covers. The catalog is published and uses custom website content mode. Runtime fixture products were removed; only isolated SDK-valid test fixtures remain.

The gateway SDK validates version 1, integration and response route. Bootstrap also
asserts the configured MORIS business and origin. The root loader supplies navigation
only; product loaders request bounded cards/detail separately. `GET /api/products`
now returns paginated presentation cards, not full product records or every page.
Existing EN/FR/DE category URL aliases are preserved. There are no fixture fallbacks.

Owner activation steps:

1. In Commerce → Payments → Existing merchant and storefront setup, register `https://echoray.cloud`. Complete the password confirmation directly in the dashboard. Preserve the one-time result; do not paste its credential into chat.
2. Put `STOREFRONT_INTEGRATION_ID`, `STOREFRONT_INTEGRATION_SECRET`, and `STOREFRONT_DOMAIN_CHALLENGE` into the moris Worker’s protected bindings with Wrangler secret commands. Keep any temporary input file mode 0600 and remove it after upload. Never put credentials in VITE variables. Public catalog adoption uses the separately named public integration ID in wrangler.jsonc. The existing protected registration bindings are preserved; private credentials are for later transactional commerce.
3. The Worker serves the exact challenge as plain text at `/.well-known/echoray-storefront` without language redirection or caching. Then click **Verify published domain challenge** in the registration result. A published catalog and active integration are both required before the catalog renders.
4. Read `https://echoray.cloud/api/categories`; successful activation returns status `ready` and the published categories. Reload the site after activation. The router refreshes catalog loader data after 30 seconds when navigating.

Existing active registrations must be preserved; a pending or already recorded origin can also prevent registration. Resolve any registration conflict through the owner dashboard before proceeding. Registration and public catalog display do not establish checkout, shopper accounts, sandbox payment availability, or live payment readiness.

## Main files

| File                          | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| src/styles.css                | Design tokens, layouts, breakpoints, and interaction styling     |
| src/components/home-page.tsx  | Homepage composition                                             |
| src/components/oak-story.tsx  | Interactive oak origin and material story                        |
| src/styles/oak-story.css      | Oak story layout, photography transitions and breakpoints        |
| src/components/site-shell.tsx | Shared navigation, search, language selector, footer             |
| src/lib/catalog.ts            | Translated category and material labels                 |
| src/lib/commerce.server.ts    | SDK gateway transport, business/origin scope and bounded catalog |
| src/lib/commerce.ts           | Catalog server functions and shared loader hooks                 |
| src/lib/category-copy.ts      | Existing translated descriptions and merchant copy               |
| src/lib/locale.ts             | Country selection, preference handling, entry redirects          |
| src/server.ts                 | Workers-compatible Paraglide middleware                          |
| messages/*.json               | Editable English, French, and German copy                        |
| project.inlang/settings.json  | Locale and message-format configuration                          |

Photography sources are recorded in [ASSET_SOURCES.md](ASSET_SOURCES.md).
