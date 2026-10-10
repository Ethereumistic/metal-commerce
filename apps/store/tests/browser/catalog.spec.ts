import { test, expect } from "@playwright/test";
const control = "http://127.0.0.1:4319/control";
test.beforeEach(async ({ request }) => {
  await request.get(`${control}?reset=1&fail=0&scope=ok`);
});

test("informational SSR reads bootstrap only and every dynamic response is no-store", async ({
  request,
}) => {
  for (const locale of ["en", "fr", "de"]) {
    const response = await request.get(`/${locale}/about`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const html = await response.text();
    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('hrefLang="fr"');
  }
  const calls = (await (await request.get(control)).json()).requests;
  expect(calls).toHaveLength(3);
  expect(
    calls.every((c: { path: string }) => c.path.endsWith("/bootstrap")),
  ).toBe(true);
  const redirect = await request.get("/", { maxRedirects: 0 });
  expect(redirect.headers()["cache-control"]).toContain("no-store");
  const invalid = await request.get("/api/products?limit=999");
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()["cache-control"]).toContain("no-store");
});

test("home fetches four cards and derivatives; hydration, mobile menu and locale remain usable", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/de");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await expect(page.locator(".edit-section .piece-card")).toHaveCount(4);
  await expect(page.locator(".category-card")).toHaveCount(7);
  expect(
    await page.locator(".piece-primary").first().getAttribute("src"),
  ).toContain("/media/");
  expect(
    await page.locator(".piece-primary").first().getAttribute("srcset"),
  ).toContain("640w");
  await page.getByRole("button", { name: "Menü öffnen" }).click();
  await expect(page.locator(".mobile-menu nav a")).toHaveCount(8);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Menü öffnen" })).toBeFocused();
  const calls = (await (await request.get(control)).json()).requests;
  expect(
    calls.some(
      (c: { path: string; query: { limit: string } }) =>
        c.path.endsWith("/products") && c.query.limit === "4",
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("global discovery paginates, aliases reach the backend, and filters restart cursors", async ({
  page,
  request,
}) => {
  await page.goto("/en/collection?category=chairs");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(24);
  await expect(page.locator(".piece-count")).toHaveText(
    "24 pieces on this page",
  );
  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(7);
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await page.getByRole("button", { name: "Refine" }).click();
  await page.getByRole("button", { name: "Glass", exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page).toHaveURL(/material=glass/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(7);
  await page.goBack();
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(24);
  const calls = (await (await request.get(control)).json()).requests;
  expect(
    calls
      .filter((c: { path: string }) => c.path.endsWith("/products"))
      .every(
        (c: { query: { collection: string } }) =>
          c.query.collection === "Chairs",
      ),
  ).toBe(true);
  await page.goto("/en/collection?category=chairs&cursor=invalid");
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(24);
});

test("search is bounded, reports refinement, and opens a localized detail with original zoom", async ({
  page,
  request,
}) => {
  await page.goto("/fr/about");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Rechercher" });
  await box.fill("Z");
  await expect(page.locator(".search-result")).toHaveCount(8);
  await box.fill("broad");
  await expect(page.locator(".empty-search")).toContainText("préciser");
  await box.fill("arm");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.locator(".search-result").click();
  await expect(page).toHaveURL("/fr/pieces/arm");
  await expect(page.locator("h1")).toHaveText("Arm");
  expect(await page.locator(".gallery-open img").getAttribute("src")).toContain(
    "/detail",
  );
  expect(
    await page.locator(".gallery-thumbnails img").first().getAttribute("src"),
  ).toContain("/thumbnail");
  await page.getByRole("button", { name: "Agrandir l’image" }).click();
  await expect(page.locator(".lightbox-photo img")).toHaveAttribute(
    "src",
    /\/api\/storage\//,
  );
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".gallery-controls").last()).toContainText("02");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const calls = (await (await request.get(control)).json()).requests;
  const searches = calls.filter(
    (c: { query: { search?: string } }) => c.query.search,
  );
  expect(
    searches.every(
      (c: { query: { limit: string; sort: string } }) =>
        c.query.limit === "8" && c.query.sort === "relevance",
    ),
  ).toBe(true);
  // Detail includes related cards and never requests a complete product list.
  expect(
    calls.filter(
      (c: { path: string; query: { search?: string } }) =>
        c.path.endsWith("/products") && !c.query.search,
    ),
  ).toHaveLength(0);
});

test("focus refresh drops stale content on failure and recovers; 404 remains distinct", async ({
  page,
  request,
}) => {
  await page.goto("/en/collection");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await expect(page.locator(".piece-card")).toHaveCount(24);
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await request.get(`${control}?fail=1`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".piece-card")).toHaveCount(0);
  await expect(page.locator(".collection-empty")).toContainText("unavailable");
  await request.get(`${control}?fail=0`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".piece-card")).toHaveCount(24);
  const response = await page.goto("/de/pieces/missing");
  expect(response?.status()).toBe(404);
});

test("gateway failures and merchant-scope mismatch cannot become ready empty catalog data", async ({
  request,
}) => {
  await request.get(`${control}?fail=1`);
  const failed = await request.get("/api/products");
  expect(failed.status()).toBe(503);
  expect(failed.headers()["cache-control"]).toContain("no-store");
  expect(await failed.json()).toMatchObject({
    productStatus: "unavailable",
    products: [],
    errorCode: "ORIGIN_UNAVAILABLE",
  });
  await request.get(`${control}?fail=0&scope=wrong`);
  const scope = await request.get("/api/categories");
  expect(scope.status()).toBe(503);
  expect(await scope.json()).toMatchObject({
    status: "unavailable",
    categories: [],
  });
  const home = await request.get("/en");
  expect(await home.text()).not.toContain('class="piece-card"');
});

test("navigation reuses original receipts until expiry and refreshes the active root on return", async ({
  page,
  request,
}) => {
  await page.goto("/en/collection?category=chairs");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await page.locator(".collection-grid .piece-card").first().click();
  await expect(page.locator("h1")).toHaveText("Arm");
  await page.goBack();
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(24);
  const calls = (await (await request.get(control)).json()).requests;
  expect(
    calls.filter((c: { path: string }) => c.path.endsWith("/bootstrap")),
  ).toHaveLength(1);
  expect(
    calls.filter((c: { path: string }) => c.path.endsWith("/products")),
  ).toHaveLength(1);
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await page
    .locator(".header-left")
    .getByRole("link", { name: "Our story" })
    .click();
  await expect(page).toHaveURL("/en/about");
  await expect
    .poll(async () => {
      const fresh = (await (await request.get(control)).json()).requests;
      return fresh.filter((c: { path: string }) =>
        c.path.endsWith("/bootstrap"),
      ).length;
    })
    .toBe(2);
});

test("long URL searches explain refinement, and dynamic layouts fit small screens", async ({
  page,
}) => {
  await page.goto(
    "/en/collection?q=" + encodeURIComponent(Array(17).fill("wood").join(" ")),
  );
  await expect(page.locator(".collection-empty")).toContainText("more words");
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ["/en/collection", "/fr/pieces/arm", "/de/about"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path,
      ).toBe(true);
    }
  }
});
