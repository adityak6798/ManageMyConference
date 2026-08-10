// @acceptance ACC-REVIEW
import { expect, test } from "@playwright/test";

test("organizer triages and reviewer completes an unbiased evaluation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Abstract triage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await page.getByLabel("Filter status").selectOption("submitted");
  await expect(page.getByText("Typed boundaries at scale", { exact: true })).toBeVisible();
  await expect(page.getByText("Designing for the hallway track", { exact: true })).toHaveCount(0);
  await page.getByLabel("Filter status").selectOption("");
  await page
    .getByLabel("Ordered status labels")
    .fill("Submitted, Under review, Reviewed, Withdrawn, Needs follow-up");
  await page.getByRole("button", { name: "Save statuses" }).click();
  await expect(
    page.getByLabel("Transition to").getByRole("option", { name: "Needs follow-up" }),
  ).toHaveCount(1);
  await page.getByLabel(/Typed boundaries at scale/).check();
  await page.getByRole("button", { name: /Move to Under review/i }).click();
  await expect(
    page.getByText(/Typed boundaries at scale: submitted → under_review by seed-organizer/),
  ).toBeVisible();
  await page.getByLabel("Reviewer").selectOption("seed-reviewer");
  await page.getByRole("button", { name: "Assign selected reviewer" }).click();
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expect(page.getByText("Average", { exact: false })).toHaveCount(0);
  const card = page.getByRole("article").filter({ hasText: "Typed boundaries at scale" });
  await card.getByLabel("Private notes").fill("Clear and relevant");
  await card.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(card.getByText("completed")).toBeVisible();
});
