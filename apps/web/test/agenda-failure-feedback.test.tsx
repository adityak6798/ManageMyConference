// @acceptance ACC-AGENDA
/*
 * Where the agenda board reports a refusal.
 *
 * The audit measured the old answer: clicking "Remove" beside a room that still holds a
 * placement put the server's reason 310px below the fold, in a page-level notice appended
 * after the whole workspace, while every *successful* agenda action announced under the
 * toolbar. These tests pin the corrected rule — success and failure share one live region,
 * and a refusal about one row is repeated inside that row — in the only terms jsdom can
 * assert honestly: which element carries the text, and where in the document it sits
 * relative to the toolbar and to the panel the click happened in.
 */
import type { EventDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgendaWorkspace } from "../src/agenda/AgendaWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

const event: EventDto = {
  id: eventId,
  organizationId: "00000000-0000-4000-8000-000000000010",
  name: "Greenroom Demo Summit",
  timezone: "America/Los_Angeles",
  createdAt: "2026-08-09T12:00:00.000Z",
};

/** One room holding one placement — exactly the shape the server refuses to delete. */
const board = {
  eventId,
  rooms: [
    { id: "room-main", name: "Main stage" },
    { id: "room-lab", name: "Lab" },
  ],
  tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
  slots: [
    {
      id: "slot-0900",
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
    },
  ],
  sessions: [{ id: "session-opening", title: "Opening keynote", speakerIds: [] }],
  placements: [
    {
      id: "placement-opening",
      sessionId: "session-opening",
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-0900",
    },
  ],
  occurrences: { sessions: {}, slots: {} },
  conflicts: [],
};

const IN_USE = "Remove affected placements before deleting resources";

function refusal(message: string, status = 409) {
  return new Response(
    JSON.stringify({
      error: { code: "VALIDATION_FAILED", message, correlationId: "correlation-1" },
    }),
    { status },
  );
}

/** Serves the board on GET and answers every write with `reply`. */
function stubFetch(reply?: () => Response) {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET")
        return Promise.resolve(new Response(JSON.stringify({ agenda: board }), { status: 200 }));
      writes.push(`${method} ${String(input)}`);
      return Promise.resolve(
        reply ? reply() : new Response(JSON.stringify({ agenda: board }), { status: 200 }),
      );
    }),
  );
  return writes;
}

/**
 * The resources-panel row for a room or track, by the name it shows. Scoped to the panel
 * because a room name is also a column header on the board itself.
 */
function rowFor(name: string): HTMLElement {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(".agenda-resources .resource-row"),
  );
  const row = rows.find(
    (candidate) => candidate.querySelector(".name")?.textContent?.trim() === name,
  );
  if (!row) throw new Error(`No resources row is named “${name}”.`);
  return row;
}

describe("AgendaWorkspace failure feedback", () => {
  const onError = vi.fn<(message: string) => void>();

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onError.mockReset();
  });

  it("announces a refused room removal under the toolbar, not below the workspace", async () => {
    const writes = stubFetch(() => refusal(IN_USE));
    const { container } = render(<AgendaWorkspace event={event} onError={onError} />);

    await screen.findByText("Manage rooms, tracks, and times");
    const row = rowFor("Main stage");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(IN_USE);

    // The live region is the workspace's own — the element directly after the toolbar,
    // which is where every successful agenda action already announces itself.
    expect(alert.previousElementSibling).toHaveClass("agenda-toolbar");
    // …and therefore above the resources panel the operator clicked in, not after it.
    const resources = container.querySelector("details.agenda-resources");
    if (!resources) throw new Error("the resources panel is missing");
    expect(resources.contains(alert)).toBe(false);
    expect(
      alert.compareDocumentPosition(resources) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The row that was refused says so too, so the reason is legible from the button.
    expect(within(row).getByText(IN_USE)).toBeInTheDocument();
    // Nothing is handed to the page shell: this is not a page-level failure.
    expect(onError).not.toHaveBeenCalled();
  });

  it("says a room is holding sessions before the organizer clicks Remove", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);

    await screen.findByText("Manage rooms, tracks, and times");
    const row = rowFor("Main stage");
    const note = within(row).getByText(
      "Holds 1 scheduled session. Move or unschedule it before removing this room.",
    );
    // A disabled button cannot be focused, so the reason travels with the live one.
    expect(within(row).getByRole("button", { name: "Remove" })).toHaveAttribute(
      "aria-describedby",
      note.id,
    );

    // A room with nothing in it carries no warning at all.
    const free = rowFor("Lab");
    expect(within(free).queryByText(/Move or unschedule/)).toBeNull();
    expect(within(free).getByRole("button", { name: "Remove" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("announces a refused track removal in the row that was refused", async () => {
    stubFetch(() => refusal(IN_USE));
    render(<AgendaWorkspace event={event} onError={onError} />);

    await screen.findByText("Manage rooms, tracks, and times");
    const row = rowFor("Platform");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));

    expect(await within(row).findByText(IN_USE)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(IN_USE);
    expect(onError).not.toHaveBeenCalled();
  });

  it("announces a refused timeslot removal in the row and under the toolbar", async () => {
    stubFetch(() => refusal(IN_USE));
    render(<AgendaWorkspace event={event} onError={onError} />);

    const remove = await screen.findByRole("button", { name: /^Remove Tue, Sep 1/ });
    fireEvent.click(remove);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(IN_USE);
    expect(alert.previousElementSibling).toHaveClass("agenda-toolbar");
    const row = remove.closest(".resource-row");
    if (!row) throw new Error("the timeslot row is missing");
    expect(within(row as HTMLElement).getByText(IN_USE)).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("announces a refused publication beside the Publish button", async () => {
    stubFetch(() => refusal("Schedule conflicts must be resolved before publication"));
    render(<AgendaWorkspace event={event} onError={onError} />);

    fireEvent.click(await screen.findByRole("button", { name: "Publish schedule" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Schedule conflicts must be resolved before publication");
    expect(alert.previousElementSibling).toHaveClass("agenda-toolbar");
    expect(onError).not.toHaveBeenCalled();
  });

  it("announces a refused placement where the successful one would have announced", async () => {
    stubFetch(() => refusal("Slot not found", 404));
    render(<AgendaWorkspace event={event} onError={onError} />);

    // Pick the placed session up, then drop it in the other room: the same code path a
    // pointer drag ends in, and the one whose failure used to leave the board silent.
    fireEvent.click(await screen.findByRole("button", { name: /^Opening keynote\./ }));
    fireEvent.click(screen.getByRole("button", { name: /Place .+ in Lab/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Slot not found");
    expect(alert.previousElementSibling).toHaveClass("agenda-toolbar");
    expect(onError).not.toHaveBeenCalled();
  });

  it("still hands a failure to load to the page shell, which owns that notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "INTERNAL_ERROR",
                message: "The agenda could not be read.",
                correlationId: "correlation-2",
              },
            }),
            { status: 500 },
          ),
        ),
      ),
    );
    render(<AgendaWorkspace event={event} onError={onError} />);

    // There is no workspace to report this in — the board never rendered.
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The agenda could not be read."));
  });
});
