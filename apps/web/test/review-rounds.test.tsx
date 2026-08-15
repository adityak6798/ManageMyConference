// @acceptance ACC-REVIEW
/*
 * The organizer's rounds console, the reminder controls, and the submitted reviews on the detail.
 *
 * These pin the half a service test cannot: which round the console is actually working in, that a
 * capability the database has had since `1300` is now reachable from a control, that a refusal
 * arrives as a sentence rather than as a disabled button, and that the exact rating and written
 * comment a reviewer submitted appear where an organizer decides (`#221`).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "../src/ReviewWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const raviAssignment = "55555555-5555-4555-8555-555555555555";
const ninaAssignment = "66666666-6666-4666-8666-666666666666";
const RAVI = "seed-reviewer";
const NINA = "review-nina-alvarez";

type Json = Record<string, unknown>;
type Sent = { url: string; method: string; body: Json };

const proposal = (id: string, title: string, overrides: Json = {}) => ({
  id,
  eventId,
  title,
  abstract: `Why ${title} matters.`,
  submitterName: "Alex Morgan",
  submitter: { name: "Alex Morgan", email: `${id}@example.test` },
  answers: [
    { fieldId: "abstract", label: "Abstract", type: "long_text" as const, value: "An abstract." },
  ],
  status: "submitted",
  ...overrides,
});

const statuses = [
  { key: "submitted", label: "Submitted", sortOrder: 0 },
  { key: "under_review", label: "Under review", sortOrder: 1 },
  { key: "accepted", label: "Accepted", sortOrder: 2 },
  { key: "declined", label: "Declined", sortOrder: 3 },
];

const plan = {
  eventId,
  criteria: [
    {
      id: "relevance",
      name: "Audience fit",
      description: "Overall strength",
      minScore: 1,
      maxScore: 5,
      weight: 2,
    },
  ],
  updatedAt: "2026-08-01T09:00:00.000Z",
};

const committeeCriteria = [
  {
    id: "programme_fit",
    name: "Programme fit",
    description: "Balance across the programme",
    minScore: 1,
    maxScore: 5,
    weight: 3,
  },
];

const round = (overrides: Json = {}) => ({
  eventId,
  sequence: 1,
  name: "First pass",
  opensAt: null,
  closesAt: null,
  state: "open",
  anonymized: true,
  criteria: null,
  poolMode: "named",
  reviewerIds: [RAVI],
  createdAt: "2026-08-09T09:00:00.000Z",
  updatedAt: "2026-08-09T09:00:00.000Z",
  ...overrides,
});

const workspace = (overrides: Json = {}) => ({
  proposals: [proposal(firstId, "Typed boundaries at scale"), proposal(secondId, "Hallway track")],
  plan,
  assignments: [],
  outcomes: [],
  evaluations: [],
  audit: [],
  statuses,
  reviewers: [
    { id: RAVI, name: "Ravi Reviewer" },
    { id: NINA, name: "Nina Alvarez" },
  ],
  reviewerDirectory: [
    { id: RAVI, name: "Ravi Reviewer" },
    { id: NINA, name: "Nina Alvarez" },
  ],
  decisions: [],
  progress: [],
  rounds: [round()],
  roundProgress: [],
  ...overrides,
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function stubApi(routes: (url: string, sent: Sent[]) => Promise<Response> | undefined) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET")
        sent.push({
          url,
          method: init.method,
          body: init.body ? (JSON.parse(String(init.body)) as Json) : {},
        });
      return routes(url, sent) ?? jsonResponse({});
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the round the console is working in", () => {
  it("recomputes an edited filter definition before saving the rest of the round", async () => {
    const updatedFilters = [{ field: "track", values: ["Platform", "Practice"] }];
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(workspace());
      if (url.endsWith("/round-plans/1/recompute"))
        return jsonResponse({ round: round({ filters: updatedFilters, filterVersion: 2 }) });
      if (url.endsWith("/round-plans/1"))
        return jsonResponse({ round: round({ filters: updatedFilters, filterVersion: 2 }) });
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit First pass" }));
    fireEvent.change(screen.getByLabelText("Filters"), {
      target: { value: "track=Platform, Practice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save round" }));

    await waitFor(() => expect(sent.some(({ url }) => url.endsWith("/round-plans/1"))).toBe(true));
    const writes = sent.filter(({ url }) => url.includes("/round-plans/1"));
    expect(writes.map(({ url }) => url)).toEqual([
      `/api/events/${eventId}/review/round-plans/1/recompute`,
      `/api/events/${eventId}/review/round-plans/1`,
    ]);
    expect(writes[0]?.body).toEqual({ filters: updatedFilters });
    expect(writes[1]?.body).toMatchObject({ filters: updatedFilters });
  });

  it("assigns and distributes into the chosen round, with the cap the organizer set", async () => {
    const sent = stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            workspace({
              rounds: [
                round(),
                round({
                  sequence: 2,
                  name: "Programme committee",
                  anonymized: false,
                  criteria: committeeCriteria,
                  reviewerIds: [NINA],
                }),
              ],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    // The default is the earliest open round: triage is where abstracts nobody has looked at yet
    // are handled, and those belong at the start of the process.
    const selector = await screen.findByLabelText("Working in round");
    expect(selector).toHaveValue("1");
    // Only that round's pool is offered, because a name the round does not admit is an assignment
    // the organizer would be refused for.
    fireEvent.click(screen.getByRole("button", { name: "Typed boundaries at scale" }));
    const panel = screen.getByRole("region", { name: "Typed boundaries at scale" });
    expect(
      within(panel.querySelector("select[id$='reviewer']") ?? panel)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).not.toContain("Nina Alvarez");

    // Switching rounds switches the pool, the policy summary, and where work lands.
    fireEvent.change(selector, { target: { value: "2" } });
    expect(screen.getByText(/Open review · its own scorecard/)).toBeVisible();

    fireEvent.change(screen.getByLabelText("Max abstracts per reviewer"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByLabelText("Select every abstract in this view"));
    fireEvent.click(screen.getByRole("button", { name: "Distribute selection" }));

    await waitFor(() =>
      expect(sent.some(({ url }) => url.endsWith("/assignments/distribute"))).toBe(true),
    );
    const distribution = sent.find(({ url }) => url.endsWith("/assignments/distribute"));
    /*
     * Three things this request now carries that it never used to.
     *
     * `round` — the console assigned into round 1 implicitly and had no way to say otherwise.
     * `maxAssignmentsPerReviewer` — the cap an organizer typed, rather than the hard-coded 20 that
     * made `review_assignment_caps` and its trigger unreachable since `1300`. And `reviewerIds`
     * scoped to the round's pool rather than the whole event directory.
     */
    expect(distribution?.body).toMatchObject({
      round: 2,
      maxAssignmentsPerReviewer: 3,
      reviewerIds: [NINA],
    });
  });

  it("says why a round takes no work, instead of a control that will not press", async () => {
    stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            workspace({
              rounds: [round({ state: "draft", name: "Not started yet" })],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    // A draft round is a state an organizer can fix, and the notice names it and where to fix it.
    expect(
      await screen.findByText(/“Not started yet” is still a draft, so it takes no new assignments/),
    ).toBeVisible();
  });

  it("explains Start next round rather than disabling it silently", async () => {
    stubApi((url) => (url.includes("/review/organizer") ? jsonResponse(workspace()) : undefined));
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    const advance = await screen.findByRole("button", { name: "Start next round" });
    /*
     * PR #219's sweep found this control disabled on three conditions with none of them stated —
     * the fifth recorded instance of a capability that exists, is reachable in principle, and is
     * withheld by a condition nobody names. It is pressable now, and answers.
     */
    expect(advance).toBeEnabled();
    expect(screen.getByText(/Start next round: Choose one status tab first/)).toBeVisible();
    fireEvent.click(advance);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose one status tab first");
  });

  it("orders by aggregate in both directions, and sinks the unscored either way", async () => {
    stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            workspace({
              outcomes: [
                {
                  eventId,
                  proposalId: firstId,
                  round: 1,
                  completedEvaluationCount: 1,
                  averageScore: 4.5,
                  updatedAt: "2026-08-12T09:00:00.000Z",
                },
              ],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    const order = await screen.findByLabelText("Order");
    // The rounds console renders a table of its own, so the triage table is named rather than
    // taken as "the" table.
    const titles = () =>
      within(screen.getByRole("table", { name: /abstract/i }))
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector(".cell-link")?.textContent);

    fireEvent.change(order, { target: { value: "score-desc" } });
    expect(titles()).toEqual(["Typed boundaries at scale", "Hallway track"]);
    fireEvent.change(order, { target: { value: "score-asc" } });
    /*
     * The scored abstract still leads, and that is the assertion worth having.
     *
     * The obvious ascending implementation treats "not scored" as `-Infinity`, which puts every
     * abstract nobody has reviewed above the genuinely weakest ones — the opposite of what an
     * organizer sorting upwards is looking for. No score is the absence of one, not a low one.
     */
    expect(titles()).toEqual(["Typed boundaries at scale", "Hallway track"]);
  });
});

describe("reviewer progress and reminders", () => {
  const withOutstanding = () =>
    workspace({
      assignments: [
        {
          id: raviAssignment,
          eventId,
          proposalId: firstId,
          reviewerId: RAVI,
          round: 1,
          createdAt: "2026-08-11T09:00:00.000Z",
        },
      ],
      roundProgress: [
        { round: 1, reviewerId: RAVI, assigned: 3, completed: 1, outstanding: 2 },
        { round: 1, reviewerId: NINA, assigned: 2, completed: 2, outstanding: 0 },
      ],
    });

  it("shows counts per round and sends a reminder only to the outstanding", async () => {
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(withOutstanding());
      if (url.endsWith("/review/reminders"))
        return jsonResponse({
          reminders: [{ reviewerId: RAVI, outstanding: 2, state: "queued" }],
        });
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    const progress = await screen.findByRole("region", { name: "Reviewer progress" });
    const raviRow = within(progress)
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("Ravi Reviewer"));
    expect(raviRow?.textContent).toContain("First pass");
    expect(raviRow?.textContent).toContain("2");

    // The picker offers only reviewers with work still open in the round: reminding somebody who
    // has finished is a message telling them to do work they have already done.
    const picks = within(progress).getAllByRole("checkbox");
    expect(picks).toHaveLength(1);
    fireEvent.click(picks[0] as HTMLElement);
    fireEvent.click(within(progress).getByRole("button", { name: /Send reminder to 1 reviewer/ }));

    await waitFor(() => expect(sent.some(({ url }) => url.endsWith("/reminders"))).toBe(true));
    expect(sent.find(({ url }) => url.endsWith("/reminders"))?.body).toEqual({
      round: 1,
      reviewerIds: [RAVI],
    });
    expect(await within(progress).findByText("Reminder queued")).toBeVisible();
  });

  it("keeps reminder outcomes isolated by round when the same reviewer appears in both", async () => {
    const twoRounds = workspace({
      rounds: [round(), round({ sequence: 2, name: "Programme committee" })],
      roundProgress: [
        { round: 1, reviewerId: RAVI, assigned: 3, completed: 1, outstanding: 2 },
        { round: 2, reviewerId: RAVI, assigned: 1, completed: 0, outstanding: 1 },
      ],
    });
    stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(twoRounds);
      if (url.endsWith("/review/reminders"))
        return jsonResponse({
          reminders: [{ reviewerId: RAVI, outstanding: 2, state: "queued" }],
        });
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    const progress = await screen.findByRole("region", { name: "Reviewer progress" });
    const roundPicker = within(progress).getByLabelText("Round");
    fireEvent.click(within(progress).getByRole("button", { name: "Remind everyone outstanding" }));
    expect(await within(progress).findByText("Reminder queued")).toBeVisible();

    fireEvent.change(roundPicker, { target: { value: "2" } });
    expect(within(progress).queryByText("Reminder queued")).not.toBeInTheDocument();
    expect(
      within(progress)
        .getAllByRole("row")
        .find((row) => row.textContent?.includes("Programme committee")),
    ).toHaveTextContent("Not reminded");

    fireEvent.change(roundPicker, { target: { value: "1" } });
    expect(within(progress).getByText("Reminder queued")).toBeVisible();
  });

  it("names each outcome rather than reporting a count of messages that may not exist", async () => {
    stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(withOutstanding());
      if (url.endsWith("/review/reminders"))
        return jsonResponse({
          reminders: [{ reviewerId: RAVI, outstanding: 2, state: "unaddressable" }],
        });
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    const progress = await screen.findByRole("region", { name: "Reviewer progress" });
    fireEvent.click(within(progress).getByRole("button", { name: "Remind everyone outstanding" }));
    /*
     * A reviewer with no linked address is a real state and the organizer's repair is to fix the
     * address. Reporting it as "1 reminder sent" is how somebody comes to believe a message exists
     * that does not, so the outcome is named and the announcement is an error rather than a
     * success.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent("1 with no email on file");
    expect(await within(progress).findByText("No email on file")).toBeVisible();
  });
});

describe("what the reviewers said", () => {
  const reviewed = () =>
    workspace({
      assignments: [
        {
          id: raviAssignment,
          eventId,
          proposalId: firstId,
          reviewerId: RAVI,
          round: 1,
          createdAt: "2026-08-11T09:00:00.000Z",
        },
        {
          id: ninaAssignment,
          eventId,
          proposalId: firstId,
          reviewerId: NINA,
          round: 1,
          createdAt: "2026-08-11T09:05:00.000Z",
        },
      ],
      evaluations: [
        {
          assignmentId: raviAssignment,
          reviewerId: RAVI,
          scores: [{ criterionId: "relevance", value: 4, score: 4 }],
          notes: "A genuinely useful session for this audience.",
          state: "completed",
          updatedAt: "2026-08-12T09:00:00.000Z",
          completedAt: "2026-08-12T09:00:00.000Z",
        },
        {
          assignmentId: ninaAssignment,
          reviewerId: NINA,
          scores: [{ criterionId: "relevance", value: 2, score: 2 }],
          notes: "Still forming a view on this one.",
          state: "draft",
          updatedAt: "2026-08-12T09:30:00.000Z",
        },
      ],
    });

  it("shows the exact rating and written comment on the proposal detail", async () => {
    stubApi((url) => (url.includes("/review/organizer") ? jsonResponse(reviewed()) : undefined));
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Typed boundaries at scale" }));
    const detail = await screen.findByRole("region", { name: "Typed boundaries at scale" });

    /*
     * The defect the 2026-08-14 evaluator run recorded as CFP-11 partial: the aggregate and the
     * completion count were shown and the comment was not — the numeric result exposed, the words
     * an organizer decides on withheld.
     */
    expect(within(detail).getByText("A genuinely useful session for this audience.")).toBeVisible();
    // Attributed, and read off the review itself rather than off the assign-to select beside it.
    expect(within(detail).getByText("Ravi Reviewer", { selector: "strong" })).toBeVisible();
    expect(within(detail).getByText("Completed")).toBeVisible();
    // The criterion name comes from the round's rubric, so a value is labelled with the name it
    // was recorded under, and the value itself is the stored one rather than a re-derived score.
    expect(within(detail).getByText("Audience fit")).toBeVisible();
    expect(within(detail).getByText("4")).toBeVisible();

    // A draft is a reviewer's unfinished thinking, and the same person can still change it.
    // Publishing it to an organizer would misreport an opinion nobody has finished forming.
    expect(within(detail).queryByText("Still forming a view on this one.")).toBeNull();
    expect(within(detail).queryByText("Nina Alvarez", { selector: "strong" })).toBeNull();
  });

  it("says so plainly when nobody has finished reviewing yet", async () => {
    stubApi((url) => (url.includes("/review/organizer") ? jsonResponse(workspace()) : undefined));
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Typed boundaries at scale" }));
    const detail = await screen.findByRole("region", { name: "Typed boundaries at scale" });
    expect(
      within(detail).getByText("No reviewer has completed an evaluation of this abstract yet."),
    ).toBeVisible();
  });
});

describe("the reviewer's side of a round", () => {
  const queueItem = (overrides: Json = {}) => ({
    assignment: {
      id: raviAssignment,
      eventId,
      proposalId: firstId,
      reviewerId: RAVI,
      round: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
    },
    proposal: {
      ...proposal(firstId, "Typed boundaries at scale"),
      submitterName: "Hidden for blind review",
      submitter: null,
      coAuthors: [],
    },
    plan,
    conflict: null,
    evaluation: null,
    suggestions: [],
    round: round(),
    roundClosedReason: null,
    ...overrides,
  });

  it("names the round's blind policy, and shows authors when the round is open review", async () => {
    stubApi((url) =>
      url.includes("/review/assignments")
        ? jsonResponse({
            assignments: [
              queueItem({
                proposal: {
                  ...proposal(firstId, "Typed boundaries at scale"),
                  coAuthors: [{ name: "Avery Chen", role: "Co-presenter" }],
                },
                round: round({ sequence: 2, name: "Programme committee", anonymized: false }),
              }),
            ],
            suggestionsEnabled: false,
          })
        : undefined,
    );
    render(<ReviewerWorkspace eventId={eventId} />);
    // The hint *names the author*, which is the point of turning blind review off. It used to say
    // "Authors and co-authors are shown" and then show only the co-authors — the name was on the
    // wire and rendered nowhere, so the setting bought the exposure without the benefit.
    expect(
      await screen.findByText(/Programme committee — open review. Submitted by Alex Morgan./),
    ).toBeVisible();
    expect(screen.getByText(/Avery Chen — Co-presenter/)).toBeVisible();
  });

  it("makes a closed round view-only before the reviewer types, not after they save", async () => {
    stubApi((url) =>
      url.includes("/review/assignments")
        ? jsonResponse({
            assignments: [
              queueItem({
                round: round({ state: "closed" }),
                roundClosedReason:
                  "“First pass” is closed. Its assignments, evaluations and results stay readable, but no new work can be recorded in it.",
              }),
            ],
            suggestionsEnabled: true,
          })
        : undefined,
    );
    render(<ReviewerWorkspace eventId={eventId} />);
    expect(await screen.findAllByText(/“First pass” is closed/)).not.toHaveLength(0);
    // The refusal arrives as a statement rather than as a rejected save, and the assistant is not
    // offered either — there is no point drafting into a round that will not take the result.
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Complete evaluation" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Declare a conflict" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Draft with the review assistant/ })).toBeNull();
  });
});
