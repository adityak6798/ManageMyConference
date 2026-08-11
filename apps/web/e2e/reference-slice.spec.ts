// @acceptance ACC-IDENTITY-EVENTS
import { expect, test } from "@playwright/test";

test("signs in, switches events and roles, creates, and reloads an event", async ({ page }) => {
  const eventName = `Greenroom Browser Summit ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Reference:");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(
    "Greenroom Demo Summit",
  );
  await page
    .getByRole("combobox", { name: "Event workspace" })
    .selectOption({ label: "Greenroom Workshop Day" });
  await expect(page.getByRole("heading", { name: "Greenroom Workshop Day" })).toBeVisible();
  await page.getByLabel("Event name").fill(eventName);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { name: eventName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build the proposal form" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(eventName);
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
  await expect(page.getByRole("link", { name: "Review assignments" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
});
