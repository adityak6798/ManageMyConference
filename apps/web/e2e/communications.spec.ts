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

import { resolveWorktreeEnvironment } from "../../../tools/worktree-env.mjs";
import { expect, type Locator, type Page, test } from "./fixtures";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
const COMMUNICATIONS = `/communications?event=${EVENT_ID}&tab=compose`;

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
  await expect(page.getByRole("heading", { name: "Messages", level: 1 })).toBeVisible();
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
    .poll(
      async () =>
        (await outbox(page)).find(({ delivery }) => delivery.recipientRef === recipient)?.delivery
          .state,
    )
    .toBe("queued");

  // Recovery does not rewrite history: the failed attempt is still there, and draining again
  // adds a second one rather than replacing the first.
  await drain(page);
  await page.reload();
  const recoveredRow = await findDeliveryRow(page, recipient);
  await recoveredRow.getByRole("button", { name: `Show attempt history for ${recipient}` }).click();
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

/** One recipient as the server resolves them, which is the only authority on who is reachable. */
interface Recipient {
  userId: string;
  name: string;
  address: string | null;
}

/** What a delivery kept, read back from history rather than from the panel that sent it. */
interface StoredDelivery {
  idempotencyKey: string;
  recipientRef: string;
  state: string;
  renderedSubject: string | null;
  renderedBody: string | null;
}

/**
 * Every delivery this event has filed under a key the caller recognises.
 *
 * The cursor is walked rather than reading one page: history is ordered oldest first and this
 * fixture accumulates across runs, so the page a send just landed on is the last one. `outbox`
 * above reads the first page on purpose — it is asserting about states, not about finding a
 * needle — and this journey is looking for one exact key.
 */
async function findDeliveries(page: Page, matches: (key: string) => boolean) {
  const found: StoredDelivery[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 20; index += 1) {
    const response = await page.request.get(
      `/api/communications/history?organizationId=${ORGANIZATION_ID}&eventId=${EVENT_ID}&limit=50${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(response.ok(), `reading the outbox failed: ${await response.text()}`).toBe(true);
    const body = (await response.json()) as {
      history: { delivery: StoredDelivery }[];
      nextCursor: string | null;
    };
    for (const { delivery } of body.history)
      if (matches(delivery.idempotencyKey)) found.push(delivery);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return found;
}

/*
 * The bulk personalized message (#189), from an empty composer to the delivery it stored.
 *
 * One property runs through all of it: a single text survives the whole path. The server renders
 * each recipient's own copy, the organizer approves that copy, and the delivery keeps it character
 * for character — which is why the assertions below compare the history against the strings read
 * off the screen rather than against the template they were rendered from. A preview computed in
 * the browser would satisfy every screenshot and still mail something else, and a preview nobody
 * compared to the stored message is a preview that is believed rather than checked.
 *
 * The template key is stamped per run for the reason `runKey` gives, and the send is narrowed to
 * one named speaker so this run's delivery is one row it can address by key.
 */
test("an organizer resolves each speaker's own message, and history keeps exactly what was approved", async ({
  page,
}) => {
  await openOutbox(page);
  const key = runKey();
  const compose = page.getByRole("region", { name: "Send to speakers" });

  /*
   * The merge vocabulary, read from the server that resolves it.
   *
   * Asserted as a whole set rather than as three tokens this journey happens to know: if a fourth
   * is ever documented, this fails and says the coverage below stopped being complete, instead of
   * passing while a token nothing drives quietly ships.
   */
  const documented = (
    (await (await page.request.get("/api/communications/merge-fields")).json()) as {
      fields: { token: string }[];
    }
  ).fields.map(({ token }) => token);
  expect([...documented].sort()).toEqual(["eventName", "speakerEmail", "speakerName"]);

  await compose.getByRole("button", { name: "New template" }).click();
  // The composer prints the same vocabulary, because an author who cannot see the list writes a
  // template that cannot be sent — the renderer refuses a placeholder with no value.
  for (const token of documented)
    await expect(compose.locator(".comms-merge-list")).toContainText(`{{${token}}}`);

  await compose.getByLabel("Template name").fill(key);
  await compose.getByLabel("Subject").fill(`${key} · {{eventName}} needs you, {{speakerName}}`);
  await compose
    .getByLabel("Message")
    .fill(
      `Hi {{speakerName}},\n\nThis copy of ${key} is going to {{speakerEmail}} about {{eventName}}.`,
    );
  await compose.getByRole("button", { name: "Save template version" }).click();
  // Version 1 of a key nobody has published before: the announcement names what was written, and
  // the panel selects it, so what follows is about this run's own template and no other.
  await expect(compose.getByRole("status")).toContainText(`Saved ${key} version 1`);
  await expect(page.locator("#template-select")).toHaveValue(key);

  // Who the server says this event can reach. The picker is asserted against this rather than
  // against a count typed here: the number an organizer approves has to be the server's own.
  const resolvedRecipients = (
    (await (
      await page.request.get(
        `/api/communications/recipients?organizationId=${ORGANIZATION_ID}&eventId=${EVENT_ID}`,
      )
    ).json()) as { recipients: Recipient[] }
  ).recipients;
  const reachable = resolvedRecipients.filter(({ address }) => address !== null);
  const unreachable = resolvedRecipients.filter(({ address }) => address === null);
  const audience = page.locator(".comms-audience");
  await expect(audience.locator(".comms-audience-row")).toHaveCount(reachable.length);
  for (const recipient of reachable) await expect(audience).toContainText(recipient.address ?? "");
  await expect(audience.locator(".comms-audience-count")).toContainText(
    `Sending to ${reachable.length} ${reachable.length === 1 ? "speaker" : "speakers"}`,
  );

  /*
   * A speaker with no address is named, not hidden. A send to "the speakers" that silently reaches
   * three of four is the failure this surface is designed against, and the count of unreachable
   * speakers is asserted first so this stays a real check rather than a loop over nothing if the
   * seed ever gives everybody an address.
   */
  expect(
    unreachable.length,
    "the seeded roster should still hold a speaker with no address on their identity",
  ).toBeGreaterThan(0);
  for (const recipient of unreachable)
    await expect(compose.locator(".comms-unreachable")).toContainText(recipient.name);

  const target = reachable.find(({ name }) => name === "Sam Speaker");
  expect(target, "the seeded reachable speaker should be on this event").toBeDefined();
  // Narrowed to one person, and the line that states the audience follows the selection rather
  // than the roster — the count on screen is the count that is about to be written to.
  await audience.getByRole("button", { name: "Clear selection" }).click();
  await expect(
    compose.getByRole("button", { name: "Select at least one speaker to send to" }),
  ).toBeVisible();
  await audience
    .locator("label.comms-audience-row")
    .filter({ hasText: target?.address ?? "" })
    .getByRole("checkbox")
    .check();
  await expect(audience.locator(".comms-audience-count")).toContainText("Sending to 1 speaker.");

  /*
   * Before the send control is pressed, what is on screen is the template — and it is labelled as
   * instructions, placeholders and all. Showing that text under the word "preview" invited an
   * organizer to approve a message nobody will ever receive.
   */
  await expect(compose.locator(".comms-preview.is-template")).toContainText("{{speakerName}}");
  await expect(compose.locator(".comms-previews")).toHaveCount(0);
  await expect(compose.getByRole("group", { name: "Confirm send" })).toHaveCount(0);

  await compose.getByRole("button", { name: /^Send to 1 speaker$/ }).click();
  const resolved = compose.locator(".comms-previews");
  await expect(resolved).toContainText("What each speaker receives (1)");
  await expect(resolved.locator(".comms-preview")).toHaveCount(1);
  const message = resolved.getByRole("article", { name: `Message for ${target?.name}` });
  const subject = (await message.locator(".comms-preview-subject").textContent()) ?? "";
  const body = (await message.locator(".comms-preview-body").textContent()) ?? "";
  // Substituted, per recipient, by the server: every placeholder is gone and each value is this
  // speaker's own rather than the template's.
  expect(body).not.toMatch(/\{\{/);
  expect(subject).not.toMatch(/\{\{/);
  expect(body).toContain(`Hi ${target?.name},`);
  expect(body).toContain(target?.address ?? "");
  expect(subject).toContain("Greenroom Demo Summit");
  expect(subject).toContain(target?.name ?? "");

  // Only now is there something to confirm, and it names the version as well as the count.
  const confirm = compose.getByRole("group", { name: "Confirm send" });
  await expect(confirm).toContainText(`${key}`);
  await expect(confirm).toContainText("version 1");
  await confirm.getByRole("button", { name: /^Yes, send to 1 speaker$/ }).click();
  await expect(compose.getByRole("status")).toContainText(`Queued 1 delivery for ${key} version 1`);
  // The speaker with no address is reported by the send itself, not only by the panel beforehand.
  await expect(compose.getByRole("status")).toContainText(
    `${unreachable.length} ${unreachable.length === 1 ? "speaker" : "speakers"} had no address`,
  );

  /*
   * The delivery, addressed by the key the broadcast derives, and compared against the exact
   * strings the organizer read. Equality rather than `toContain`: a renderer that dropped a line,
   * trimmed the greeting or re-rendered against a since-edited template would still satisfy a
   * substring check while sending something nobody approved.
   */
  const stored = await findDeliveries(
    page,
    (idempotencyKey) => idempotencyKey === `broadcast:${key}:v1:${EVENT_ID}:${target?.userId}`,
  );
  expect(stored, "the confirmed send should have stored one delivery").toHaveLength(1);
  expect(stored[0]?.renderedSubject).toBe(subject);
  expect(stored[0]?.renderedBody).toBe(body);
  expect(stored[0]?.recipientRef).toBe(target?.address);
  // Durable and not yet handed to a provider: what was approved is what the outbox will send.
  expect(stored[0]?.state).toBe("queued");
  // Nobody else was written to. The selection was one speaker, so the audience the organizer
  // approved is the audience that got a row.
  expect(await findDeliveries(page, (id) => id.startsWith(`broadcast:${key}:`))).toHaveLength(1);

  /*
   * A template the payload cannot fill, refused on the screen showing the message.
   *
   * `{{sessionTitle}}` is a placeholder a speaker broadcast has no value for — a message to "the
   * speakers" is not about one talk — so this is the honest shape of the mistake an author makes.
   * The refusal has to land here, naming the placeholder, rather than after the first delivery is
   * queued: half a sentence in somebody's inbox cannot be taken back.
   */
  const unfillable = `${key}-unfillable`;
  await compose.getByRole("button", { name: "New template" }).click();
  await compose.getByLabel("Template name").fill(unfillable);
  await compose.getByLabel("Subject").fill("About your session");
  await compose.getByLabel("Message").fill("Hi {{speakerName}}, your talk is {{sessionTitle}}.");
  await compose.getByRole("button", { name: "Save template version" }).click();
  await expect(compose.getByRole("status")).toContainText(`Saved ${unfillable} version 1`);
  await expect(page.locator("#template-select")).toHaveValue(unfillable);

  await compose.getByRole("button", { name: /^Send to 1 speaker$/ }).click();
  const refusal = compose.getByRole("alert");
  await expect(refusal).toContainText("{{sessionTitle}}");
  await expect(refusal).toContainText("has no value in the delivery payload");
  // Nothing was resolved, so there is nothing to confirm: the one control that opens the
  // confirmation is the one that failed, which is what keeps an unsendable template unsendable.
  await expect(compose.locator(".comms-previews")).toHaveCount(0);
  await expect(compose.getByRole("group", { name: "Confirm send" })).toHaveCount(0);
  expect(
    await findDeliveries(page, (id) => id.startsWith(`broadcast:${unfillable}:`)),
    "a refused preview must not have queued anything",
  ).toHaveLength(0);
});
