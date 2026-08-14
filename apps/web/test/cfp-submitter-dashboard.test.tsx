// @acceptance ACC-CFP
/*
 * The applicant's dashboard, and the three writes behind it.
 *
 * These are jsdom tests because each one turns on *what the page sends* and in what order: which
 * revision a save names back, whether a submit of a never-saved proposal creates one first, and
 * whether a refused write leaves the answers on screen. A browser assertion on visible text passes
 * happily while any of those is wrong, and the cost of being wrong is somebody's proposal.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicCfpView } from "../src/public-event/PublicCfpView";

const eventId = "00000000-0000-4000-8000-000000000001";
const LA = "America/Los_Angeles";
const proposalsPath = `/api/events/${eventId}/cfp/proposals`;

const liveCfp = {
  eventId,
  title: "Share what you learned",
  description: "Submit a practical session.",
  fields: [
    {
      id: "title",
      type: "short_text" as const,
      label: "Proposal title",
      guidance: "",
      required: true,
      options: [],
    },
  ],
  routing: [],
  status: "open" as const,
  version: 3,
  publishedAt: "2026-08-01T12:00:00.000Z",
  publishedStatus: "open" as const,
  opensAt: null,
  closesAt: null,
  effectiveStatus: "open" as const,
};

const session = {
  actor: { id: "user-pat", name: "Pat Attendee", persona: "public" },
  organizations: [],
  eventAccess: [],
  capabilities: [],
  authentication: "session",
};

const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: "50000000-0000-4000-8000-000000000001",
  eventId,
  lifecycle: "draft",
  state: "draft",
  title: "Half an idea",
  answers: { title: "Half an idea" },
  revision: 1,
  updatedAt: "2026-08-10T12:00:00.000Z",
  submittedAt: null,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Call = { url: string; method: string; body: Record<string, unknown> };

/**
 * A signed-in applicant, with the dashboard answering `proposals` and every write routed by the
 * caller. Records the writes so a test can assert the request rather than the rendering.
 */
function mount(
  options: {
    proposals?: readonly Record<string, unknown>[];
    status?: "open" | "closed";
    write?: (url: string, init: RequestInit) => Promise<Response> | undefined;
  } = {},
) {
  const calls: Call[] = [];
  let listed = options.proposals ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method)
        calls.push({
          url,
          method: init.method,
          body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
      if (url === "/api/session") return jsonResponse(session);
      if (url === "/api/auth/config") return jsonResponse({ demoMode: true, google: false });
      if (init?.method) {
        const answered = options.write?.(url, init);
        if (answered) return answered;
      }
      if (url === proposalsPath) return jsonResponse({ proposals: listed });
      return jsonResponse({ error: {} }, 404);
    }),
  );
  const status = options.status ?? "open";
  render(
    <PublicCfpView
      eventId={eventId}
      liveCfp={{ ...liveCfp, effectiveStatus: status } as never}
      unavailable={null}
      status={status}
      statusLine={status === "open" ? "Open for submissions." : "Submissions closed."}
      title={liveCfp.title}
      description={liveCfp.description}
      timezone={LA}
      eventStartsOn="2026-09-15"
    />,
  );
  return {
    calls,
    /** Change what the dashboard answers next, so a write's refresh can be observed. */
    setProposals(next: readonly Record<string, unknown>[]) {
      listed = next;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the signed-in applicant's proposals", () => {
  it("lists nothing as an invitation rather than as an error", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Your proposals" })).toBeVisible();
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    // Signing in is not offered again to somebody already signed in.
    expect(screen.queryByRole("heading", { name: "Keep track of your proposal" })).toBeNull();
    // And the control a draft needs is offered, because now there is an owner for one.
    expect(screen.getByRole("button", { name: "Save draft" })).toBeVisible();
  });

  it("saves a draft by creating one, then names its revision back on the next save", async () => {
    const created = proposal();
    const revised = proposal({
      revision: 2,
      title: "A whole idea",
      answers: { title: "A whole idea" },
    });
    const harness = mount({
      write: (url, init) => {
        if (url === proposalsPath && init.method === "POST")
          return jsonResponse({ proposal: created }, 201);
        if (url === `${proposalsPath}/${created.id}` && init.method === "PUT")
          return jsonResponse({ proposal: revised });
        return undefined;
      },
    });
    await screen.findByRole("heading", { name: "Your proposals" });

    fireEvent.change(screen.getByLabelText(/Proposal title/), {
      target: { value: "Half an idea" },
    });
    harness.setProposals([created]);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/You can come back to this proposal any time/);

    fireEvent.change(screen.getByLabelText(/Proposal title/), {
      target: { value: "A whole idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(harness.calls).toHaveLength(2));

    // The second save is an update naming the revision the first one returned — not a second
    // create, which would leave two half-written proposals on the dashboard.
    expect(harness.calls[0]).toMatchObject({
      url: proposalsPath,
      method: "POST",
      body: { answers: { title: "Half an idea" } },
    });
    expect(harness.calls[1]).toMatchObject({
      url: `${proposalsPath}/${created.id}`,
      method: "PUT",
      body: { answers: { title: "A whole idea" }, expectedRevision: 1 },
    });
  });

  it("submits a proposal it has never saved by creating it first", async () => {
    const created = proposal();
    const harness = mount({
      write: (url, init) => {
        if (url === proposalsPath && init.method === "POST")
          return jsonResponse({ proposal: created }, 201);
        if (url === `${proposalsPath}/${created.id}/submit`)
          return jsonResponse({
            proposal: proposal({
              lifecycle: "submitted",
              state: "under_consideration",
              revision: 2,
            }),
          });
        return undefined;
      },
    });
    await screen.findByRole("heading", { name: "Your proposals" });

    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "Straight in" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await screen.findByText(/Proposal submitted/);

    // Two calls, in this order, so every submitted proposal has the same shape on the dashboard
    // however it got there — and the create's idempotency key still converges on a retry.
    expect(harness.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${proposalsPath}`,
      `POST ${proposalsPath}/${created.id}/submit`,
    ]);
    expect(harness.calls[1]?.body).toMatchObject({ expectedRevision: 1 });
    // The form is cleared, so the next visitor action starts a new proposal rather than silently
    // editing the one just submitted.
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("");
  });

  it("offers a save and no submit when the proposal it is editing is already submitted", async () => {
    const submitted = proposal({
      lifecycle: "submitted",
      state: "under_consideration",
      title: "Already with the organizers",
      revision: 3,
      submittedAt: "2026-08-11T12:00:00.000Z",
    });
    const harness = mount({
      proposals: [submitted],
      write: (url, init) =>
        url === `${proposalsPath}/${submitted.id}` && init.method === "PUT"
          ? jsonResponse({ proposal: { ...submitted, revision: 4 } })
          : undefined,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /Edit Already with the organizers/ }),
    );

    // Submitting a submitted proposal is refused by the service, so a "Submit proposal" button here
    // would have exactly one outcome: an error message. It is not offered.
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // And the revision the edit names back is the one the dashboard listed, not 1.
    await waitFor(() => expect(harness.calls).toHaveLength(1));
    expect(harness.calls[0]).toMatchObject({
      url: `${proposalsPath}/${submitted.id}`,
      method: "PUT",
      body: { expectedRevision: 3 },
    });
    // A revision to something the organizers already hold is not still private, and does not say so.
    expect(await screen.findByText(/The organizers see this revision/)).toBeVisible();
  });

  it("reports a stale second tab and keeps the answers on screen", async () => {
    const existing = proposal();
    mount({
      proposals: [existing],
      write: (url, init) => {
        if (url === `${proposalsPath}/${existing.id}` && init.method === "PUT")
          return jsonResponse(
            {
              error: {
                code: "CONFLICT",
                message: "This proposal changed in another tab or window",
                correlationId: "trace-cfp",
              },
            },
            409,
          );
        return undefined;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Continue Half an idea/ }));
    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "My version" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another tab");
    // Losing the race must not also lose the words: the refusal is data-loss-free.
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("My version");
  });

  it("shows a decision, and stops offering edits once the call has closed", async () => {
    mount({
      status: "closed",
      proposals: [
        proposal({
          lifecycle: "submitted",
          state: "accepted",
          title: "Accepted talk",
          submittedAt: "2026-08-11T12:00:00.000Z",
        }),
        proposal({
          id: "50000000-0000-4000-8000-000000000002",
          lifecycle: "submitted",
          state: "declined",
          title: "Declined talk",
          submittedAt: "2026-08-11T12:05:00.000Z",
        }),
      ],
    });

    expect(await screen.findByText("Accepted")).toBeVisible();
    // "Not accepted" rather than "Declined": the same fact, addressed to the person it is about.
    expect(screen.getByText("Not accepted")).toBeVisible();
    // No triage vocabulary reaches this page — an event may configure "shortlist_maybe".
    expect(screen.queryByText(/under_review|shortlist/)).toBeNull();
    // After the deadline the list is a record, and it says so rather than offering dead buttons.
    expect(screen.queryByRole("button", { name: /Edit / })).toBeNull();
    expect(screen.getByText(/read but not changed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
  });
});
