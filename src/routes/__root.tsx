import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  Link,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import stylesheet from "@/styles.css?url";
import { getLocale, localizeHref, locales } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";
import {
  recordReceipt,
  receiptExpired,
  catalogKey,
  type CatalogRouterContext,
} from "@/lib/catalog-freshness";
import { getStoreCatalog } from "@/lib/commerce";
import { CartDrawer, CartFlightLayer, CartSync } from "@/components/cart";

export const Route = createRootRouteWithContext<CatalogRouterContext>()({
  loader: async ({ context, abortController }) => {
    const result = await getStoreCatalog({ signal: abortController.signal });
    recordReceipt(context, "__root__", result);
    return result;
  },
  shouldReload: ({ context }) => receiptExpired(context, "__root__"),
  staleTime: 30_000,
  preloadStaleTime: 30_000,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MORIS — " + m.announcement() },
      { name: "description", content: m.collection_intro() },
      { name: "theme-color", content: "#faf9f6" },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
  }),
  component: Root,
  notFoundComponent: () => (
    <main className="not-found">
      <Link className="wordmark" to="/">
        MORIS
      </Link>
      <h1>{m.not_found()}</h1>
      <p>{m.not_found_body()}</p>
      <Link to="/" className="text-link">
        {m.return_home()}
      </Link>
    </main>
  ),
});

function Root() {
  const { pathname, searchStr } = useLocation();
  const router = useRouter();
  useEffect(() => {
    document.documentElement.dataset.morisHydrated = "true";
    // Seed request-scoped receipts from SSR hydration without changing their age.
    for (const match of router.state.matches) {
      const data = match.loaderData as { loadedAt?: number } | undefined;
      if (
        data &&
        ["__root__", "/", "/collection", "/pieces/$slug"].includes(
          match.routeId,
        )
      ) {
        recordReceipt(
          router.options.context!,
          catalogKey(
            match.routeId,
            match.loaderDeps,
            "slug" in match.params ? match.params.slug : undefined,
          ),
          data,
        );
      }
    }
    let refreshing = false;
    const refresh = () => {
      if (document.visibilityState !== "visible" || refreshing) return;
      const active = new Set(router.state.matches.map((match) => match.id));
      const stale = new Set(
        router.state.matches
          .filter((match) => {
            const data = match.loaderData as { loadedAt?: number } | undefined;
            if (
              !["__root__", "/", "/collection", "/pieces/$slug"].includes(
                match.routeId,
              )
            )
              return false;
            const ttl =
              match.routeId === "/collection" && match.search.q
                ? 15_000
                : 30_000;
            return !data?.loadedAt || Date.now() - data.loadedAt >= ttl;
          })
          .map((match) => match.id),
      );
      if (!stale.size) return;
      refreshing = true;
      void router
        .invalidate({
          filter: (match) => active.has(match.id) && stale.has(match.id),
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  const siteUrl = import.meta.env.VITE_SITE_URL ?? "";
  const path = pathname + searchStr;
  return (
    <html lang={getLocale()}>
      <head>
        <HeadContent />
        {locales.map((locale) => (
          <link
            key={locale}
            rel="alternate"
            hrefLang={locale}
            href={siteUrl + localizeHref(path, { locale })}
          />
        ))}
        <link
          rel="alternate"
          hrefLang="x-default"
          href={siteUrl + localizeHref(path, { locale: "en" })}
        />
        <link rel="canonical" href={siteUrl + localizeHref(path)} />
      </head>
      <body>
        <Outlet />
        <CartSync />
        <CartDrawer />
        <CartFlightLayer />
        <Scripts />
      </body>
    </html>
  );
}
