import handler from "@tanstack/react-start/server-entry";
import { paraglideMiddleware } from "./paraglide/server";
import { localeRedirect } from "./lib/locale";
import { env } from "cloudflare:workers";
import { validateProductFilters } from "./lib/commerce";
import { readCategoryCatalog, readProductCatalog } from "./lib/commerce.server";
import { createShopGateway } from "./lib/shop.server";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

function noStore(response: Response, secure: boolean) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  if (secure) headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Shop sessions use __Host- cookies, which only work over HTTPS.
    if (url.protocol === "http:" && !LOCAL_HOST.test(url.hostname)) {
      url.protocol = "https:";
      return new Response(null, {
        status: 308,
        headers: { Location: url.href, "Cache-Control": "no-store" },
      });
    }
    const secure = url.protocol === "https:";
    try {
      const response = await serve(request);
      if (response.status >= 400)
        console.warn(
          JSON.stringify({
            event: "metal_craft_error_response",
            status: response.status,
            method: request.method,
            path: url.pathname,
          }),
        );
      return noStore(response, secure);
    } catch {
      console.warn(JSON.stringify({ event: "metal_craft_request_unavailable" }));
      return noStore(
        new Response(
          request.method === "HEAD"
            ? null
            : "Storefront temporarily unavailable.",
          { status: 503 },
        ),
        secure,
      );
    }
  },
};
async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Framework RPC is transport, not a localized document. Keep its exact URL.
  if (/^\/_server(\/|$)/.test(url.pathname)) return handler.fetch(request);
  if (url.pathname === "/.well-known/echoray-storefront") {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    const challenge =
      "STOREFRONT_DOMAIN_CHALLENGE" in env
        ? env.STOREFRONT_DOMAIN_CHALLENGE
        : undefined;
    return new Response(
      request.method === "HEAD"
        ? null
        : typeof challenge === "string"
          ? challenge
          : "Domain verification pending.",
      {
        status: typeof challenge === "string" && challenge ? 200 : 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (url.pathname === "/api/shop")
    return createShopGateway(request).respond();
  if (url.pathname === "/api/categories") {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    const catalog = await readCategoryCatalog(request.signal);
    return new Response(
      request.method === "HEAD" ? null : JSON.stringify(catalog),
      {
        status: catalog.status === "ready" ? 200 : 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (url.pathname === "/api/products") {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    let filters;
    try {
      filters = validateProductFilters({
        ...Object.fromEntries(url.searchParams),
        ...(url.searchParams.has("limit")
          ? { limit: Number(url.searchParams.get("limit")) }
          : {}),
      });
    } catch {
      return Response.json(
        {
          productStatus: "unavailable",
          products: [],
          cursor: null,
          errorCode: "INVALID_REQUEST",
        },
        { status: 400 },
      );
    }
    const catalog = await readProductCatalog(filters, request.signal);
    return new Response(
      request.method === "HEAD" ? null : JSON.stringify(catalog),
      {
        status:
          catalog.productStatus === "ready"
            ? 200
            : catalog.errorCode === "INVALID_REQUEST"
              ? 400
              : catalog.errorCode === "RESTART_PAGINATION"
                ? 409
                : catalog.errorCode === "RATE_LIMITED"
                  ? 429
                  : 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  // Commerce share links use /products; preserve the storefront’s established piece URLs.
  const productLink = url.pathname.match(
    /^\/(bg\/|en\/)?products\/([a-z0-9][a-z0-9-]{1,78}[a-z0-9])\/?$/,
  );
  if (productLink && ["GET", "HEAD"].includes(request.method)) {
    url.pathname = `/${productLink[1] ?? ""}pieces/${productLink[2]}`;
    return new Response(null, {
      status: 302,
      headers: { Location: url.href, "Cache-Control": "private, no-store" },
    });
  }
  const redirect = localeRedirect(request);
  if (redirect) return redirect;
  // Keep the original URL: the router owns locale-prefix rewrites.
  return paraglideMiddleware(request, () => handler.fetch(request));
}
