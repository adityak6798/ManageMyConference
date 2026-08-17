// @acceptance ACC-CFP ACC-PUBLIC
/*
 * The submission window, in a browser, in both directions (issue #222).
 *
 * `cfp-window.test.tsx` covers the same two transitions against stubbed responses, and this file
 * is deliberately the other half of that: two real tabs, one running Worker, one D1 fixture, and
 * no reload between the organizer's save and the public page changing its mind. The defect the
 * evaluator recorded is not reachable from a component test — the enforcement was already correct
 * at the application boundary, and what was wrong was that a page which had read `effectiveStatus`
 * once kept the answer while an organizer moved the deadline in another tab.
 *
 * Both directions are here because a call that shuts and never reopens is half a feature, and
 * because the two paths differ in the browser: closing hides a form that is on screen, reopening
 * has to bring one back that is not.
 *
 * **This spec mutates the fixture and puts it back, twice over.** It runs before `cfp.spec.ts` in
 * path order (`-` sorts before `.`), which asserts `Published · open` from its first line, and
 * before nothing else that matters — but `00-seed-state.spec.ts` runs first on the *next* run and
 * submits through the public form expecting 201, so a past deadline left behind by a failure here
 * becomes a failing seed canary that reads like fixture corruption. So the window is cleared
 * through the control as the last assertion, *and* restored in a `finally` whatever happened. The
 * assertion is the point; the `finally` is the safety net.
 */
import { expect, type Page, test } from "./fixtures";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const COMPOSER = `/cfp?event=${EVENT_ID}`;
const PUBLIC_CFP = "/events/greenroom-demo-summit/cfp";

/** The seeded demo event's own timezone, which is the only one this surface ever states. */
const EVENT_ZONE = "America/Los_Angeles";

// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({ extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.8" } });

/**
 * The wall clock an instant reads as in the event's zone, in the format the input carries.
 *
 * A `datetime-local` value has no timezone in it, so a deadline typed here means whatever the
 * *event's* zone says it means — and the runner's own zone is not that zone on any machine but
 * one. Computing the string in the target zone is the only way this spec asserts about a deadline
 * that is genuinely in the past or the future rather than one that happens to be on the machine
 * that ran it.
 */
const zonedInput = (instant: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * Return to a tab that has been sitting in the background.
 *
 * `page.bringToFront()` is the honest way to write this and it does not work here: headless
 * Chromium keeps every page's `visibilityState` at `visible`, so a background tab fires no
 * `visibilitychange` at all — probed in this runner before this helper was written, and the
 * activation produced an empty event list. So the event is dispatched on the document instead.
 *
 * **What that does and does not prove.** The listener is the page's own, registered on the real
 * document; the re-read that follows goes to the running Worker and the assertion is on what the
 * page then renders. Only the *trigger* is simulated. A regression that removed the listener,
 * read the wrong event, or rendered a stale answer still fails this spec; one that attached the
 * listener to something other than `document` would not, and `cfp-window.test.tsx` does not cover
 * that either. `bringToFront` is still called first, so the tab really is the active one when the
 * assertion runs.
 */
const returnToTab = async (tab: Page) => {
  await tab.bringToFront();
  await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
};

test("a deadline saved in one tab closes and reopens the public call in another, with no reload", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; wait for the signed-in shell before navigating, or the
  // next document can win the race and bounce back to sign-in.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  // Start from a call that is published, open and bounded by nothing, whatever an earlier run of
  // this suite left behind.
  expect(
    (
      await page.request.post(`/api/events/${EVENT_ID}/cfp/state`, { data: { state: "publish" } })
    ).ok(),
  ).toBe(true);
  const cleared = await page.request.put(`/api/events/${EVENT_ID}/cfp/window`, {
    data: { opensAt: null, closesAt: null },
  });
  expect(cleared.ok(), `clearing the window failed: ${await cleared.text()}`).toBe(true);

  await page.goto(COMPOSER);
  await expect(page.getByText("Published · open")).toBeVisible();
  // The window is live state with one control, so it sits beside the form's own details rather
  // than inside the draft — and the composer opens on Questions, where the work is.
  await page.getByRole("button", { name: "Form details" }).click();
  // The zone this spec computes its deadlines in is the zone the composer says it is using, so
  // the two cannot drift apart without this failing rather than silently testing another clock.
  // The date control states it on the field itself, which is what a screen reader is told.
  await expect(page.getByLabel("Deadline")).toHaveAccessibleDescription(
    `Times are in ${EVENT_ZONE}.`,
  );
  await expect(page.getByText("Applicants can submit now.")).toBeVisible();

  // The public page, in its own tab, reading the call before anything has changed.
  const publicPage = await context.newPage();
  await publicPage.goto(PUBLIC_CFP);
  await expect(publicPage.getByRole("button", { name: "Submit proposal" })).toBeVisible();
  await expect(publicPage.getByText(/^Submissions clos/)).toHaveCount(0);

  try {
    // ---- open → closed ----------------------------------------------------------
    await page.bringToFront();
    const past = zonedInput(new Date(Date.now() - 2 * DAY), EVENT_ZONE);
    await page.getByLabel("Deadline").fill(past);
    await page.getByRole("button", { name: "Save window" }).click();

    /*
     * The announcement is phrased from the state the server computed, not from the timestamp that
     * was sent. Saving a past deadline used to be announced as a date "applicants see on the public
     * form" while the call it described was already shut.
     */
    await expect(page.getByRole("status")).toContainText(
      "That deadline has already passed, so the call is closed to new submissions.",
    );
    await expect(
      page.getByText(
        "The deadline has passed, so applicants cannot submit even though the call is marked open.",
      ),
    ).toBeVisible();
    // And the tab that has been sitting there all along, on being looked at again. No reload, no
    // navigation: this is the assertion the whole file exists for.
    await returnToTab(publicPage);
    await expect(
      publicPage.getByText("This call is closed and is no longer accepting submissions."),
    ).toBeVisible();
    await expect(publicPage.getByText(/^Submissions closed /)).toBeVisible();
    await expect(publicPage.getByRole("button", { name: "Submit proposal" })).toHaveCount(0);

    // ---- closed → open ----------------------------------------------------------
    await page.bringToFront();
    const future = zonedInput(new Date(Date.now() + 30 * DAY), EVENT_ZONE);
    await page.getByLabel("Deadline").fill(future);
    await page.getByRole("button", { name: "Save window" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Submission window saved. Applicants see the deadline on the public form.",
    );
    await expect(page.getByText("Applicants can submit now.")).toBeVisible();

    await returnToTab(publicPage);
    await expect(publicPage.getByRole("button", { name: "Submit proposal" })).toBeVisible();
    await expect(publicPage.getByText(/^Submissions close /)).toBeVisible();
    await expect(
      publicPage.getByText("This call is closed and is no longer accepting submissions."),
    ).toHaveCount(0);

    // ---- and the fixture goes back to the state every other spec expects -------
    // Through the control, because "Clear window" is part of what this spec covers. The `finally`
    // below is the safety net rather than the mechanism, and it is deliberately not the only
    // restore: a `finally` that silently repaired the fixture would let this assertion rot.
    await page.bringToFront();
    await page.getByRole("button", { name: "Clear window" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Submission window cleared. The call is bounded only by the open and closed controls.",
    );
    await expect(page.getByText("Applicants can submit now.")).toBeVisible();
    await returnToTab(publicPage);
    await expect(publicPage.getByText(/^Submissions clos/)).toHaveCount(0);
  } finally {
    /*
     * The deadline goes back even when an assertion above failed.
     *
     * Without this, one failing assertion between the two saves leaves `closes_at` two days in
     * the past — and `00-seed-state.spec.ts`, which runs first on the *next* run and does no
     * normalization of its own, submits through the public form expecting 201 and gets a closed
     * call. One failing spec would become a failing seed canary, which reads as fixture
     * corruption rather than as the failure it was. `cfp-submitter.spec.ts` says the same thing
     * about its own deadline test.
     */
    // ERROR-INTENT: this runs while a failure may already be propagating, and a restore that threw
    // would replace the assertion failure with a network error and hide what actually broke.
    await page.request
      .put(`/api/events/${EVENT_ID}/cfp/window`, { data: { opensAt: null, closesAt: null } })
      .catch(() => undefined);
    // ERROR-INTENT: same reason as the restore above, and `close()` is idempotent — a throw here
    // could only replace a real failure with a less useful one.
    await publicPage.close().catch(() => undefined);
  }
});
