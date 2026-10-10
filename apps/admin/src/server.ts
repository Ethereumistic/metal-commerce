import handler from "@tanstack/react-start/server-entry";

// Back-office pages are per-operator: never cache, never frame, never leak referrers.
export default {
  async fetch(request: Request): Promise<Response> {
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
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
