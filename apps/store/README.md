# Metal Craft

Metal Craft storefront, forked from `furniture-commerce`, built with TanStack Start, React, Tailwind CSS and Base UI. Production hosting uses a separate Cloudflare Worker.

- Website: https://metal.echoray.cloud
- Worker: `metal-craft`
- Business: `ks7edx6n4kr4zz1396yqy4deq18g0tkc`
- Dashboard: https://dev.echoray.io/dashboard/ks7edx6n4kr4zz1396yqy4deq18g0tkc
- Active storefront integration: `p172wsjnz491b5jj0cm3hh33sh8g15gp`

Public catalog reads use `@echoray/api-client/public-catalog` through `https://commerce.echoray.io`. Bootstrap checks the configured business and origin. Private shopper operations use the same-origin `/api/shop` gateway and protected Worker bindings. Credentials are never part of browser configuration.

## Storefront categories and collections

The shop at `/{locale}/collection` groups published collections beneath storefront categories:

- `/{locale}/categories/wall-art` contains Architecture.
- `/{locale}/categories/collectibles` contains Ninja Blades (display replicas).
- Each collection has its own filtered page, such as `/{locale}/collections/architecture` or `/{locale}/collections/ninja-blades`.

`src/lib/taxonomy.ts` owns this presentation grouping. Commerce remains authoritative for collection names, product membership, descriptions and imagery. New unmapped collections remain discoverable under More collections until assigned to a group. Empty groups are omitted. This change does not create or rename dashboard records.

Products retain their stable `/{locale}/pieces/{slug}` URLs and link back through category and collection breadcrumbs. Existing `/collection?category=...` links remain usable; their canonical and language alternate links point to the clean collection route. Product filtering and cursor pagination run through the public catalog gateway; category navigation uses bootstrap without fetching all products.

## Setup and deployment

```sh
pnpm install
cp .env.example .env
pnpm dev
```

`VITE_SITE_URL=https://metal.echoray.cloud` must be set before a production build to generate canonical and alternate-language URLs. Runtime settings live in `wrangler.jsonc`.

```sh
VITE_SITE_URL=https://metal.echoray.cloud pnpm run deploy
```

The protected `STOREFRONT_INTEGRATION_ID`, `STOREFRONT_INTEGRATION_SECRET` and `STOREFRONT_DOMAIN_CHALLENGE` bindings were installed on `metal-craft`. Use Cloudflare secret commands for any future changes; never commit credentials, put them in `VITE_*`, or reuse credentials from the furniture store. Deployment preserves existing Worker secrets.

The `catalog_test` environment uses isolated fixture data and must never be deployed. Bulgarian is the default language, with English as the only alternative. Routes use `/bg` and `/en`; former `/fr` and `/de` links redirect to the preferred supported language. Language selection uses `METAL_CRAFT_LOCALE`, and cart/session storage is scoped to Metal Craft.

## Current readiness

The domain challenge is deployed and the storefront integration is active. Shop settings use external website content and the existing EUR currency, tax and support settings. The empty catalog is published. No products or collections were invented or imported from MORIS.

Product discovery currently returns `UNAVAILABLE: Discovery migration in progress.` The platform initializes an empty business’s discovery index when its first real product is saved. The website keeps this error visible instead of falling back to another shop or copied furniture data.

The inherited cart, shopper account and checkout review code is present. The private authentication configuration endpoint successfully resolves the Metal Craft integration. Actual sign-in, cart, orders and payments were not exercised. Checkout still needs real products, approved policy references, delivery rules and a payment-provider connection. The inherited checkout page has no enabled payment submission.

See [the setup record](../../docs/metal-craft-setup-2026-10-10.md) for deployment evidence and remaining steps. Older MORIS documents and assets are historical foundation material, not Metal Craft operational facts.
