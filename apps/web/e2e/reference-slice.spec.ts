// @acceptance ACC-IDENTITY-EVENTS

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
  await expect(page.getByRole("alert")).toContainText("Reference:");

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

  await switcher.selectOption({ label: "Greenroom Workshop Day" });
  // The selected event is carried in the URL so a workspace view is shareable.
  await expect(page).toHaveURL(/\?event=/);

  await page.goto("/settings?tab=event");
  await expect(page.getByRole("heading", { level: 1, name: "Event" })).toBeVisible();
  await page.getByLabel("Current event name").fill("Greenroom Workshop Day Renamed");
  // The timezone is chosen from the browser's own zone list rather than typed: a free-text box
  // let a typo through to the public site, the agenda board and every `.ics` invite (#206).
  // Exact, because the create form below carries a second control whose label contains this one.
  const timezone = page.getByLabel("Event timezone", { exact: true });
  await expect(timezone).toHaveRole("combobox");
  await timezone.selectOption("America/Chicago");
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
  await expect(page.getByText(`${eventName} \u00b7 Europe/Berlin`)).toBeVisible();

  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("reviewer");
  await expect(page.getByRole("link", { name: /Review assignments/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Event settings/ })).toHaveCount(0);
});

test("a demo persona signs out and returns to the landing page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Try the demo" }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole("link", { name: "Try the demo" }).first()).toBeVisible();
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
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();

  await page.getByRole("button", { name: "Publish schedule" }).click();
  // The publication counter advances with every run against a shared fixture, so assert
  // that a version was published rather than pinning the number.
  await expect(page.getByRole("status")).toContainText(/Published version \d+/);

  // Start the experiment by moving the seeded day-two session into Unscheduled. The
  // browser journey restores that exact placement before it exits, so other specs still
  // receive the two-day demo the reset established.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: /Accessible by default/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");
  await page.getByRole("tab", { name: /^Room/ }).click();

  // The conflict is made the way an organizer would make one: the second session is
  // dropped into the cell the opening keynote already holds. It used to be forged with a
  // `page.request.put` against the placements route, which proved the rule and nothing
  // about whether the product can reach it — and left a placement no control could clear.
  const card = page.getByRole("button", { name: /Accessible by default\. Not scheduled/ });
  await card.focus();
  await card.press("Enter");
  await page
    .getByRole("button", {
      name: /Place .*\. Already holds 1 session/,
    })
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
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeEnabled();

  // Put the session back on its seeded second day with the same keyboard path used above.
  await page.getByRole("tab", { name: /^Room/ }).click();
  await page
    .getByRole("combobox", { name: "Day", exact: true })
    .selectOption({ label: "Wed, Sep 2" });
  const restore = page.getByRole("button", { name: /Accessible by default\. Not scheduled/ });
  await restore.focus();
  await restore.press("Enter");
  await page
    .getByRole("button", { name: /Place .* in Workshop lab at 10:00–11:00/ })
    .press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "“Accessible by default” placed in Workshop lab at 10:00–11:00.",
  );
});
