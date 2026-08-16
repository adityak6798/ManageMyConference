// @acceptance ACC-CFP
/*
 * The applicant journey issue #190 exists for, end to end in a real browser: arrive at a public
 * call, sign in, save a title-only draft, leave, come back, finish it, submit it, and read the
 * organizer's decision on the same page — with a second submitter proving that none of it is
 * visible to anybody else.
 *
 * Why this is a browser test and not a service one. Every rule it depends on is already pinned by
 * `cfp-submitter.test.ts` and `d1-cfp-account-binding.integration.test.ts`; what only a browser can
 * show is that the *route through the product* exists — that a person who has never seen the
 * console can reach the form, find the door, and return to a draft after their session ends. The
 * evaluator baseline scored this at 52.9% precisely because each of those steps existed nowhere.
 *
 * Re-runnable, and it has to be: the seeded fixture is shared and this file mutates the live call.
 * The deadline test restores the window in a `finally`, so a failed assertion cannot leave
 * `lifecycle.spec.ts` and `public-event.spec.ts` — both of which submit through the open form —
 * facing a closed one.
 *
 * Re-runnability needs one more thing here than a `finally`, because proposals **accumulate**:
 * they belong to an account and no product affordance deletes one, so a second run against the
 * same server meets the first run's rows. Every title this file writes therefore carries `RUN`, a
 * per-run marker, and every locator and count is scoped by it. Without that the spec passed
 * exactly once per reset — and its "still one proposal" assertion, which is the point of the
 * step it guards, was the first thing to break. For the same reason the decision recorded below is a *decline*: accepting
 * would add a content session to the demo event and break `lifecycle-demo.spec.ts`'s count of it.
 * See the note at that call.
 */
import { expect, test } from "./fixtures";

/**
 * Distinguishes this run's proposals from an earlier run's against the same server.
 *
 * A proposal cannot be deleted, so rows accumulate. Titles are the only thing the dashboard
 * offers to tell them apart by, and `toHaveCount(1)` is meaningless without it.
 */
const RUN = `r${Date.now().toString(36)}`;

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SLUG = "greenroom-demo-summit";
const CFP = `/events/${SLUG}/cfp`;

// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({ extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.7" } });

/** The seeded form, restated so the journey starts from one exact state on every run. */
const SEEDED_FORM = {
  title: "Share your conference story",
  description: "Submit a practical session for Greenroom Demo Summit.",
  fields: [
    {
      id: "title",
      type: "short_text",
      label: "Proposal title",
      guidance: "Keep it specific",
      required: true,
      options: [],
    },
    {
      id: "abstract",
      type: "long_text",
      label: "Abstract",
      guidance: "What will attendees learn?",
      required: true,
      options: [],
    },
    {
      id: "name",
      type: "short_text",
      label: "Your name",
      guidance: "How organizers should address you",
      required: false,
      options: [],
    },
    {
      id: "email",
      type: "email",
      label: "Contact email",
      guidance: "We will send your confirmation here",
      required: true,
      options: [],
    },
  ],
};

/**
 * Put the live call back to "published, open, unbounded" as this event's organizer, then leave.
 *
 * Uses the API rather than the composer because it is setup, not the thing under test — and it is
 * idempotent, so a re-run against a fixture an earlier run edited starts from the same place. It
 * ends **signed out**, because every test in this file begins from a visitor who holds no session.
 */
async function normalizeCall(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  const current = await page.request.get(`/api/events/${EVENT_ID}/cfp`);
  expect(current.ok(), `loading the CFP failed: ${await current.text()}`).toBe(true);
  const version = (await current.json()).cfp.version as number;
  const saved = await page.request.put(`/api/events/${EVENT_ID}/cfp`, {
    data: { ...SEEDED_FORM, expectedVersion: version },
  });
  expect(saved.ok(), `seeding the CFP failed: ${await saved.text()}`).toBe(true);
  expect(
    (
      await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "publish" } })
    ).ok(),
  ).toBe(true);
  await clearWindow(page);
  const live = await page.request.get(`/api/events/${EVENT_ID}/cfp`);
  if ((await live.json()).cfp.publishedStatus === "closed")
    expect(
      (
        await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "reopen" } })
      ).ok(),
    ).toBe(true);
  await page.goto(CFP);
  await signOut(page);
}

/**
 * Take the organizer's session through the API rather than the landing page.
 *
 * Setup and teardown only. The window is an organizer-only control, so restoring it needs an
 * organizer's cookie — and the teardown below runs while an *applicant* is signed in.
 */
const asPersona = async (
  page: import("@playwright/test").Page,
  persona: "organizer" | "speaker" | "public",
) => {
  const started = await page.request.post("/api/demo-session", { data: { persona } });
  expect(started.ok(), `starting the ${persona} session failed: ${await started.text()}`).toBe(
    true,
  );
};

const clearWindow = async (page: import("@playwright/test").Page) => {
  await asPersona(page, "organizer");
  const cleared = await page.request.put(`/api/events/${EVENT_ID}/cfp/window`, {
    data: { opensAt: null, closesAt: null },
  });
  expect(cleared.ok(), `clearing the window failed: ${await cleared.text()}`).toBe(true);
};

/** Sign in through the door the public call itself offers, as the demo submitter named. */
async function signInAs(page: import("@playwright/test").Page, name: string) {
  await page.goto(CFP);
  await page.getByRole("button", { name: `Continue as ${name}` }).click();
  await expect(page.getByText(`Signed in as ${name}.`)).toBeVisible();
}

const signOut = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Keep track of your proposal" })).toBeVisible();
};

test("an applicant signs in from the public call, drafts, resumes, submits, and reads the decision", async ({
  page,
}) => {
  await normalizeCall(page);

  // ---- the anonymous arrival ---------------------------------------------------
  await page.goto(CFP);
  await expect(page.getByRole("heading", { name: "Share your conference story" })).toBeVisible();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  // This is a desktop application form, not a phone-width card floating in an empty canvas.
  // Keep the applicant workspace broad enough to scan while guarding against horizontal escape.
  const formBox = await page.locator(".pub-form").boundingBox();
  expect(formBox?.width).toBeGreaterThan(600);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 1280,
  );
  // Both doors are offered, and only one of them can keep anything: an anonymous proposal is
  // submittable and afterwards unreachable, which is what the invitation says.
  await expect(page.getByRole("button", { name: "Submit proposal" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep track of your proposal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);

  // ---- signing in from the call itself -----------------------------------------
  await page.getByRole("button", { name: "Continue as Sam Speaker" }).click();
  await expect(page.getByRole("heading", { name: "Your proposals" })).toBeVisible();
  await expect(page.getByText("Signed in as Sam Speaker.")).toBeVisible();
  /*
   * The seeded fixture holds an accepted proposal whose *answers* name Sam Speaker. It arrived
   * through the anonymous door, so it belongs to no account and must not appear here — which is
   * `#132`'s premise made visible: an address on a form buys ownership of nothing.
   */
  await expect(page.getByText("Designing the calm conference")).toHaveCount(0);

  // ---- a title-only draft -------------------------------------------------------
  await page.getByLabel("Proposal title").fill(`Draft that survives a sign-out ${RUN}`);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("You can come back to this proposal");
  const listed = page.locator(".pub-proposal", {
    hasText: `Draft that survives a sign-out ${RUN}`,
  });
  await expect(listed).toBeVisible();
  await expect(listed.getByText("Draft", { exact: true })).toBeVisible();

  // ---- out, and back in ---------------------------------------------------------
  await signOut(page);
  // Signed out, the dashboard is gone entirely rather than showing an empty one.
  await expect(page.getByRole("heading", { name: "Your proposals" })).toHaveCount(0);
  await signInAs(page, "Sam Speaker");
  const resumed = page.locator(".pub-proposal", {
    hasText: `Draft that survives a sign-out ${RUN}`,
  });
  await expect(resumed).toBeVisible();

  // ---- finishing and submitting it ----------------------------------------------
  await resumed.getByRole("button", { name: /^Continue / }).click();
  await expect(page.getByLabel("Proposal title")).toHaveValue(
    `Draft that survives a sign-out ${RUN}`,
  );
  await page.getByLabel("Proposal title").fill(`Idempotent conference workflows ${RUN}`);
  await page
    .getByLabel("Abstract")
    .fill(`A practical session about retries that converge on one proposal. ${RUN}`);
  await page.getByLabel("Your name").fill("Sam Speaker");
  await page.getByLabel("Contact email").fill("sam@example.test");
  await page.getByRole("button", { name: "Submit proposal" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal submitted");
  const submitted = page.locator(".pub-proposal", {
    hasText: `Idempotent conference workflows ${RUN}`,
  });
  await expect(submitted.getByText("Under consideration")).toBeVisible();
  // Still one proposal *of this run's*: submitting the draft moved it rather than adding a second
  // row. Scoped by `RUN` because an earlier run's rows are still on this dashboard — an absolute
  // count here is the assertion that made this spec pass exactly once per reset.
  await expect(page.locator(".pub-proposal", { hasText: RUN })).toHaveCount(1);

  // ---- a second submitter sees none of it ---------------------------------------
  const mine = await page.request.get(`/api/events/${EVENT_ID}/cfp/proposals`);
  // Named rather than indexed, for the same reason as the deadline test below: the listing is
  // oldest-first, so `[0]` is an *earlier run's* proposal on any server that has not been reset.
  const proposalId = ((await mine.json()).proposals as { id: string; title: string }[]).find(
    ({ title }) => title === `Idempotent conference workflows ${RUN}`,
  )?.id as string;
  expect(proposalId, "this run's submitted proposal was not in the listing").toBeTruthy();
  await signOut(page);
  await signInAs(page, "Pat Attendee");
  await expect(page.getByText(/Nothing yet/)).toBeVisible();
  await expect(page.getByText(`Idempotent conference workflows ${RUN}`)).toHaveCount(0);
  // 404 rather than 403: the two answers must be indistinguishable, or proposal ids are
  // enumerable from any account.
  const foreign = await page.request.get(`/api/events/${EVENT_ID}/cfp/proposals/${proposalId}`);
  expect(foreign.status()).toBe(404);
  await signOut(page);

  // ---- the organizer's side: exact values, then a decision ----------------------
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  const triage = await page.request.get(`/api/events/${EVENT_ID}/review/organizer`);
  expect(triage.ok(), `loading triage failed: ${await triage.text()}`).toBe(true);
  const proposal = ((await triage.json()).proposals as { id: string }[]).find(
    (entry) => entry.id === proposalId,
  );
  // Every value the applicant typed reaches the organizer unchanged — the round trip issue #190
  // asks for, asserted on the projection the console renders rather than on the rendering.
  expect(proposal).toMatchObject({
    title: `Idempotent conference workflows ${RUN}`,
    abstract: `A practical session about retries that converge on one proposal. ${RUN}`,
    submitterName: "Sam Speaker",
    submitter: { email: "sam@example.test" },
  });

  /*
   * Declined rather than accepted, and the reason is the shared fixture rather than the feature.
   *
   * Accepting creates a content session on the demo event, and `lifecycle-demo.spec.ts` — which
   * runs after this file — asserts that event's exact session count ("1 of 2 scheduled"). Adding a
   * third session here would break an assertion in another domain's spec as a side effect of this
   * one, which is worse than choosing the outcome that leaves the fixture as it found it.
   *
   * The accepted half of the same rule is proven where it costs nothing:
   * `d1-cfp-account-binding.integration.test.ts` moves a real proposal to `accepted` through the
   * CFP interface review uses and reads the owner's dashboard projection back, and
   * `cfp-submitter-dashboard.test.tsx` renders the pill. `lifecycle.spec.ts` is the browser
   * journey that carries an *accepted* proposal all the way to a published session.
   */
  const decided = await page.request.post(`/api/events/${EVENT_ID}/review/decisions`, {
    data: { proposalIds: [proposalId], outcome: "declined", note: "" },
  });
  expect(decided.ok(), `deciding failed: ${await decided.text()}`).toBe(true);
  // The confirmation and the decision are both queued through communications and visible in its
  // history, which is where an operator inspects a deterministic send.
  const history = await page.request.get(
    `/api/communications/history?organizationId=00000000-0000-4000-8000-000000000010&eventId=${EVENT_ID}`,
  );
  expect(history.ok(), `loading delivery history failed: ${await history.text()}`).toBe(true);
  const entries = (await history.json()).history as {
    delivery: { triggerType: string; recipientRef: string; renderedBody: string | null };
  }[];
  const confirmation = entries.find(
    (entry) => entry.delivery.triggerType === "proposal.submitted",
  )?.delivery;
  expect(confirmation, "the submission confirmation must be queued").toBeDefined();
  expect(entries.map((entry) => entry.delivery.triggerType)).toContain("decision.recorded");
  /*
   * The recipient came from the *session*, not from the form.
   *
   * The applicant typed `sam@example.test` into the contact-email question; the account they signed
   * in as is linked to `speaker@greenroom.test` in `identity_emails`. The confirmation goes to the
   * second one, which is the whole of what makes this message safe under `#132` — nothing a request
   * carries can direct it.
   */
  expect(confirmation?.recipientRef).toBe("speaker@greenroom.test");
  expect(confirmation?.renderedBody).toContain(`Idempotent conference workflows ${RUN}`);

  // ---- and the submitter reads it on their own page -----------------------------
  // The organizer's own session has to end first: the sign-in doors are offered to a visitor who
  // holds none, which is the honest condition for showing them.
  await page.goto(CFP);
  await signOut(page);
  await signInAs(page, "Sam Speaker");
  // "Not accepted" rather than "Declined": the same fact, addressed to the person it is about. And
  // no triage vocabulary reaches this page — the event configures `under_review` and `reviewed`,
  // neither of which is anybody's business but the organizers'.
  await expect(
    page
      .locator(".pub-proposal", { hasText: `Idempotent conference workflows ${RUN}` })
      .getByText("Not accepted"),
  ).toBeVisible();
  await expect(page.getByText(/under_review|reviewed/)).toHaveCount(0);
  await signOut(page);
});

test("a configured deadline closes the public call and locks the proposals behind it", async ({
  page,
}) => {
  await normalizeCall(page);
  await signInAs(page, "Sam Speaker");
  await page.getByLabel("Proposal title").fill(`Written before the deadline ${RUN}`);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status")).toContainText("You can come back to this proposal");

  try {
    /*
     * A deadline already in the past, which is the only way to observe the closed state without
     * waiting for one. The window is live state, so this reaches applicants without a republish.
     *
     * Set through the API as the organizer, then straight back to the applicant: the personas are
     * one cookie, and which of them the *setup* uses is not what this test is about.
     */
    await asPersona(page, "organizer");
    const closed = await page.request.put(`/api/events/${EVENT_ID}/cfp/window`, {
      data: { opensAt: null, closesAt: "2026-01-31T23:59:00.000Z" },
    });
    expect(closed.ok(), `setting the deadline failed: ${await closed.text()}`).toBe(true);
    await asPersona(page, "speaker");

    await page.goto(CFP);
    await expect(page.getByText("Closed", { exact: true })).toBeVisible();
    // The date, not a bare refusal: "closed" with no date reads as a decision made this morning.
    await expect(page.locator(".pub-cfp-deadline")).toContainText(
      "Submissions closed Saturday, January 31, 2026",
    );
    await expect(page.getByRole("button", { name: "Submit proposal" })).toHaveCount(0);
    // The draft is still readable and no longer editable — and the page says which.
    const locked = page.locator(".pub-proposal", { hasText: `Written before the deadline ${RUN}` });
    await expect(locked).toBeVisible();
    await expect(locked.getByRole("button", { name: /^Continue / })).toHaveCount(0);
    await expect(page.getByText(/read but not changed/)).toBeVisible();

    // The lock is at the application boundary, not only in the UI.
    const listed = await page.request.get(`/api/events/${EVENT_ID}/cfp/proposals`);
    expect(listed.ok(), `listing proposals failed: ${await listed.text()}`).toBe(true);
    // Named rather than indexed: `listProposalsForOwner` is oldest-first, so `[0]` is this
    // account's *first* proposal — which after the test above is a submitted one, not the draft
    // this test just wrote.
    const draft = (
      (await listed.json()).proposals as { id: string; revision: number; title: string }[]
    ).find(({ title }) => title === `Written before the deadline ${RUN}`);
    expect(draft, "the draft this test wrote was not in the listing").toBeTruthy();
    const refused = await page.request.put(`/api/events/${EVENT_ID}/cfp/proposals/${draft?.id}`, {
      data: { answers: { title: "Late edit" }, expectedRevision: draft?.revision ?? 1 },
    });
    expect(refused.status()).toBe(409);
    // And so is the anonymous door, which the schedule shuts for everybody at once.
    const guest = await page.request.post(`/api/public/events/${EVENT_ID}/submissions`, {
      data: {
        idempotencyKey: crypto.randomUUID(),
        answers: { title: "Late guest", abstract: "x", email: "guest@example.test" },
      },
    });
    // 404 rather than the owned routes' 409: this endpoint answered `NOT_FOUND` before
    // the window existed, and changing a status code is breaking under `api-compatibility.md`.
    expect(guest.status()).toBe(404);

    // Reopening cannot undo a deadline: both gates have to permit, and the API says so rather
    // than answering 200 to a request that would change nothing anybody can see.
    await asPersona(page, "organizer");
    await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "close" } });
    const reopen = await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, {
      data: { state: "reopen" },
    });
    expect(reopen.status()).toBe(400);
    expect(await reopen.text()).toContain("deadline has passed");
  } finally {
    /*
     * The shared fixture goes back to an open, unbounded call whatever happened above.
     * `lifecycle.spec.ts` and `public-event.spec.ts` both submit through this form later in the
     * run, so a failed assertion here must not become three failures over there.
     */
    await clearWindow(page);
    const live = await page.request.get(`/api/events/${EVENT_ID}/cfp`);
    if ((await live.json()).cfp.publishedStatus === "closed")
      await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "reopen" } });
  }
});
