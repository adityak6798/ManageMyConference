// @acceptance ACC-SPEAKER
/**
 * Authoring the event's speaker checklist from the console (`PRD-SPK-002`, issue #176).
 *
 * `speaker_task_templates` shipped with commands, routes, contracts, a seed and a template
 * slice that clones it — and no surface at all. This is the journey that was missing: an
 * organizer writes the checklist, corrects a line, drops one, and turns what is left into dated
 * work for a named speaker.
 *
 * **Two events, deliberately.** Authoring runs against an event this run creates, because these
 * specs share one mutable D1 fixture at `workers: 1` and a line added to the demo event would
 * change what `speaker-portal.spec.ts`, the traceability rows and the demo itself show. The
 * assignment half runs against the demo event, because that is the only place with a speaker to
 * assign to — and it uses the seed's third checklist line, which the seed leaves assigned to
 * nobody for exactly this purpose. Sam ends the run with one extra open task, which
 * `speaker-portal.spec.ts` restores from at its own start.
 *
 * This file sorts before `speaker-portal.spec.ts`, which is what makes that restoration the
 * thing that runs second.
 */
import { expect, type Page, test } from "@playwright/test";

const DEMO_EVENT_ID = "00000000-0000-4000-8000-000000000001";
/** The seeded line the seed deliberately assigns to nobody. */
const UNASSIGNED_LINE = "Send your slides";

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
}

/**
 * An event this run owns, created through the product's own control.
 *
 * Unique per run because the fixture is shared across runs, and created rather than borrowed
 * because authoring writes: a checklist line added to the demo event would still be there when
 * the next spec, the next run, and a judge opening the demo look at it.
 */
async function createEvent(page: Page): Promise<string> {
  await page.getByRole("link", { name: /Event settings/ }).click();
  await page.getByLabel("Event name", { exact: true }).fill(`Checklist Trial ${Date.now()}`);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(
    "Checklist Trial",
  );
  const id = new URL(page.url()).searchParams.get("event");
  expect(id, "the workspace URL must carry the selected event").toBeTruthy();
  return id as string;
}

/** The disclosure the checklist lives in, opened the way an organizer opens it. */
async function openChecklist(page: Page, eventId: string) {
  await page.goto(`/sessions?event=${eventId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sessions & speakers" })).toBeVisible();
  const summary = page.getByRole("heading", { name: "Speaker checklist" });
  await expect(summary).toBeVisible();
  await summary.click();
  return page.locator("details", { has: page.getByRole("heading", { name: "Speaker checklist" }) });
}

test("an organizer writes the event's speaker checklist, corrects it, and prunes it", async ({
  page,
}) => {
  await signIn(page);
  const eventId = await createEvent(page);
  const panel = await openChecklist(page, eventId);

  // ---- the empty state teaches, rather than looking like a failed load --------
  // A new event has no checklist because nobody has written one. That is the normal state, so
  // the surface says what a checklist is for instead of showing an empty list.
  await expect(panel).toContainText("No checklist yet");
  await expect(panel).toContainText("every speaker at this event is asked for");

  // ---- the first line ---------------------------------------------------------
  await panel.getByRole("button", { name: "New checklist line" }).click();
  await panel.getByLabel("What the speaker is asked for").fill("Upload a headhsot");
  await panel.getByLabel("Due", { exact: true }).fill("-30");
  await panel.getByLabel("Instructions").fill("A square image, at least 800px on each side.");
  await panel.getByRole("button", { name: "Add line" }).click();

  const line = panel.getByRole("listitem").filter({ hasText: "Upload a headhsot" });
  await expect(line).toBeVisible();
  // The stored value is a signed day count, and the surface says what somebody means by it.
  await expect(line).toContainText("30 days before");

  // ---- the correction, which is the thing the bulk declaration cannot do ------
  // Declaring writes at `(event_id, title)`, so through that path a corrected title creates a
  // second line and leaves the typo in the checklist for ever.
  await panel.getByRole("button", { name: /Edit Upload a headhsot/ }).click();
  await panel.getByLabel("What the speaker is asked for").fill("Upload a headshot");
  await panel.getByRole("button", { name: "Save line" }).click();
  await expect(panel.getByRole("listitem").filter({ hasText: "Upload a headshot" })).toBeVisible();
  await expect(panel.getByRole("listitem").filter({ hasText: "headhsot" })).toHaveCount(0);

  // ---- a second line, and a title the checklist already holds ------------------
  await panel.getByRole("button", { name: "New checklist line" }).click();
  await panel.getByLabel("What the speaker is asked for").fill("Upload a headshot");
  await panel.getByRole("button", { name: "Add line" }).click();
  // Refused rather than converged on: quietly rewriting the line already on screen is not what
  // somebody typing a title means by it.
  await expect(panel.getByRole("alert")).toContainText("already called");
  await expect(panel.getByRole("listitem")).toHaveCount(1);

  await panel.getByLabel("What the speaker is asked for").fill("Send a short bio");
  await panel.getByLabel("Due", { exact: true }).fill("-7");
  await panel.getByRole("button", { name: "Add line" }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(2);

  // ---- removing one, and what that does not touch -----------------------------
  await panel.getByRole("button", { name: /Remove Send a short bio/ }).click();
  await expect(panel.getByRole("status")).toContainText("Tasks already assigned from it");
  await expect(panel.getByRole("listitem")).toHaveCount(1);

  // The checklist survives a reload, which is the difference between a surface that wrote and
  // one that only rendered.
  const reopened = await openChecklist(page, eventId);
  await expect(reopened.getByRole("listitem").filter({ hasText: "Upload a headshot" })).toBeVisible(
    {},
  );
  await expect(reopened.getByRole("listitem")).toHaveCount(1);

  // ---- 390px: the panel stacks rather than scrolling the page sideways --------
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("an organizer turns the demo event's checklist into work for a named speaker", async ({
  page,
}) => {
  await signIn(page);
  const panel = await openChecklist(page, DEMO_EVENT_ID);
  // The seed's third line, left assigned to nobody so this command has something to do.
  await expect(panel.getByRole("listitem").filter({ hasText: UNASSIGNED_LINE })).toBeVisible();

  await panel.getByLabel("Assign to").selectOption({ label: "Sam Speaker" });
  await panel.getByRole("button", { name: /Assign 3 lines to 1 speaker/ }).click();

  /*
   * Idempotent per speaker and line: Sam already holds the first two lines as tasks, so exactly
   * one is created. That number is the whole point of the command — it is what makes running it
   * again after a speaker joins safe rather than a way to ask everybody for everything twice.
   */
  await expect(panel.getByRole("status")).toContainText("1 task assigned across 1 speaker");

  /*
   * And again, which now has nothing left to do. That answer is the assertion that the first
   * press really wrote: "everybody already has every line" is only reachable once the line
   * this run assigned is a task Sam holds.
   */
  await panel.getByRole("button", { name: /Assign 3 lines to 1 speaker/ }).click();
  await expect(panel.getByRole("status")).toContainText("already has every line");
});
