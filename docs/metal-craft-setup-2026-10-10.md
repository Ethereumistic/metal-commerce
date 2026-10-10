# Metal Craft connection — 2026-10-10

Production origin: https://metal.echoray.cloud

Business: `ks7edx6n4kr4zz1396yqy4deq18g0tkc` (Metal Craft).

Integration: `p172wsjnz491b5jj0cm3hh33sh8g15gp`, activated through the owner’s dashboard verification.

Worker: `metal-craft`, Cloudflare account verified through the existing authenticated Wrangler installation. No existing Worker or domain route was replaced.

Current deployment: `48a77534-9e16-499c-9784-803c560f2a45`.

First challenge deployment: `0e569154-0e26-410d-9d0c-6f3fbf61152f`. This is only a rollback for this new Worker, not the original furniture store.

## Changes

- Replaced production business, canonical origin and public registration settings.
- Installed three protected Worker bindings. Deleted the temporary credential input after upload; confirmed the private credential is absent from the public build.
- Published Metal Craft’s existing empty shop configuration in custom website content mode, preserving existing merchant settings.
- Updated visible branding, page titles, localized entry/empty-state copy and isolated browser storage.
- Removed the inherited oak provenance story from the rendered home/about pages.
- Removed furniture-specific category ordering; dashboard collections remain authoritative.
- Kept inherited styling/editorial assets as foundation material. No merchant product records, stock, prices, payment accounts, delivery promises or legal policies were invented.

## Observed evidence

- Runtime contract supports protocol 1, public catalog, private commerce/shop auth and Pay capabilities.
- Exact challenge route returns HTTP 200, plain text, no redirect and private/no-store caching over valid HTTPS.
- Public SDK bootstrap resolves the exact Metal Craft business and origin, with zero collections.
- `/api/categories` returns HTTP 200 with `status: ready` and an empty array.
- `/en` renders Metal Craft with canonical URLs on the production origin and private/no-store caching.
- Same-origin `/api/shop` `authConfig` returns enabled password and OTP settings using the protected integration.
- Product discovery returns `UNAVAILABLE: Discovery migration in progress.` Source inspection shows initialization on the first real product save for an empty business. No platform mutation or fake product was used to bypass this gate.
- Cloudflare public DNS resolves the domain. Local recursive DNS retained an earlier negative response during initial verification; direct checks used the published Cloudflare DNS address with normal TLS certificate validation.

## Validation and readiness

Production Vite builds completed; TypeScript and six locale tests passed. Broader inherited browser suites were not run. Browser screenshots were attempted but the browser capture service timed out.

The connection and domain configuration are complete. The catalog is empty; saving the first actual product initializes discovery. Live sales still require products, applicable tax confirmation, approved policy versions/URLs, delivery eligibility and a connected payment provider. Account creation, email delivery, cart changes, purchases and financial transactions were not run.

## Recovery

`wrangler.jsonc` is the production configuration source. Deploy with the production `VITE_SITE_URL`. Preserve Worker secrets and use the hosting version history for code rollback. Do not restore the shared database or replace/retire the commerce integration to undo a website release.
