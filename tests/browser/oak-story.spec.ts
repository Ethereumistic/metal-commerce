import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const translations = {
  en: {
    grain: "The grain",
    patina: "The patina",
    life: "A second life",
    closer: "Look closer",
    age: "over 100 years old",
  },
  fr: {
    grain: "Le grain",
    patina: "La patine",
    life: "Une seconde vie",
    closer: "Voir de près",
    age: "plus de 100 ans",
  },
  de: {
    grain: "Die Maserung",
    patina: "Die Patina",
    life: "Ein zweites Leben",
    closer: "Genauer ansehen",
    age: "über 100 Jahre alter",
  },
};

for (const [locale, copy] of Object.entries(translations)) {
  test(
    "the oak story works by touch and keyboard in " + locale,
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/" + locale + "/about");
      const story = page.locator("#oak-story");
      const explorer = story.locator(".oak-story-explorer");
      await expect(story.locator("h1")).toBeVisible();
      await expect(story.locator(".oak-story-intro")).toContainText(copy.age);
      await expect(
        story.getByRole("tab", { name: copy.grain }),
      ).toHaveAttribute("aria-selected", "true");
      await story.getByRole("tab", { name: copy.patina }).click();
      await expect(explorer).toHaveAttribute("data-chapter", "patina");
      await expect(story.getByRole("tabpanel")).toHaveCount(1);
      await story.getByRole("tab", { name: copy.patina }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(story.getByRole("tab", { name: copy.life })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(explorer).toHaveAttribute("data-chapter", "life");
      await story
        .locator('.oak-story-image[data-active="true"]')
        .evaluate((image) => (image as HTMLImageElement).decode());
      const zoom = story.getByRole("button", {
        name: copy.closer,
        exact: true,
      });
      await zoom.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("img")).toHaveAttribute("src", /oak-chair/);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(zoom).toBeFocused();
      await story.getByRole("tab", { name: copy.grain }).click();
      await expect(explorer).toHaveAttribute("data-chapter", "grain");
    },
  );
}

test("every oak chapter fits small phones, tablets and wide screens", async ({
  page,
}) => {
  for (const width of [320, 600, 900, 1024, 1920]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/de/about");
    for (const label of Object.values(translations.de).slice(0, 3)) {
      await page
        .locator("#oak-story")
        .getByRole("tab", { name: label })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        width + "px: " + label,
      ).toBe(true);
      await page
        .locator('.oak-story-image[data-active="true"]')
        .evaluate((image) => (image as HTMLImageElement).decode());
    }
  }
});

test("oak chapters and image enlargement remain accessible with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en/about");
  const story = page.locator("#oak-story");
  for (const label of ["The grain", "The patina", "A second life"]) {
    await story.getByRole("tab", { name: label }).click();
    const results = await new AxeBuilder({ page })
      .include("#oak-story")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    expect(
      await story
        .locator('.oak-story-image[data-active="true"]')
        .evaluate((image) =>
          parseFloat(getComputedStyle(image).transitionDuration),
        ),
    ).toBeLessThan(0.02);
  }
  await story.getByRole("button", { name: "Look closer", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
