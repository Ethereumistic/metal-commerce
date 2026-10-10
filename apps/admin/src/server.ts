import handler from "@tanstack/react-start/server-entry";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

// Back-office pages are per-operator: never cache, never frame, never leak referrers.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Session cookies are __Host- prefixed and require HTTPS.
    if (url.protocol === "http:" && !LOCAL_HOST.test(url.hostname)) {
      url.protocol = "https:";
      return new Response(null, {
        status: 308,
        headers: { Location: url.href, "Cache-Control": "no-store" },
      });
    }
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    if (url.protocol === "https:")
      headers.set("Strict-Transport-Security", "max-age=31536000");
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
