// @acceptance ACC-IDENTITY-EVENTS

import { confirmInDrawer, filterAndCommit, switchEvent, switchPersona } from "./controls";
import { fillAdditionalEvent } from "./event-creation";
import { expect, test } from "./fixtures";

test("signs in, switches events and roles, creates, and reloads an event", async ({ page }) => {
  const eventName = `Greenroom Browser Summit ${Date.now()}`;
  const seededEventId = "00000000-0000-4000-8000-000000000001";
  // The correlation-aware refusal moved rather than went. `/` is now the marketing landing
  // page, and a visitor at the front door is not looking at an error — but a *deep link* while
  // signed out still reaches the console's own signed-out surface, which is where `PRD-IAM-002`
  // requires the reference to appear. Asserting it there keeps the property proven instead of
  // deleting the assertion along with the screen that used to carry it.
  await page.goto("/agenda");
  const refused = page.getByRole("alert");
  await expect(refused).toContainText("Sign in to continue.");
  // The reference is beside the sentence rather than glued onto it: an identifier read
  // character by character is a value to quote, so it sets as a measure with a copy control.
  await expect(refused.getByRole("button", { name: "Copy the reference" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();

  let seededProposalCount: number | undefined;
  await expect
    .poll(async () => {
      const before = await page.request.get(`/api/events/${seededEventId}/cfp/proposals`);
      if (!before.ok()) return before.status();
      seededProposalCount = ((await before.json()).proposals as unknown[]).length;
      return before.status();
    })
    .toBe(200);
  if (seededProposalCount === undefined) throw new Error("Seeded proposals never became readable");

  const switcher = page.getByRole("combobox", { name: "Event workspace" });
  await expect(switcher).toContainText("Greenroom Demo Summit");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  await switchEvent(page, "Greenroom Workshop Day");
  // The selected event is carried in the URL so a workspace view is shareable.
  await expect(page).toHaveURL(/\?event=/);

  await page.goto("/settings?tab=event");
  await expect(page.getByRole("heading", { level: 1, name: "Event" })).toBeVisible();
  await page.getByLabel("Event name", { exact: true }).fill("Greenroom Workshop Day Renamed");
  // The timezone is chosen from the browser's own zone list rather than typed: a free-text box
  // let a typo through to the public site, the agenda board and every `.ics` invite (#206).
  // Exact, because the create form below carries a second control whose label contains this one.
  // A filtering combobox, not a native select: roughly 400 zones is the one list length a
  // select popup is worst at. Typing narrows, Enter commits the single remaining match.
  await filterAndCommit(
    page,
    page.getByLabel("Event timezone", { exact: true }),
    "America/Chicago",
  );
  await page.getByRole("button", { name: "Save event settings" }).click();
  await expect(switcher).toContainText("Greenroom Workshop Day Renamed");
  // The page subtitle prints the stored zone, so this asserts what was saved rather than what
  // the control shows.
  await expect(
    page.getByText("Greenroom Workshop Day Renamed \u00b7 America/Chicago"),
  ).toBeVisible();
  // A new event gets its own zone rather than the constant every create used to send.
  await fillAdditionalEvent(page, { name: eventName, timezone: "Europe/Berlin" });
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(switcher).toContainText(eventName);
  const createdEventId = new URL(page.url()).searchParams.get("event");
  expect(createdEventId).toBeTruthy();

  // No implicit clone: the existing event keeps every proposal it had and the new event has
  // none. This reads both event-scoped APIs after the write, rather than inferring isolation from
  // two switcher options that could still point at shared data.
  const [createdProposals, seededProposals] = await Promise.all([
    page.request.get(`/api/events/${createdEventId}/cfp/proposals`),
    page.request.get(`/api/events/${seededEventId}/cfp/proposals`),
  ]);
  expect(createdProposals.ok()).toBe(true);
  expect(seededProposals.ok()).toBe(true);
  expect((await createdProposals.json()).proposals).toEqual([]);
  expect(((await seededProposals.json()).proposals as unknown[]).length).toBe(seededProposalCount);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(eventName);
  // Creating an event is its own destination now, so the reader is still on the form that made
  // it; the overview is where the event states its name and its zone.
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Overview" })
    .click();
  await expect(page.getByText(`${eventName} \u00b7 Europe/Berlin`)).toBeVisible();

  // The persona picker moved inside the account control, where everything about who is signed
  // in now lives, and is only drawn on a demo deployment — the route behind it 404s elsewhere.
  await switchPersona(page, "Reviewer");
  await expect(page.getByRole("link", { name: /Review assignments/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Event settings/ })).toHaveCount(0);
});

test("a demo persona signs out and returns to the landing page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  // Signing out lives behind the account control, with everything else about who is signed in.
  await page.getByRole("button", { name: /^Account and access for / }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  // The marketing page's primary door *starts* the demo rather than linking to a page showing a
  // strict subset of what is already on screen, so it is a button and it says what it does.
  const door = page.getByRole("button", { name: "Open the demo as an organizer" });
  await expect(door.first()).toBeVisible();

  await page.reload();
  await expect(door.first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toHaveCount(0);
});

// @acceptance ACC-AGENDA
test("publishes a clean agenda, explains draft conflicts, and keeps publication stable", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.goto(
    `/schedule?event=${new URL(page.url()).searchParams.get("event")}&tab=agenda&view=room`,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();

  await page.getByRole("button", { name: "Publish schedule" }).click();
  // Publication is irreversible, so the board asks first and previews what becomes public.
  await confirmInDrawer(page, "Publish the schedule", "Publish schedule");
  // The publication counter advances with every run against a shared fixture, so assert
  // that a version was published rather than pinning the number.
  // Filtered: while the draft has conflicts, the standing summary is a second polite region.
  await expect(page.getByRole("status").filter({ hasText: /Published version \d+/ })).toBeVisible();

  // Start the experiment by moving the seeded day-two session into Unscheduled. The
  // browser journey restores that exact placement before it exits, so other specs still
  // receive the two-day demo the reset established.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: /Accessible by default/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "moved back to Unscheduled" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Room/ }).click();

  // The conflict is made the way an organizer would make one: the second session is
  // dropped into the cell the opening keynote already holds. It used to be forged with a
  // `page.request.put` against the placements route, which proved the rule and nothing
  // about whether the product can reach it — and left a placement no control could clear.
  const card = page.getByRole("button", { name: /Accessible by default\. Not scheduled/ });
  await card.focus();
  await card.press("Enter");
  // The drop target is the whole board cell, which is a `gridcell` in ARIA terms — an inner
  // strip meant the drag-over highlight reported the wrong area of a 170×80px target.
  await page
    .getByRole("gridcell", { name: /Place .*\. Holds 1 session/ })
    .first()
    .press("Enter");
  await expect(page.getByText("Room double-booked", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeDisabled();

  // Publication is immutable: the draft conflict must not reach the public projection.
  // The public schedule is addressed by the published slug, not the internal event id.
  const publicResponse = await request.get("/api/public/events/greenroom-demo-summit/schedule");
  expect(publicResponse.ok()).toBeTruthy();
  const body = await publicResponse.json();
  expect(body.schedule.version).toBeGreaterThanOrEqual(2);
  // The draft now moves the second session onto the main stage at the first session's
  // time. The published answer must retain both original placements instead.
  expect(body.schedule.sessions).toHaveLength(2);
  expect(body.schedule.sessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ slug: "designing-the-calm-conference", room: "Main stage" }),
      expect.objectContaining({ slug: "accessible-by-default", room: "Workshop lab" }),
    ]),
  );
  // The public schedule is composed from the published projection, so it carries readable
  // identifiers only — never the internal room/track/slot/placement keys the board uses.
  expect(JSON.stringify(body)).not.toMatch(/room-main|track-platform|slot-0900|placement-/);

  // Cleared with the same controls that made it. Leaving the conflict behind would block
  // publication for every later run against this fixture.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: /Accessible by default/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "moved back to Unscheduled" }),
  ).toBeVisible();
  // The board bar no longer repeats "no conflicts" — the Conflicts tab carries that at zero
  // vertical cost — so the answer is read where an organizer goes to look for it.
  await page.getByRole("tab", { name: /^Conflicts/ }).click();
  await expect(page.getByRole("heading", { name: "No conflicts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeEnabled();

  // Put the session back on its seeded second day with the same keyboard path used above.
  await page.getByRole("tab", { name: /^Room/ }).click();
  // The day picker is a radiogroup drawn on the board bar, not a select in a filter toolbar.
  await page.getByRole("radio", { name: /Wed, Sep 2/ }).click();
  const restore = page.getByRole("button", { name: /Accessible by default\. Not scheduled/ });
  await restore.focus();
  await restore.press("Enter");
  await page
    .getByRole("gridcell", { name: /Place .* in Workshop lab/ })
    .first()
    .press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: /“Accessible by default” placed in Workshop lab/ }),
  ).toBeVisible();
});

/**
 * An event-settings save, arriving where every other surface reads the event from.
 *
 * The chip in the topbar is the one thing on every console surface that says which event this
 * is, and it is drawn from the shell's event list rather than from the form that changes it. So
 * a save that wrote to D1 and did not tell the shell looked exactly like a save that had not
 * happened: the page kept saying the old name, on every surface, until a reload. `onEventChanged`
 * is the seam, and this is the journey that would notice it going missing.
 *
 * It works on the workshop event and puts the name back, because the demo event's name is what
 * the public projection and half this suite assert against.
 */
test("an event-settings save reaches the topbar chip every surface reads", async ({ page }) => {
  const workshopEventId = "00000000-0000-4000-8000-000000000002";
  const renamed = `Greenroom Workshop Day ${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  // Whatever an earlier journey in this shared fixture left the event called, restored at the end.
  const before = await page.request.get(`/api/events/${workshopEventId}`);
  expect(before.ok(), `reading the workshop event failed: ${await before.text()}`).toBe(true);
  const { name: original, timezone } = (
    (await before.json()) as { event: { name: string; timezone: string } }
  ).event;

  try {
    await page.goto(`/settings?event=${workshopEventId}&tab=event`);
    await expect(page.getByRole("heading", { level: 1, name: "Event" })).toBeVisible();
    // The chip is the shell's, so it is read from the banner rather than from the page.
    const chip = page.getByRole("banner").getByRole("combobox", { name: "Event workspace" });
    await expect(chip).toContainText(original);

    await page.getByLabel("Event name", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save event settings" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Event settings saved." }),
    ).toBeVisible();
    // The assertion this test exists for: the save is visible in the chip, without a reload.
    await expect(chip).toContainText(renamed);

    // And it is the shell's list that changed, not this form's own state: another workspace,
    // reached without a document load, states the same name.
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .locator(`a[href="/schedule?event=${workshopEventId}"]`)
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();
    await expect(chip).toContainText(renamed);
  } finally {
    // Both values, because the route replaces the event's settings rather than patching them:
    // a request that omits the zone is a request to have no zone, and it is refused.
    const restored = await page.request.patch(`/api/events/${workshopEventId}`, {
      data: { name: original, timezone },
    });
    expect(restored.ok(), `restoring the workshop event failed: ${await restored.text()}`).toBe(
      true,
    );
  }
});
