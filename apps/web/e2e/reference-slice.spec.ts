// @acceptance ACC-HARNESS
import { expect, test } from "@playwright/test";

test("shows denial, signs in, creates, and reloads an event", async ({ page }) => {
  const eventName = `Greenroom Browser Summit ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Reference:");
  await page.getByRole("button", { name: "Continue as demo organizer" }).click();
  await page.getByLabel("Event name").fill(eventName);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByText(eventName)).toBeVisible();
  await page.reload();
  await expect(page.getByText(eventName)).toBeVisible();
});
