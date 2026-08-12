// @acceptance ACC-REVIEW
/*
 * Deciding is not a status change, and a control must not be offered where it produces half of
 * one.
 *
 * The triage board used to carry the review domain's reserved keys in its *pipeline* dropdown, so
 * "Move selection to → Accepted" turned the pill green, raised the Accepted count and recorded no
 * decision at all: no session, no speaker, and a content domain that then refused the abstract its
 * own board showed as Accepted. These pin the shape of the fix — the pipeline offers pipeline
 * steps, the decision route takes a whole selection, and the reserved statuses cannot be removed
 * from the pipeline editor either — plus the three states the confirmation itself has to tell
 * apart, and the reviewer's queue staying where the reviewer left it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "../src/ReviewWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
const firstAssignment = "55555555-5555-4555-8555-555555555555";
const secondAssignment = "66666666-6666-4666-8666-666666666666";

type Json = Record<string, unknown>;

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

/** The pipeline an organizer configured, plus the two keys the review domain reserves. */
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
      description: "Overall strength for this event",
      minScore: 1,
      maxScore: 5,
    },
  ],
  updatedAt: "2026-08-01T09:00:00.000Z",
};

const workspace = (overrides: Json = {}) => ({
  proposals: [proposal(firstId, "Typed boundaries at scale"), proposal(secondId, "Hallway track")],
  plan: null,
  assignments: [],
  outcomes: [],
  audit: [],
  statuses,
  reviewers: [],
  decisions: [],
  ...overrides,
});

const decision = (proposalId: string, outcome: "accepted" | "declined" = "accepted") => ({
  eventId,
  proposalId,
  outcome,
  decidedBy: "seed-organizer",
  decidedAt: "2026-08-11T10:00:00.000Z",
  note: "",
});

const acceptance = (proposalId: string, overrides: Json = {}) => ({
  proposalId,
  state: "content" as const,
  sessionId,
  detail: "",
  fieldErrors: {},
  ...overrides,
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

type Sent = { url: string; method: string; body: Json };

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

const optionsOf = (select: HTMLElement) =>
  [...within(select).getAllByRole("option")].map((option) => option.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the pipeline select", () => {
  it("offers no reserved decision status, in the bulk bar or on a row", async () => {
    stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            workspace({
              proposals: [
                proposal(firstId, "Typed boundaries at scale", { status: "accepted" }),
                proposal(secondId, "Hallway track"),
              ],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(await screen.findByLabelText("Select Hallway track"));

    // Reaching `accepted` is the effect of a decision, never a destination: a transition there
    // writes a status with nothing behind it that the programme can act on.
    const bulk = screen.getByLabelText("Move selection to");
    expect(optionsOf(bulk)).toEqual(["Choose a status", "Submitted", "Under review"]);
    // Nothing is preselected, so a stray "Move" cannot send abstracts somewhere nobody chose.
    expect((bulk as HTMLSelectElement).value).toBe("");
    // Both tabs still exist — the board is allowed to *show* decided abstracts.
    expect(screen.getByRole("tab", { name: /^Accepted/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Typed boundaries at scale" }));
    const detail = screen.getByRole("region", { name: "Typed boundaries at scale" });
    const row = await screen.findByLabelText("Move this abstract to");
    expect(optionsOf(row)).toEqual(["Choose a status", "Submitted", "Under review"]);
    // This abstract's own status is `accepted`, which the select seeds from — and which is not
    // a destination, so it seeds empty and Move stays inert rather than re-sending it.
    expect((row as HTMLSelectElement).value).toBe("");
    expect(within(detail).getByRole("button", { name: "Move" })).toBeDisabled();
  });

  it("says where the two decision outcomes went", async () => {
    stubApi((url) => (url.includes("/review/organizer") ? jsonResponse(workspace()) : undefined));
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(await screen.findByLabelText("Select Typed boundaries at scale"));
    // The organizer who reached for "Accepted" here is told what to reach for instead, and it
    // is the control's own accessible description rather than prose elsewhere on the page.
    expect(screen.getByLabelText("Move selection to")).toHaveAccessibleDescription(
      /Accepted and Declined are not on this list: they are recorded with Accept or Decline/,
    );
  });
});

describe("deciding a whole selection", () => {
  const bulkApi = () => {
    let decided = false;
    return stubApi((url) => {
      if (url.includes("/review/organizer"))
        return jsonResponse(
          workspace(
            decided
              ? {
                  proposals: [
                    proposal(firstId, "Typed boundaries at scale", { status: "accepted" }),
                    proposal(secondId, "Hallway track", { status: "accepted" }),
                  ],
                  decisions: [decision(firstId), decision(secondId)],
                }
              : {},
          ),
        );
      if (url.endsWith("/review/decisions")) {
        decided = true;
        return jsonResponse(
          {
            proposals: [],
            decisions: [decision(firstId), decision(secondId)],
            acceptances: [acceptance(firstId), acceptance(secondId)],
          },
          201,
        );
      }
      return undefined;
    });
  };

  it("accepts every selected abstract through the decision route in one request", async () => {
    const sent = bulkApi();
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(await screen.findByLabelText("Select Typed boundaries at scale"));
    fireEvent.click(screen.getByLabelText("Select Hallway track"));
    fireEvent.click(screen.getByRole("button", { name: "Accept selection" }));

    // The confirmation names every abstract in the set before anything is posted.
    expect(await screen.findByRole("heading", { name: "Accept these abstracts" })).toBeVisible();
    const listed = screen.getByRole("list", { name: "" }).textContent ?? "";
    expect(listed).toContain("Typed boundaries at scale");
    expect(listed).toContain("Hallway track");
    expect(sent).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Confirm acceptance" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // One decision request for the whole selection — never a status transition, which is what
    // "Move selection to → Accepted" used to send.
    expect(sent[0]).toMatchObject({
      url: `/api/events/${eventId}/review/decisions`,
      method: "POST",
      body: { proposalIds: [firstId, secondId], outcome: "accepted" },
    });
    expect(sent.some(({ url }) => url.includes("/review/transitions"))).toBe(false);

    const status = await screen.findByText(/2 abstracts are accepted/);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("Each is now a session in Sessions & speakers");
    // Both rows now carry the recorded outcome, not just a green status pill.
    await waitFor(() => expect(document.querySelectorAll(".decision-cell .pill")).toHaveLength(2));
  });

  it("refuses the whole selection when one abstract could never produce a speaker", async () => {
    const sent = stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            workspace({
              proposals: [
                proposal(firstId, "Typed boundaries at scale"),
                proposal(secondId, "Hallway track", {
                  submitter: null,
                  submitterName: "Applicant",
                }),
              ],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(await screen.findByLabelText("Select Typed boundaries at scale"));
    fireEvent.click(screen.getByLabelText("Select Hallway track"));
    fireEvent.click(screen.getByRole("button", { name: "Accept selection" }));

    const confirm = await screen.findByRole("button", { name: "Confirm acceptance" });
    // Half-accepting the rest is exactly the state this dialog exists to prevent, so the whole
    // selection is refused and the abstracts that cannot be accepted are named.
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription(/“Hallway track”/);
    expect(confirm).toHaveAccessibleDescription(/Clear them from the selection/);
    fireEvent.click(confirm);
    expect(sent).toHaveLength(0);
  });
});

describe("the confirmation after the decision has landed", () => {
  it("withdraws Confirm once the acceptance and its session exist", async () => {
    let decided = false;
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer"))
        return jsonResponse(
          workspace(
            decided
              ? {
                  proposals: [
                    proposal(firstId, "Typed boundaries at scale", { status: "accepted" }),
                    proposal(secondId, "Hallway track"),
                  ],
                  decisions: [decision(firstId)],
                }
              : {},
          ),
        );
      if (url.endsWith("/review/decisions")) {
        decided = true;
        return jsonResponse(
          { proposals: [], decisions: [decision(firstId)], acceptances: [acceptance(firstId)] },
          201,
        );
      }
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept Typed boundaries at scale" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm acceptance" }));

    await screen.findByText(/is accepted\. It is now a session/);
    // The question has been answered, so the dialog stops asking it. A still-enabled
    // "Confirm acceptance" under "Accept <title>?" reads as "the first click did not take",
    // and pressing it only re-posts the identical decision.
    expect(screen.queryByRole("button", { name: "Confirm acceptance" })).toBeNull();
    // The panel now states the outcome instead of asking for it, and drops the note field and
    // the "Already recorded as accepted by …" line that made the pair read as a stuck click.
    const question = document.querySelector(".decision-question") as HTMLElement;
    expect(question).toHaveTextContent("Accepted Typed boundaries at scale.");
    expect(question.textContent).not.toContain("?");
    expect(screen.queryByText(/Already recorded as accepted by/)).toBeNull();
    expect(screen.queryByLabelText("Decision note (optional)")).toBeNull();

    // The panel stays mounted so its live region survives, and dismissing it is all that is left.
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeVisible();
    expect(sent).toHaveLength(1);
    fireEvent.click(close);
    await waitFor(() =>
      expect((document.querySelector("dialog.decision-dialog") as HTMLDialogElement).open).toBe(
        false,
      ),
    );
  });
});

describe("the proposal status editor", () => {
  const renderStatuses = async (routes?: (url: string) => Promise<Response> | undefined) => {
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(workspace());
      return routes?.(url);
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    await screen.findByLabelText("Status 1 label");
    return sent;
  };

  it("offers no Remove on the two statuses the programme acts on", async () => {
    await renderStatuses();

    const rows = [...document.querySelectorAll(".status-row")].map((row) => row as HTMLElement);
    expect(rows).toHaveLength(4);
    // Removing them never worked: the server completes any saved set with them, so the row came
    // back — at the end of the pipeline, silently reordering it — under "Proposal statuses saved."
    const removable = rows
      .filter((row) => within(row).queryByRole("button", { name: "Remove" }))
      .map((row) => (within(row).getByRole("textbox") as HTMLInputElement).value);
    expect(removable).toEqual(["Submitted", "Under review"]);
    const accepted = rows[2] as HTMLElement;
    expect(within(accepted).getByRole("textbox")).toHaveValue("Accepted");
    // (The setup panel is a closed <details>, so this asserts presence rather than visibility.)
    expect(
      within(accepted).getByText(/this is the outcome the programme acts on/i),
    ).toBeInTheDocument();
    // Renaming stays available: the label is the organizer's, the key is not.
    expect(within(accepted).getByRole("textbox")).toBeEnabled();
  });

  it("says so rather than announcing an unqualified success when the server changed the set", async () => {
    const sent = await renderStatuses((url) =>
      url.endsWith("/review/statuses")
        ? // What the server stored is not what the form sent: `withReservedStatuses` completes
          // a saved set, so a 2xx alone never proved the pipeline reads the way the form does.
          jsonResponse({
            statuses: [
              { key: "submitted", label: "Submitted", sortOrder: 0 },
              { key: "under_review", label: "Under review", sortOrder: 1 },
              { key: "declined", label: "Declined", sortOrder: 2 },
              { key: "accepted", label: "Accepted", sortOrder: 3 },
            ],
          })
        : undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save statuses" }));

    await waitFor(() =>
      expect(sent.some(({ url }) => url.endsWith("/review/statuses"))).toBe(true),
    );
    const status = await screen.findByText(/Proposal statuses saved, with changes/);
    expect(status).toHaveTextContent(
      "The pipeline is now Submitted, Under review, Declined, Accepted.",
    );
  });
});

describe("the locked evaluation plan", () => {
  it("shows the rubric in force, not the criteria the organizer never saved", async () => {
    let assigned = false;
    stubApi((url) => {
      if (url.includes("/review/organizer"))
        return jsonResponse(
          workspace({
            plan,
            reviewers: [{ id: "seed-reviewer", name: "Ravi Reviewer" }],
            assignments: assigned
              ? [
                  {
                    id: firstAssignment,
                    eventId,
                    proposalId: firstId,
                    reviewerId: "seed-reviewer",
                    round: 1,
                    createdAt: "2026-08-11T09:00:00.000Z",
                  },
                ]
              : [],
          }),
        );
      if (url.endsWith("/review/assignments")) {
        assigned = true;
        return jsonResponse({ assignments: [] }, 201);
      }
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.change(await screen.findByLabelText("Criterion 1 name"), {
      target: { value: "Relevance to attendees (NOT SAVED)" },
    });

    // The first assignment lands from the triage table above, while the rubric is mid-edit.
    fireEvent.click(screen.getByRole("button", { name: "Typed boundaries at scale" }));
    fireEvent.change(await screen.findByLabelText("Assign this abstract to"), {
      target: { value: "seed-reviewer" },
    });
    fireEvent.click(
      within(screen.getByRole("region", { name: "Typed boundaries at scale" })).getByRole(
        "button",
        { name: "Assign" },
      ),
    );

    const summary = await waitFor(() => {
      const found = document.querySelector(".rubric-summary");
      if (!found) throw new Error("the rubric has not locked yet");
      return found;
    });
    // The panel says these criteria are the ones every reviewer scores against, so it must read
    // the server's plan. It used to render the editor's state — unsaved text, presented as the
    // rubric in force, with the Save button that would have applied it gone.
    expect(summary).toHaveTextContent("Audience fit");
    expect(summary).not.toHaveTextContent("NOT SAVED");
    expect(document.body.textContent).not.toContain("NOT SAVED");
    // And the discarded edit is named rather than silently dropped.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reviewers were assigned while you were editing, so your unsaved changes were not applied.",
    );
  });
});

describe("the reviewer's queue", () => {
  const queue = (completeFirst: boolean) => ({
    assignments: [
      {
        assignment: {
          id: firstAssignment,
          eventId,
          proposalId: firstId,
          reviewerId: "seed-reviewer",
          round: 1,
          createdAt: "2026-08-10T09:00:00.000Z",
        },
        proposal: proposal(firstId, "Typed boundaries at scale", {
          submitter: null,
          submitterName: "Applicant",
        }),
        plan,
        conflict: null,
        evaluation: completeFirst
          ? {
              assignmentId: firstAssignment,
              reviewerId: "seed-reviewer",
              scores: [{ criterionId: "relevance", score: 4 }],
              notes: "",
              state: "completed" as const,
              updatedAt: "2026-08-11T10:00:00.000Z",
              completedAt: "2026-08-11T10:00:00.000Z",
            }
          : null,
      },
      {
        assignment: {
          id: secondAssignment,
          eventId,
          proposalId: secondId,
          reviewerId: "seed-reviewer",
          round: 1,
          createdAt: "2026-08-10T09:05:00.000Z",
        },
        proposal: proposal(secondId, "Hallway track", {
          submitter: null,
          submitterName: "Applicant",
        }),
        plan,
        conflict: null,
        evaluation: null,
      },
    ],
  });

  it("stays on the abstract that was just completed and confirms the submission", async () => {
    let completed = false;
    const sent = stubApi((url) => {
      if (url.endsWith("/review/assignments")) return jsonResponse(queue(completed));
      if (url.endsWith("/evaluation")) {
        completed = true;
        return jsonResponse({
          evaluation: {
            assignmentId: firstAssignment,
            reviewerId: "seed-reviewer",
            scores: [{ criterionId: "relevance", score: 4 }],
            notes: "",
            state: "completed",
            updatedAt: "2026-08-11T10:00:00.000Z",
            completedAt: "2026-08-11T10:00:00.000Z",
          },
        });
      }
      return undefined;
    });
    render(<ReviewerWorkspace eventId={eventId} />);

    // Nothing has been clicked in the queue: this is the abstract the workspace chose.
    expect(
      await screen.findByRole("heading", { name: "Typed boundaries at scale" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Audience fit"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete evaluation" }));

    await waitFor(() => expect(sent.some(({ url }) => url.endsWith("/evaluation"))).toBe(true));
    // The reviewer is still looking at what they scored. The selection used to be derived from
    // "the first assignment that is not finished", so completing one moved them onto a
    // different abstract with an empty form and no word about what had been submitted.
    expect(screen.getByRole("heading", { name: "Typed boundaries at scale" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hallway track" })).toBeNull();
    expect(await screen.findByText("Evaluation completed.")).toHaveAttribute("role", "status");
    expect(screen.getByText(/Evaluation submitted\./)).toBeVisible();

    // Moving on is the reviewer's choice, and it still works.
    fireEvent.click(
      within(screen.getByRole("region", { name: "Your queue" })).getByRole("button", {
        name: /Hallway track/,
      }),
    );
    expect(await screen.findByRole("heading", { name: "Hallway track" })).toBeInTheDocument();
  });
});
