import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localeForCountry,
  preferredLocale,
  localeRedirect,
} from "../src/lib/locale.ts";

function request(
  path: string,
  options: { country?: string; cookie?: string; headerCountry?: string } = {},
) {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.headerCountry) headers.set("CF-IPCountry", options.headerCountry);
  const req = new Request("https://moris.example" + path, { headers });
  if (options.country)
    Object.defineProperty(req, "cf", { value: { country: options.country } });
  return req;
}

test("France receives French, Germany German, and every other country English", () => {
  assert.equal(localeForCountry("FR"), "fr");
  assert.equal(localeForCountry("DE"), "de");
  for (const country of [
    "US",
    "GB",
    "CA",
    "CH",
    "BE",
    "AT",
    "BG",
    "LB",
    "XX",
    undefined,
    null,
  ]) {
    assert.equal(localeForCountry(country), "en");
  }
});
test("Cloudflare country metadata takes precedence over an incoming country header", () => {
  assert.equal(
    preferredLocale(request("/", { country: "FR", headerCountry: "DE" })),
    "fr",
  );
  assert.equal(preferredLocale(request("/", { headerCountry: "DE" })), "de");
});
test("a valid saved language choice takes priority over geography", () => {
  assert.equal(
    preferredLocale(
      request("/", {
        country: "FR",
        cookie: "other=x; MORIS_LOCALE=de; another=y",
      }),
    ),
    "de",
  );
  assert.equal(
    preferredLocale(request("/", { country: "DE", cookie: "MORIS_LOCALE=en" })),
    "en",
  );
  assert.equal(
    preferredLocale(
      request("/", { country: "DE", cookie: "MORIS_LOCALE=unsupported" }),
    ),
    "de",
  );
});
test("entry redirects retain the route and filters and cannot be shared through cache", () => {
  const response = localeRedirect(
    request("/collection?category=chairs", { country: "FR" }),
  )!;
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://moris.example/fr/collection?category=chairs",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, CF-IPCountry");
});
test("explicit localized links always take precedence over geography and cookies", () => {
  for (const locale of ["en", "fr", "de"]) {
    assert.equal(
      localeRedirect(
        request("/" + locale + "/pieces/arc-lounge-chair", {
          country: "DE",
          cookie: "MORIS_LOCALE=fr",
        }),
      ),
      undefined,
    );
  }
});
test("assets, framework transport, and non-GET requests are never localized", () => {
  for (const path of [
    "/images/hero-640.webp",
    "/assets/app.js",
    "/favicon.svg",
    "/cdn-cgi/local/explorer/api",
    "/_server/test",
    "/__debug",
    "/src/app.tsx",
  ]) {
    assert.equal(localeRedirect(request(path, { country: "FR" })), undefined);
  }
  assert.equal(
    localeRedirect(
      new Request("https://moris.example/collection", { method: "POST" }),
    ),
    undefined,
  );
});
