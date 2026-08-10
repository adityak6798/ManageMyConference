// @acceptance ACC-CRM
import { expect, test } from "@playwright/test";

test("organizer filters the pipeline, adds a prospect, and converts it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Prospect pipeline" })).toBeVisible();
  await expect(page.getByText("Dr. Ada Rivera")).toBeVisible();
  await page.getByLabel("Pipeline view").selectOption("overdue");
  await expect(page.getByText("Follow up on keynote topic")).toBeVisible();
  const name = `Browser Prospect ${Date.now()}`;
  await page.getByLabel("Prospect name").fill(name);
  await page.getByLabel("Contact email").fill(`browser-${Date.now()}@example.test`);
  await page.getByLabel("First action due").fill("2026-08-01T12:00");
  await page.getByRole("button", { name: "Add prospect" }).click();
  await page.getByLabel("Pipeline view").selectOption("overdue");
  await expect(page.getByText(name)).toBeVisible();
  await page.getByLabel("Pipeline view").selectOption("all");
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name: `${name} details` })).toBeVisible();
  await page.getByLabel("Stage").selectOption("engaged");
  await page.getByLabel("Next action", { exact: true }).fill("Confirm session outline");
  await page.getByLabel("Next action due").fill("2027-08-01T12:00");
  await page.getByLabel("Private note").fill("Available after 2pm");
  await page.getByRole("button", { name: "Save prospect" }).click();
  await expect(page.getByText("Available after 2pm")).toBeVisible();
  await page.getByLabel("Pipeline view").selectOption("overdue");
  await expect(page.getByText(name)).toHaveCount(0);
  await page.getByLabel("Pipeline view").selectOption("all");
  await page.getByLabel("Contact name").fill("Speaker assistant");
  await page.getByLabel("Additional contact email").fill("assistant@example.test");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByText("assistant@example.test", { exact: false })).toBeVisible();
  await row.getByRole("button", { name: "Convert to speaker" }).click();
  await expect(row.getByText("Speaker linked")).toBeVisible();
});
