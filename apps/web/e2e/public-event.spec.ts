// @acceptance ACC-PUBLIC
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Asia/Tokyo" });

test("browses the same accessible published projection directly and embedded", async ({ page }) => {
  await page.goto("/events/greenroom-demo-summit");
  await expect(page.getByRole("heading", { name: "Greenroom Demo Summit" })).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Schedule", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Plan your time" })).toBeVisible();
  await expect(page.getByText("Sep 17, 2026, 10:00 AM America/Los_Angeles")).toBeVisible();
  await page.getByRole("link", { name: "Calm systems for busy event teams" }).click();
  await expect(
    page.getByRole("heading", { name: "Calm systems for busy event teams" }),
  ).toBeVisible();
  await page.goto("/embed/events/greenroom-demo-summit/schedule");
  await expect(page.getByRole("heading", { name: "Plan your time" })).toBeVisible();
  await expect(page.getByText("Calm systems for busy event teams")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  await expect(page.locator("main")).toHaveCount(1);
  expect(await page.locator("img:not([alt])").count()).toBe(0);
  expect(
    await page
      .locator("[id]")
      .evaluateAll((nodes) => new Set(nodes.map((node) => node.id)).size === nodes.length),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("shows a clear unpublished or unknown event state", async ({ page }) => {
  await page.goto("/events/not-published");
  await expect(page.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
});
