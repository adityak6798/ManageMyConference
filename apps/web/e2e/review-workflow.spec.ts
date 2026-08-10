// @acceptance ACC-REVIEW
import { expect, test } from "@playwright/test";

test("organizer triages and reviewer completes an unbiased evaluation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Abstract triage" })).toBeVisible();
  await page.getByLabel(/Typed boundaries at scale/).check();
  await page.getByRole("button", { name: "Move to under review" }).click();
  await page.getByRole("button", { name: "Assign Ravi Reviewer" }).click();
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expect(page.getByText("Average", { exact: false })).toHaveCount(0);
  const card = page.getByRole("article").filter({ hasText: "Typed boundaries at scale" });
  await card.getByLabel("Private notes").fill("Clear and relevant");
  await card.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(card.getByText("completed")).toBeVisible();
});
