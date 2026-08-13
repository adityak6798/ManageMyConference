// @acceptance ACC-SPEAKER
/*
 * Taking a session back out of the programme, and where a session's time comes from.
 *
 * The decline-an-accepted dialog told organizers to "delete the session in Sessions & speakers".
 * Nothing there could: the only action on a session row was Edit, and the editor offered Save
 * and Close. These cover the control that makes that sentence true — a two-step withdrawal that
 * says what it takes with it — and the portal copy for a session the published agenda has not
 * placed, which used to be answered from a column no product path ever wrote.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentWorkspace } from "../src/ContentWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const profileId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

// Held in constants because a literal `role=` prop reads as an ARIA role to the linter.
const ORGANIZER = "organizer" as const;
const SPEAKER = "speaker" as const;

const speaker = {
  id: profileId,
  eventId,
  userId: "user-alex",
  sourcePersonId: "crm-email:alex.morgan@example.test",
  name: "Alex Morgan",
  email: "alex.morgan@example.test",
  bio: "",
  pronouns: "",
  organization: "Greenroom Labs",
};

const session = (schedule?: { startsAt: string; endsAt: string; location: string }) => ({
  id: sessionId,
  eventId,
  proposalId: "11111111-1111-4111-8111-111111111111",
  title: "Designing the calm conference",
  abstract: "A practical guide to reducing operational noise.",
  format: "45-minute talk",
  speakerProfileIds: [profileId],
  tags: [],
  tracks: [],
  publicationState: "published" as const,
  ...(schedule ? { schedule } : {}),
});

function workspace(options: { sessions?: unknown[] } = {}) {
  return {
    sessions: options.sessions ?? [session()],
    speakers: [speaker],
    tasks: [],
    assets: [],
    messages: [],
  };
}

type Sent = { url: string; method: string };

/** Serves the workspace and records every mutation, so a click can be asserted on the wire. */
function stubApi(next: () => unknown) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET") sent.push({ url, method: init.method });
      if (url.endsWith(`/api/events/${eventId}/content`))
        return Promise.resolve(new Response(JSON.stringify(next()), { status: 200 }));
      // The checklist panel reads the event's own checklist on mount, exactly as the
      // Accelevents panel reads its status. Unanswered, it would put its own failure notice
      // inside a workspace these tests are asserting something else about.
      if (url.endsWith("/speaker-task-templates"))
        return Promise.resolve(new Response(JSON.stringify({ templates: [] }), { status: 200 }));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("withdrawing a session", () => {
  it("asks before it removes anything, then deletes the session the dialog names", async () => {
    let current: unknown = workspace();
    const sent = stubApi(() => current);
    render(<ContentWorkspace eventId={eventId} role={ORGANIZER} />);

    const withdraw = await screen.findByRole("button", {
      name: /Withdraw Designing the calm conference/,
    });
    // One click sends nothing: withdrawal is irreversible, so it is confirmed first.
    fireEvent.click(withdraw);
    expect(sent).toEqual([]);
    // The confirmation says what else goes, and what does not.
    expect(screen.getByText(/any agenda placement holding it is removed/i)).toBeInTheDocument();
    expect(screen.getByText(/until you publish again/i)).toBeInTheDocument();

    // Backing out leaves the session alone.
    fireEvent.click(screen.getByRole("button", { name: "Keep this session" }));
    expect(screen.queryByText(/any agenda placement holding it is removed/i)).toBeNull();
    expect(sent).toEqual([]);

    fireEvent.click(withdraw);
    current = workspace({ sessions: [] });
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, withdraw Designing the calm conference" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        url: `/api/content-sessions/${sessionId}`,
        method: "DELETE",
      }),
    );

    // The programme is refetched, so the row is gone, and the confirmation says what happened.
    await waitFor(() => expect(screen.queryByText("Designing the calm conference")).toBeNull());
    const sessions = await screen.findByRole("region", { name: "Accepted sessions" });
    expect(within(sessions).getByRole("status")).toHaveTextContent(
      /was withdrawn, along with any agenda placement holding it/,
    );
    // The withdrawal succeeded, so nothing on the page reports a failure.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a speaker their session is not on the published schedule, rather than inventing a time", async () => {
    stubApi(() => workspace());
    render(<ContentWorkspace eventId={eventId} role={SPEAKER} />);

    const sessions = await screen.findByRole("region", { name: "Your sessions" });
    expect(within(sessions).getByText(/Not on the published schedule yet/)).toBeInTheDocument();
    // The download exists only once a VEVENT can be produced, and it says so.
    expect(within(sessions).queryByRole("link", { name: /Download calendar/ })).toBeNull();
    expect(
      within(sessions).getByText(/Downloadable once the published schedule places a session/),
    ).toBeInTheDocument();
  });

  it("shows the speaker the time and room the agenda published", async () => {
    stubApi(() =>
      workspace({
        sessions: [
          session({
            startsAt: "2026-09-01T16:00:00.000Z",
            endsAt: "2026-09-01T17:00:00.000Z",
            location: "Main stage",
          }),
        ],
      }),
    );
    render(<ContentWorkspace eventId={eventId} role={SPEAKER} />);

    const sessions = await screen.findByRole("region", { name: "Your sessions" });
    expect(within(sessions).getByText(/Main stage/)).toBeInTheDocument();
    expect(within(sessions).getByRole("link", { name: /Download calendar/ })).toHaveAttribute(
      "href",
      `/api/events/${eventId}/speaker-calendar.ics`,
    );
  });
});
