// @acceptance ACC-INTEGRATION
import { expect, type Page, test } from "@playwright/test";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
const COMMUNICATIONS = `/communications?event=${EVENT_ID}`;

/**
 * The seeded outbox, by recipient. Every one of these is a real `communication_deliveries`
 * row the outbox renders; the state is asserted against the row that carries it rather
 * than against the page, because more than one row can hold the same state once this
 * journey has recovered a failed delivery.
 */
const QUEUED = "speaker:queued";
const RETRYING = "reviewer:retrying";
const SUCCEEDED = "session:success";
const FAILED = "session:terminal";

interface DeliveryRow {
  delivery: { id: string; recipientRef: string; state: string };
}

async function outbox(page: Page): Promise<DeliveryRow[]> {
  const response = await page.request.get(
    `/api/communications/history?organizationId=${ORGANIZATION_ID}&eventId=${EVENT_ID}`,
  );
  expect(response.ok(), `reading the outbox failed: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { history: DeliveryRow[] }).history;
}

async function openOutbox(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; navigating before its cookie lands loads the outbox
  // unauthenticated and the shell bounces to the sign-in surface.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(COMMUNICATIONS);
  await expect(page.getByRole("heading", { name: "Communications", level: 1 })).toBeVisible();
}

test("organizer sees every delivery state inline, per row", async ({ page }) => {
  await openOutbox(page);

  // The history loads with the page: no button stands between the operator and state.
  const rows = page.getByRole("table").locator("tbody tr");
  const row = (recipient: string) => rows.filter({ hasText: recipient });

  // Three of the four seeded deliveries are never mutated by any spec, so each one pins
  // its own badge. Asserting per row rather than per page is what makes this survive a
  // second run: recovery adds a second `queued` row and the page-wide locator then
  // matches two elements.
  await expect(row(QUEUED).locator(".delivery-state.state-queued")).toBeVisible();
  await expect(row(RETRYING).locator(".delivery-state.state-retrying")).toBeVisible();
  await expect(row(SUCCEEDED).locator(".delivery-state.state-succeeded")).toBeVisible();
  // The failed delivery keeps its provider error in line whatever its current state, so
  // the operator can still see why it failed after it has been put back in the outbox.
  await expect(row(FAILED)).toContainText("PROVIDER_REJECTED");

  // Each state is also a filter carrying its own count, and the counts describe the whole
  // outbox rather than the visible page.
  await page.getByRole("tab", { name: /^Succeeded/ }).click();
  await expect(row(SUCCEEDED)).toBeVisible();
  await expect(row(QUEUED)).toHaveCount(0);
  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(row(QUEUED)).toBeVisible();

  // Attempt history stays expandable rather than always-on.
  const attempts = page.getByRole("button", { name: `attempt history for ${RETRYING}` });
  await expect(page.getByText("Attempt 1: retryable_failure — PROVIDER_TIMEOUT")).toHaveCount(0);
  await attempts.click();
  await expect(page.getByText("Attempt 1: retryable_failure — PROVIDER_TIMEOUT")).toBeVisible();
  await expect(attempts).toHaveAttribute("aria-expanded", "true");
});

test("recovers a failed delivery and refuses to recover one that never failed", async ({
  page,
}) => {
  await openOutbox(page);
  const rows = page.getByRole("table").locator("tbody tr");
  const row = (recipient: string) => rows.filter({ hasText: recipient });

  // A queued delivery is not recoverable — the worker still owns it. The control is
  // absent, and the route refuses rather than silently re-queueing it.
  await expect(row(QUEUED).getByRole("button", { name: `Retry ${QUEUED}` })).toHaveCount(0);
  const queuedDelivery = (await outbox(page)).find(
    (entry) => entry.delivery.recipientRef === QUEUED,
  );
  expect(queuedDelivery, "the seed must carry a queued delivery").toBeDefined();
  const refused = await page.request.post(
    `/api/communications/deliveries/${queuedDelivery?.delivery.id}/retry?organizationId=${ORGANIZATION_ID}`,
  );
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("CONFLICT");

  /*
   * Recovery consumes its own precondition, and nothing in the product can put a delivery
   * back into a failed state: `POST /api/communications/deliveries` only ever enqueues,
   * and the only provider wired into the Worker is the deterministic *success* fake, so
   * draining the outbox can never produce a terminal attempt either (issues #52, #66).
   * The seeded outbox therefore offers a finite number of failed deliveries.
   *
   * Rather than depend on a reset, this asserts whichever half of the invariant is true
   * now. `npm run gate:browser` resets first, so the recovery half is what CI runs; a
   * repeat run against the same fixture asserts the complement — that the delivery this
   * journey already recovered is queued, offers no recovery, and is refused by the route.
   */
  const failed = (await outbox(page)).find(
    (entry) => entry.delivery.recipientRef === FAILED && entry.delivery.state === "terminal",
  );

  if (failed) {
    await page.getByRole("tab", { name: /^Terminal/ }).click();
    await expect(row(FAILED)).toBeVisible();
    await expect(page.getByText("PROVIDER_REJECTED")).toBeVisible();
    await page.getByRole("tab", { name: /^All/ }).click();

    // Recovery is offered where the failure is, and reports its result.
    await page.getByRole("button", { name: `Retry ${FAILED}` }).click();
    await expect(page.getByText(`Retry queued for ${FAILED}`)).toBeVisible();
    await expect(row(FAILED).locator(".delivery-state.state-queued")).toBeVisible();
    // The outbox agrees with the badge: the row really changed state, it was not re-rendered.
    expect(
      (await outbox(page)).find((entry) => entry.delivery.recipientRef === FAILED)?.delivery.state,
    ).toBe("queued");
  } else {
    // The complement: an earlier run of this journey already recovered it.
    await expect(row(FAILED).locator(".delivery-state.state-queued")).toBeVisible();
    await expect(row(FAILED).getByRole("button", { name: `Retry ${FAILED}` })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /Terminal\s*0/ })).toBeVisible();
  }
});
