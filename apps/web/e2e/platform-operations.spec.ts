// @acceptance ACC-OPS
/*
 * Searching the event the way an operator actually does it.
 *
 * The service suite proves the authorization model and the browser unit suite proves the
 * palette's states. What only a real browser can show is the journey between them: a keystroke
 * from anywhere in the console, a query typed, a result chosen with the keyboard alone, and the
 * surface that holds the record on screen afterwards with the record visible on it.
 *
 * Both roles are driven, because the permission rule is the point of the feature. A reviewer
 * gets an answer — theirs — and is told in words which sections their role does not include,
 * rather than being refused the surface or shown four empty headings.
 *
 * This spec mutates nothing. Every route it touches is a read.
 */

import { fillAdditionalEvent } from "./event-creation";
import { expect, type Page, test } from "./fixtures";

async function openConsoleAs(page: Page, persona: "organizer" | "reviewer") {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  if (persona === "organizer") return;
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { level: 1, name: "Review assignments" })).toBeVisible();
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Search this event" });

test("an organizer reaches a session from the keyboard alone and lands on it", async ({ page }) => {
  await openConsoleAs(page, "organizer");
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();

  // From a workspace rather than from the overview: the chord has to work wherever the operator
  // already is, which is the whole reason it is registered on the document.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole("combobox")).toBeFocused();

  // Typed with the keyboard, never filled: what is being asserted is that a keyboard-only
  // operator can drive this, and `fill()` would set the value without pressing a key. The term
  // is one the deterministic seed holds, so an empty listbox is a defect rather than a correct
  // answer about a word nobody wrote.
  await page.keyboard.type("Accessible by default");
  const option = palette(page)
    .getByRole("option", { name: /Accessible by default/ })
    .first();
  await expect(option).toBeVisible();

  // The listbox is a single tab stop: focus stays on the input while the active option moves.
  await expect(palette(page).getByRole("combobox")).toBeFocused();
  const activeId = await palette(page).getByRole("combobox").getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();

  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  // Landed on the surface that holds the record, with the record on it — the console has no
  // per-record routes today, which `GAP-022` records.
  await expect(page).toHaveURL(/\/schedule\?event=.*&tab=sessions/);
  await expect(page.getByText("Accessible by default").first()).toBeVisible();
  // Focus followed the navigation rather than being left on a control that no longer exists.
  await expect(page.locator("main")).toBeFocused();
});

test("the full-page search surface answers an organizer and links every hit", async ({ page }) => {
  await openConsoleAs(page, "organizer");

  await page.goto("/search");
  await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();

  await page.getByLabel(/Sessions, speakers, proposals/).fill("accessible");
  // Scoped to `main`: the topbar's palette control carries the same name.
  await page.locator("main").getByRole("button", { name: "Search" }).click();

  const hit = page.getByRole("link", { name: /accessible/i }).first();
  await expect(hit).toBeVisible();
  // Every link carries the event it was searched in, produced by the server.
  await expect(hit).toHaveAttribute("href", /\?event=/);
  await hit.click();
  await expect(page).toHaveURL(/\?event=/);
});

test("a reviewer is answered from their own queue and told what their role omits", async ({
  page,
}) => {
  await openConsoleAs(page, "reviewer");

  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Search/ })
    .click();
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("hallway");

  // The reviewer's own assignment answers…
  await expect(
    palette(page).getByRole("option", { name: /Designing for the hallway track/ }),
  ).toBeVisible();
  // …and the sections their role does not include are named rather than silently absent.
  await expect(palette(page).getByText(/Not available to your role/)).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/reviews\?event=/);
  await expect(
    page.getByRole("heading", { name: "Designing for the hallway track" }),
  ).toBeVisible();
});

test("the inbox states what is waiting on the seeded event, and a dismissal round-trips", async ({
  page,
}) => {
  await openConsoleAs(page, "organizer");

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  /*
   * Three categories are populated by the deterministic seed, and each is asserted on its own
   * content rather than on a count: the seeded reviewer assignment with no evaluation, the open
   * speaker tasks, and the deliveries the fixture provider genuinely refused. Wave 5's two-day
   * programme places both seeded sessions; journeys earlier in the shared run may add their own
   * draft work, so this assertion names the seeded session that must not be waiting.
   */
  const programme = page.getByRole("region", { name: "Programme" });
  await expect(programme).toBeVisible();
  await expect(programme.getByRole("link", { name: "Accessible by default" })).toHaveCount(0);

  const speakerWork = page.getByRole("region", { name: "Speaker work" });
  await expect(speakerWork.getByRole("link", { name: "Confirm profile details" })).toBeVisible();
  await expect(speakerWork.getByText("Sam Speaker").first()).toBeVisible();

  const reviews = page.getByRole("region", { name: "Reviews outstanding" });
  await expect(
    reviews.getByRole("link", { name: "Designing for the hallway track" }),
  ).toBeVisible();
  await expect(reviews.getByText("Ravi Reviewer").first()).toBeVisible();

  const deliveries = page.getByRole("region", { name: "Deliveries that failed" });
  await expect(
    deliveries.getByRole("link", { name: "Abstracts are waiting for your review" }),
  ).toBeVisible();

  // A dismissal is visible, marked, and undone — never a way of deleting the row.
  const dismiss = speakerWork.getByRole("button", { name: "Dismiss Confirm profile details" });
  await dismiss.click();
  const restore = speakerWork.getByRole("button", { name: "Restore Confirm profile details" });
  await expect(restore).toBeVisible();
  await expect(speakerWork.getByRole("link", { name: "Confirm profile details" })).toBeVisible();

  // Handed back the way it was found: the shared fixture carries no dismissal out of this spec.
  await restore.click();
  await expect(dismiss).toBeVisible();
});

test("a brand-new event's inbox says its public page is not live", async ({ page }) => {
  /*
   * Publication is one of the two categories the seed cannot show, and that is correct rather
   * than a gap: the demo event is published and its draft matches its snapshot, so there is
   * genuinely nothing awaiting publication. (The other is `configuration`, which the seed clears
   * outright — `reset.sql` deletes `event_template_applications` — and which therefore has no
   * browser assertion at all; the `ACC-OPS` scorecard row names that absence rather than
   * implying coverage it lacks.) Driving it needs an event in that state, so this creates one — the
   * same thing `publishing.spec.ts` does, and for the same reason.
   */
  const name = `Greenroom Inbox Trial ${Date.now()}`;
  await openConsoleAs(page, "organizer");
  await page.goto("/settings?tab=event");
  await fillAdditionalEvent(page, { name });
  await page.getByRole("button", { name: "Create event" }).click();
  // Wait for the created event to become the active selection, not merely to appear somewhere
  // in the option list; navigating while creation is still refreshing would reopen the old event.
  await expect(
    page.getByRole("combobox", { name: "Event workspace" }).locator("option:checked"),
  ).toHaveText(name);

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Inbox", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  const publication = page.getByRole("region", { name: "Publication" });
  await expect(
    publication.getByRole("link", { name: "The public page is not live" }),
  ).toBeVisible();
  // And the categories with nothing in them say why they are empty rather than showing a
  // heading over nothing.
  await expect(
    page.getByRole("region", { name: "Speaker work" }).getByText("No speaker has outstanding work"),
  ).toBeVisible();
});

test("a reviewer's inbox carries their own work and names what their role omits", async ({
  page,
}) => {
  await openConsoleAs(page, "reviewer");

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  await expect(
    page
      .getByRole("region", { name: "Reviews outstanding" })
      .getByRole("link", { name: "Designing for the hallway track" }),
  ).toBeVisible();
  await expect(page.getByText(/Not available to your role/)).toBeVisible();
});

test("the activity timeline records a real mutation with the organizer who made it", async ({
  page,
}) => {
  /*
   * Its own event, for the same reason `publishing.spec.ts` creates one: the audit table is
   * append-only and nothing cleans it up, so asserting against the shared demo event would be
   * asserting against every previous run of the suite as well. A fresh event has an empty
   * timeline, which makes "this action produced this record" a claim the test can actually make.
   */
  const name = `Greenroom Activity Trial ${Date.now()}`;
  await openConsoleAs(page, "organizer");
  await page.goto("/settings?tab=event");
  await fillAdditionalEvent(page, { name });
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(name);
  const eventId = new URL(page.url()).searchParams.get("event");
  expect(eventId, "the workspace URL must carry the selected event").toBeTruthy();

  await page.goto(`/settings?event=${eventId}&tab=activity`);
  await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
  await expect(page.getByText("Nothing recorded yet")).toBeVisible();

  // Publish a schedule: an agenda mutation whose audit record commits inside the publication's
  // own batch, so this is also the browser-level evidence that the batch writer is wired.
  await page.goto(`/schedule?event=${eventId}&tab=agenda`);
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await page.getByRole("button", { name: "Create agenda" }).click();
  await page.locator("summary").filter({ hasText: "Manage rooms, tracks, and times" }).click();
  await page.getByLabel("New timeslot start").fill("2026-11-04T09:00");
  await page.getByLabel("New timeslot end").fill("2026-11-04T10:00");
  await page.getByRole("button", { name: "Add timeslot" }).click();
  await expect(page.getByRole("status")).toContainText("Timeslot added.");
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect(page.getByRole("status")).toContainText("Published version 1");

  await page.goto(`/settings?event=${eventId}&tab=activity`);
  const published = page.getByRole("row", { name: /Agenda schedule published/ });
  await expect(published).toBeVisible();
  // The organizer who pressed Publish, named, and marked as a person rather than a program.
  await expect(published).toContainText("Olivia Organizer");
  await expect(published).toContainText("Person");

  /*
   * The fifth domain. Publishing the *site* is a different act from publishing the schedule, and
   * until #99's last phase it was the one change the timeline could not account for — publishing
   * had no seam to observe. Driving it here is what turns "five domains" from a claim into an
   * observation.
   */
  await page.goto(`/publish?event=${eventId}&tab=event-site`);
  await expect(page.getByRole("heading", { level: 1, name: "Publishing" })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Snapshot matches the draft")).toBeVisible();

  await page.goto(`/settings?event=${eventId}&tab=activity`);
  const site = page.getByRole("row", { name: /Publishing event published/ });
  await expect(site).toBeVisible();
  await expect(site).toContainText("Olivia Organizer");
});

test("a role without events:settings:read is not offered the activity timeline", async ({
  page,
}) => {
  await openConsoleAs(page, "reviewer");

  // The log names who did what to an event, which is the administrative view of it rather than
  // something every role on the event may read.
  await expect(
    page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: "Activity", exact: true }),
  ).toHaveCount(0);
});
