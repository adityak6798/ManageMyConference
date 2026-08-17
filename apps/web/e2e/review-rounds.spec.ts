// @acceptance ACC-REVIEW
/*
 * Review rounds in the browser: two named rounds with different terms, a pool that does not carry
 * forward, results that sort both ways, an export whose contents are read, and reminders that say
 * what happened to each reviewer.
 *
 * A separate file from `review-workflow.spec.ts` on purpose. That one owns the triage journey and
 * the reviewer's scoring form, and it mutates the shared fixture in ways this file must not care
 * about; this one owns the round model. Both restate the seeded state they assert, because the
 * fixture is shared across the whole suite.
 */
import { chooseMenuItem, chooseOption } from "./controls";
import { expect, type Page, test } from "./fixtures";

// One applicant address per spec file; see the note in `00-seed-state.spec.ts`.
test.use({ extraHTTPHeaders: { "cf-connecting-ip": "198.51.100.9" } });

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const TRIAGE = `/abstracts?event=${DEMO_EVENT}`;

/**
 * The second round's own scorecard, restated because `PUT /review/round-plans/:sequence` replaces
 * a round's terms rather than patching them — a request that omits `criteria` is a request to
 * score against the event plan, which is a real edit and not a no-op.
 */
const COMMITTEE_SCORECARD = [
  {
    id: "programme_fit",
    name: "Programme fit",
    description: "Balance across the final programme",
    type: "numeric" as const,
    minScore: 1,
    maxScore: 5,
    weight: 3,
  },
  {
    id: "delivery",
    name: "Delivery confidence",
    description: "Confidence this speaker can deliver it",
    type: "numeric" as const,
    minScore: 1,
    maxScore: 5,
    weight: 1,
  },
  {
    id: "committee_note",
    name: "Committee note",
    description: "One sentence for the record",
    type: "text" as const,
    maxLength: 500,
    weight: 1,
  },
];

async function signInAsOrganizer(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
}

/**
 * The two seeded rounds, restated.
 *
 * Every journey in this suite shares one database, and rounds are editable, so this file puts the
 * two it asserts back the way the seed writes them before reading them. Without it the second run
 * of the day is asserting whatever the first run left behind.
 */
async function restoreSeededRounds(page: Page) {
  const seeded = [
    {
      sequence: 1,
      body: {
        name: "First pass",
        opensAt: "2026-08-09T00:00:00.000Z",
        closesAt: "2027-01-31T00:00:00.000Z",
        state: "open",
        anonymized: true,
        poolMode: "named",
      },
    },
    {
      sequence: 2,
      body: {
        name: "Programme committee",
        opensAt: "2026-08-12T00:00:00.000Z",
        closesAt: "2027-02-28T00:00:00.000Z",
        state: "open",
        anonymized: false,
        poolMode: "named",
        criteria: COMMITTEE_SCORECARD,
      },
    },
  ];
  for (const { sequence, body } of seeded) {
    const saved = await page.request.put(
      `/api/events/${DEMO_EVENT}/review/round-plans/${sequence}`,
      { data: body },
    );
    expect(saved.ok(), `restoring round ${sequence} failed: ${await saved.text()}`).toBe(true);
  }
  // Ravi in the first pass, Nina in both — the arrangement that makes "absent from round 2 until
  // explicitly added" a thing the console can show.
  for (const [sequence, reviewerIds] of [
    [1, ["seed-reviewer", "review-nina-alvarez"]],
    [2, ["review-nina-alvarez"]],
  ] as const) {
    const pooled = await page.request.put(
      `/api/events/${DEMO_EVENT}/review/round-plans/${sequence}/pool`,
      { data: { reviewerIds } },
    );
    expect(pooled.ok(), `restoring pool ${sequence} failed: ${await pooled.text()}`).toBe(true);
  }
}

test("two rounds carry different dates, scorecards, blind policies and pools", async ({ page }) => {
  await signInAsOrganizer(page);
  await restoreSeededRounds(page);
  await page.goto(TRIAGE);

  const rounds = page.getByRole("region", { name: "Review rounds" });
  await expect(rounds).toBeVisible();
  const table = rounds.getByRole("table");
  const firstPass = table.getByRole("row", { name: /First pass/ });
  const committee = table.getByRole("row", { name: /Programme committee/ });

  /*
   * The acceptance criterion, read off one screen: two named rounds whose dates, scorecards,
   * blind-review settings and pools all differ, and which survive a reload because they are rows
   * rather than component state.
   */
  await expect(firstPass).toContainText("No author (blind)");
  await expect(firstPass).toContainText("The event plan");
  await expect(firstPass).toContainText("Nina Alvarez");
  await expect(firstPass).toContainText("Ravi Reviewer");
  await expect(committee).toContainText("Author and co-authors");
  await expect(committee).toContainText("Its own (3)");
  await expect(committee).not.toContainText("Ravi Reviewer");

  await page.reload();
  // Scoped to the rounds table: the progress table below names the same round, and a bare row
  // lookup matches both.
  await expect(
    page
      .getByRole("region", { name: "Review rounds" })
      .getByRole("row", { name: /Programme committee/ }),
  ).toContainText("Author and co-authors");
});

test("a reviewer in round 1 is absent from round 2 until explicitly added", async ({ page }) => {
  await signInAsOrganizer(page);
  await restoreSeededRounds(page);
  await page.goto(TRIAGE);

  const roundSelector = page.getByLabel("Working in round");
  // The console opens on the earliest open round, which is where unreviewed abstracts belong.
  // The picker is the shared listbox, so what it holds is the option's text, not an input value.
  await expect(roundSelector).toContainText("First pass");

  /*
   * Who the round would let this abstract be assigned to, read from the drawer that holds it.
   *
   * The abstract opens in a drawer now, where the eye already is — it used to be a panel inserted
   * under the table, roughly 4,000px beneath the viewport, so clicking a title appeared to do
   * nothing at all. A drawer is modal, so it is closed again before anything behind it is touched.
   */
  const assignableIn = async (): Promise<string> => {
    await page.getByRole("button", { name: "Typed boundaries at scale", exact: true }).click();
    const detail = page.getByRole("dialog", { name: "Typed boundaries at scale" });
    const offered = (await detail.getByLabel("Assign this abstract to").innerText()).trim();
    await detail.getByRole("button", { name: "Close Typed boundaries at scale" }).click();
    await expect(detail).toBeHidden();
    return offered;
  };

  expect(await assignableIn()).toContain("Ravi Reviewer");

  // Switch to the second round and Ravi is simply not offered — the pool is keyed on the round,
  // so there is nothing to inherit.
  await chooseOption(page, roundSelector, "Programme committee");
  const secondRound = await assignableIn();
  expect(secondRound).not.toContain("Ravi Reviewer");
  expect(secondRound).toContain("Nina Alvarez");

  // Adding him explicitly is what changes that, and nothing else does.
  const rounds = page.getByRole("region", { name: "Review rounds" });
  await rounds
    .getByRole("row", { name: /Programme committee/ })
    .getByRole("button", { name: /^Edit/ })
    .click();
  const editor = rounds.getByRole("group", { name: "Reviewer pool" });
  await editor.getByLabel("Ravi Reviewer").check();
  await rounds.getByRole("button", { name: "Save round" }).click();
  await expect(page.getByRole("status").filter({ hasText: "saved" }).first()).toBeVisible();
  expect(await assignableIn()).toContain("Ravi Reviewer");

  // Put the pool back, so the next journey starts where the seed leaves it.
  await restoreSeededRounds(page);
});

test("results sort both ways and export with criterion values, comments and co-authors", async ({
  page,
}) => {
  await signInAsOrganizer(page);
  await restoreSeededRounds(page);
  await page.goto(TRIAGE);

  const table = page.getByRole("table", { name: /Submitted abstracts/ });
  const titlesInOrder = async () =>
    (await table.getByRole("row").allTextContents()).slice(1).map((row) => row.trim());

  /*
   * The seed completes two abstracts under the committee's own scorecard: `(5×3 + 3×1) / 4 = 4.5`
   * and `(4×3 + 2×1) / 4 = 3.5`. Both differ from the unweighted mean of their own values — 4.0
   * and 3.0 — so a table showing 4.5 and 3.5 is a table showing that the weights were applied.
   */
  await expect(table.getByRole("row", { name: /Designing the calm conference/ })).toContainText(
    "4.5",
  );
  await expect(table.getByRole("row", { name: /Accessible by default/ })).toContainText("3.5");

  // Three orderings rather than a toggle, offered from the shared listbox.
  const order = page.getByLabel("Order");
  await chooseOption(page, order, "Highest aggregate first");
  const descending = await titlesInOrder();
  await chooseOption(page, order, "Lowest aggregate first");
  const ascending = await titlesInOrder();
  const positionOf = (rows: string[], title: string) =>
    rows.findIndex((row) => row.includes(title));
  // Both directions, which is the acceptance criterion — and the weaker of the two scored
  // abstracts leads the ascending list rather than the unscored ones, because no score is the
  // absence of a score and not a low one.
  expect(positionOf(descending, "Designing the calm conference")).toBeLessThan(
    positionOf(descending, "Accessible by default"),
  );
  expect(positionOf(ascending, "Accessible by default")).toBeLessThan(
    positionOf(ascending, "Designing the calm conference"),
  );

  // The export is *inspected*, not merely triggered: the acceptance criterion asks for a file
  // whose contents contain statuses, criterion values, aggregates and co-authors.
  const download = page.waitForEvent("download");
  // One press is "export"; the format is a choice attached to it rather than two buttons of
  // equal weight asking which file type before anybody has decided to export at all.
  await chooseMenuItem(page, "Choose an export format", "Export CSV");
  const file = await download;
  const stream = await file.createReadStream();
  const csv = (
    await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    })
  ).toString("utf8");

  const header = csv.split("\n")[0] ?? "";
  // The header is the union of every round's scorecard, so a round with its own criteria has
  // columns for them. Taken from the event plan alone, the committee's values would have been in
  // the file with nowhere to land.
  for (const column of [
    "Round name",
    "Reviewer comment",
    "Aggregate",
    "Co-authors",
    "Programme fit",
    "Delivery confidence",
    "Relevance",
  ])
    expect(header, `the export has no ${column} column`).toContain(`"${column}"`);
  /*
   * One row per assignment, so this abstract has two — its first pass and its committee round.
   * Picking "the line that mentions the title" finds the first pass and asserts nothing about the
   * round-2 aggregate, which is the one the weights produced.
   */
  const calm = csv
    .split("\n")
    .find(
      (line) =>
        line.includes("Designing the calm conference") && line.includes("Programme committee"),
    );
  expect(calm, "the export has no committee row for the calm conference").toBeDefined();
  expect(calm).toContain("4.5");
  // Its criterion values land in the committee columns rather than in the event plan's.
  expect(calm).toContain("Anchors the operations track.");
  // The reviewer's written comment travels with the row, which is what makes the file a record of
  // a review rather than a table of numbers.
  expect(csv).toContain("The strongest opener we have.");

  // And finishing is observable rather than assumed: a download the browser handles silently is
  // indistinguishable from a button that did nothing.
  await expect(
    page.getByRole("status").filter({ hasText: /Exported \d+ result rows?/ }),
  ).toBeVisible();
});

test("organizer detail shows the exact rating and comment a reviewer submitted", async ({
  page,
}) => {
  await signInAsOrganizer(page);
  await restoreSeededRounds(page);
  await page.goto(TRIAGE);

  await page.getByRole("button", { name: "Designing the calm conference", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Designing the calm conference" });
  /*
   * Issue #221: the 2026-08-14 evaluator run saw the 4.5 aggregate and the completion count here
   * and no comment at all — the numeric result exposed and the words an organizer decides on
   * withheld.
   */
  const reviews = detail.getByText("Submitted reviews").locator("..");
  await expect(reviews).toContainText("Nina Alvarez");
  await expect(reviews).toContainText("Completed");
  await expect(reviews).toContainText("Programme committee");
  // The criterion is named from the round's own scorecard, and the value is the stored one.
  await expect(reviews).toContainText("Programme fit");
  await expect(reviews).toContainText("The strongest opener we have.");
});

test("reminders reach only the outstanding, once, and report each outcome", async ({ page }) => {
  await signInAsOrganizer(page);
  await restoreSeededRounds(page);
  await page.goto(TRIAGE);

  const progress = page.getByRole("region", { name: "Reviewer progress" });
  await expect(progress).toBeVisible();
  // Progress is per round: Ravi owes one evaluation in the first pass, and Nina owes nothing.
  const ravi = progress.getByRole("row", { name: /Ravi Reviewer/ });
  await expect(ravi).toContainText("First pass");
  await expect(ravi).toContainText("Not reminded");

  await progress.getByRole("checkbox").first().check();
  await progress.getByRole("button", { name: /Send reminder to 1 reviewer/ }).click();
  await expect(progress.getByText("Reminder queued")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "1 queued" })).toBeVisible();

  /*
   * The delivery is communications', so that is where it is confirmed — review keeps no second
   * copy of somebody else's send state. One row, `reviewer.reminder`, addressed to Nina's
   * colleague rather than to a form answer.
   */
  /*
   * Paged through rather than read off the first response.
   *
   * `historyPage` orders ascending by `created_at`, so the delivery this test just queued is the
   * *newest* and therefore the last — behind however many the rest of the suite has accumulated by
   * the time this journey runs. A single first-page read passes alone and fails in the suite,
   * which is exactly the shape of flake worth not writing.
   */
  const reminderDeliveries = async () => {
    const found: { triggerType: string; recipientRef: string }[] = [];
    let cursor: string | undefined;
    for (let page_ = 0; page_ < 20; page_ += 1) {
      const response = await page.request.get(
        `/api/communications/history?eventId=${DEMO_EVENT}&organizationId=${ORGANIZATION}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.ok(), `reading delivery history failed: ${await response.text()}`).toBe(true);
      const body = (await response.json()) as {
        history: { delivery: { triggerType: string; recipientRef: string } }[];
        nextCursor?: string | null;
      };
      found.push(
        ...body.history
          .map(({ delivery }) => delivery)
          .filter(({ triggerType }) => triggerType === "reviewer.reminder"),
      );
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    return found;
  };
  const reminders = await reminderDeliveries();
  expect(reminders).toHaveLength(1);
  expect(reminders[0]?.recipientRef).toBe("reviewer@greenroom.test");

  // Pressing again queues nothing and says so, which is the difference between "sent" and "sent
  // again" that stops an organizer pressing a third time.
  await progress.getByRole("checkbox").first().check();
  await progress.getByRole("button", { name: /Send reminder to 1 reviewer/ }).click();
  await expect(progress.getByText("Already reminded")).toBeVisible();
  expect(await reminderDeliveries()).toHaveLength(1);
});

test("select-all stays reachable at 390px, where the table header is not", async ({ page }) => {
  await signInAsOrganizer(page);
  await page.goto(TRIAGE);
  await page.setViewportSize({ width: 390, height: 844 });

  /*
   * PR #219's sweep found this: the control lived in `<thead>`, and `review.css` sets
   * `.triage-table thead { display: none }` below 780px so the table can reflow into cards — so
   * selecting every abstract simply did not exist on a phone. It is in the toolbar now.
   */
  const selectAll = page.getByLabel("Select every abstract in this view");
  await expect(selectAll).toBeVisible();
  const bounds = await selectAll.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await selectAll.check();
  await expect(page.getByText(/\d+ selected/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
});
