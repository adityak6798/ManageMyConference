// @acceptance ACC-SPEAKER
import { expect, test } from "@playwright/test";

test("organizer tracks accepted content and speaker completes portal work", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Sessions & speakers" })).toBeVisible();
  await expect(page.getByText("Designing the calm conference")).toBeVisible();
  await page.getByRole("button", { name: "Accept demo proposal" }).click();
  await expect(page.getByText("A newly accepted session")).toBeVisible();
  await page.getByRole("button", { name: "Request presentation asset" }).click();
  await expect(page.getByText(/open tasks/)).toBeVisible();
  await page.getByRole("button", { name: "Record communication" }).click();
  await expect(page.getByText("Speaker preparation reminder sent", { exact: false })).toBeVisible();

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("speaker");
  await expect(page.getByRole("heading", { name: /tasks to complete/ })).toBeVisible();
  await page.getByRole("button", { name: "Mark complete" }).first().click();
  await expect(page.getByRole("button", { name: "Completed" })).toBeVisible();
  await page.getByLabel("Bio").fill("Speaker-managed public biography.");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page
    .getByLabel("Speaker asset")
    .setInputFiles({ name: "headshot.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
  await page.getByRole("button", { name: "Upload asset" }).click();
  await expect(page.getByText("1 asset(s) securely stored.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download calendar (.ics)" }).click();
  expect((await download).suggestedFilename()).toBe("greenroom-sessions.ics");
});

test("reviewers cannot call the private content workspace", async ({ request }) => {
  const session = await request.post("/api/demo-session", { data: { persona: "reviewer" } });
  expect(session.ok()).toBeTruthy();
  const response = await request.get("/api/events/00000000-0000-4000-8000-000000000001/content");
  expect(response.status()).toBe(403);
});
