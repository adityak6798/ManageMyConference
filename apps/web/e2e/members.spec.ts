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

/**
 * Where an invitation link lands somebody who has never signed in.
 *
 * This is the half of the invitation journey the browser *can* own, and it had no coverage at
 * all: the accept surface lives inside the console, and a stranger following the link has no
 * console. Routing `/invitations/accept` straight there served an invitee a shell with no
 * session, no event and no way back to the link they were sent — which is the majority case,
 * because somebody being offered a reviewer or speaker role is by definition not a member yet.
 *
 * Two properties, and the second is the one that is easy to lose. The signed-out surface has to
 * name the invitation rather than read as a stray URL; and the token has to survive the sign-in
 * round trip, which cannot ride in the URL because every door out of that page is a full
 * navigation — the Google flow leaves for a consent screen and returns to a path the *server*
 * chooses. Landing back on `/invitations/accept` still carrying the token is that hand-off.
 */
test("a signed-out invitee follows an invitation link and is handed the token back", async ({
  page,
}) => {
  /*
   * A token no invitation matches. What is being proved is the *routing* of the link and the
   * hand-off across sign-in; the acceptance itself belongs to real D1, for the reason the file
   * header gives, and a demo persona is refused it by rule 1 of the authorization document.
   */
  const token = `invitation-e2e-${Date.now()}`;
  await page.goto(`/invitations/accept?token=${token}`);

  // Signed out, this is an invitation rather than the ordinary sign-in page, and it says why it
  // is asking for a sign-in before it can do anything.
  await expect(
    page.getByRole("heading", { level: 1, name: "Accept your invitation" }),
  ).toBeVisible();
  await expect(page.getByText(/Sign in first\. The link names the invitation/)).toBeVisible();
  // And the console's own accept form is not offered to somebody with nobody to accept as.
  await expect(page.getByLabel("Invitation token")).toHaveCount(0);

  await page.getByRole("button", { name: "Continue as organizer" }).click();

  // Through the door, and back on the invitation with its token — the hand-off, in the URL the
  // console is handed rather than in the one the visitor arrived on.
  await expect(page.getByRole("heading", { level: 1, name: "Accept an invitation" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("token")).toBe(token);

  /*
   * And the deployment says why this identity cannot finish, before the press rather than after.
   * The route refuses a demo persona outright, and the transport reports that with the standard
   * 401 sentence — "Sign in to continue." — which to somebody who has just signed in is untrue
   * and leads nowhere. The surface answers it instead, the way API clients answers the same rule.
   */
  const refusal = page.getByRole("status").filter({ hasText: "A demo identity cannot accept" });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText("it still carries the token");
});

/** A link with no token at all is a broken link, and says so rather than asking for a password. */
test("an invitation link with no token says the link is incomplete", async ({ page }) => {
  await page.goto("/invitations/accept");
  await expect(
    page.getByRole("heading", { level: 1, name: "Accept your invitation" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("carried no token");
});
