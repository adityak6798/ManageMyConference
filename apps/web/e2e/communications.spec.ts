// @acceptance ACC-INTEGRATION
import { expect, test } from "@playwright/test";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const COMMUNICATIONS = `/communications?event=${EVENT_ID}`;

test("organizer sees every delivery state inline and recovers a terminal delivery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.goto(COMMUNICATIONS);
  await expect(page.getByRole("heading", { name: "Communications", level: 1 })).toBeVisible();

  // The history loads with the page: no button stands between the operator and state.
  const rows = page.getByRole("table").locator("tbody tr");
  await expect(rows.filter({ hasText: "speaker:queued" })).toBeVisible();
  for (const state of ["queued", "retrying", "succeeded", "terminal"])
    await expect(page.locator(`.delivery-state.state-${state}`)).toBeVisible();

  // Each state is also a filter carrying its own count.
  await page.getByRole("tab", { name: /^Terminal/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("PROVIDER_REJECTED")).toBeVisible();
  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(rows.filter({ hasText: "speaker:queued" })).toBeVisible();

  // Attempt history stays expandable rather than always-on.
  const attempts = page.getByRole("button", { name: /attempt history for reviewer:retrying/ });
  await expect(page.getByText("Attempt 1: retryable_failure — PROVIDER_TIMEOUT")).toHaveCount(0);
  await attempts.click();
  await expect(page.getByText("Attempt 1: retryable_failure — PROVIDER_TIMEOUT")).toBeVisible();
  await expect(attempts).toHaveAttribute("aria-expanded", "true");

  // Recovery is offered where the failure is, and reports its result.
  await expect(page.getByRole("button", { name: "Retry speaker:queued" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry session:terminal" }).click();
  await expect(page.getByText("Retry queued for session:terminal")).toBeVisible();
  await expect(
    rows.filter({ hasText: "session:terminal" }).locator(".delivery-state.state-queued"),
  ).toBeVisible();
});
