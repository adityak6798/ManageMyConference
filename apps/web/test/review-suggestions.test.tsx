// @acceptance ACC-REVIEW
/*
 * What a reviewer can see and do with an AI-drafted suggestion.
 *
 * The rendering half of `PRD-AI-001`. A draft-only guarantee enforced perfectly in storage is
 * still broken if the screen presents a drafted number as the reviewer's own, so these assert the
 * things a reviewer reads: the provenance is on screen with the draft, the scoring form is
 * untouched until they accept, accepting fills their form without submitting it, dismissing
 * changes nothing, and a failed assistant leaves a usable form behind a plain notice.
 *
 * These stub `fetch`, so they prove the surface, never the pipeline. The server-side half is
 * `apps/api/test/review-suggestions.test.ts` and the D1 guards.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewerWorkspace } from "../src/ReviewWorkspace";

/**
 * The score a criterion is showing, read off the segmented scale.
 *
 * A bounded 1–5 scale is a row of choices the reviewer can see rather than a list to open, so
 * "what is scored" is which segment is checked — there is no input carrying a value any more.
 */
function scoreOf(criterion: string) {
  const group = screen.getByRole("radiogroup", { name: criterion });
  return (
    within(group)
      .getAllByRole("radio")
      .find((segment) => segment.getAttribute("aria-checked") === "true")?.textContent ?? null
  );
}

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const proposalId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "55555555-5555-4555-8555-555555555555";
const suggestionId = "77777777-7777-4777-8777-777777777777";

type Json = Record<string, unknown>;

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

const suggestion = (overrides: Json = {}) => ({
  id: suggestionId,
  eventId,
  assignmentId,
  reviewerId: "seed-reviewer",
  proposalId,
  round: 1,
  summary: "A talk about watermark-only stream joins.",
  scores: [{ criterionId: "relevance", value: 4, rationale: "Squarely on this audience's topic." }],
  state: "offered",
  provenance: {
    model: "fixture-suggester-v1",
    promptVersion: "review-suggestion/v1",
    generatedAt: "2026-08-11T10:00:00.000Z",
    proposalRevision: "rev-abcd1234",
  },
  respondedBy: null,
  respondedAt: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  ...overrides,
});

const queue = (overrides: Json = {}, itemOverrides: Json = {}) => ({
  suggestionsEnabled: true,
  assignments: [
    {
      assignment: {
        id: assignmentId,
        eventId,
        proposalId,
        reviewerId: "seed-reviewer",
        round: 1,
        createdAt: "2026-08-10T09:00:00.000Z",
      },
      proposal: {
        id: proposalId,
        eventId,
        title: "Typed boundaries at scale",
        abstract: "Why typed boundaries matter.",
        submitterName: "Hidden for blind review",
        submitter: null,
        answers: [],
        status: "under_review",
      },
      plan,
      conflict: null,
      evaluation: null,
      proposalRevision: "rev-abcd1234",
      suggestions: [],
      ...itemOverrides,
    },
  ],
  ...overrides,
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

type Sent = { url: string; method: string; body: Json };

function stubApi(
  routes: (url: string, init: RequestInit | undefined) => Promise<Response> | undefined,
) {
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
      return routes(url, init) ?? jsonResponse({});
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the assistant's draft", () => {
  it("renders the draft with its provenance, and scores nothing", async () => {
    stubApi((url) =>
      url.endsWith("/review/assignments")
        ? jsonResponse(queue({}, { suggestions: [suggestion()] }))
        : undefined,
    );

    render(<ReviewerWorkspace eventId={eventId} />);

    const panel = await screen.findByRole("region", { name: "Assistant's draft" });
    // Provenance is *with* the draft, not behind a disclosure: a reviewer has to know what
    // produced a number before they weigh it.
    expect(within(panel).getByText("fixture-suggester-v1")).toBeInTheDocument();
    expect(within(panel).getByText("review-suggestion/v1")).toBeInTheDocument();
    expect(within(panel).getByText("rev-abcd1234")).toBeInTheDocument();
    expect(within(panel).getByText("Not scored")).toBeInTheDocument();
    expect(within(panel).getByText("Squarely on this audience's topic.")).toBeInTheDocument();

    // And the reviewer's own form is untouched — a drafted 4 is not in the select.
    expect(scoreOf("Audience fit")).toBeNull();
    expect(screen.getByText("1 of 1 criteria still need a score.")).toBeInTheDocument();
  });

  it("says plainly when the abstract has changed since the draft was written", async () => {
    stubApi((url) =>
      url.endsWith("/review/assignments")
        ? jsonResponse(queue({}, { suggestions: [suggestion()], proposalRevision: "rev-99999999" }))
        : undefined,
    );

    render(<ReviewerWorkspace eventId={eventId} />);

    expect(await screen.findByText(/edited since the draft was written/i)).toBeInTheDocument();
  });

  it("fills the reviewer's form on accept without submitting it", async () => {
    let answered = false;
    const sent = stubApi((url) => {
      if (url.endsWith(`/suggestions/${suggestionId}/response`)) {
        answered = true;
        return jsonResponse({
          suggestion: suggestion({ state: "accepted", respondedBy: "seed-reviewer" }),
          evaluation: {
            assignmentId,
            reviewerId: "seed-reviewer",
            scores: [{ criterionId: "relevance", value: 4, score: 4 }],
            notes: "",
            state: "draft",
            updatedAt: "2026-08-11T10:05:00.000Z",
            source: "suggested",
            suggestionId,
          },
        });
      }
      if (url.endsWith("/review/assignments"))
        return jsonResponse(queue({}, { suggestions: answered ? [] : [suggestion()] }));
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept into my scores" }));

    // The accepted value lands in the reviewer's own control, where they can change it.
    await waitFor(() => expect(scoreOf("Audience fit")).toBe("4"));
    // Accepting is not completing: no evaluation was submitted, and the card still offers both.
    expect(sent.filter(({ url }) => url.endsWith("/evaluation"))).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Complete evaluation" })).toBeInTheDocument();
    expect(
      await screen.findByText(/press Complete evaluation when you agree with them/i),
    ).toBeInTheDocument();
  });

  it("leaves the summary out of the notes unless the reviewer ticks the box", async () => {
    const sent = stubApi((url) => {
      if (url.endsWith(`/suggestions/${suggestionId}/response`))
        return jsonResponse({
          suggestion: suggestion({ state: "accepted" }),
          evaluation: {
            assignmentId,
            reviewerId: "seed-reviewer",
            scores: [{ criterionId: "relevance", value: 4, score: 4 }],
            notes: "",
            state: "draft",
            updatedAt: "2026-08-11T10:05:00.000Z",
            source: "suggested",
            suggestionId,
          },
        });
      if (url.endsWith("/review/assignments"))
        return jsonResponse(queue({}, { suggestions: [suggestion()] }));
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    const box = await screen.findByLabelText(/copy the summary into my private notes/i);
    // Off by default: organizers read the notes field as the reviewer's own words.
    expect(box).not.toBeChecked();
    fireEvent.click(await screen.findByRole("button", { name: "Accept into my scores" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ response: "accepted", includeSummaryInNotes: false });
  });

  it("does not throw away notes the reviewer has typed but not saved", async () => {
    // Accepting says nothing about notes, so it must not touch them. This failed before the guard:
    // the accepted evaluation's `notes` (empty, because nothing had been saved yet) replaced what
    // the reviewer had typed, on an action about scores.
    stubApi((url) => {
      if (url.endsWith(`/suggestions/${suggestionId}/response`))
        return jsonResponse({
          suggestion: suggestion({ state: "accepted" }),
          evaluation: {
            assignmentId,
            reviewerId: "seed-reviewer",
            scores: [{ criterionId: "relevance", value: 4, score: 4 }],
            notes: "",
            state: "draft",
            updatedAt: "2026-08-11T10:05:00.000Z",
            source: "suggested",
            suggestionId,
          },
        });
      if (url.endsWith("/review/assignments"))
        return jsonResponse(queue({}, { suggestions: [suggestion()] }));
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    const notes = await screen.findByLabelText("Private notes");
    fireEvent.change(notes, { target: { value: "Halfway through my own note" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept into my scores" }));

    await waitFor(() => expect(scoreOf("Audience fit")).toBe("4"));
    expect(screen.getByLabelText("Private notes")).toHaveValue("Halfway through my own note");
  });

  it("appends the summary to what the reviewer has typed, rather than replacing it", async () => {
    // The checked branch had the same defect as the unchecked one, one layer down: the server
    // composes the summary onto the notes *it* has stored, and handing that back replaced
    // anything typed since. The summary is appended to what is actually on screen instead.
    const sent = stubApi((url) => {
      if (url.endsWith(`/suggestions/${suggestionId}/response`))
        return jsonResponse({
          suggestion: suggestion({ state: "accepted" }),
          evaluation: {
            assignmentId,
            reviewerId: "seed-reviewer",
            scores: [{ criterionId: "relevance", value: 4, score: 4 }],
            // What the server stored: its own (empty) copy plus the summary. Not what the
            // reviewer is looking at.
            notes: "A talk about watermark-only stream joins.",
            state: "draft",
            updatedAt: "2026-08-11T10:05:00.000Z",
            source: "suggested",
            suggestionId,
          },
        });
      if (url.endsWith("/review/assignments"))
        return jsonResponse(queue({}, { suggestions: [suggestion()] }));
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    const notes = await screen.findByLabelText("Private notes");
    fireEvent.change(notes, { target: { value: "My own half-written note" } });
    fireEvent.click(screen.getByLabelText(/copy the summary into my private notes/i));
    fireEvent.click(screen.getByRole("button", { name: "Accept into my scores" }));

    await waitFor(() => expect(scoreOf("Audience fit")).toBe("4"));
    expect(screen.getByLabelText("Private notes")).toHaveValue(
      "My own half-written note\n\nA talk about watermark-only stream joins.",
    );
    expect(sent[0]?.body).toMatchObject({ includeSummaryInNotes: true });
  });

  it("says what a dismissal does and does not record", async () => {
    let answered = false;
    stubApi((url) => {
      if (url.endsWith(`/suggestions/${suggestionId}/response`)) {
        answered = true;
        return jsonResponse({
          suggestion: suggestion({ state: "rejected", respondedBy: "seed-reviewer" }),
          evaluation: null,
        });
      }
      if (url.endsWith("/review/assignments"))
        return jsonResponse(queue({}, { suggestions: answered ? [] : [suggestion()] }));
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    // "Nothing was recorded" contradicted the audit row a dismissal deliberately keeps.
    expect(await screen.findByText(/No evaluation was recorded/i)).toBeInTheDocument();
    expect(await screen.findByText(/kept as an audit record/i)).toBeInTheDocument();
  });

  it("dismisses a draft without touching the form", async () => {
    let answered = false;
    const sent = stubApi((url) => {
      if (url.endsWith(`/suggestions/${suggestionId}/response`)) {
        answered = true;
        return jsonResponse({
          suggestion: suggestion({ state: "rejected", respondedBy: "seed-reviewer" }),
          evaluation: null,
        });
      }
      if (url.endsWith("/review/assignments"))
        return jsonResponse(queue({}, { suggestions: answered ? [] : [suggestion()] }));
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText(/No evaluation was recorded/i)).toBeInTheDocument();
    expect(sent[0]?.body).toMatchObject({ response: "rejected" });
    expect(scoreOf("Audience fit")).toBeNull();
  });

  it("leaves a usable scoring form when the assistant is unavailable", async () => {
    stubApi((url) => {
      if (url.endsWith("/suggestions"))
        return jsonResponse(
          {
            error: {
              code: "UPSTREAM_UNAVAILABLE",
              message: "The review assistant could not draft a suggestion.",
              correlationId: "correlation-1",
              fieldErrors: { suggestion: ["PROVIDER_TIMEOUT"] },
            },
          },
          502,
        );
      if (url.endsWith("/review/assignments")) return jsonResponse(queue());
      return undefined;
    });

    render(<ReviewerWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Draft with the review assistant" }));

    // The normalized code becomes a sentence about what to do, not a stack trace and not a
    // paraphrase of the provider.
    expect(await screen.findByText(/did not answer in time/i)).toBeInTheDocument();
    expect(await screen.findByText(/still score this yourself/i)).toBeInTheDocument();
    // The manual path is intact, which is the whole point of the degradation.
    expect(
      within(screen.getByRole("radiogroup", { name: "Audience fit" })).getByRole("radio", {
        name: "3",
      }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Complete evaluation" })).toBeEnabled();
  });

  it("offers no assistant at all when the deployment has switched it off", async () => {
    stubApi((url) =>
      url.endsWith("/review/assignments")
        ? jsonResponse(queue({ suggestionsEnabled: false }))
        : undefined,
    );

    render(<ReviewerWorkspace eventId={eventId} />);

    // Not a disabled button with an explanation — the control is absent, so the surface is what
    // it was before this feature existed.
    expect(await screen.findByLabelText("Audience fit")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Draft with the review assistant" }),
    ).not.toBeInTheDocument();
  });

  it("offers no draft control on an assignment the reviewer has recused themselves from", async () => {
    stubApi((url) =>
      url.endsWith("/review/assignments")
        ? jsonResponse(
            queue(
              {},
              {
                conflict: {
                  assignmentId,
                  reviewerId: "seed-reviewer",
                  reason: "Former colleague",
                  declaredAt: "2026-08-11T09:00:00.000Z",
                },
              },
            ),
          )
        : undefined,
    );

    render(<ReviewerWorkspace eventId={eventId} />);

    expect(await screen.findByText(/This assignment can no longer be scored/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Draft with the review assistant" }),
    ).not.toBeInTheDocument();
  });
});
