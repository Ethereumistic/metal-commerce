# MORIS public catalog adoption, 2026-10-07

Production adoption is complete at **100%** on https://echoray.cloud.

| Surface | Deployed version |
| --- | --- |
| MORIS Worker `moris` | `3c50cbf8-02f1-46e8-8b34-d985d87ed9ae` |
| Shared production gateway | `8d85e083-3d15-481d-b773-585c4fbfddd9` |
| Shared staging gateway | `a510630f-6e26-41a2-91b0-990aa2948543` |

The initial 503 was caused by `redirect: "error"`, which this Workers runtime
rejects before issuing a fetch. Catalog and media now use manual redirects and
reject non-success responses; no redirect is followed. Safe failure-stage logging
was added. Catalog and Media native caching is enabled; the default gateway stays
uncached. Media no longer consumes the 30-request discovery bucket, which could
reject images during ordinary collection browsing. Visitor, tenant and origin
admission limits still apply.

Both gateway and MORIS used a 10% canary before expansion to 100%. MORIS preview,
forced canary requests on the actual domain, and final unpinned production checks
passed. No production merchant data, prices, stock, payment settings or private
flows were changed.

## Version and merchant configuration

- SDK: `@echoray/api-client@1.0.0`, entrypoint `public-catalog`.
- Vendored published archive: `vendor/echoray-api-client-1.0.0.tgz`.
- SHA-256: `572332199c0441a24cdda77924e9bb234bb97ec5a857e409f583fab9835b9982`.
- Wire version: 1; backend release: `core-commerce-public-catalog-1`.
- Production gateway: `https://commerce.echoray.io`.
- Public integration: `p1724smvytpbhadhmmdfpgh3p58fnvxe`.
- Business: `ks78yp26ch3085wpavqdwas6gs8fkdqa` (MORIS FURNITURE).
- Merchant origin: `https://echoray.cloud`.

`wrangler.jsonc` owns `STOREFRONT_GATEWAY_URL`,
`STOREFRONT_PUBLIC_INTEGRATION_ID`, `STOREFRONT_CATALOG_ADAPTER` and existing
merchant/origin/auth settings. SDK validation checks wire version, route and
integration on every response. Bootstrap additionally asserts business and origin.
Private integration secret and domain challenge stay in protected bindings. There
is no purge/admin credential or new cache in MORIS. HTTP transport avoids a local
service-binding dependency; the SDK can accept a binding in a future configuration.

`npm ci` installs the committed SDK archive without monorepo access. Regenerate
Worker bindings with `npm run cf-typegen` after configuration changes.

## Route and API consumption

| Surface                   | New catalog requests on cold route load                 | Previous single-page call graph                                         |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| About / journal / article | Bootstrap only (1)                                      | Contract + resolve + categories, contract + resolve + full products (6) |
| Home                      | Bootstrap + four cards (2)                              | Same full root catalog (6)                                              |
| Collection                | Bootstrap + one page, max 24 cards (2)                  | Same full root catalog (6), then local filters                          |
| Detail                    | Bootstrap + detail including max four related cards (2) | Full root catalog + contract + resolve + detail (9)                     |

These counts are call-graph observations and fixture acceptance, not production
traffic or performance measurements. Extra category pages are bounded at 20 pages
of 50 and preserve complete navigation. Collection filters apply globally before
pagination; lower-case legacy category aliases become exact backend names. Search
is debounced 300 ms, aborts superseded/closed requests and returns at most eight
suggestions. It uses token/prefix relevance and offers full paginated results.
Broad-search errors explain how to refine the query. Name ordering is backend NFKC
codepoint A–Z, not browser locale collation. SDK 1 has no editorial featured sort;
the default label now says Catalog order and home displays its first four cards.

`GET /api/categories` preserves the complete, bounded navigation adapter.
`GET /api/products` returns `{ productStatus, products, cursor, loadedAt }` with
presentation cards, max 50, default 24. Parameters: `category`, `material`,
`sort=name`, `q`, `cursor`, `limit`. Previous full-detail/all-product consumers must
migrate; there is deliberately no unbounded export. Invalid filters return 400,
cursor restart 409, admission 429, unavailable 503. Framework server functions,
SSR HTML, API JSON, domain challenge and redirects remain `private, no-store`.

Original SDK receipt times control navigation reuse (30 s catalog, 15 s search).
A router-instance map records timestamps only; it does not store another catalog.
Failures never renew successful data. Focus and visibility return refresh active
stale loaders, coalescing concurrent events. Intent prefetch, scrolling, locale URLs,
SEO, options/prices and 404/unavailable distinction remain intact.

Category/card/hover media uses SDK derivative URLs and responsive width candidates.
Gallery uses detail previews and thumbnail controls; selected previews are prioritized.
Reserved image containers plus dimensions prevent layout collapse. Intentional
fullscreen zoom keeps original URLs. Missing manifests use original URLs; backend
image credits are retained as links. Live derivative delivery and desktop/mobile rendering were checked. A sample thumbnail/card/detail measured 4,834 / 20,172 / 64,858 bytes, with MISS then HIT in staging; the production card also returned MISS then HIT. Shared and browser copies retain the intentionally public withdrawal policy described in the checklist.

## Verification

Local acceptance uses `catalog_test`, a fixture-only gateway at `127.0.0.1:4319`.
Do not deploy that environment. Public SDK-valid backend responses are recorded in
`tests/fixtures`; synthetic additional cards exercise more than one page. Media
responses use local stand-in WebP bytes; this is transport/UI acceptance, not a
claim about production image quality. The fixture service never accesses Convex.

Commands:

```sh
npm run typecheck
npm run test:locale
npm run test:catalog
npm run build
```

Final checks: TypeScript passes, six locale tests pass, eight catalog browser tests pass, and the default production Vite build passes. Worker types were regenerated. The catalog suite builds and runs the
production bundle in the local Workers runtime. It covers bootstrap-only SSR,
EN/FR/DE, no-store, mobile menu/focus, cards and derivative attributes, global
multi-page filtering, back/forward, invalid-cursor restart, bounded/refined search,
localized detail/gallery/original zoom, stale refresh failure/recovery, merchant
scope mismatch, 404, and original-receipt reuse/expiry.

Read-only live browser acceptance (`tests/support/live-catalog.mjs`) passed on the
uploaded preview, forced 10% canary at the actual domain, and final production.
It checks EN/FR/DE SSR/hydration, no-store, all 21 collection cards and 42 loaded
published derivatives, French Arm detail, a 390-pixel filtered layout, bounded
search and 404. Screenshots are in `catalog-release-evidence/`.

Echoray acceptance passed against the actual pinned Convex component runtime on an
owned disposable loopback process: eleven distinct integrations with identical
slugs, 31 products each, multi-page results, global material filtering, foreign and
filter-changed cursors, archive/collection and shop publication, suspend, uninstall,
revocation, foreign availability IDs and fresh price reads. No production data or
mail credentials entered that runner.

The deployed synthetic gateway/origin passed native cache tenant isolation, stable
hit timestamps, 5/15/30-second expiry during a scheduled origin outage, redirect,
size, scope and deadline rejection, uncached 404/503, and purge of both cache owners.
Production operator purge also returned success from both owners, followed by
bootstrap MISS then HIT with identical generation time and seven categories.
[Cache observations](catalog-release-evidence/deployed-cache.json) and
[production operator evidence](catalog-release-evidence/production-operator.json)
are saved. Temporary synthetic Workers were removed after acceptance.

The shared schema/contract suite passed ten tests and its typecheck; the gateway
strict typecheck passed. Broader legacy backend checks exposed 30 checkout test
failures (including blank-phone fixtures and policy/order expectations) and
existing full-backend Pay/Convex type errors. Those checks are not green; this
catalog rollout does not establish paid-checkout readiness. No backend runtime
functions were redeployed by this rollout. Full regional tier-promotion, sustained
capacity/load, billing forecasts, recurring off-host recovery and provider/payment
acceptance remain separate platform work. Old fixture-era UI tests were not used;
no lint was run.

## Rollout and rollback

The fresh database/storage snapshot was ZIP-validated before deployment:
`/home/echo/.echoray/core-platform-backups/20261007-moris-rollout/snapshot.zip`
(236,350,384 bytes, mode 0600). Secret backups remain protected separately.

Storefront rollback to the previous production version:

```sh
npx wrangler versions deploy 5ec6b9d2-c784-4ada-a326-ab003854e2a7@100 --yes
```

Run from this checkout. Or set `STOREFRONT_CATALOG_ADAPTER=direct`, rebuild the
production configuration and deploy explicitly. Gateway errors never switch
adapters automatically. The direct adapter is bounded but uses heavier legacy
queries, substring search and originals; gateway cursors restart.

Shared gateway rollback to the healthy uncached version, from its Echoray directory:

```sh
pnpm exec wrangler versions deploy 0a8e40ba-4380-453b-af98-1659b9f1db91@100 --env production --yes
```

Keep additive schemas/manifests and original images. Do not restore the database
to undo a storefront release. A separately required restore must rotate catalog
epochs. Disabling cache does not purge stored entries; use the protected operator
route from both owners if distributed public content must stop immediately.
The `catalog_test` storefront environment must never be deployed.

Server logs record `moris_catalog` diagnostics (cache, environment, origin latency)
and `moris_catalog_error` codes only. Raw search/cursor, IP, cookies and credentials
are omitted. Successful receipt timestamps remain available in loader/API data.
