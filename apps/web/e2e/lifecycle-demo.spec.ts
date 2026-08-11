// @acceptance ACC-LIFECYCLE
import { expect, test } from "@playwright/test";

test("makes the complete seeded lifecycle discoverable across every role", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();

  for (const heading of [
    "Build the proposal form",
    "Abstract triage",
    "Sessions & speakers",
    "Schedule sessions",
    "Prospect pipeline",
    "Communications history",
  ])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

  const organizerNavigation = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const destination of ["Agenda", "People", "Communications", "Publishing"])
    await expect(organizerNavigation.getByRole("link", { name: destination })).toBeVisible();

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prospect pipeline" })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("speaker");
  await expect(page.getByRole("heading", { name: "2 tasks to complete" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your sessions" })).toBeVisible();

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("public");
  await expect(page.getByRole("link", { name: "Published event" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
});

test("keeps the evaluator-facing public route accessible and within smoke budgets", async ({
  page,
}) => {
  await page.goto("/events/greenroom-demo-summit");
  await expect(page.getByRole("heading", { name: "Greenroom Demo Summit" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);

  const audit = await page.evaluate(() => {
    const headingLevels = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    const unlabeledControls = [...document.querySelectorAll("button, input, select, textarea, a")]
      .filter((element) => {
        const htmlElement = element as HTMLElement;
        const label =
          htmlElement.innerText.trim() ||
          htmlElement.getAttribute("aria-label") ||
          htmlElement.getAttribute("aria-labelledby") ||
          htmlElement.getAttribute("title") ||
          (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() : "");
        return !label;
      })
      .map((element) => element.outerHTML);
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return {
      headingLevels,
      unlabeledControls,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? Number.POSITIVE_INFINITY,
      resourceCount: performance.getEntriesByType("resource").length,
    };
  });

  expect(audit.unlabeledControls).toEqual([]);
  expect(audit.headingLevels[0]).toBe(1);
  expect(
    audit.headingLevels.every(
      (level, index, levels) => index === 0 || level <= (levels[index - 1] ?? 0) + 1,
    ),
  ).toBe(true);
  expect(audit.domContentLoadedMs).toBeLessThan(10_000);
  expect(audit.resourceCount).toBeLessThan(100);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
