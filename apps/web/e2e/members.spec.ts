// @acceptance ACC-IDENTITY-EVENTS
/**
 * The members workspace in the browser.
 *
 * What this spec can and cannot drive is worth stating, because the gap is a product decision
 * rather than a missing test. The browser suite runs against the demo deployment
 * (`DEMO_MODE=true`), whose only identities are the four seeded personas — and every membership
 * *write* refuses a persona, because anything it wrote would be real state handed to the next
 * visitor who presses **Continue as organizer** (`docs/architecture/authorization.md`, rules 2
 * and 3). So the invite → accept → staffed → removed journey cannot exist here at all; it is
 * proved end to end against real D1 in `apps/api/test/d1-identity-membership.integration.test.ts`
 * and at the transport in `membership-http.test.ts`.
 *
 * What the browser owns is the half those cannot reach: that the surface renders, that the
 * refusal is *visible and explained* rather than a silent no-op, and — through the sweep in
 * `lifecycle-demo.spec.ts`, which discovers destinations from the sidebar — that it passes the
 * accessibility audit.
 */
import { expect, test } from "./fixtures";

async function openMembers(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; navigating before its cookie lands loads Settings
  // unauthenticated and the shell bounces to the sign-in surface. The switcher is the shell.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto("/settings?tab=team");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
}

test("shows the organization's members, its invitations, and its identity activity", async ({
  page,
}) => {
  await openMembers(page);

  // The three reads this surface is made of. Each renders its own empty state rather than
  // nothing, which is what `PRD-IAM-002` requires of every console surface.
  await expect(page.getByRole("heading", { name: "Members" }).nth(1)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outstanding invitations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent identity activity" })).toBeVisible();

  // The seeded organizer is a member of the seeded organization, so the table is not empty and
  // the read genuinely reached D1. Exact, because the row's Actions cell is named after the same
  // person — "Grant a role to Olivia Organizer" — and a substring match resolves to both.
  await expect(page.getByRole("cell", { name: "Olivia Organizer", exact: true })).toBeVisible();
});

/**
 * The demo-safety rule, asserted where a person would meet it.
 *
 * A persona holds `identity:manage` and belongs to the organization, so nothing about the
 * *authorization* refuses this — it is refused for being a persona. The point of the assertion is
 * that the console says so: a refusal that rendered as a silent no-op would leave an evaluator
 * believing they had invited somebody.
 */
test("refuses a demo persona's membership write, and says so on the screen", async ({ page }) => {
  await openMembers(page);

  await page.getByLabel("Email address").fill("someone@example.test");
  await page.getByRole("button", { name: "Send invitation" }).click();

  const refusal = page.getByRole("alert");
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("not allowed on this deployment");
  // And the refusal carries the correlation reference every console failure carries, so a report
  // of it can be turned back into the log line. It sits beside the sentence rather than inside it:
  // an identifier read character by character is a value to quote, not news to announce, so it is
  // asserted through the control that puts it on the clipboard.
  await expect(page.getByRole("button", { name: "Copy the reference" })).toBeVisible();

  // Nothing was created: the outstanding-invitations section still shows its empty state.
  await expect(page.getByText("No invitations are outstanding")).toBeVisible();
});
