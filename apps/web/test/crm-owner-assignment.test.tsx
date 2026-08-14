// @acceptance ACC-CRM
/*
 * The owner control is the CRM's only field whose valid values live in another domain, so it is
 * the one place the workspace must not invent a vocabulary: it offers what identity-access says
 * the event's staff is, and it shows the server's refusal on the control the organizer used.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmWorkspace } from "../src/CrmWorkspace";

const eventId = "00000000-0000-4000-8000-000000000001";
const prospectId = "50000000-0000-4000-8000-000000000001";

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: prospectId,
  eventId,
  name: "Dr. Ada Rivera",
  stage: "contacted",
  ownerId: "seed-organizer",
  nextAction: "Follow up on keynote topic",
  nextActionAt: "2026-08-08T17:00:00.000Z",
  contacts: [
    {
      id: "60000000-0000-4000-8000-000000000001",
      name: "Ada Rivera",
      email: "ada@example.test",
      isPrimary: true,
    },
  ],
  activities: [],
  speakerId: null,
  convertedAt: null,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
  ...overrides,
});

const owners = [
  { id: "seed-organizer", name: "Olivia Organizer" },
  { id: "seed-reviewer", name: "Ravi Reviewer" },
];

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Sent = { url: string; method: string; body: Record<string, unknown> };

function stubApi(routes: (url: string) => Promise<Response> | undefined) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET")
        sent.push({
          url,
          method: init.method,
          body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
      return routes(url) ?? jsonResponse({});
    }),
  );
  return sent;
}

/**
 * The board this workspace opens on, so the stubbed pipeline has columns to draw its cards in.
 *
 * Only the four stages these cases touch: the surface reads whatever the server sends, and a
 * fixture repeating all eight would assert the default set rather than the behaviour.
 */
const stages = [
  { key: "identified", label: "Identified", category: "open", sortOrder: 0 },
  { key: "contacted", label: "Contacted", category: "open", sortOrder: 1 },
  { key: "engaged", label: "Engaged", category: "open", sortOrder: 2 },
  { key: "converted", label: "Converted", category: "won", sortOrder: 3 },
].map((stage, index) => ({
  ...stage,
  id: `52000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  eventId,
  createdAt: "2026-08-14T00:00:00.000Z",
}));

const pipeline =
  (prospects: unknown[], staff: unknown[] = owners) =>
  (url: string) => {
    if (url.endsWith("/prospects/owners")) return jsonResponse({ owners: staff });
    if (url.includes("/pipeline/stages")) return jsonResponse({ stages });
    if (url.includes("/prospects")) return jsonResponse({ prospects });
    return undefined;
  };

/**
 * Open the prospect from the board, which is the view the workspace opens on.
 *
 * The card's accessible name carries the contact and the next action as well as the name — it
 * is one control per prospect, not a row of them — so it is matched by substring rather than by
 * the exact string a table cell used to be.
 */
const openProspect = async (name: string) =>
  fireEvent.click((await screen.findAllByRole("button", { name: new RegExp(name) }))[0] as Element);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("assigning a prospect owner", () => {
  it("offers the event's staff by name and posts the identity that was chosen", async () => {
    const sent = stubApi((url) => {
      if (url.endsWith(`/prospects/${prospectId}`))
        return jsonResponse({ prospect: prospect({ ownerId: "seed-reviewer" }) });
      return pipeline([prospect()])(url);
    });
    render(<CrmWorkspace eventId={eventId} ownerId="seed-organizer" />);

    await openProspect("Dr. Ada Rivera");
    const owner = await screen.findByLabelText<HTMLSelectElement>("Owner", { exact: true });
    // The set comes from identity-access, not from whoever happens to own a prospect: the
    // reviewer is offered though no prospect names them, and the speaker persona is absent.
    expect([...owner.options].map((option) => option.textContent)).toEqual([
      "Olivia Organizer (you)",
      "Ravi Reviewer",
    ]);
    expect(owner.value).toBe("seed-organizer");

    fireEvent.change(owner, { target: { value: "seed-reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save prospect" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      url: `/api/events/${eventId}/prospects/${prospectId}`,
      method: "PATCH",
      body: { ownerId: "seed-reviewer" },
    });
  });

  it("renders the server's owner refusal on the owner control instead of a bare 500", async () => {
    stubApi((url) => {
      if (url.endsWith(`/prospects/${prospectId}`))
        return jsonResponse(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Choose an owner who works on this event.",
              correlationId: "trace-67",
              fieldErrors: {
                ownerId: ["Choose an organizer or reviewer assigned to this event."],
              },
            },
          },
          400,
        );
      // A stored owner who is no longer staff stays selectable, so saving another field cannot
      // silently reassign the prospect.
      return pipeline([prospect({ ownerId: "departed-organizer" })])(url);
    });
    render(<CrmWorkspace eventId={eventId} ownerId="seed-organizer" />);

    await openProspect("Dr. Ada Rivera");
    const owner = await screen.findByLabelText<HTMLSelectElement>("Owner", { exact: true });
    expect(owner.value).toBe("departed-organizer");

    fireEvent.change(owner, { target: { value: "seed-reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save prospect" }));

    expect(
      await screen.findByText("Choose an organizer or reviewer assigned to this event."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Owner", { exact: true })).toHaveAttribute("aria-invalid", "true");
    // The workspace's existing announcement still carries the correlation id for support.
    expect(screen.getByRole("alert")).toHaveTextContent("Reference: trace-67");

    // Correcting the control clears its error rather than leaving a stale refusal on screen.
    fireEvent.change(screen.getByLabelText("Owner", { exact: true }), {
      target: { value: "seed-organizer" },
    });
    expect(
      screen.queryByText("Choose an organizer or reviewer assigned to this event."),
    ).toBeNull();
  });

  it("shows the stage transition the server recorded in the timeline", async () => {
    const moved = prospect({
      stage: "engaged",
      activities: [
        {
          id: "70000000-0000-4000-8000-000000000011",
          kind: "stage-change",
          summary: "contacted → engaged",
          private: false,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
        {
          id: "70000000-0000-4000-8000-000000000012",
          kind: "note",
          summary: "Available after 2pm",
          private: true,
          occurredAt: "2026-08-11T12:00:00.000Z",
          actorId: "seed-organizer",
        },
      ],
    });
    let saved = false;
    const sent = stubApi((url) => {
      if (url.endsWith(`/prospects/${prospectId}`)) {
        saved = true;
        return jsonResponse({ prospect: moved });
      }
      return pipeline([saved ? moved : prospect()])(url);
    });
    render(<CrmWorkspace eventId={eventId} ownerId="seed-organizer" />);

    await openProspect("Dr. Ada Rivera");
    expect(screen.getByText(/No activity recorded yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Stage", { exact: true }), {
      target: { value: "engaged" },
    });
    fireEvent.change(screen.getByLabelText("Private note"), {
      target: { value: "Available after 2pm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save prospect" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The client never posts a stage-change activity: the note is the only one it sends, and
    // the transition is the server's to record.
    expect(sent[0]?.body).toMatchObject({
      stage: "engaged",
      activity: { kind: "note", summary: "Available after 2pm", private: true },
    });

    const timeline = within(
      await screen.findByRole("region", { name: "Activity timeline" }),
    ).getAllByRole("listitem");
    expect(timeline).toHaveLength(2);
    expect(within(timeline[0] as HTMLElement).getByText("stage change")).toBeInTheDocument();
    expect(within(timeline[0] as HTMLElement).getByText("contacted → engaged")).toBeInTheDocument();
  });
});
