// @acceptance ACC-CFP ACC-REVIEW ACC-SPEAKER ACC-AGENDA ACC-PUBLIC
/*
 * One proposal, carried across every domain boundary in the product, in one run.
 *
 * Every other spec starts from the seed and proves one hop. This one files a proposal
 * nobody has seen before and follows it: public submission → organizer triage → reviewer
 * assignment → scoring and completion → acceptance into content → publication readiness →
 * a place on the agenda → a published schedule → a published site — and then reads the
 * title it invented off the public page and the embed. Nothing it asserts about the
 * artifact comes from the seed; the only fixed identifiers are the demo event and its
 * public slug, because the seeded event is the only one the demo directory staffs with a
 * reviewer, and a reviewer is one of the hops.
 *
 * It hands the fixture back at the end. The public projection is the demo an evaluator
 * opens next, and the board has four cells; a run that left its session published and
 * placed would change what every later spec — and every later run — meets.
 *
 * `TST-006` recorded this scenario as outstanding until it landed.
 */
import { expect, type Page, test } from "./fixtures";

// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({ extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.3" } });

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const SLUG = "greenroom-demo-summit";
const TRIAGE = `/abstracts?event=${DEMO_EVENT}`;
const QUEUE = `/program?event=${DEMO_EVENT}&tab=submissions`;
const SESSIONS = `/schedule?event=${DEMO_EVENT}&tab=sessions`;
const AGENDA = `/schedule?event=${DEMO_EVENT}&tab=agenda&view=room`;
const PUBLISHING = `/publish?event=${DEMO_EVENT}&tab=event-site`;

async function becomeOrganizer(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
}

/**
 * Switch the signed-in persona, and wait for the switch to actually land.
 *
 * `switchPersona` (apps/web/src/App.tsx) is fired from the select's change handler and
 * deliberately not awaited, so `selectOption` returns while `POST /api/demo-session` is
 * still in flight. Navigating straight afterwards aborts that request, the next document
 * is fetched with the previous identity's cookie, and `routesFor` redirects the organizer
 * off `/reviews` to the overview. Waiting for the response closes the window: the new
 * session cookie arrives with those headers.
 */
async function switchRole(page: Page, persona: "organizer" | "reviewer") {
  const role = page.getByRole("combobox", { name: "Signed-in role" });
  const switched = page.waitForResponse(
    (response) =>
      response.url().includes("/api/demo-session") && response.request().method() === "POST",
  );
  await role.selectOption(persona);
  expect((await switched).ok(), "the persona switch was refused").toBe(true);
  // The select is rendered from the session, so its value is the shell agreeing.
  await expect(role).toHaveValue(persona);
}

/** Narrow triage to the one abstract this run filed; the table is a growing fixture. */
async function findInTriage(page: Page, title: string) {
  await page.goto(TRIAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Submissions" })).toBeVisible();
  await page.getByLabel("Search abstracts").fill(title);
  await expect(page.getByRole("table").first().getByRole("row", { name: title })).toBeVisible();
}

async function publishSite(page: Page) {
  await page.goto(PUBLISHING);
  await expect(page.getByRole("heading", { level: 1, name: "Publishing" })).toBeVisible();
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
}

async function setReadiness(page: Page, title: string, state: "draft" | "published") {
  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible();
  await page.getByRole("button", { name: `Edit ${title}` }).click();
  await page.getByLabel("Publication readiness").selectOption(state);
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(page.getByLabel("Publication readiness")).toHaveValue(state);
  await page.getByRole("button", { name: "Close editor" }).click();
}

test("carries one proposal from the public form to the published site", async ({ page }) => {
  const run = Date.now();
  const title = `The lifecycle of a proposal ${run}`;
  const speaker = `Robin Lifecycle ${run}`;
  const email = `robin.lifecycle.${run}@example.test`;

  // ---- 1. an applicant files it on the public site --------------------------
  await page.goto(`/events/${SLUG}/cfp`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Share your conference story" }),
  ).toBeVisible();
  await page.getByLabel("Proposal title").fill(title);
  await page
    .getByLabel("Abstract")
    .fill("How one submission crosses every boundary in the product.");
  await page.getByLabel("Your name").fill(speaker);
  await page.getByLabel("Contact email").fill(email);
  // `cfp.spec.ts` publishes an extra required question before this spec runs; the seed
  // does not ship it, so it is answered only when the live form asks for it.
  if (await page.getByLabel("Experience level").count())
    await page.getByLabel("Experience level").selectOption("Experienced");
  const filed = page.waitForResponse(
    (response) => response.url().includes("/submissions") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Submit proposal" }).click();
  expect((await filed).status()).toBe(201);
  await expect(page.getByRole("status")).toContainText(/Confirmation: [0-9a-f-]{36}/);

  // ---- 2. it reaches organizer triage, and gets a reviewer ------------------
  await becomeOrganizer(page);
  await findInTriage(page, title);
  await page.getByRole("button", { name: title, exact: true }).click();
  const detail = page.getByRole("region", { name: title });
  // The organizer sees who filed it; the reviewer never will.
  await expect(detail).toContainText(email);
  await detail.getByLabel("Assign this abstract to").selectOption({ label: "Ravi Reviewer" });
  // Exact: the panel also carries "Unassign <name> from …" once a reviewer is on it.
  await detail.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Ravi Reviewer is now reviewing" }),
  ).toBeVisible();

  // ---- 3. the reviewer scores it --------------------------------------------
  await switchRole(page, "reviewer");
  await page.goto(QUEUE);
  const queue = page.getByRole("region", { name: "Your queue" });
  await queue.getByRole("button", { name: title }).click();
  // Blind review: the queue must not carry the address the organizer just read.
  await expect(page.getByText(email)).toHaveCount(0);
  const evaluation = page.getByRole("region", { name: "Your evaluation" });
  await evaluation.getByLabel("Relevance").selectOption("3");
  await evaluation.getByLabel("Recommended format").selectOption("Talk");
  await evaluation.getByLabel("Reviewer feedback").fill("A strong fit for the audience.");
  await evaluation.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Evaluation completed" })).toBeVisible();

  // ---- 4. the organizer accepts it, and content is created ------------------
  await switchRole(page, "organizer");
  await findInTriage(page, title);
  const row = page.getByRole("table").first().getByRole("row", { name: title });
  // The score the reviewer just entered is what the organizer decides on.
  await expect(row).toContainText("3");
  await page.getByRole("button", { name: `Accept ${title}` }).click();
  const decision = page.getByRole("region", { name: "Accept this abstract" });
  await expect(decision).toContainText(`links ${speaker} (${email})`);
  await decision.getByRole("button", { name: "Confirm acceptance" }).click();
  await expect(decision.getByRole("status")).toContainText(
    `“${title}” is accepted. It is now a session in Sessions & speakers with ${speaker} linked as its speaker.`,
  );

  await page.goto(SESSIONS);
  const sessions = page.getByRole("region", { name: "Accepted sessions" });
  await expect(sessions.getByRole("row", { name: new RegExp(title) })).toContainText(speaker);
  // The speaker was provisioned from the submission, not typed by an organizer: the
  // roster names them by the address the applicant filed with.
  await page.goto(`/people?event=${DEMO_EVENT}&tab=speakers`);
  await expect(
    page
      .getByRole("region", { name: "Speakers" })
      .getByRole("row", { name: new RegExp(speaker) })
      .getByText(email),
  ).toBeVisible();
  await page.goto(SESSIONS);

  // ---- 5. it is marked ready for the public site ----------------------------
  await setReadiness(page, title, "published");

  // ---- 6. it takes a room and a time on the board ---------------------------
  await page.goto(AGENDA);
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  const card = page.getByRole("button", { name: new RegExp(`${title}\\. Not scheduled`) });
  await card.focus();
  await card.press("Enter");
  await expect(page.getByRole("status")).toContainText("Holding");
  // Pick-up lands on the first cell; the arrows walk to the free one.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const target = page.getByRole("button", { name: /Place .* in Workshop lab at 10:00–11:00/ });
  await expect(target).toBeFocused();
  await target.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    `“${title}” placed in Workshop lab at 10:00–11:00.`,
  );
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect(page.getByRole("status")).toContainText(/Published version \d+/);

  // ---- 7. and the site is published -----------------------------------------
  await publishSite(page);

  // ---- 8. a visitor finds it ------------------------------------------------
  await page.goto(`/events/${SLUG}/schedule`);
  const scheduled = page.getByRole("link", { name: title });
  await expect(scheduled).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Tuesday, September 1" }).getByText("Workshop lab"),
  ).toBeVisible();
  await scheduled.click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: speaker })).toBeVisible();

  await page.goto(`/events/${SLUG}/speakers`);
  await expect(page.getByRole("link", { name: speaker })).toBeVisible();

  // The embed serves the same artifact with none of the site's chrome.
  await page.goto(`/embed/events/${SLUG}/schedule`);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);
  await page.goto(`/embed/events/${SLUG}/speakers`);
  await expect(page.getByRole("link", { name: speaker })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Event navigation" })).toHaveCount(0);

  // ---- 9. hand the demo back ------------------------------------------------
  // Taking the session off the board and out of publication is the same chain in reverse,
  // so the withdrawal is proved on the public page too.
  await page.goto(AGENDA);
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: new RegExp(title) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect(page.getByRole("status")).toContainText(/Published version \d+/);

  await setReadiness(page, title, "draft");
  await publishSite(page);

  await page.goto(`/events/${SLUG}/schedule`);
  await expect(page.getByRole("link", { name: title })).toHaveCount(0);
  await page.goto(`/events/${SLUG}/speakers`);
  await expect(page.getByRole("link", { name: speaker })).toHaveCount(0);
  // And the seeded programme is intact behind it.
  await expect(page.getByRole("link", { name: "Jordan Bell" })).toBeVisible();
});
