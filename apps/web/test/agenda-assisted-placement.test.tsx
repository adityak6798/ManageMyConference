// @acceptance ACC-AGENDA
/*
 * One action fills the board, and what it could not fill says why.
 *
 * The two things worth pinning in jsdom are the ones a service test cannot see: that the whole
 * pass is a single request — looping a request per session is exactly how the per-placement
 * round-trip cost issue #69 removed would come back through the UI — and that a session left
 * unscheduled carries its reason where the organizer is already looking, in the Unscheduled
 * rail rather than in a notice they have to go and find.
 */
import type { EventDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgendaWorkspace } from "../src/AgendaWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

const event: EventDto = {
  id: eventId,
  organizationId: "00000000-0000-4000-8000-000000000010",
  name: "Greenroom Demo Summit",
  timezone: "America/Los_Angeles",
  createdAt: "2026-08-09T12:00:00.000Z",
};

/** One room, one slot, two sessions: room for one of them and no room for the other. */
const board = {
  eventId,
  rooms: [{ id: "room-main", name: "Main stage" }],
  tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
  slots: [
    { id: "slot-0900", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
  ],
  sessions: [
    { id: "session-one", title: "Opening keynote", speakerIds: [] },
    { id: "session-two", title: "Closing panel", speakerIds: [] },
  ],
  placements: [],
  conflicts: [],
};

const NO_ROOM = "Every room and time slot is already taken.";

/** The board after the pass: the first session seated, the second explained. */
const generated = {
  ...board,
  placements: [
    {
      id: "assisted-session-one",
      sessionId: "session-one",
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-0900",
    },
  ],
  unplaced: [{ sessionId: "session-two", title: "Closing panel", reason: NO_ROOM }],
};

function stubFetch() {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET")
        return Promise.resolve(new Response(JSON.stringify({ agenda: board }), { status: 200 }));
      writes.push(`${method} ${String(input)}`);
      return Promise.resolve(new Response(JSON.stringify({ agenda: generated }), { status: 200 }));
    }),
  );
  return writes;
}

const rail = () => within(screen.getByRole("region", { name: /Unscheduled/i }) as HTMLElement);

describe("assisted agenda placement", () => {
  const onError = vi.fn<(message: string) => void>();

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onError.mockReset();
  });

  it("fills the board in one request and explains what it could not place", async () => {
    const writes = stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: /Generate draft/i });

    fireEvent.click(screen.getByRole("button", { name: /Generate draft/i }));

    await waitFor(() => expect(writes).toHaveLength(1));
    // One request for the whole pass, regardless of how many sessions it seats.
    expect(writes[0]).toMatch(/POST .*\/agenda\/assisted-placements$/);

    // The reason lands on the session it is about, in the rail the organizer is already reading.
    await waitFor(() => expect(rail().getByText(NO_ROOM)).toBeTruthy());
    expect(onError).not.toHaveBeenCalled();
  });

  it("tells a screen reader the reason as part of the session's own label", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: /Generate draft/i });

    fireEvent.click(screen.getByRole("button", { name: /Generate draft/i }));

    // `aria-label` replaces the card's content, so the reason has to be inside the label or a
    // screen-reader user never hears why the session stayed put.
    await waitFor(() =>
      expect(rail().getByRole("button", { name: new RegExp(NO_ROOM) })).toBeTruthy(),
    );
  });

  it("offers nothing to generate once every session is scheduled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agenda: {
                ...board,
                placements: generated.placements,
                sessions: [board.sessions[0]],
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    render(<AgendaWorkspace event={event} onError={onError} />);

    // A control that would do nothing should not invite a click.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Generate draft/i }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("drops an explanation once a later edit could have made it untrue", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    fireEvent.click(await screen.findByRole("button", { name: /Generate draft/i }));
    await waitFor(() => expect(rail().getByText(NO_ROOM)).toBeTruthy());

    // Unscheduling frees the only cell, so "every room and time slot is already taken" stops
    // being true — about a session that itself did not move. A note that survives the edit
    // that invalidated it is worse than no note.
    fireEvent.click(screen.getByRole("tab", { name: /^List/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Unschedule" })[0] as HTMLElement);

    await waitFor(() => expect(screen.queryByText(NO_ROOM)).toBeNull());
  });

  it("stays available while a search hides the sessions it would place", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    const button = (await screen.findByRole("button", {
      name: /Generate draft/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // The pass places every unscheduled session, not the ones matching the search box, so a
    // search for something else must not disable the control that starts it.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz no match" } });

    await waitFor(() => expect(rail().queryByText("Opening keynote")).toBeNull());
    expect(
      (screen.getByRole("button", { name: /Generate draft/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
