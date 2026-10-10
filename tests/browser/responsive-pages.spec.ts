import { test, expect } from "@playwright/test";

for (const width of [320, 600, 768, 1024, 1440]) {
  test("all page layouts fit at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1024 ? 600 : 844 });
    for (const path of [
      "/de/collection",
      "/de/pieces/arc-lounge-chair",
      "/fr/about",
      "/de/journal",
      "/fr/journal/a-conversation-in-wood",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path,
      ).toBe(true);
    }
  });
}
