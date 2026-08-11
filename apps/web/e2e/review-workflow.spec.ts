// @acceptance ACC-REVIEW
import { expect, test } from "@playwright/test";

test("organizer triages and reviewer completes an unbiased evaluation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Abstract triage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await page.getByLabel("Filter status").selectOption("submitted");
  await expect(
    page.getByRole("region", { name: "Abstract triage" }).locator("strong", {
      hasText: "Typed boundaries at scale",
    }),
  ).toBeVisible();
  await expect(page.getByText("Designing for the hallway track", { exact: true })).toHaveCount(0);
  await page.getByLabel("Filter status").selectOption("");
  await expect(page.getByLabel("Criterion 1 name")).toHaveValue("Relevance");
  await expect(page.getByLabel("Criterion 2 name")).toHaveValue("Clarity");
  await page
    .getByRole("combobox", { name: "Event workspace" })
    .selectOption({ label: "Greenroom Workshop Day" });
  await expect(page.getByLabel("Criterion 1 name")).toHaveValue("Audience fit");
  await page.getByLabel("Criterion 1 name").fill("Program relevance");
  await page.getByLabel("Guidance for criterion 1").fill("Fit for this program");
  await page.getByRole("button", { name: "Add criterion" }).click();
  await page.getByLabel("Criterion 2 name").fill("Originality");
  await page.getByLabel("Guidance for criterion 2").fill("Novel contribution");
  await page
    .getByLabel("Criterion 2 name")
    .locator("../..")
    .getByRole("button", { name: "Move up" })
    .click();
  await page.getByRole("button", { name: "Add criterion" }).click();
  await page
    .getByLabel("Criterion 3 name")
    .locator("../..")
    .getByRole("button", { name: "Remove criterion" })
    .click();
  const rubricSaved = page.waitForResponse(
    (response) => response.url().endsWith("/review/plan") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save rubric" }).click();
  await expect((await rubricSaved).ok()).toBe(true);
  await expect(page.getByLabel("Criterion 1 name")).toHaveValue("Originality");
  await expect(page.getByLabel("Criterion 2 name")).toHaveValue("Program relevance");
  await page.reload();
  await page
    .getByRole("combobox", { name: "Event workspace" })
    .selectOption({ label: "Greenroom Workshop Day" });
  await expect(page.getByLabel("Criterion 1 name")).toHaveValue("Originality");
  await expect(page.getByLabel("Criterion 2 name")).toHaveValue("Program relevance");
  await page
    .getByRole("combobox", { name: "Event workspace" })
    .selectOption({ label: "Greenroom Demo Summit" });
  await page.getByLabel("Status 1 label").fill("New submissions");
  await page.getByRole("button", { name: "Add status" }).click();
  await page.getByLabel("Status 5 label").fill("Needs follow-up");
  await page.getByRole("button", { name: "Save statuses" }).click();
  await expect(
    page.getByLabel("Transition to").getByRole("option", { name: "Needs follow-up" }),
  ).toHaveCount(1);
  await page.getByLabel("Status 5 label").fill("Follow up required");
  await page.getByRole("button", { name: "Save statuses" }).click();
  await expect(
    page.getByLabel("Transition to").getByRole("option", { name: "Follow up required" }),
  ).toHaveAttribute("value", "needs_follow_up");
  await expect(
    page.getByLabel("Filter status").getByRole("option", { name: "New submissions" }),
  ).toHaveAttribute("value", "submitted");
  await page.getByLabel(/Typed boundaries at scale/).check();
  await page.getByRole("button", { name: /Move to Under review/i }).click();
  await expect(
    page.getByText(/Typed boundaries at scale: submitted → under_review by seed-organizer/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Assign selected reviewer" })).toBeDisabled();
  await page.getByLabel(/Typed boundaries at scale/).check();
  await page.getByLabel("Reviewer").selectOption("seed-reviewer");
  const assignmentSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/review/assignments") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Assign selected reviewer" }).click();
  await expect((await assignmentSaved).ok()).toBe(true);
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expect(page.getByText("Average", { exact: false })).toHaveCount(0);
  const card = page.getByRole("article").filter({ hasText: "Typed boundaries at scale" });
  await card.getByLabel("Private notes").fill("Clear and relevant");
  await card.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(card.getByText("completed")).toBeVisible();
});
