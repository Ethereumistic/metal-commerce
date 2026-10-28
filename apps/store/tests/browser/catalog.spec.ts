import { test, expect } from "@playwright/test";
const control = "http://127.0.0.1:4319/control";
test.beforeEach(async ({ request }) => {
  await request.get(`${control}?reset=1&fail=0&scope=ok&catalog=furniture`);
});

test("informational SSR reads bootstrap only and every dynamic response is no-store", async ({
  request,
}) => {
  for (const locale of ["bg", "en"]) {
    const response = await request.get(`/${locale}/about`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const html = await response.text();
    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('hrefLang="bg"');
  }
  const calls = (await (await request.get(control)).json()).requests;
  expect(calls).toHaveLength(2);
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
  await page.goto("/bg");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await expect(
    page.locator('section[aria-labelledby="latest-heading"] .piece-card'),
  ).toHaveCount(4);
  await expect(
    page.locator('section[aria-labelledby="collections-heading"] a'),
  ).toHaveCount(8);
  expect(
    await page.locator(".piece-primary").first().getAttribute("src"),
  ).toContain("/media/");
  expect(
    await page.locator(".piece-primary").first().getAttribute("srcset"),
  ).toContain("640w");
  await page.getByRole("button", { name: "Отвори менюто" }).click();
  await expect(page.locator(".mobile-menu nav a")).toHaveCount(9);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Отвори менюто" }),
  ).toBeFocused();
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
  await page.goto("/bg/about");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await page.getByRole("button", { name: "Търсене", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Търсене" });
  await box.fill("Z");
  await expect(page.locator(".search-result")).toHaveCount(8);
  await box.fill("broad");
  await expect(page.locator(".empty-search")).toContainText("по-точни");
  await box.fill("arm");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.locator(".search-result").click();
  await expect(page).toHaveURL("/bg/pieces/arm");
  await expect(page.locator("h1")).toHaveText("Arm");
  expect(await page.locator(".gallery-open img").getAttribute("src")).toContain(
    "/detail",
  );
  expect(
    await page.locator(".gallery-thumbnails img").first().getAttribute("src"),
  ).toContain("/thumbnail");
  await page.getByRole("button", { name: "Виж по-голямо изображение" }).click();
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
  const response = await page.goto("/bg/pieces/missing");
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
    .locator(".primary-nav")
    .getByRole("link", { name: "The workshop" })
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
    for (const path of ["/en/collection", "/bg/pieces/arm", "/bg/about"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Page must fit the viewport",
      ).toBe(true);
    }
  }
});

test("Bulgarian defaults, supported language switching, and removed locale links retain the page", async ({
  page,
  context,
  request,
}) => {
  const entry = await request.get("/", { maxRedirects: 0 });
  expect(entry.status()).toBe(307);
  expect(entry.headers().location).toMatch(/\/bg$/);
  await page.goto("/bg/collection?category=chairs");
  await expect(page.locator("html")).toHaveAttribute("lang", "bg");
  await expect(page.locator("h1")).toHaveText("Столове.");
  const trigger = page.locator("header").getByRole("combobox");
  await trigger.click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option", { name: "Български" })).toBeVisible();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page).toHaveURL(/\/en\/collection\?category=chairs/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === "METAL_CRAFT_LOCALE",
    )?.value,
  ).toBe("en");
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
  await page.goto("/fr/collection?category=chairs");
  await expect(page).toHaveURL(/\/en\/collection\?category=chairs/);
  await page.locator("header").getByRole("combobox").click();
  await page.getByRole("option", { name: "Български" }).click();
  await expect(page).toHaveURL(/\/bg\/collection\?category=chairs/);
  await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute(
    "href",
    /\/bg\/collections\/chairs$/,
  );
  await expect(
    page.locator('link[hreflang="fr"], link[hreflang="de"]'),
  ).toHaveCount(0);
  await page.goto("/de/pieces/arm");
  await expect(page).toHaveURL(/\/bg\/pieces\/arm$/);
  const shareLink = await request.get("/bg/products/arm", { maxRedirects: 0 });
  expect(shareLink.headers().location).toMatch(/\/bg\/pieces\/arm$/);
});

test("product image frame stays square on phones, tablets and desktop with gallery controls intact", async ({
  page,
}) => {
  for (const width of [320, 390, 768, 901, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/bg/pieces/arm");
    await expect(page.locator("html")).toHaveAttribute(
      "data-moris-hydrated",
      "true",
    );
    await page.evaluate(() => document.fonts.ready);
    const stage = await page.locator(".gallery-stage").boundingBox();
    expect(stage).not.toBeNull();
    expect(
      Math.abs(stage!.width - stage!.height),
      `${width}px square frame`,
    ).toBeLessThan(1);
    const photo = await page.locator(".gallery-open img").boundingBox();
    expect(Math.abs(photo!.width - (stage!.width - 6))).toBeLessThan(1);
    expect(Math.abs(photo!.height - (stage!.height - 6))).toBeLessThan(1);
    expect(
      await page
        .locator(".gallery-open img")
        .evaluate((img) => getComputedStyle(img).objectFit),
    ).toBe("contain");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Page must fit the viewport",
    ).toBe(true);
  }
  await page
    .getByRole("button", { name: "Следващо изображение", exact: true })
    .click();
  await expect(page.locator(".gallery-controls")).toContainText("02");
  await page.getByRole("button", { name: "Виж по-голямо изображение" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".gallery-controls").last()).toContainText("01");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("Bulgarian and English home pages fit narrow phones and wide screens", async ({
  page,
}) => {
  for (const locale of ["bg", "en"]) {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${locale}`);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${locale} at ${width}px`,
      ).toBe(true);
    }
  }
});

test("categories lead to clean collection URLs and stable product breadcrumbs", async ({
  page,
  request,
}) => {
  await request.get(`${control}?catalog=metal`);
  const legacy = await request.get("/en/collection?category=Architecture");
  expect(await legacy.text()).toContain(
    'rel="canonical" href="/en/collections/architecture"',
  );
  await page.goto("/en/collection");
  await expect(page.locator("html")).toHaveAttribute(
    "data-moris-hydrated",
    "true",
  );
  await expect(page.locator(".category-group")).toHaveCount(2);
  await page
    .locator(".category-group h3")
    .getByRole("link", { name: "Wall Art" })
    .click();
  await expect(page).toHaveURL("/en/categories/wall-art");
  await expect(page.locator("h1")).toHaveText("Wall Art");
  await expect(page.locator(".collection-preview")).toHaveCount(1);
  await page.locator(".collection-preview").click();
  await expect(page).toHaveURL("/en/collections/architecture");
  await expect(page.locator(".piece-card")).toHaveCount(1);
  await expect(page.locator(".breadcrumb")).toContainText("Wall Art");
  await page.locator(".piece-card").click();
  await expect(page).toHaveURL("/en/pieces/sydney-opera-house");
  await expect(page.locator(".breadcrumb")).toContainText(
    "Home/Shop/Wall Art/Architecture/Sydney Opera House",
  );
  await page
    .locator(".breadcrumb")
    .getByRole("link", { name: "Architecture", exact: true })
    .click();
  await expect(page).toHaveURL("/en/collections/architecture");
  const calls = (await (await request.get(control)).json()).requests;
  expect(
    calls
      .filter((c: { path: string }) => c.path.endsWith("/products"))
      .every(
        (c: { query: { collection?: string } }) =>
          !c.query.collection || c.query.collection === "Architecture",
      ),
  ).toBe(true);
  for (const path of [
    "/en/categories/missing",
    "/en/categories/more-collections",
    "/en/collections/missing",
  ]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test("Collectibles contains Ninja Blades; collection pagination, filters, locale and refresh retain scope", async ({
  page,
  request,
}) => {
  await request.get(`${control}?catalog=metal`);
  await page.goto("/en/categories/collectibles");
  await page.locator(".collection-preview").click();
  await expect(page).toHaveURL("/en/collections/ninja-blades");
  await expect(page.locator(".piece-card")).toHaveCount(24);
  await expect(page.locator(".breadcrumb")).toContainText("Collectibles");
  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/\/en\/collections\/ninja-blades\?cursor=/);
  await expect(page.locator(".piece-card")).toHaveCount(2);
  await page.getByRole("link", { name: "First page" }).click();
  await expect(page).toHaveURL("/en/collections/ninja-blades");
  await page.getByRole("button", { name: "Refine" }).click();
  await page.getByRole("button", { name: "Glass", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".piece-card")).toHaveCount(0);
  await expect(page.locator(".collection-empty")).toContainText(
    "No pieces here yet",
  );
  await page.goto("/en/collections/ninja-blades?cursor=invalid");
  await expect(page).toHaveURL("/en/collections/ninja-blades");
  await expect(page.locator(".piece-card")).toHaveCount(24);
  await page.locator("header").getByRole("combobox").click();
  await page.getByRole("option", { name: "Български" }).click();
  await expect(page).toHaveURL("/bg/collections/ninja-blades");
  await expect(page.locator("h1")).toHaveText("Нинджа остриета.");
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await request.get(`${control}?fail=1`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".piece-card")).toHaveCount(0);
  await request.get(`${control}?fail=0`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".piece-card")).toHaveCount(24);
  await page.goto("/en/collections/ninja-blades?q=" + "x".repeat(201));
  await expect(page.locator(".collection-empty")).toContainText(
    "fewer than 200",
  );
});

test("category and collection discovery fit phones and desktop in both languages", async ({
  page,
  request,
}) => {
  await request.get(`${control}?catalog=metal`);
  for (const locale of ["bg", "en"]) {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of [
        "",
        "/collection",
        "/categories/collectibles",
        "/collections/architecture",
        "/collections/ninja-blades",
      ]) {
        const response = await page.goto(`/${locale}${path}`);
        expect(response?.status()).toBe(200);
        await expect(page.locator("h1")).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${locale}${path} at ${width}px`,
        ).toBe(true);
      }
    }
  }
});
