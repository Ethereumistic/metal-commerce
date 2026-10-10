# MORIS commerce caching implementation checklist

Updated: 2026-10-07. Status: **implemented, verified and deployed at 100% on https://echoray.cloud; shared native catalog/media caching enabled**. See the adoption record for versions, acceptance and rollback.

The authoritative backend, gateway, API, freshness and release contract is
[Echoray's shared commerce plan](/home/echo/Documents/echoray.io/docs/core-platform/commerce-caching-plan.md).
This checklist covers only the custom storefront. It does not define another cache
service; update it from the shared plan when those contracts change.

## Existing behavior to preserve

Worker `moris` serves `https://echoray.cloud` using TanStack Start. Root/detail
loaders already reuse data for 30 seconds; intent prefetch and scroll restoration
already exist. Preserve EN/FR/DE, search/filter URLs, locale redirects, SEO,
prices/options, category covers, hover images, galleries, and unavailable/404 states.

Categories/products separately probe and resolve Convex before fetching data.
Root downloads the full catalog, including on informational pages. Cards and gallery
thumbnails use originals; two audited image samples were approximately 1 MB each.
The current release has no cart, checkout, account, or payment implementation.

Recheck applicable local/ancestor `AGENTS.md` before implementation; none was found
inside this checkout during review. Preserve unrelated work. The owner requested implementation on 2026-10-07. Local build, typecheck, locale tests and isolated browser acceptance were run for this task. Deployed cache failure/expiry and operator acceptance used owned synthetic Workers; catalog lifecycle mutations used a disposable loopback backend. Live MORIS checks were read-only.

## Dependencies owned by Echoray

Before production migration Echoray supplies:

1. Additive `publicCatalog: [1]`, scoped DTOs, efficient card/detail projections,
   discovery filters/sorting and bounded pagination.
2. Shared gateway with bootstrap, collections, cards, detail/related cards and typed
   unavailable/not-found results, plus request limits and diagnostics.
3. Versioned public SDK consumable in this separate npm project through HTTP or an
   optional Cloudflare fetch binding. No monorepo filesystem dependency or copied DTOs.
4. Owned published-media derivative manifests and shared cached delivery.
5. Staging/production configuration, freshness policy, canary and rollback support.

Convex owns authority and future purchase checks. The gateway owns shared caching,
keys, limits and purge. MORIS owns presentation and route data consumption.

## Work in this checkout

- [x] **Configuration:** add gateway URL/integration ID to `wrangler.jsonc` and
      environment examples; optionally add a same-account gateway service binding.
      Retain merchant-scope assertions, locale and auth configuration. No purge/admin
      credential belongs here; integration IDs are public.
- [x] **Server adapter:** replace direct public Convex reads in
      `src/lib/commerce.server.ts` with the SDK and remove duplicated contract/shop
      probes. Preserve one compatible direct adapter behind an explicit rollout flag
      for controlled rollback, not automatic fallback on every gateway failure.
- [x] **Types/transport:** update `src/lib/commerce.ts` for bootstrap, small cards,
      detail and paginated responses. Keep server functions thin; validate version and
      expected merchant scope. Errors do not become successful empty fixtures.
- [x] **Root:** in `src/routes/__root.tsx`, load shop/navigation bootstrap only.
      Remove the all-products dependency from informational pages.
- [x] **Home:** add a bounded featured-card loader in `src/routes/index.tsx` and
      consume it in `src/components/home-page.tsx`.
- [x] **Collection:** in `src/routes/collection.tsx`, send URL category/material/
      sort/search/cursor to the gateway; apply global filters before pagination.
      Add Load more/page navigation and reset cursor when filters change. A loaded-page
      length is not a total count. Reconcile ordering/search semantics with Echoray.
- [x] **Search/navigation:** update `src/components/site-shell.tsx` for bounded,
      debounced/cancellable search. Preserve category aliases, mobile and keyboard use.
      Translate existing lowercase category URLs to actual backend collection names.
- [x] **Detail:** in `src/routes/pieces.$slug.tsx`, use detail plus at most four
      related cards. Remove dependence on root products; preserve options, prices,
      specifications, FAQs and image credits.
- [x] **Current API adapters:** `/api/categories` and `/api/products` in
      `src/server.ts` use the SDK with pagination or an explicit compatible adapter.
      Do not hide an unbounded all-pages export behind an old endpoint.
- [x] **Navigation cache:** retain intent prefetch/scroll and at most 30-second route
      reuse, with tenant/filter/sort/cursor/locale keys as appropriate. Retain original
      load time; refresh stale active loaders on visibility return. Failures do not
      perpetually renew old data.
- [x] **HTTP:** explicitly keep SSR HTML, framework server-function responses,
      JSON adapters and cookie/geography-dependent redirects `no-store`. No whole-app
      native cache or cache-everything rule. The central gateway caches catalog JSON.
- [x] **Images:** update `src/components/piece-card.tsx`, category imagery and
      `src/components/product-gallery.tsx` for derivative URLs, `srcset`/`sizes`, reserved
      image space and thumbnail controls. Avoid originals solely for every hover view;
      retain image-2 reveal and zoom. Prioritize the selected main image and lazy-load
      below-fold media. Source/original images remain available when zoom needs them.
- [x] **Documentation:** record compatible SDK/API versions, merchant configuration,
      rollout flag, diagnostics, deployment order and rollback.

This is not a UI-library migration, monorepo move, or private-checkout feature.

## Freshness and release

Catalog TTL is 30 seconds with mandatory revalidation and no stale-on-error. A
pre-change fill can take five seconds, so the proposed maximum gateway snapshot
age is 35 seconds, excluding delivery. Route reuse can add 30 seconds on navigation.
Already open pages are not continually revoked; focus refresh updates stale data.
Previously public immutable images may remain servable from shared cache for 24
hours after withdrawal and in browser copies for up to a year; changed bytes use a
new URL. This applies to intentionally public display media. Stale display never
authorizes a sale.

When authorized, verify SSR/hydration, back/forward, mobile/keyboard, EN/FR/DE/SEO,
filters/sort/search across more than one page, cursor restart, failure/404 states,
gallery behavior and image bytes/cache headers. Record before/after requests.
TTFB is not a complete browser rendering metric. Echoray owns distinct-tenant load,
cache/origin failures and withdrawal acceptance; MORIS alone cannot prove capacity.

Deploy compatible backend/gateway/SDK versions before canary MORIS, then expand.
Inspect scripts for implicit checks and follow the implementation task's deployment
authorization. Keep prior versions/source media. A catalog-only release explicitly
reports media work pending until derivatives and consumers are delivered.

## Implementation record, 2026-10-07

The storefront installs the published SDK archive into `vendor/` and uses the
version 1 public-catalog entrypoint. No runtime path points to the Echoray monorepo
and no backend DTO definitions were copied. See
[adoption and verification record](commerce-catalog-adoption-2026-10-07.md) for
configuration, request counts, deployed versions, acceptance evidence and rollback.

Page navigation uses **Next page / First page**, preserving browser back/forward
and cursor URLs. A page count is labelled “pieces on this page.” Both default
catalog order and the preserved `sort=name` URL use backend normalized A–Z;
search uses relevance and disables name sorting. Featured home cards are the first
four in catalog order because SDK 1 has no editorial rank filter. Search prefixes
match backend merchant copy; this task does not introduce translated product data.

A router-instance receipt map retains original SDK timestamps, including intent
prefetch. It is bounded at 128 entries and never contains catalog data. Missing or
failed receipts force reload. Focus/visibility refresh affects active stale loaders;
there is no perpetual polling or server cache. Catalog route TTL is at most 30 s,
search 15 s. Failed refreshes replace cards with the unavailable state.

The explicit direct adapter retains bounded legacy projections, original images,
options and related cards for rollback. It scans at most 20 pages of 50 products
for global compatibility filtering and then returns one page. This heavier path
uses legacy substring search and is temporary rollback support only. The public
products API never exports every page in a response.
