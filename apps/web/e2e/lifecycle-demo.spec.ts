// @acceptance ACC-DEMO-SMOKE
import { expect, test } from "@playwright/test";

/**
 * Every organizer destination, in sidebar order, with the page title it must reach.
 * Asserting the destination renders — rather than only that a link exists — is the
 * point: the previous shell shipped nav links that pointed at nothing.
 */
const organizerDestinations = [
  { link: /Overview/, heading: "Overview" },
  { link: /Abstracts/, heading: "Abstracts" },
  { link: /Sessions & speakers/, heading: "Sessions & speakers" },
  { link: /Agenda/, heading: "Agenda" },
  { link: /Call for proposals/, heading: "Call for proposals" },
  { link: /Speaker CRM/, heading: "Speaker CRM" },
  { link: /Communications/, heading: "Communications" },
  { link: /Event settings/, heading: "Event settings" },
];

test("makes the complete seeded lifecycle discoverable across every role", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();

  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  for (const destination of organizerDestinations) {
    await navigation.getByRole("link", { name: destination.link }).click();
    await expect(page.getByRole("heading", { level: 1, name: destination.heading })).toBeVisible();
    // The destination must be linkable, not just reachable by clicking.
    await expect(page).toHaveURL(/\?event=/);
  }

  // A reloaded deep link lands on the same surface rather than bouncing home.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Event settings" })).toBeVisible();

  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { level: 1, name: "Review assignments" })).toBeVisible();
  for (const forbidden of [/Speaker CRM/, /Communications/, /Event settings/])
    await expect(navigation.getByRole("link", { name: forbidden })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: /Abstracts/ })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("public");
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});

test("keeps the organizer console usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  for (const path of ["/", "/abstracts", "/agenda", "/sessions", "/communications"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
  }
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
