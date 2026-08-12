// @acceptance ACC-AGENDA
/*
 * Placing a chosen subset, rather than the whole board.
 *
 * The endpoint has always taken a `sessionIds` subset (issue #96); issue #119 is about the board
 * being able to name one. Three things are worth pinning here, and none of them is visible to a
 * service test.
 *
 * The request must carry exactly what was ticked — a selection that quietly widens to the whole
 * board is the same defect the label would be lying about. It is still *one* request, whatever
 * is ticked, because the round-trip cost issue #69 removed must not come back through a subset.
 * And the control has to say which of the two things it will do, because "Generate draft" over a
 * three-session selection is precisely the promise-versus-effect mismatch #113 fixed for this
 * button's enabled state.
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

/** The board the API answers a pass with: the keynote seated, the panel explained. */
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

type Write = { url: string; body: unknown };

function stubFetch() {
  const writes: Write[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET")
        return Promise.resolve(new Response(JSON.stringify({ agenda: board }), { status: 200 }));
      writes.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(new Response(JSON.stringify({ agenda: generated }), { status: 200 }));
    }),
  );
  return writes;
}

const rail = () => within(screen.getByRole("region", { name: /Unscheduled/i }) as HTMLElement);
const action = () =>
  screen.getByRole("button", { name: /Generate draft|Place \d+ selected/ }) as HTMLButtonElement;
const tick = (title: string) =>
  fireEvent.click(rail().getByRole("checkbox", { name: `Select ${title} for assisted placement` }));

describe("choosing which sessions an assisted pass seats", () => {
  const onError = vi.fn<(message: string) => void>();

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onError.mockReset();
  });

  it("sends exactly the ticked sessions, in one request", async () => {
    const writes = stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    tick("Closing panel");
    fireEvent.click(action());

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.url).toMatch(/\/agenda\/assisted-placements$/);
    // Only what was ticked. A subset that widens to the whole board would place sessions the
    // organizer deliberately left alone.
    expect(writes[0]?.body).toEqual({ sessionIds: ["session-two"] });
    expect(onError).not.toHaveBeenCalled();
  });

  it("names what it will do: the whole board, or the count that is ticked", async () => {
    const writes = stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    tick("Opening keynote");
    expect(action().textContent).toContain("Place 1 selected");
    tick("Closing panel");
    expect(action().textContent).toContain("Place 2 selected");

    // Cleared, the action is about everything again — and says so.
    fireEvent.click(rail().getByRole("button", { name: "Clear selection" }));
    expect(action().textContent).toContain("Generate draft");

    fireEvent.click(action());
    await waitFor(() => expect(writes).toHaveLength(1));
    // No selection means no `sessionIds` at all, which is the endpoint's "place everything".
    expect(writes[0]?.body).toEqual({});
  });

  it("ticks and clears the whole listed group from one control", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    const all = (await screen.findByRole("checkbox", { name: "Select all 2" })) as HTMLInputElement;

    fireEvent.click(all);
    expect(action().textContent).toContain("Place 2 selected");
    expect(all.checked).toBe(true);

    fireEvent.click(all);
    expect(action().textContent).toContain("Generate draft");
  });

  it("shows the group control as partly ticked when only some of it is", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    const all = (await screen.findByRole("checkbox", { name: "Select all 2" })) as HTMLInputElement;

    tick("Opening keynote");

    // "Some of these" and "all of these" are different answers, and a screen reader only hears
    // the difference if the third state is actually set.
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it("keeps a selection the search hides, and says it will still place it", async () => {
    const writes = stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    tick("Opening keynote");
    tick("Closing panel");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Closing" } });

    await waitFor(() => expect(rail().queryByText("Opening keynote")).toBeNull());
    // The selection is about sessions, not about what the rail is currently listing, so the
    // count must not shrink with the view — and the rail says what is out of sight.
    expect(action().textContent).toContain("Place 2 selected");
    expect(rail().getByText(/1 selected session is hidden by your search/)).toBeTruthy();

    fireEvent.click(action());
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ sessionIds: ["session-one", "session-two"] });
  });

  it("forgets a session that is no longer unscheduled", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    tick("Opening keynote");
    tick("Closing panel");
    fireEvent.click(action());

    // The pass seated the keynote, so only the panel is still selectable. A tick that outlived
    // its session would make the next press act on a board that no longer exists.
    await waitFor(() => expect(rail().getByText(NO_ROOM)).toBeTruthy());
    expect(action().textContent).toContain("Place 1 selected");
    expect(rail().queryByRole("checkbox", { name: /Opening keynote/ })).toBeNull();
  });

  it("keeps focus in the rail when the control that cleared the selection leaves with it", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    tick("Opening keynote");
    const clear = rail().getByRole("button", { name: "Clear selection" });
    clear.focus();
    fireEvent.click(clear);

    // The button is gone with the selection it cleared. On `document.body`, the next Tab
    // restarts at the top of the console — so focus lands on the group control instead.
    expect(document.activeElement).toBe(
      rail().getByRole("checkbox", { name: /^Select all/ }) as HTMLElement,
    );
  });

  it("announces the count politely, without borrowing the action's own live region", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    // Mounted before the change it will announce, or a screen reader hears nothing: ticking a
    // box otherwise says only "checked", never that the action now means one session.
    const live = document.querySelector(".agenda-rail-status")?.getAttribute("aria-live");
    expect(live).toBe("polite");
    // And it is not a second `status` region: the workspace's action feedback owns that role,
    // and it reports what an action did rather than what the next one will do.
    expect(
      (document.querySelector(".agenda-rail-status") as HTMLElement).getAttribute("role"),
    ).toBeNull();

    tick("Opening keynote");
    expect(rail().getByText("1 selected")).toBeTruthy();
  });

  /*
   * What a subset pass is allowed to say about the sessions it was not given.
   *
   * The explanations in the rail are the verdict of one pass over one board, and the board's
   * standing rule is that a board change makes every earlier verdict stale. A subset pass makes
   * that rule sharper in both directions, and both directions are asserted here: a pass that
   * seated nothing did not move the board, so notes it never judged still hold; a pass that
   * seated something did, so they do not.
   */
  describe("explanations a subset pass did not overturn", () => {
    const threeSessions = [
      { id: "session-one", title: "Opening keynote", speakerIds: [] },
      { id: "session-two", title: "Closing panel", speakerIds: [] },
      { id: "session-three", title: "Hallway track", speakerIds: [] },
    ];
    const full = { ...board, sessions: threeSessions };
    const seatedOne = {
      ...full,
      placements: [
        {
          id: "assisted-session-one",
          sessionId: "session-one",
          roomId: "room-main",
          trackId: "track-platform",
          slotId: "slot-0900",
        },
      ],
    };

    /** Answers each pass from the ids it names, so a subset gets a subset's answer. */
    function stubPasses(subsetPlaces: boolean) {
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          if (method === "GET")
            return Promise.resolve(new Response(JSON.stringify({ agenda: full }), { status: 200 }));
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
          const asked: string[] | undefined = body.sessionIds;
          const unplaced = (asked ?? ["session-two", "session-three"])
            .filter((id) => id !== "session-one")
            .map((sessionId) => ({ sessionId, title: sessionId, reason: NO_ROOM }));
          // A subset pass either seats nothing (the board stands still) or seats its one
          // session into a second room the response invents.
          const placements =
            asked && subsetPlaces
              ? [
                  ...seatedOne.placements,
                  {
                    id: `assisted-${asked[0]}`,
                    sessionId: asked[0] as string,
                    roomId: "room-main",
                    trackId: "track-platform",
                    slotId: "slot-0900",
                  },
                ]
              : seatedOne.placements;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                agenda: { ...seatedOne, placements, unplaced: asked ? unplaced : unplaced },
              }),
              { status: 200 },
            ),
          );
        }),
      );
    }

    it("keeps the note on a session it was never asked about, when it seated nothing", async () => {
      stubPasses(false);
      render(<AgendaWorkspace event={event} onError={onError} />);
      fireEvent.click(await screen.findByRole("button", { name: "Generate draft" }));
      await waitFor(() => expect(rail().getAllByText(NO_ROOM)).toHaveLength(2));

      tick("Closing panel");
      fireEvent.click(action());

      // The pass judged one session and moved nothing. "Hallway track" is exactly as stuck as
      // it was a moment ago, and taking its reason away would be losing what the organizer is
      // reading rather than retracting something that stopped being true.
      await waitFor(() => expect(rail().getAllByText(NO_ROOM)).toHaveLength(2));
    });

    it("drops the others once it has actually moved the board", async () => {
      stubPasses(true);
      render(<AgendaWorkspace event={event} onError={onError} />);
      fireEvent.click(await screen.findByRole("button", { name: "Generate draft" }));
      await waitFor(() => expect(rail().getAllByText(NO_ROOM)).toHaveLength(2));

      tick("Closing panel");
      fireEvent.click(action());

      // This pass seated something, so the board is not the board those verdicts were about.
      await waitFor(() => expect(rail().queryAllByText(NO_ROOM)).toHaveLength(0));
    });
  });

  it("offers no selection control once every session is scheduled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agenda: { ...board, placements: generated.placements, sessions: [board.sessions[0]] },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    render(<AgendaWorkspace event={event} onError={onError} />);

    await waitFor(() => expect(action().disabled).toBe(true));
    expect(rail().queryByRole("checkbox")).toBeNull();
  });
});
