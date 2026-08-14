// @acceptance ACC-INTEGRATION
/**
 * `JNY-009` proved by deliveries the product produced, not by rows typed into the seed.
 *
 * What this replaces: the previous version of this file asserted that the four strings queued,
 * retrying, succeeded and terminal were visible, and that a Retry button existed. Those four
 * states were hand-written `INSERT`s, nothing in the product could produce one, and the button
 * was never clicked — so the "explicit recovery" in the test's own title was unproven and the
 * suite could not have detected that no lifecycle action enqueued anything (issue #82).
 *
 * Every delivery asserted below is created during the run: composed and sent from the console,
 * or refused by the fixture provider because its recipient is genuinely unaddressable. No
 * assertion here depends on a seeded delivery.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { resolveWorktreeEnvironment } from "../../../tools/worktree-env.mjs";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
const COMMUNICATIONS = `/communications?event=${EVENT_ID}`;

/**
 * The Worker's scheduled entrypoint, driven directly.
 *
 * The outbox drains from a one-minute cron in the deployment, which is not something a browser
 * test can wait for. `wrangler dev` exposes the same `scheduled()` export this way, so this
 * drives the real drain — the same `drainOutbox` the deployment runs, through the same handler —
 * rather than a test-only endpoint added to the product for the suite's convenience.
 *
 * It goes to the API's own origin because the web dev server proxies `/api` and nothing else.
 */
const API_ORIGIN = `http://127.0.0.1:${resolveWorktreeEnvironment().apiPort}`;

interface DeliveryRow {
  delivery: {
    id: string;
    recipientRef: string;
    state: string;
    renderedBody: string | null;
    templateId: string | null;
    triggerType: string;
  };
}

async function outbox(page: Page): Promise<DeliveryRow[]> {
  const response = await page.request.get(
    `/api/communications/history?organizationId=${ORGANIZATION_ID}&eventId=${EVENT_ID}&limit=50`,
  );
  expect(response.ok(), `reading the outbox failed: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { history: DeliveryRow[] }).history;
}

/** Run the outbox until it stops making progress, so an assertion never races the worker. */
async function drain(page: Page) {
  const response = await page.request.post(`${API_ORIGIN}/cdn-cgi/handler/scheduled`);
  expect(response.ok(), `draining the outbox failed: ${await response.text()}`).toBe(true);
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

/** Follow the real history pagination until the named delivery is on screen. */
async function findDeliveryRow(page: Page, recipient: string): Promise<Locator> {
  await expect(page.getByRole("region", { name: "Delivery history" })).toContainText(
    /\d+ deliver(?:y|ies) loaded/,
  );
  const rows = page.getByRole("table").locator("tbody tr");
  const row = rows.filter({ hasText: recipient });
  for (let pageNumber = 0; pageNumber < 10 && (await row.count()) === 0; pageNumber += 1) {
    const more = page.getByRole("button", { name: "Load more history" });
    expect(await more.count(), `${recipient} was not present in delivery history`).toBe(1);
    const before = await rows.count();
    const loaded = page.waitForResponse(
      (response) =>
        response.url().includes("/api/communications/history") &&
        response.request().method() === "GET",
    );
    await more.click();
    expect((await loaded).ok(), "loading more delivery history failed").toBe(true);
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
  return row;
}

/**
 * A template key unique to this run.
 *
 * Template versions are immutable and the suite shares one local fixture across runs, so a fixed
 * key would collide on the second run — and the idempotency key a send derives from
 * `{key}:v{version}` would make the second run's send a no-op that queues nothing. A fresh key
 * each run is what keeps this journey re-runnable without a reset (`DEBT-007`'s neighbourhood).
 */
const runKey = () => `e2e-send-${Date.now()}`;

test("an organizer composes a message, sends it to the speakers, and it is delivered", async ({
  page,
}) => {
  await openOutbox(page);
  const key = runKey();

  await page.getByRole("button", { name: "New template" }).click();
  await page.getByLabel("Template name").fill(key);
  await page.getByLabel("Subject").fill("Your session is confirmed");
  await page
    .getByLabel("Message")
    .fill("Hi {{speakerName}}, your session is confirmed. Bring water.");
  await page.getByRole("button", { name: "Save template version" }).click();

  // The panel says how many people the send will reach before it will send to anybody, and the
  // count is the server's own resolution of the event's speakers rather than a number typed here.
  const send = page.getByRole("button", { name: /^Send to \d+ speakers?$/ });
  await expect(send).toBeVisible();
  await send.click();
  await expect(page.getByRole("group", { name: "Confirm send" })).toContainText(key);
  await page.getByRole("button", { name: /^Yes, send to \d+ speakers?$/ }).click();

  await expect(page.getByText(/Queued \d+ deliveries?|Queued 1 delivery/)).toBeVisible();

  // The delivery exists and carries the message a human receives, with the placeholder filled
  // in. This is the assertion that fails if rendering ever stops interpolating.
  const queued = (await outbox(page)).filter(({ delivery }) =>
    delivery.renderedBody?.includes("Bring water."),
  );
  expect(queued.length, "the send should have queued at least one delivery").toBeGreaterThan(0);
  for (const { delivery } of queued) {
    expect(delivery.renderedBody).toContain("Hi Sam Speaker,");
    expect(delivery.renderedBody).not.toContain("{{speakerName}}");
  }

  // Nothing has been sent yet — the deliveries are durable, the provider has not been called.
  expect(queued.every(({ delivery }) => delivery.state === "queued")).toBe(true);

  await drain(page);
  await page.reload();

  // The outbox agrees with the page, so what follows is a state change and not a re-render.
  const after = (await outbox(page)).filter(({ delivery }) =>
    delivery.renderedBody?.includes("Bring water."),
  );
  expect(after.every(({ delivery }) => delivery.state === "succeeded")).toBe(true);

  /*
   * Located by this send's own template rather than by the recipient's address. The suite shares
   * one fixture and this event's speakers are also written to by seeded history and by the other
   * journeys here, so several rows legitimately carry the same address — and a locator that
   * matched any of them would be asserting about whichever delivery happened to sort first.
   * The template id is unique to the version this run published.
   */
  const templateId = after[0]?.delivery.templateId ?? "";
  expect(templateId, "the delivery should name the template it rendered from").not.toBe("");
  const sent = page.getByRole("table").locator("tbody tr").filter({ hasText: templateId });
  await expect(sent.locator(".delivery-state.state-succeeded")).toBeVisible();

  // The message is readable where the delivery is, not only in the database.
  await sent
    .getByRole("button", { name: `Show attempt history for ${after[0]?.delivery.recipientRef}` })
    .click();
  await expect(
    page.getByText("Hi Sam Speaker, your session is confirmed. Bring water."),
  ).toBeVisible();
});

test("an organizer recovers a delivery the provider refused, by clicking Retry", async ({
  page,
}) => {
  await openOutbox(page);

  /*
   * A genuinely undeliverable recipient, refused by the provider rather than declared failed.
   * The fixture provider reads the `+bounce` sub-address tag and terminally rejects it, the way
   * a real mail API rejects an address that does not exist — so this delivery fails for a
   * reason, and its attempt records the provider's normalized code.
   *
   * It is enqueued through the published trigger endpoint rather than the compose panel because
   * every speaker identity-access knows about for this event is reachable or has no address at
   * all; the product offers no way to send to an address an organizer types. That is a correct
   * restriction, and working around it in the seed would put the fabricated row this test exists
   * to remove back into the fixture.
   */
  const recipient = `bounced+bounce@example.test`;
  const enqueued = await page.request.post("/api/communications/deliveries", {
    data: {
      organizationId: ORGANIZATION_ID,
      eventId: EVENT_ID,
      idempotencyKey: `e2e-bounce:${Date.now()}`,
      triggerType: "speaker.invited",
      channel: "email",
      recipientRef: recipient,
      payload: { speakerName: "Bounced Speaker" },
      templateKey: "speaker-invite",
    },
  });
  expect(enqueued.status(), await enqueued.text()).toBe(202);

  await drain(page);
  await expect
    .poll(async () => {
      const delivery = (await outbox(page)).find(
        ({ delivery: candidate }) => candidate.recipientRef === recipient,
      )?.delivery;
      return delivery?.state;
    })
    .toBe("terminal");
  // Refresh through the organizer's control so the row is read after the scheduled handler's
  // transaction is visible, instead of racing a document reload against the outbox drain.
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/communications/history") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh outbox" }).click();
  expect((await refreshed).ok(), "refreshing the outbox failed").toBe(true);

  const row = await findDeliveryRow(page, recipient);
  await expect(row.locator(".delivery-state.state-terminal")).toBeVisible();
  await expect(row).toContainText("PROVIDER_REJECTED");

  // Clicked, not merely present. The previous version of this spec asserted the button existed
  // and called that "explicit recovery".
  await row.getByRole("button", { name: `Retry ${recipient}` }).click();
  await expect(page.getByText(`Retry queued for ${recipient}`)).toBeVisible();
  await expect
    .poll(async () =>
      (await outbox(page)).find(({ delivery }) => delivery.recipientRef === recipient)?.delivery
        .state,
    )
    .toBe("queued");

  // Recovery does not rewrite history: the failed attempt is still there, and draining again
  // adds a second one rather than replacing the first.
  await drain(page);
  await page.reload();
  const recoveredRow = await findDeliveryRow(page, recipient);
  await recoveredRow
    .getByRole("button", { name: `Show attempt history for ${recipient}` })
    .click();
  await expect(page.getByText("Attempt 1: terminal_failure — PROVIDER_REJECTED")).toBeVisible();
  await expect(page.getByText("Attempt 2: terminal_failure — PROVIDER_REJECTED")).toBeVisible();
});

test("a queued delivery is not recoverable, and the route says so", async ({ page }) => {
  await openOutbox(page);
  const key = runKey();

  await page.getByRole("button", { name: "New template" }).click();
  await page.getByLabel("Template name").fill(key);
  await page.getByLabel("Subject").fill("Not yet sent");
  await page.getByLabel("Message").fill("Hi {{speakerName}}, this one stays queued.");
  await page.getByRole("button", { name: "Save template version" }).click();
  await page.getByRole("button", { name: /^Send to \d+ speakers?$/ }).click();
  await page.getByRole("button", { name: /^Yes, send to \d+ speakers?$/ }).click();
  await expect(page.getByText(/Queued \d+ deliveries?|Queued 1 delivery/)).toBeVisible();

  const queued = (await outbox(page)).find(({ delivery }) =>
    delivery.renderedBody?.includes("this one stays queued."),
  );
  expect(queued, "the send should have queued a delivery").toBeDefined();

  await page.reload();
  const row = page
    .getByRole("table")
    .locator("tbody tr")
    .filter({ hasText: queued?.delivery.recipientRef ?? "" })
    .first();
  // The worker still owns it, so the control is absent rather than present and refused on click.
  await expect(
    row.getByRole("button", { name: `Retry ${queued?.delivery.recipientRef}` }),
  ).toHaveCount(0);

  const refused = await page.request.post(
    `/api/communications/deliveries/${queued?.delivery.id}/retry?organizationId=${ORGANIZATION_ID}`,
  );
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("CONFLICT");
});
