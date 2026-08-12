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
  placed: ["session-one"],
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
/** Matched on the title alone: a shared title also carries a position in the name. */
const box = (title: string) =>
  rail().getByRole("checkbox", { name: new RegExp(`^Select ${title}[ (]`) });
const tick = (title: string) => fireEvent.click(box(title));

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

  it("keeps the live region on the page when a search empties the rail", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz no match" } });

    // Emptied, never removed. A screen reader that registers live regions as they are inserted
    // will not see one that arrives already carrying the news it was supposed to announce.
    await waitFor(() => expect(rail().queryByRole("checkbox")).toBeNull());
    expect(document.querySelector(".agenda-rail-status")).not.toBeNull();
  });

  it("offers the escape hatch in the toolbar when the rail has no room for it", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    tick("Opening keynote");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz no match" } });
    await waitFor(() => expect(rail().queryByRole("checkbox")).toBeNull());

    // The selection is still armed and the action still names it, so there has to be a way to
    // undo it — and the rail no longer has a group control to hang one on.
    expect(action().textContent).toContain("Place 1 selected");
    const clear = screen.getByRole("button", { name: "Clear selection" });
    clear.focus();
    fireEvent.click(clear);
    expect(action().textContent).toContain("Generate draft");
    // Exactly one control by that name at a time; two would be two homes for one job.
    expect(screen.queryAllByRole("button", { name: "Clear selection" })).toHaveLength(0);
    // And focus goes to the search box the operator was using — not to the action beside it,
    // which clearing has just turned back into a whole-board "Generate draft".
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });

  /*
   * A refusal recovers focus; it never takes it.
   *
   * Moving a placed card is the caller that proves it. Unlike the assisted action it asks for
   * no recovery-only treatment, and the card it names is still on the board after the refusal —
   * so if the failure path honoured the caller's option instead of forcing recovery, focus would
   * jump to that card and this test goes red.
   */
  it("leaves the operator's focus alone when an action is refused under them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET")
          return Promise.resolve(
            new Response(JSON.stringify({ agenda: generated }), { status: 200 }),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "CONFLICT", message: "Nope.", correlationId: "c1" } }),
            { status: 409 },
          ),
        );
      }),
    );
    render(<AgendaWorkspace event={event} onError={onError} />);

    // Pick the placed card up and drop it, which is the move the API then refuses.
    const card = await screen.findByRole("button", { name: /Opening keynote\. Main stage/ });
    fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: /^Place .* in Main stage/ }));
    // Meanwhile the operator has moved to the search box.
    const search = screen.getByRole("searchbox") as HTMLElement;
    search.focus();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nope."));
    // The refusal moved nothing, so it has no business moving the caret: the next space types a
    // space rather than picking up the card focus would have landed on.
    expect(document.activeElement).toBe(search);
  });

  it("adds a position to a checkbox only when its title is not its own", async () => {
    // Two sessions under one title — the assisted planner breaks ties on id for exactly that
    // reason — and two identical announcements give a screen-reader user nothing to choose by.
    const twins = {
      ...board,
      sessions: [
        { id: "session-one", title: "Lightning talks", speakerIds: [] },
        { id: "session-two", title: "Lightning talks", speakerIds: [] },
        { id: "session-three", title: "Closing panel", speakerIds: [] },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ agenda: twins }), { status: 200 })),
      ),
    );
    render(<AgendaWorkspace event={event} onError={onError} />);
    await screen.findByRole("button", { name: "Generate draft" });

    expect(
      rail().getByRole("checkbox", {
        name: "Select Lightning talks (1 of 2) for assisted placement",
      }),
    ).toBeTruthy();
    expect(
      rail().getByRole("checkbox", {
        name: "Select Lightning talks (2 of 2) for assisted placement",
      }),
    ).toBeTruthy();
    // Numbered within the pair, not within the rail: "(3 of 12)" would be a position in a
    // list that renumbers with the search box and a total that contradicts the count beside it.
    // The unambiguous session is left alone entirely.
    expect(
      rail().getByRole("checkbox", { name: "Select Closing panel for assisted placement" }),
    ).toBeTruthy();
  });

  /*
   * What a pass is allowed to leave on screen about sessions it did not judge: nothing.
   *
   * The first review of #119 asked for the opposite — a subset pass that seats nothing should
   * keep the notes it never looked at — and it was built that way. Two later passes took it
   * apart: whether those notes still hold depends on whether the board moved, and the board that
   * comes back also carries rooms, slots and other organizers' edits, so this screen cannot tell.
   * A verdict that outlives the change which disproved it is worse than no verdict, so the rule
   * is the one this map has always followed, and it is asserted rather than assumed.
   */
  describe("explanations belong to the pass that made them", () => {
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
    function stubPasses() {
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
          return Promise.resolve(
            new Response(JSON.stringify({ agenda: { ...seatedOne, placed: [], unplaced } }), {
              status: 200,
            }),
          );
        }),
      );
    }

    it("replaces every verdict with its own, and says nothing about the rest", async () => {
      stubPasses();
      render(<AgendaWorkspace event={event} onError={onError} />);
      fireEvent.click(await screen.findByRole("button", { name: "Generate draft" }));
      await waitFor(() => expect(rail().getAllByText(NO_ROOM)).toHaveLength(2));

      tick("Closing panel");
      fireEvent.click(action());

      // One session was judged, so one reason is on screen. "Hallway track" is unscheduled and
      // silent, which is the honest state: nothing in this response is a statement about it, and
      // the last thing that was may no longer be true.
      await waitFor(() => expect(rail().getAllByText(NO_ROOM)).toHaveLength(1));
    });

    it("counts what the server says it seated, not the difference between two boards", async () => {
      // The pass seats nothing, and in the same seconds another organizer's placement arrives in
      // the response. A client diffing boards would credit this button with their drag.
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          if (method === "GET")
            return Promise.resolve(new Response(JSON.stringify({ agenda: full }), { status: 200 }));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                agenda: {
                  ...seatedOne,
                  placed: [],
                  unplaced: [{ sessionId: "session-two", title: "Closing panel", reason: NO_ROOM }],
                },
              }),
              { status: 200 },
            ),
          );
        }),
      );
      render(<AgendaWorkspace event={event} onError={onError} />);
      await screen.findByRole("button", { name: "Generate draft" });

      tick("Closing panel");
      fireEvent.click(action());

      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("Placed 0 sessions."),
      );
    });
  });

  it("drops the explanations when a new time slot could have made them untrue", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate draft" }));
    await waitFor(() => expect(rail().getByText(NO_ROOM)).toBeTruthy());

    // Adding a slot is a board change like any other, and it is the change that most obviously
    // disproves "every room and time slot is already taken" — but it is the one board-changing
    // path that does not run through `act`, so it has to drop the verdicts itself.
    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));

    await waitFor(() => expect(screen.queryByText(NO_ROOM)).toBeNull());
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
