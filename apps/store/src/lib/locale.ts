export const supportedLocales = ["bg", "en"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export function preferredLocale(request: Request): SupportedLocale {
  const cookie = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)METAL_CRAFT_LOCALE=(bg|en)(?:;|$)/)?.[1];
  return (cookie as SupportedLocale | undefined) ?? "bg";
}

export function localeRedirect(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (/^\/(bg|en)(\/|$)/.test(url.pathname)) return undefined;
  // Assets and framework transport must never be redirected to language routes.
  if (
    /^\/(assets|images|flags|cdn-cgi|_server|__debug|@|src|node_modules)(\/|$)/.test(
      url.pathname,
    ) ||
    /\.[a-z0-9]+$/i.test(url.pathname) ||
    !["GET", "HEAD"].includes(request.method)
  )
    return undefined;
  const locale = preferredLocale(request);
  // Keep old shared links usable without retaining unsupported language routes.
  const path = url.pathname.replace(/^\/(fr|de)(?=\/|$)/, "");
  url.pathname = `/${locale}${path === "/" ? "" : path}`;
  return new Response(null, {
    status: 307,
    headers: {
      Location: url.href,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}
