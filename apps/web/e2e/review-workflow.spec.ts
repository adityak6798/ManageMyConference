// @acceptance ACC-REVIEW
import { expect, test } from "@playwright/test";

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

test("organizer triages abstracts and a reviewer completes an unbiased evaluation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; the fixture requests below are authenticated by
  // its cookie, so wait for the signed-in shell before issuing any of them.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();

  // The journey mutates the fixture, so it first restores the exact pipeline and
  // placement it asserts against. Completion stays terminal by design, so the
  // final scoring step still expects a freshly reset fixture.
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
  await page.getByRole("button", { name: "Designing for the hallway track" }).click();
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
  await page.getByRole("button", { name: "Typed boundaries at scale" }).click();
  const typed = page.getByRole("region", { name: "Typed boundaries at scale" });
  const assigned = page.waitForResponse(
    (response) =>
      response.url().endsWith("/review/assignments") && response.request().method() === "POST",
  );
  await typed.getByLabel("Assign this abstract to").selectOption({ label: "Ravi Reviewer" });
  await typed.getByRole("button", { name: "Assign" }).click();
  expect((await assigned).ok()).toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: "Ravi Reviewer is now reviewing" }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Add status" }).click();
  await page.getByLabel("Status 2 label").fill("Shortlisted");
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

  // ---- the reviewer scores the abstract that was just assigned -------------
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("reviewer");
  await page.goto(QUEUE);

  const queue = page.getByRole("region", { name: "Your queue" });
  await queue.getByRole("button", { name: /Typed boundaries at scale/ }).click();
  const evaluation = page.getByRole("region", { name: "Your evaluation" });
  await expect(page.getByRole("region", { name: "Typed boundaries at scale" })).toBeVisible();

  // Reviewers must never see aggregate outcomes before they submit.
  await expect(page.getByText(/average/i)).toHaveCount(0);

  // Unscored criteria are explicit, and completing without them is refused
  // rather than silently defaulting each one to its minimum score.
  await expect(evaluation.getByText("2 of 2 criteria still need a score.")).toBeVisible();
  await evaluation.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(page.getByRole("alert")).toContainText("Relevance, Clarity");
  await expect(queue.getByRole("button", { name: /Typed boundaries at scale/ })).toContainText(
    "Not started",
  );

  await evaluation.getByLabel("Relevance").selectOption("4");
  await evaluation.getByLabel("Clarity").selectOption("5");
  await evaluation.getByLabel("Private notes").fill("Clear and relevant.");
  await evaluation.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Typed boundaries at scale/ })).toContainText(
    "Draft saved",
  );

  await evaluation.getByRole("button", { name: "Complete evaluation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Evaluation completed" })).toBeVisible();
  // Completion is terminal: the scoring form is replaced by the locked record.
  await expect(evaluation.getByRole("button", { name: "Complete evaluation" })).toHaveCount(0);
  await expect(evaluation.getByRole("button", { name: "Declare a conflict" })).toHaveCount(0);
  await expect(evaluation).toContainText("Scores and conflicts are now locked");
  await expect(queue.getByRole("button", { name: /Typed boundaries at scale/ })).toContainText(
    "Completed",
  );

  // ---- the organizer, and only the organizer, sees the aggregate -----------
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("organizer");
  await page.goto(TRIAGE);
  await expect(
    page
      .getByRole("table")
      .first()
      .getByRole("row", { name: /Typed boundaries at scale/ }),
  ).toContainText("4.5");
});
