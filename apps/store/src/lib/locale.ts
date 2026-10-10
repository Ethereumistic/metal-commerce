export const supportedLocales = ["en", "fr", "de"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export function localeForCountry(
  country: string | undefined | null,
): SupportedLocale {
  return country?.toUpperCase() === "FR"
    ? "fr"
    : country?.toUpperCase() === "DE"
      ? "de"
      : "en";
}

export function preferredLocale(request: Request): SupportedLocale {
  const cookie = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)METAL_CRAFT_LOCALE=(en|fr|de)(?:;|$)/)?.[1];
  if (cookie) return cookie as SupportedLocale;
  const country =
    (request as Request & { cf?: { country?: string } }).cf?.country ??
    request.headers.get("CF-IPCountry");
  return localeForCountry(country);
}

export function localeRedirect(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (/^\/(en|fr|de)(\/|$)/.test(url.pathname)) return undefined;
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
  url.pathname = `/${locale}${url.pathname === "/" ? "" : url.pathname}`;
  return new Response(null, {
    status: 307,
    headers: {
      Location: url.href,
      "Cache-Control": "private, no-store",
      Vary: "Cookie, CF-IPCountry",
    },
  });
}
