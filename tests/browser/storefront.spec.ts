import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const locale of ["en", "fr", "de"]) {
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    test(
      locale + " stays within the viewport at " + width + "px",
      async ({ page }) => {
        await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
        await page.goto("/" + locale);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.locator("h1")).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page
          .locator(".hero img")
          .evaluate((image) => (image as HTMLImageElement).decode());
        expect(
          await page
            .locator(".hero img")
            .evaluate((image) => (image as HTMLImageElement).naturalWidth > 0),
        ).toBe(true);
      },
    );
  }
}

test("switching language keeps the page and filters, and remembers the choice", async ({
  page,
  context,
}) => {
  await page.goto("/en/collection?category=chairs");
  await page.locator("header").getByRole("combobox").click();
  await page.getByRole("option", { name: "Français" }).click();
  await expect(page).toHaveURL(/\/fr\/collection\?category=chairs/);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.locator("h1")).toHaveText("Chaises.");
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "MORIS_LOCALE" && cookie.value === "fr",
    ),
  ).toBe(true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/fr$/);
  await page.locator("header").getByRole("combobox").click();
  await page.getByRole("option", { name: "Deutsch" }).click();
  await expect(page).toHaveURL(/\/de$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("search finds a translated piece and opens its localized detail page", async ({
  page,
}) => {
  await page.goto("/fr");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await page.getByRole("textbox", { name: "Rechercher" }).fill("chêne");
  await expect(page.locator(".search-result")).toHaveCount(2);
  await page.locator(".search-result").filter({ hasText: "Arc" }).click();
  await expect(page).toHaveURL(/\/fr\/pieces\/arc-lounge-chair/);
  await expect(page.locator("h1")).toHaveText("Arc");
  await page.getByRole("button", { name: "Agrandir l’image" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Entretien et matières" }).click();
  await expect(page.locator(".product-accordion")).toContainText(
    "Dépoussiérez",
  );
});

test("category, material, sorting, and empty state work without commerce services", async ({
  page,
}) => {
  await page.goto("/en/collection?category=chairs");
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(3);
  await expect(
    page.locator('.collection-tabs [aria-current="page"]'),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Refine" }).click();
  await page.getByRole("button", { name: "Upholstery", exact: true }).click();
  await page.getByRole("button", { name: "1 piece", exact: true }).click();
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(1);
  await expect(page.locator(".piece-caption")).toHaveText("Soft");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .locator(".active-filters")
    .getByRole("button", { name: "Upholstery", exact: true })
    .click();
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(3);
  await page.getByRole("combobox", { name: "Sort by" }).click();
  await page.getByRole("option", { name: "Name, A–Z" }).click();
  await expect(page.locator(".piece-caption h3")).toHaveText([
    "Arc",
    "Forma",
    "Soft",
  ]);
  await page.goto("/en/collection?category=chairs&material=glass");
  await expect(
    page.getByRole("heading", { name: "A little more room to explore." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".collection-grid .piece-card")).toHaveCount(3);
});

test("mobile menu exposes all seven categories and restores focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/de");
  const trigger = page.getByRole("button", { name: "Menü öffnen" });
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".mobile-menu nav a")).toHaveCount(8);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Schreibtische", exact: true })
    .click();
  await expect(page).toHaveURL(/\/de\/collection\?category=desks/);
  await expect(page.locator("h1")).toHaveText("Schreibtische.");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("concurrent server rendering keeps languages isolated", async ({
  request,
}) => {
  const results = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const locale = ["en", "fr", "de"][index % 3];
      const response = await request.get("/" + locale + "/collection");
      const html = await response.text();
      expect(response.status()).toBe(200);
      expect(html).toContain('<html lang="' + locale + '">');
      expect(html).toContain('hrefLang="' + locale + '"');
    }),
  );
  expect(results.length).toBe(12);
});

test("unknown product and article URLs render a localized 404", async ({
  page,
}) => {
  for (const path of ["/fr/pieces/missing", "/de/journal/missing"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByRole("link").last()).toBeVisible();
  }
});

test("key pages have no WCAG A/AA violations", async ({ page }) => {
  for (const path of [
    "/en",
    "/fr/collection",
    "/de/pieces/arc-lounge-chair",
    "/en/about",
    "/fr/journal",
  ]) {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
});
