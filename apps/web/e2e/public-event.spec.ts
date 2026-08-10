// @acceptance ACC-PUBLIC
import { expect, test } from "@playwright/test";

test("browses the same accessible published projection directly and embedded", async ({ page }) => {
  await page.goto("/events/greenroom-demo-summit");
  await expect(page.getByRole("heading", { name: "Greenroom Demo Summit" })).toBeVisible();
  await page.getByRole("link", { name: "Schedule", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan your time" })).toBeVisible();
  await page.getByRole("link", { name: "Calm systems for busy event teams" }).click();
  await expect(
    page.getByRole("heading", { name: "Calm systems for busy event teams" }),
  ).toBeVisible();
  await page.goto("/embed/events/greenroom-demo-summit/schedule");
  await expect(page.getByRole("heading", { name: "Plan your time" })).toBeVisible();
  await expect(page.getByText("Calm systems for busy event teams")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
});

test("shows a clear unpublished or unknown event state", async ({ page }) => {
  await page.goto("/events/not-published");
  await expect(page.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
});
