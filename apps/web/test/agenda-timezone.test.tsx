// @acceptance ACC-AGENDA
/*
 * The agenda board renders instants on the *event's* wall clock.
 *
 * This is a jsdom test rather than only a browser one because the regression it guards
 * is arithmetic, not layout: the same stored instant has to land on a different heading
 * and a different day bucket depending on the event's timezone, and that is cheap to
 * assert without a server.
 */

import type { EventDto } from "@greenroom/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgendaWorkspace } from "../src/agenda/AgendaWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const organizationId = "00000000-0000-4000-8000-000000000010";

function eventIn(timezone: string, id = eventId): EventDto {
  return {
    id,
    organizationId,
    name: "Greenroom Summit",
    timezone,
    createdAt: "2026-08-09T12:00:00.000Z",
  };
}

/*
 * 16:00Z is 09:00 in Los Angeles and 12:00 in New York. 2026-09-02T04:00Z is the
 * interesting one: 21:00 on September 1st in Los Angeles, but already September 2nd
 * in UTC — so it proves the day bucket follows the event, not the stored instant's
 * UTC date.
 */
const draft = {
  eventId,
  rooms: [{ id: "room-main", name: "Main stage" }],
  tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
  slots: [
    {
      id: "slot-morning",
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
    },
    {
      id: "slot-evening",
      startsAt: "2026-09-02T04:00:00.000Z",
      endsAt: "2026-09-02T05:00:00.000Z",
    },
  ],
  sessions: [{ id: "session-opening", title: "Opening keynote", speakerIds: [] }],
  placements: [
    {
      id: "placement-opening",
      sessionId: "session-opening",
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-morning",
    },
  ],
  occurrences: { sessions: {}, slots: {} },
  conflicts: [],
};

/** The zone chip on the toolbar; its text is split across a hidden prefix and the value. */
function zoneLabel() {
  return document.querySelector(".agenda-timezone");
}

function stubAgendaFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ agenda: draft }), { status: 200 }))),
  );
}

describe("AgendaWorkspace timezone rendering", () => {
  // A spy rather than a noop: a board that failed to load would otherwise fail these
  // tests with a confusing "element not found" instead of the reason it never rendered.
  const onError = vi.fn<(message: string) => void>();

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onError.mockReset();
  });

  it("renders slot times and day buckets on the event's wall clock", async () => {
    stubAgendaFetch();
    render(<AgendaWorkspace event={eventIn("America/Los_Angeles")} onError={onError} />);

    // The room board's row headers are the times an organizer reads off the grid.
    expect(await screen.findByRole("rowheader", { name: "09:00–10:00" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "21:00–22:00" })).toBeInTheDocument();
    // The UTC rendering of the same two slots must be gone, not merely relabelled.
    expect(screen.queryByRole("rowheader", { name: "16:00–17:00" })).not.toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "04:00–05:00" })).not.toBeInTheDocument();

    // 21:00 local is September 2nd in UTC, so a UTC bucket would split these into two
    // days and hide the evening slot behind the day picker.
    expect(screen.getByRole("option", { name: "Tue, Sep 1" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Wed, Sep 2" })).not.toBeInTheDocument();

    // The board says which zone it is in, so a reader is never left guessing.
    expect(zoneLabel()).toHaveTextContent("Times are shown in America/Los_Angeles (PDT)");

    // A placed card carries the local time too, including in its accessible name.
    expect(
      screen.getByRole("button", { name: /Opening keynote\. Main stage, 09:00–10:00/ }),
    ).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("re-renders in the new zone when the selected event changes", async () => {
    stubAgendaFetch();
    const { rerender } = render(
      <AgendaWorkspace event={eventIn("America/Los_Angeles")} onError={onError} />,
    );
    expect(await screen.findByRole("rowheader", { name: "09:00–10:00" })).toBeInTheDocument();

    // A different event, exactly as the switcher hands one over: no reload, no remount
    // needed for the board to re-read every instant on the new event's clock.
    rerender(
      <AgendaWorkspace
        event={eventIn("America/New_York", "123e4567-e89b-12d3-a456-426614174001")}
        onError={onError}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("rowheader", { name: "12:00–13:00" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("rowheader", { name: "09:00–10:00" })).not.toBeInTheDocument();
    expect(zoneLabel()).toHaveTextContent("Times are shown in America/New_York (EDT)");
    // Midnight Eastern belongs to the next day, so Eastern really does split these two.
    expect(screen.getByRole("option", { name: "Wed, Sep 2" })).toBeInTheDocument();
    // Every day is also exposed without opening the select. A session on another day should not
    // look missing merely because the room board initially shows the event's first day.
    expect(
      screen.getByRole("button", { name: "Wed, Sep 2 0 scheduled sessions" }),
    ).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("warns when scheduled session content is not published", async () => {
    const sessionId = "123e4567-e89b-12d3-a456-426614174009";
    const agenda = {
      ...draft,
      sessions: [{ id: sessionId, title: "Opening keynote", speakerIds: [] }],
      placements: [{ ...draft.placements[0], sessionId }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input).endsWith("/content")
            ? new Response(
                JSON.stringify({
                  sessions: [
                    {
                      id: sessionId,
                      eventId,
                      proposalId: "proposal-opening",
                      title: "Opening keynote",
                      speakerProfileIds: [],
                      publicationState: "draft",
                    },
                  ],
                  speakers: [],
                  tasks: [],
                  assets: [],
                  messages: [],
                }),
                { status: 200 },
              )
            : new Response(JSON.stringify({ agenda }), { status: 200 }),
        ),
      ),
    );

    render(<AgendaWorkspace event={eventIn("America/Los_Angeles")} onError={onError} />);

    expect(
      await screen.findByText("1 scheduled session will not appear publicly"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Publish these first: Opening keynote/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review sessions" })).toHaveAttribute(
      "href",
      "/?tab=sessions",
    );
    expect(screen.getByRole("button", { name: "Publish schedule (0 public)" })).toBeVisible();
  });

  /*
   * `DEBT-008`: an empty board used to read the zone abbreviation at `new Date()`.
   *
   * The abbreviation is a fact about an *instant* — DST makes it so — and a board with no slots
   * shows no instant. Reading "now" made a January conference configured in July announce itself
   * as PDT, stated exactly as confidently as a real reading, and flipped to PST six months later
   * with nothing about the event having changed. The event record carries no dates of its own
   * (`EventDto` is id, organization, name, timezone and creation time), so there is no honest
   * instant to substitute and the board says only the zone.
   *
   * Both abbreviations are ruled out rather than the current one, so this holds in either half of
   * the year without faking a clock — the old fallback printed one of exactly these two whenever
   * it ran.
   */
  it("names no abbreviation on an empty board, in either half of the year", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ agenda: { ...draft, slots: [], placements: [] } }), {
            status: 200,
          }),
        ),
      ),
    );
    render(<AgendaWorkspace event={eventIn("America/Los_Angeles")} onError={onError} />);

    await waitFor(() =>
      expect(zoneLabel()).toHaveTextContent("Times are shown in America/Los_Angeles"),
    );
    expect(zoneLabel()).not.toHaveTextContent("PDT");
    expect(zoneLabel()).not.toHaveTextContent("PST");
    expect(onError).not.toHaveBeenCalled();
  });

  it("falls back to UTC, and names it, when the event carries an unusable zone", async () => {
    stubAgendaFetch();
    render(<AgendaWorkspace event={eventIn("Not/AZone")} onError={onError} />);

    expect(await screen.findByRole("rowheader", { name: "16:00–17:00" })).toBeInTheDocument();
    expect(zoneLabel()).toHaveTextContent("Times are shown in UTC");
    // A zone the runtime cannot resolve degrades the board; it does not break it.
    expect(onError).not.toHaveBeenCalled();
  });
});
