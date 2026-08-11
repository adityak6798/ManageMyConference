// @acceptance ACC-INTEGRATION
import { expect, test } from "@playwright/test";

test("organizer inspects every delivery state and finds explicit recovery", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Greenroom Demo Summit" })).toBeVisible();
  await page.getByRole("button", { name: "Inspect delivery history" }).click();
  for (const state of ["queued", "retrying", "succeeded", "terminal"])
    await expect(page.getByText(state, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry session:terminal" })).toBeVisible();
});
