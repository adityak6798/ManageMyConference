// @acceptance ACC-CRM
import { expect, test } from "@playwright/test";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const CRM = `/speakers?event=${EVENT_ID}`;

test("organizer works the pipeline, adds a prospect, and converts it", async ({ page }) => {
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000);
  const futureLocal = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.goto(CRM);
  await expect(page.getByRole("heading", { name: "Speaker CRM", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prospect pipeline" })).toBeVisible();

  // Stage counts are readable before a stage is chosen.
  const pipeline = page.getByRole("table");
  await expect(pipeline.getByRole("button", { name: "Dr. Ada Rivera" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Overdue/ })).toBeVisible();

  await page.getByRole("tab", { name: /^Overdue/ }).click();
  await expect(page.getByText("Follow up on keynote topic")).toBeVisible();
  await page.getByRole("tab", { name: /^All/ }).click();

  const name = `Browser Prospect ${Date.now()}`;
  await page.getByRole("button", { name: "New prospect" }).click();
  await page.getByLabel("Prospect name").fill(name);
  await page
    .getByLabel("Contact email", { exact: true })
    .fill(`browser-${Date.now()}@example.test`);
  // The owner control is a select over known identities: free text used to 500.
  await expect(page.getByLabel("Owner", { exact: true })).toHaveRole("combobox");
  await page.getByLabel("First action due").fill("2026-08-01T12:00");
  await page.getByRole("button", { name: "Add prospect" }).click();
  await expect(page.getByText(`${name} added to the pipeline`)).toBeVisible();

  await page.getByRole("tab", { name: /^Overdue/ }).click();
  await expect(pipeline.getByRole("button", { name })).toBeVisible();
  await page.getByRole("tab", { name: /^All/ }).click();

  // Open the detail panel and move the prospect along its pipeline.
  await pipeline.getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByLabel("Stage", { exact: true }).selectOption("engaged");
  await page.getByLabel("Next action", { exact: true }).fill("Confirm session outline");
  await page.getByLabel("Next action due").fill(futureLocal);
  await page.getByLabel("Private note").fill("Available after 2pm");
  await page.getByRole("button", { name: "Save prospect" }).click();
  await expect(page.getByText("Available after 2pm")).toBeVisible();

  await page.getByRole("tab", { name: /^Overdue/ }).click();
  await expect(pipeline.getByRole("button", { name })).toHaveCount(0);
  await page.getByRole("tab", { name: /^All/ }).click();

  await page.getByText("Add another contact").click();
  await page.getByLabel("Contact name").fill("Speaker assistant");
  await page.getByLabel("Additional contact email").fill("assistant@example.test");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByRole("link", { name: "assistant@example.test" })).toBeVisible();

  // Conversion is confirmed before it runs, then reported.
  await page.getByRole("button", { name: "Convert to speaker" }).click();
  await expect(page.getByText(`Convert ${name}?`)).toBeVisible();
  await page.getByRole("button", { name: `Yes, convert ${name}` }).click();
  await expect(page.getByText(`${name} is now a speaker`)).toBeVisible();
  await expect(page.getByText("Converted prospects are read-only")).toBeVisible();
});

test("the pipeline searches by contact and explains an empty stage", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.goto(CRM);

  await page.getByLabel("Search prospects").fill("morgan@example.test");
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dr. Ada Rivera" })).toHaveCount(0);

  await page.getByLabel("Search prospects").fill("nobody-matches-this");
  await expect(page.getByRole("heading", { name: "No prospects in this view" })).toBeVisible();
  await page.getByRole("button", { name: "Show every prospect" }).click();
  await expect(page.getByRole("button", { name: "Morgan Chen" })).toBeVisible();
});
