# Metal Craft

pnpm + Turborepo monorepo for the Metal Craft shop on the Echoray platform. Both apps are TanStack Start and deploy as separate Cloudflare Workers.

| Path | Package | Purpose | Production |
| --- | --- | --- | --- |
| `apps/store` | `@metal/store` | Customer storefront ([README](apps/store/README.md)) | https://metal.echoray.cloud (Worker `metal-craft`) |
| `apps/admin` | `@metal/admin` | Back office for business operators | https://metal-admin.echoray.cloud (Worker `metal-admin`) |
| `packages/ui` | `@workspace/ui` | Shared shadcn/ui components, hooks and theme | — |

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
