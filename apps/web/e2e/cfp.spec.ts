// @acceptance ACC-CFP
import { expect, test } from "@playwright/test";

test("organizer publishes a typed form and an applicant receives a durable confirmation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Build the proposal form" })).toBeVisible();

  await page.getByRole("button", { name: "Add field" }).click();
  const lastField = page
    .locator(".cfp-field")
    .filter({ has: page.getByLabel("Field type") })
    .last();
  await lastField.getByLabel("Field type").selectOption("select");
  await lastField.getByLabel("Question label").fill("Experience level");
  await lastField.getByLabel("Guidance").fill("Choose the closest match");
  await lastField.getByLabel("Options (comma separated)").fill("New, Experienced");
  await lastField.getByLabel("Required").check();
  await lastField.getByRole("button", { name: "Move up" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publish CFP" }).click();
  await expect(page.getByText("CFP is open.", { exact: true })).toBeVisible();
  await page.getByLabel("Description").fill("A replacement draft description");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Close live CFP" })).toBeVisible();
  await page.getByRole("button", { name: "Close live CFP" }).click();
  await expect(page.getByLabel("Description")).toHaveValue("A replacement draft description");
  await page.getByRole("button", { name: "Reopen live CFP" }).click();
  await page.getByRole("button", { name: "Publish CFP" }).click();

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("public");
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
  await page.getByLabel("Proposal title").fill("Idempotent conference workflows");
  await page.getByLabel("Abstract").fill("A practical session about reliable submissions.");
  await page.getByLabel("Contact email").fill("speaker@example.com");
  await page.getByLabel("Experience level").selectOption("Experienced");
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByRole("status")).toContainText(/Confirmation: [0-9a-f-]{36}/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
});
