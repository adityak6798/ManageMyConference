// @acceptance ACC-EVENT-TEMPLATES
/**
 * Cloning an event's configuration, from the console (`PRD-EVT-002`).
 *
 * The journey is deliberately create-then-preview-then-apply-then-apply-again, and the first
 * step is not scaffolding.
 *
 * **It clones onto an event this run creates, and never onto the demo event.** Applying a
 * template rewrites the destination's agenda slots, CFP draft, triage statuses, rubric, public
 * draft page and portal resources. The seeded demo event is the one fixture every other browser
 * spec asserts against — these specs share a single mutable D1 fixture at `workers: 1` and are
 * deliberately order-dependent — so a clone onto it is not a risky test, it is a test that
 * reconfigures the subject of `speaker-portal.spec.ts` and `public-event.spec.ts` out from under
 * them. This file may read the demo event; only the second test does, and capture is a read.
 *
 * **Creating the destination first is also the real journey.** `ARC-FLOW-006` makes creating and
 * configuring two requests on purpose: the request actor is a snapshot resolved before any
 * handler runs, so the organizer grant `EventService.create` writes never reaches the actor of
 * the request that created the event, and a single request that created a destination and then
 * configured it would be denied by its own authorization check. The console's answer is create,
 * re-read the session, then clone — which is exactly what an organizer does and now exactly what
 * this spec walks.
 *
 * **And a fresh destination makes the assertions stronger.** Every category has somewhere empty
 * to land, so the first preview says "creates" rather than "replaces", each category that copies
 * is copying for real, and the second apply's convergence claim is about state this run produced.
 * That claim is the one that is easy to make and hard to keep: every category converges, so
 * re-applying a version repairs a partial clone instead of duplicating the part that already
 * landed (`ARC-FLOW-006`). A suite that stopped after the first apply would pass against an
 * implementation that appends a second copy of every CFP field.
 *
 * Re-runnable against the shared fixture: the destination event and the template the second test
 * saves both carry a name unique to the run, the way `publishing.spec.ts` names the event it
 * creates and `communications.spec.ts` keys its template versions.
 */
import { expect, type Page, test } from "@playwright/test";

/** Read-only here: the source the seeded template was captured from, and never a destination. */
const DEMO_EVENT_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_EVENT_NAME = "Greenroom Demo Summit";
/** Seeded, active, captured from the demo event, and holding exactly one version. */
const SEEDED_TEMPLATE = "Annual summit starter";

/** Every category the seeded version carries, which is every category that must converge. */
const CATEGORIES = [
  "CFP form and routing",
  "Agenda rooms, tracks and time slots",
  "Triage statuses and scoring rubric",
  "Public page details",
  "Speaker portal resources",
  "Speaker task checklists",
];

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; navigating before its cookie lands loads the workspace
  // unauthenticated and the shell bounces to the sign-in surface.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
}

/**
 * The destination this run will clone into, created through the product's own control.
 *
 * Unique per run, because the fixture is shared and its public address is derived from this
 * name. Creating refreshes the session, which is the client half of the two-request rule
 * `ARC-FLOW-006` states: the grant this call wrote is only readable by the *next* request.
 */
async function createDestination(page: Page): Promise<{ id: string; name: string }> {
  const name = `Greenroom Template Trial ${Date.now()}`;
  await page.getByRole("link", { name: /Event settings/ }).click();
  await page.getByLabel("Event name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(name);
  // Selecting an event means the address bar too, which is how this run learns the id the
  // console assigned. Navigating to a bare `/event-templates` would land on whichever event
  // sorts first — and clone onto that one instead.
  const id = new URL(page.url()).searchParams.get("event");
  expect(id, "the workspace URL must carry the selected event").toBeTruthy();
  return { id: id as string, name };
}

async function openTemplates(page: Page, eventId: string) {
  await page.goto(`/event-templates?event=${eventId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Event templates" })).toBeVisible();
}

const library = (page: Page) => page.getByRole("region", { name: "Templates", exact: true });
const applyPanel = (page: Page, destination: string) =>
  page.getByRole("region", { name: `Apply to ${destination}`, exact: true });
const previewPanel = (page: Page) => page.getByRole("region", { name: "Preview", exact: true });
const resultPanel = (page: Page) => page.getByRole("region", { name: "Applied", exact: true });

/** One category's row, in a preview or in a result. */
const category = (panel: ReturnType<typeof library>, label: string) =>
  panel.getByRole("listitem").filter({ hasText: label });

test("an organizer creates an event, previews a template into it, applies it, and applies it again", async ({
  page,
}) => {
  await signIn(page);
  const destination = await createDestination(page);
  await openTemplates(page, destination.id);
  const apply = applyPanel(page, destination.name);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  // ---- the organization's templates, with state and version count -------------
  // The new event is in the organizer's organization, so the seeded template — captured from a
  // different event entirely — is on offer here, which is the whole point of a template library.
  const seeded = category(library(page), SEEDED_TEMPLATE);
  await expect(seeded).toContainText("Active");
  await expect(seeded).toContainText("1 version");
  await expect(seeded).toContainText(`newest captured from ${DEMO_EVENT_NAME}`);

  await library(page).getByRole("button", { name: SEEDED_TEMPLATE, exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: SEEDED_TEMPLATE, exact: true })
      .getByRole("heading", { name: "Version 1" }),
  ).toBeVisible();

  // ---- the destination range is confirmed, never inferred ---------------------
  // There is nothing to prefill these from: an event carries no dates of its own, so the range
  // is a parameter of the clone. The surface says so where the organizer types it.
  await expect(apply).toContainText("nothing to prefill them from");
  await apply.getByLabel("First day").fill("2027-03-08");
  await apply.getByLabel("Last day").fill("2027-03-10");
  await apply.getByRole("button", { name: "Preview this clone" }).click();

  // ---- the per-category breakdown, before anything is written -----------------
  await expect(previewPanel(page)).toContainText("Nothing has been written.");
  // A breakdown is a breakdown: the surface names each category rather than summarizing the
  // clone as one verdict. The count itself is the fixture's business and grows as categories
  // are added, so the assertion is that there is more than one of them.
  expect(await previewPanel(page).getByRole("heading", { level: 3 }).count()).toBeGreaterThan(1);

  const previewedCfp = category(previewPanel(page), "CFP form and routing");
  await expect(previewedCfp).toContainText("Would copy");
  // "Creates", not "replaces": this destination was created moments ago and has no CFP of its
  // own. Cloning onto a fresh event is what lets this assert the reason rather than skirt it.
  await expect(previewedCfp).toContainText("Creates the destination's CFP draft.");
  // Named entry by entry, because this is read to find the one thing that should not travel.
  await expect(previewedCfp).toContainText("Field: Proposal title");
  await expect(previewedCfp).toContainText("Submitted proposals and their answers");

  const previewedAgenda = category(previewPanel(page), "Agenda rooms, tracks and time slots");
  await expect(previewedAgenda).toContainText("Would copy");
  await expect(previewedAgenda).toContainText(
    "Creates the destination's rooms, tracks and time slots.",
  );
  // The dated half of the clone lands on the range the organizer confirmed, not the source's.
  await expect(previewedAgenda).toContainText("Time slot: 2027-03-08");
  await expect(category(previewPanel(page), "Triage statuses and scoring rubric")).toContainText(
    "Would copy",
  );

  // A category this system copies nothing for is listed with its reason rather than omitted:
  // message templates are keyed by organization, so the destination already resolves the same
  // ones and claiming to have copied them would be a false statement in a product surface.
  const previewedMessages = category(previewPanel(page), "Message and reminder templates");
  await expect(previewedMessages).toContainText("Skipped");
  await expect(previewedMessages).toContainText("Already shared at the organization");

  // ---- applying reports every category, and refuses to soften the guarantee ---
  await previewPanel(page)
    .getByRole("button", { name: `Apply version 1 to ${destination.name}` })
    .click();
  await expect(resultPanel(page)).toBeVisible();
  for (const label of CATEGORIES)
    await expect(category(resultPanel(page), label)).toContainText("Applied");
  await expect(category(resultPanel(page), "Message and reminder templates")).toContainText(
    "Skipped",
  );
  await expect(resultPanel(page)).toContainText("roll back the categories that succeeded");
  await expect(resultPanel(page)).toContainText("Applying this same version again is the repair");

  /*
   * Every category landed, so there is nothing outstanding and the repair card stays away
   * (issue #175). The card is driven from the *stored* outcome rather than from the response
   * on screen, so this is also the assertion that a clean application does not leave a row
   * saying otherwise — and it re-reads the page to prove it, because the card would be built
   * from a fresh read of what storage holds.
   */
  await openTemplates(page, destination.id);
  await expect(
    page.getByRole("region", { name: `${destination.name} is configured in part` }),
  ).toHaveCount(0);

  // ---- the same version again converges rather than duplicating ---------------
  await apply.getByRole("button", { name: "Preview this clone" }).click();
  await expect(category(previewPanel(page), "CFP form and routing")).toContainText(
    "already matches this template",
  );
  await previewPanel(page)
    .getByRole("button", { name: `Apply version 1 to ${destination.name}` })
    .click();
  // Every category, not just the cheap one: the guarantee the surface printed above is that
  // re-applying repairs rather than duplicates, and a category that quietly wrote again would
  // be the counterexample. This run created the destination, so this is a claim about state
  // this test produced rather than about whatever the fixture happened to hold.
  for (const label of CATEGORIES)
    await expect(category(resultPanel(page), label)).toContainText("nothing needed to be written");

  // Nothing was appended anywhere: the template still holds the one version it was seeded with.
  // Read from a fresh load rather than the rows on screen — those were fetched before the first
  // preview and applying never refreshes them, so asserting on them would hold against an
  // implementation that captured a version on every apply.
  await openTemplates(page, destination.id);
  await expect(category(library(page), SEEDED_TEMPLATE)).toContainText("1 version");

  // ---- 390px: the breakdown stacks rather than scrolling sideways -------------
  await page.setViewportSize({ width: 390, height: 844 });
  await openTemplates(page, destination.id);
  await expect(category(library(page), SEEDED_TEMPLATE)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("an organizer saves this event as a template, then archives it", async ({ page }) => {
  // Captures from the demo event, which is safe where applying is not: a capture reads the
  // source's configuration and writes only to the new template.
  await signIn(page);
  await openTemplates(page, DEMO_EVENT_ID);
  // Unique per run: the suite shares one fixture across runs, and a fixed name would collide
  // with the template the previous run saved.
  const name = `Captured by the browser suite ${Date.now()}`;

  const save = page.getByRole("region", { name: "Save this event as a template" });
  await save.getByLabel("Template name").fill(name);
  await save.getByRole("button", { name: "Save template" }).click();
  // The capture reports what each category contributed, because a template quietly missing a
  // category applies cleanly and leaves the destination wrong.
  await expect(save.getByRole("status")).toContainText("as version 1");
  // The count is the fixture's business and grows as categories are added, so the assertion is
  // on the sentence being made at all — in either number, because "categorys" is not a word.
  await expect(save.getByRole("status")).toContainText(/\d+ categor(?:y|ies) captured/);

  const saved = page.getByRole("region", { name, exact: true });
  await expect(saved.getByRole("heading", { name: "Version 1" })).toBeVisible();
  await expect(saved).toContainText(`Captured from ${DEMO_EVENT_NAME}`);
  // A person, not the account id it is stored under (issue #176). The id is what storage holds
  // and `seed-organizer` is not anybody's name; identity is what turns one into the other.
  await expect(saved).toContainText("by Olivia Organizer");
  await expect(saved).not.toContainText("seed-organizer");
  await expect(category(library(page), name)).toContainText("Active");

  const manage = page.getByRole("region", { name: "Manage this template" });
  await manage.getByRole("button", { name: "Archive" }).click();
  await expect(manage.getByRole("status")).toContainText("archived");
  // Archived means out of circulation, not gone: the row stays, and says which it is.
  await expect(category(library(page), name)).toContainText("Archived");
  await expect(manage.getByRole("button", { name: "Restore" })).toBeVisible();
});
