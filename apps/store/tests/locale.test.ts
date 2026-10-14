import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  supportedLocales,
  preferredLocale,
  localeRedirect,
} from "../src/lib/locale.ts";

function request(path: string, cookie?: string, country?: string) {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  if (country) headers.set("CF-IPCountry", country);
  const req = new Request("https://metal.example" + path, { headers });
  if (country) Object.defineProperty(req, "cf", { value: { country } });
  return req;
}

test("Bulgarian is the default regardless of country; only Bulgarian and English are supported", () => {
  assert.deepEqual(supportedLocales, ["bg", "en"]);
  for (const country of ["BG", "FR", "DE", "US", "GB", undefined]) {
    assert.equal(preferredLocale(request("/", undefined, country)), "bg");
  }
});
test("saved supported choices are respected and removed languages fall back to Bulgarian", () => {
  assert.equal(
    preferredLocale(
      request("/", "other=x; METAL_CRAFT_LOCALE=en; another=y", "BG"),
    ),
    "en",
  );
  assert.equal(
    preferredLocale(request("/", "METAL_CRAFT_LOCALE=bg", "GB")),
    "bg",
  );
  for (const cookie of ["fr", "de", "unsupported", "english"]) {
    assert.equal(
      preferredLocale(request("/", `METAL_CRAFT_LOCALE=${cookie}`)),
      "bg",
    );
  }
});
test("entry redirects retain the route and filters and cannot be shared through cache", () => {
  const response = localeRedirect(request("/collection?category=chemistry"))!;
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://metal.example/bg/collection?category=chemistry",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(
    localeRedirect(request("/", "METAL_CRAFT_LOCALE=en"))!.headers.get(
      "location",
    ),
    "https://metal.example/en",
  );
});
test("former French and German links retain the page, query and preferred supported language", () => {
  for (const oldLocale of ["fr", "de"]) {
    for (const [cookie, locale] of [
      [undefined, "bg"],
      ["METAL_CRAFT_LOCALE=en", "en"],
    ] as const) {
      assert.equal(
        localeRedirect(
          request(`/${oldLocale}/pieces/atomic-orbit?view=2`, cookie),
        )!.headers.get("location"),
        `https://metal.example/${locale}/pieces/atomic-orbit?view=2`,
      );
      assert.equal(
        localeRedirect(request(`/${oldLocale}`, cookie))!.headers.get(
          "location",
        ),
        `https://metal.example/${locale}`,
      );
    }
  }
});
test("explicit supported links take precedence over saved choices", () => {
  for (const locale of supportedLocales) {
    assert.equal(
      localeRedirect(
        request(`/${locale}/pieces/atomic-orbit`, "METAL_CRAFT_LOCALE=en"),
      ),
      undefined,
    );
    assert.equal(localeRedirect(request(`/${locale}`)), undefined);
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
    assert.equal(localeRedirect(request(path)), undefined);
  }
  assert.equal(
    localeRedirect(
      new Request("https://metal.example/collection", { method: "POST" }),
    ),
    undefined,
  );
  assert.equal(
    localeRedirect(
      new Request("https://metal.example/", { method: "HEAD" }),
    )!.headers.get("location"),
    "https://metal.example/bg",
  );
});
test("Bulgarian translates every English message with matching placeholders", () => {
  const messages = (locale: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../messages/${locale}.json`, import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>;
  const en = messages("en"),
    bg = messages("bg");
  assert.deepEqual(Object.keys(bg).sort(), Object.keys(en).sort());
  const placeholders = (value: string) =>
    Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(bg[key]), placeholders(en[key]), key);
    if (key !== "$schema" && key !== "new_collection")
      assert.match(bg[key], /[А-Яа-я]/, key);
  }
});
