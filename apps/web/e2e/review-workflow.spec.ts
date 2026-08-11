// @acceptance ACC-REVIEW
import { expect, type Page, test } from "@playwright/test";

// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({ extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.5" } });

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const WORKSHOP_EVENT = "00000000-0000-4000-8000-000000000002";
const TRIAGE = `/abstracts?event=${DEMO_EVENT}`;
const QUEUE = `/reviews?event=${DEMO_EVENT}`;
const SETUP = `/abstracts?event=${WORKSHOP_EVENT}`;

/**
 * The seeded rubric for the workshop event, restated so the configuration journey
 * starts from one exact state even when an earlier run already edited it.
 */
const BASELINE_PLAN = {
  criteria: [
    {
      id: "primary",
      name: "Audience fit",
      description: "Overall strength for this event",
      minScore: 1,
      maxScore: 5,
    },
  ],
};
/**
 * Only the configurable part of the pipeline is restated. `accepted` and `declined` are the
 * review domain's reserved decision statuses: a saved set that omits them is completed with
 * them rather than refused, so both events end this reset with those two on the end.
 */
const BASELINE_STATUSES = { statuses: [{ key: "submitted", label: "Submitted", sortOrder: 0 }] };

/** The seeded pipeline and proposal placement for the demo event, restated for the same reason. */
const HALLWAY = "10000000-0000-4000-8000-000000000001";
const TYPED = "10000000-0000-4000-8000-000000000002";
const DEMO_STATUSES = {
  statuses: [
    { key: "submitted", label: "Submitted", sortOrder: 0 },
    { key: "under_review", label: "Under review", sortOrder: 1 },
    { key: "reviewed", label: "Reviewed", sortOrder: 2 },
    { key: "withdrawn", label: "Withdrawn", sortOrder: 3 },
  ],
};

/**
 * Put the seeded pipeline back the way this file asserts it.
 *
 * Both journeys below mutate the shared fixture — one moves an abstract between statuses,
 * the other one is accepted by `speaker-portal.spec.ts` — so each starts by restating the
 * exact statuses and placements it goes on to assert.
 */
async function restoreSeededPipeline(page: Page) {
  const statusReset = await page.request.put(`/api/events/${DEMO_EVENT}/review/statuses`, {
    data: DEMO_STATUSES,
  });
  expect(statusReset.ok(), `status reset refused: ${await statusReset.text()}`).toBe(true);
  for (const [proposalId, toStatus] of [
    [TYPED, "submitted"],
    [HALLWAY, "under_review"],
  ])
    expect(
      (
        await page.request.post(`/api/events/${DEMO_EVENT}/review/transitions`, {
          data: { proposalIds: [proposalId], toStatus },
        })
      ).ok(),
    ).toBe(true);
}

async function signInAsOrganizer(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; the fixture requests below are authenticated by
  // its cookie, so wait for the signed-in shell before issuing any of them.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
}

/**
 * Switch the signed-in persona, and wait for the switch to actually land.
 *
 * `switchPersona` (apps/web/src/App.tsx) is fired from the select's change handler and
 * deliberately not awaited, so `selectOption` returns while `POST /api/demo-session` is
 * still in flight. A `page.goto` issued straight afterwards aborts that request, the next
 * document is fetched with the previous identity's cookie, and `routesFor` sends the
 * organizer off `/reviews` to the overview — where the queue this journey needs does not
 * exist. The window widens as the shared fixture grows, so it fails the second or third
 * run rather than the first. Waiting for the response is what closes it: the new session
 * cookie arrives with those headers.
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

interface PublishedField {
  id: string;
  type: "short_text" | "long_text" | "email" | "select";
  label: string;
  required: boolean;
  options: string[];
}

/**
 * File an abstract through the public call for proposals.
 *
 * Evaluation is terminal by design: a completed evaluation can never be reopened, and a
 * declared conflict locks its assignment for good. A journey that scores a *seeded*
 * abstract therefore passes exactly once per reset. Each run files its own abstracts
 * instead, so what is scored below is always something this run created.
 *
 * The answers are built from whatever the published form currently asks for rather than
 * from a fixed shape: `cfp.spec.ts` publishes an extra required question whose field id is
 * a fresh UUID on every run, so no literal key would survive.
 *
 * Setup for another domain, which is why it goes through the public API rather than the
 * browser — `cfp.spec.ts` and `00-seed-state.spec.ts` own the submission journey itself.
 */
async function fileAbstract(page: Page, title: string): Promise<string> {
  const form = await page.request.get(`/api/public/events/${DEMO_EVENT}/cfp`);
  expect(form.ok(), `reading the published form failed: ${await form.text()}`).toBe(true);
  const fields = ((await form.json()) as { cfp: { fields: PublishedField[] } }).cfp.fields;
  const email = `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}@example.test`;
  const answers: Record<string, string> = {};
  for (const field of fields) {
    if (field.id === "title") answers[field.id] = title;
    else if (field.type === "email") answers[field.id] = email;
    else if (field.type === "select") answers[field.id] = field.options[0] ?? "";
    else if (field.id === "abstract" || field.type === "long_text")
      answers[field.id] = `Filed by the review journey for ${title}.`;
    else if (field.required) answers[field.id] = `Author of ${title}`;
  }
  const submitted = await page.request.post(`/api/public/events/${DEMO_EVENT}/submissions`, {
    data: { idempotencyKey: `review-e2e-${title}`, answers },
  });
  expect(submitted.status(), `submitting ${title} failed: ${await submitted.text()}`).toBe(201);
  return email;
}

test("organizer triages abstracts, assigns a reviewer, and configures the pipeline", async ({
  page,
}) => {
  await signInAsOrganizer(page);
  await restoreSeededPipeline(page);
  await page.goto(TRIAGE);

  await expect(page.getByRole("heading", { level: 1, name: "Abstracts" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  // ---- statuses are tabs, and the counts describe the whole pipeline ----------
  const allTab = page.getByRole("tab", { name: /^All/ });
  const submittedTab = page.getByRole("tab", { name: /^Submitted/ });
  await expect(allTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /^Under review/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Withdrawn\s*0/ })).toBeVisible();

  const table = page.getByRole("table").first();
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Designing for the hallway track/ })).toBeVisible();

  // A status tab shows only that status; the counts stay visible for the others.
  await submittedTab.click();
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Designing for the hallway track/ })).toHaveCount(0);
  await allTab.click();

  // ---- search narrows the table without losing the pipeline ------------------
  await page.getByLabel("Search abstracts").fill("hallway");
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toHaveCount(0);
  await expect(page.getByText("Showing 1 of")).toBeVisible();
  await page.getByLabel("Search abstracts").fill("");
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toBeVisible();

  // ---- the detail panel shows answers under their configured labels ----------
  // Every triage row carries three controls whose accessible name contains the title — the
  // row link plus Accept and Decline — and Playwright matches names by substring, so the
  // row link has to be addressed exactly.
  await page.getByRole("button", { name: "Designing for the hallway track", exact: true }).click();
  const detail = page.getByRole("region", { name: "Designing for the hallway track" });
  // The submitted answers used to render their raw storage keys ("abstract").
  await expect(detail.getByRole("term").filter({ hasText: "Abstract" })).toBeVisible();
  await expect(detail.getByRole("term").filter({ hasText: /^abstract$/ })).toHaveCount(0);
  await expect(
    detail.getByRole("definition").filter({ hasText: "A practical guide to making" }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toHaveCount(0);

  // ---- unsaved configuration survives a triage reload ------------------------
  await page.locator("summary").filter({ hasText: "Evaluation setup" }).click();
  const statusLabel = page.getByLabel("Status 1 label");
  await expect(statusLabel).toHaveValue("Submitted");
  await statusLabel.fill("Submitted (unsaved edit)");

  // ---- a bulk transition is atomic, announced, and audited -------------------
  await page.getByLabel("Select Typed boundaries at scale").check();
  const bulk = page.getByRole("group", { name: "Actions for the selected abstracts" });
  await expect(bulk.getByText("1 selected")).toBeVisible();
  await bulk.getByLabel("Move selection to").selectOption({ label: "Under review" });
  const transitioned = page.waitForResponse(
    (response) =>
      response.url().endsWith("/review/transitions") && response.request().method() === "POST",
  );
  await bulk.getByRole("button", { name: "Move" }).click();
  expect((await transitioned).ok()).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "moved to Under review" })).toBeVisible();

  await expect(
    table.getByRole("row", { name: /Typed boundaries at scale/ }).getByText("Under review"),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /Under review\s*2/ })).toBeVisible();

  const history = page.getByRole("region", { name: "Status history" });
  await expect(
    history.getByRole("row", { name: /Typed boundaries at scale/ }).first(),
  ).toContainText("Submitted → Under review");
  await expect(
    history.getByRole("row", { name: /Typed boundaries at scale/ }).first(),
  ).toContainText("seed-organizer");

  // The reload that followed the transition used to wipe the configuration form.
  await expect(statusLabel).toHaveValue("Submitted (unsaved edit)");
  await page.getByRole("button", { name: "Discard changes" }).first().click();
  await expect(statusLabel).toHaveValue("Submitted");

  // ---- a single proposal can be assigned from its detail panel ---------------
  // Assignment is idempotent: a reviewer already reviewing this abstract is not assigned
  // twice, so a second run re-runs this step against the same seeded row.
  await page.getByRole("button", { name: "Typed boundaries at scale", exact: true }).click();
  const typed = page.getByRole("region", { name: "Typed boundaries at scale" });
  const assigned = page.waitForResponse(
    (response) =>
      response.url().endsWith("/review/assignments") && response.request().method() === "POST",
  );
  await typed.getByLabel("Assign this abstract to").selectOption({ label: "Ravi Reviewer" });
  // Exact: an abstract that already has a reviewer also carries "Unassign <name> from …".
  await typed.getByRole("button", { name: "Assign", exact: true }).click();
  expect((await assigned).ok()).toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Ravi Reviewer is now reviewing" }),
  ).toBeVisible();
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toContainText(
    "Ravi Reviewer",
  );

  // An assignment made by mistake has to be reversible: without this the rubric stays locked
  // for the life of the event and the wrong person keeps the abstract. Driven here rather than
  // only in jsdom because the control, the route and the refusal rule all shipped together.
  const removed = page.waitForResponse(
    (response) =>
      /\/review\/assignments\/[0-9a-f-]+$/.test(response.url()) &&
      response.request().method() === "DELETE",
  );
  await typed.getByRole("button", { name: /^Unassign Ravi Reviewer/ }).click();
  expect((await removed).ok()).toBe(true);
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toContainText(
    "Unassigned",
  );
  // Put it back, because the assertions below this point depend on the abstract having a
  // reviewer, and so does the next run of this spec.
  await typed.getByLabel("Assign this abstract to").selectOption({ label: "Ravi Reviewer" });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/review/assignments") && response.request().method() === "POST",
    ),
    typed.getByRole("button", { name: "Assign", exact: true }).click(),
  ]);
  await expect(table.getByRole("row", { name: /Typed boundaries at scale/ })).toContainText(
    "Ravi Reviewer",
  );

  // ---- the rubric is editable only while nothing is assigned ----------------
  // Assignments exist on the demo event, so its rubric is locked rather than
  // failing on save.
  await expect(page.getByText("Reviewers are already assigned")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save rubric" })).toHaveCount(0);

  expect(
    (
      await page.request.put(`/api/events/${WORKSHOP_EVENT}/review/plan`, { data: BASELINE_PLAN })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.put(`/api/events/${WORKSHOP_EVENT}/review/statuses`, {
        data: BASELINE_STATUSES,
      })
    ).ok(),
  ).toBe(true);
  await page.goto(SETUP);
  await page.locator("summary").filter({ hasText: "Evaluation setup" }).click();
  await expect(page.getByLabel("Criterion 1 name")).toHaveValue("Audience fit");

  await page.getByLabel("Criterion 1 name").fill("Program relevance");
  await page.getByLabel("Guidance for criterion 1").fill("Fit for this program");
  await page.getByRole("button", { name: "Add criterion" }).click();
  await page.getByLabel("Criterion 2 name").fill("Originality");
  await page.getByLabel("Guidance for criterion 2").fill("Novel contribution");
  await page.getByRole("button", { name: "Move up" }).nth(1).click();
  const planSaved = page.waitForResponse(
    (response) => response.url().endsWith("/review/plan") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save rubric" }).click();
  expect((await planSaved).ok()).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Evaluation plan saved" })).toBeVisible();

  // The saved order survives a full reload, not just the optimistic render.
  await page.reload();
  await page.locator("summary").filter({ hasText: "Evaluation setup" }).click();
  await expect(page.getByLabel("Criterion 1 name")).toHaveValue("Originality");
  await expect(page.getByLabel("Criterion 2 name")).toHaveValue("Program relevance");

  // ---- a new status joins the pipeline and its tab -------------------------
  // `accepted` and `declined` are reserved: the service completes any saved set with them,
  // so the configured pipeline is longer than what this spec wrote and the row a click on
  // "Add status" appends is addressed as the last one rather than by a fixed number.
  await page.getByRole("button", { name: "Add status" }).click();
  await page
    .getByLabel(/^Status \d+ label$/)
    .last()
    .fill("Shortlisted");
  const statusesSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/review/statuses") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save statuses" }).click();
  expect((await statusesSaved).ok()).toBe(true);
  await expect(page.getByRole("tab", { name: /Shortlisted\s*0/ })).toBeVisible();
  await page.getByLabel("Select Workshop proposal").check();
  await expect(
    page
      .getByRole("group", { name: "Actions for the selected abstracts" })
      .getByLabel("Move selection to")
      .getByRole("option", { name: "Shortlisted" }),
  ).toHaveAttribute("value", "shortlisted");
});

test("a reviewer scores and declares a conflict, and only the organizer sees the aggregate", async ({
  page,
}) => {
  const run = Date.now();
  const scored = `Reviewed abstract ${run}`;
  const conflicted = `Conflicted abstract ${run}`;

  await signInAsOrganizer(page);
  await restoreSeededPipeline(page);
  await fileAbstract(page, scored);
  await fileAbstract(page, conflicted);
  await page.goto(TRIAGE);

  const table = page.getByRole("table").first();
  // Nothing has been scored yet, so the aggregate column says so rather than showing a
  // number nobody produced.
  await expect(table.getByRole("row", { name: new RegExp(scored) })).toContainText("Not scored");

  // ---- both new abstracts go to the same reviewer --------------------------
  for (const title of [scored, conflicted]) {
    await page.getByRole("button", { name: title, exact: true }).click();
    const panel = page.getByRole("region", { name: title });
    await panel.getByLabel("Assign this abstract to").selectOption({ label: "Ravi Reviewer" });
    await panel.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Ravi Reviewer is now reviewing" }),
    ).toBeVisible();
    await expect(table.getByRole("row", { name: new RegExp(title) })).toContainText(
      "Ravi Reviewer",
    );
    await panel.getByRole("button", { name: "Close" }).click();
  }

  // ---- the reviewer scores the abstract that was just assigned -------------
  await switchRole(page, "reviewer");
  await page.goto(QUEUE);

  const queue = page.getByRole("region", { name: "Your queue" });
  await queue.getByRole("button", { name: new RegExp(scored) }).click();
  const evaluation = page.getByRole("region", { name: "Your evaluation" });
  await expect(page.getByRole("region", { name: scored })).toBeVisible();

  // Reviewers must never see aggregate outcomes before they submit.
  await expect(page.getByText(/average/i)).toHaveCount(0);
  // Nor the submitter: the queue is blind.
  await expect(page.getByText("Blind review")).toBeVisible();

  // Unscored criteria are explicit, and completing without them is refused
  // rather than silently defaulting each one to its minimum score.
  await expect(evaluation.getByText("2 of 2 criteria still need a score.")).toBeVisible();
  await evaluation.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(page.getByRole("alert")).toContainText("Relevance, Clarity");
  await expect(queue.getByRole("button", { name: new RegExp(scored) })).toContainText(
    "Not started",
  );

  // Distinct, non-default scores: the minimum on this rubric is 1, so an average of 4.5
  // is only reachable if the select actually wrote 4 and 5 into the submitted evaluation.
  await evaluation.getByLabel("Relevance").selectOption("4");
  await evaluation.getByLabel("Clarity").selectOption("5");
  await evaluation.getByLabel("Private notes").fill("Clear and relevant.");
  await evaluation.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await expect(queue.getByRole("button", { name: new RegExp(scored) })).toContainText(
    "Draft saved",
  );
  // A draft is durable without being final: a reload brings the same scores back and the
  // assignment is still open for editing.
  await page.reload();
  await queue.getByRole("button", { name: new RegExp(scored) }).click();
  await expect(evaluation.getByLabel("Relevance")).toHaveValue("4");
  await expect(evaluation.getByLabel("Clarity")).toHaveValue("5");
  await expect(evaluation.getByLabel("Private notes")).toHaveValue("Clear and relevant.");

  await evaluation.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Evaluation completed" })).toBeVisible();
  // Completion is terminal: the scoring form is replaced by the locked record.
  await expect(evaluation.getByRole("button", { name: "Complete evaluation" })).toHaveCount(0);
  await expect(evaluation.getByRole("button", { name: "Declare a conflict" })).toHaveCount(0);
  await expect(evaluation).toContainText("Scores and conflicts are now locked");
  await expect(queue.getByRole("button", { name: new RegExp(scored) })).toContainText("Completed");

  // ---- and declines the one they cannot judge ------------------------------
  await queue.getByRole("button", { name: new RegExp(conflicted) }).click();
  await expect(page.getByRole("region", { name: conflicted })).toBeVisible();
  const second = page.getByRole("region", { name: "Your evaluation" });
  await second.getByRole("button", { name: "Declare a conflict" }).click();
  await second
    .getByLabel("Why can you not review this abstract?")
    .fill("Co-authored a paper with the submitter");
  await second.getByRole("button", { name: "Confirm conflict" }).click();
  await expect(second).toContainText(
    "Conflict declared: Co-authored a paper with the submitter. This assignment can no longer be scored.",
  );
  // Declaring one locks it: the scoring form is gone, not merely hidden.
  await expect(second.getByLabel("Relevance")).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Complete evaluation" })).toHaveCount(0);
  await expect(queue.getByRole("button", { name: new RegExp(conflicted) })).toContainText(
    "Conflict declared",
  );

  // ---- the organizer, and only the organizer, sees the aggregate -----------
  await switchRole(page, "organizer");
  await page.goto(TRIAGE);
  const scoredRow = page
    .getByRole("table")
    .first()
    .getByRole("row", { name: new RegExp(scored) });
  await expect(scoredRow).toContainText("4.5");
  await expect(scoredRow).toContainText("1 completed");
  // A declared conflict is not a score.
  await expect(
    page
      .getByRole("table")
      .first()
      .getByRole("row", { name: new RegExp(conflicted) }),
  ).toContainText("Not scored");

  /*
   * ---- an abstract is only ever offered to somebody who can review it -------
   *
   * This block used to hand `scored` to a second reviewer and assert the organizer's
   * average moving from one reviewer's scores to two. That second reviewer was Olivia
   * Organizer, who holds the `reviewer` role on this event as well as `organizer` — and
   * assigning to her is now refused, because it produced work nobody could ever do: the
   * organizer console has no reviewer queue, there is no unassign control, and the click
   * permanently locked the rubric. The demo directory resolves exactly one identity per
   * persona, so with the signed-in organizer out of the list Ravi Reviewer is this event's
   * only assignable reviewer and a two-reviewer average is no longer reachable through the
   * product at all — asserting one here would be asserting a state the product forbids.
   *
   * What is asserted instead is the rule that replaced it, on both sides of the wire, plus
   * the aggregate arithmetic the old block existed to protect: the control offers exactly
   * the people who can open the queue; assigning the reviewer who already filed is
   * accepted and is idempotent rather than a second assignment that reopens their
   * evaluation; the service refuses the organizer even when the request is written by hand
   * and does not come from the list; and the average the organizer reads is still composed
   * from the completed evaluations after both.
   */
  await page.getByRole("button", { name: scored, exact: true }).click();
  const panel = page.getByRole("region", { name: scored });
  const assignTo = panel.getByLabel("Assign this abstract to");
  await expect(assignTo.getByRole("option")).toHaveText(["Choose reviewer", "Ravi Reviewer"]);

  const reassigned = page.waitForResponse(
    (response) =>
      response.url().endsWith("/review/assignments") && response.request().method() === "POST",
  );
  await assignTo.selectOption({ label: "Ravi Reviewer" });
  await panel.getByRole("button", { name: "Assign", exact: true }).click();
  expect((await reassigned).ok()).toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Ravi Reviewer is now reviewing" }),
  ).toBeVisible();

  const workspace = await page.request.get(`/api/events/${DEMO_EVENT}/review/organizer`);
  expect(workspace.ok()).toBe(true);
  const { proposals, assignments, reviewers } = (await workspace.json()) as {
    proposals: { id: string; title: string }[];
    assignments: { id: string; proposalId: string; reviewerId: string }[];
    reviewers: { id: string; name: string }[];
  };
  const proposalId = proposals.find(({ title }) => title === scored)?.id;
  expect(proposalId, "the abstract this run filed must be readable back").toBeDefined();
  // The assignment made through the UI is readable back, and repeating it added nothing.
  expect(
    assignments
      .filter((assignment) => assignment.proposalId === proposalId)
      .map(({ reviewerId }) => reviewerId),
  ).toEqual(["seed-reviewer"]);
  // The console renders the control from this list, so the omission is the product's.
  expect(reviewers.map(({ id }) => id)).not.toContain("seed-organizer");

  // ...and the omission is not the list's alone: a request that never came from it is
  // refused too, naming the field it refused rather than failing anonymously.
  const selfAssigned = await page.request.post(`/api/events/${DEMO_EVENT}/review/assignments`, {
    data: { proposalIds: [proposalId], reviewerId: "seed-organizer" },
  });
  const refusal = await selfAssigned.text();
  expect(selfAssigned.status(), `self-assignment was accepted: ${refusal}`).toBe(400);
  expect(refusal).toContain("you cannot review your own event");

  // Two scores in one completed evaluation: (4 + 5) / 2, unmoved by either request above.
  await page.reload();
  const combined = page
    .getByRole("table")
    .first()
    .getByRole("row", { name: new RegExp(scored) });
  await expect(combined).toContainText("4.5");
  await expect(combined).toContainText("1 completed");
  await expect(combined.getByText("Ravi Reviewer", { exact: true })).toBeVisible();
});
