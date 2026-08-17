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
const sessionId = "223e4567-e89b-42d3-a456-426614174000";

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
  sessions: [{ id: sessionId, title: "Opening keynote", speakerIds: [] }],
  placements: [
    {
      id: "placement-opening",
      sessionId,
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-0900",
    },
  ],
  occurrences: { sessions: {}, slots: {} },
  conflicts: [],
};

const IN_USE = "Remove affected placements before deleting resources";

/**
 * The box `useActionFeedback` draws, given the paragraph inside it that carries the alert.
 *
 * The announcement is a live region nested in the region's own body, so that a correlation
 * reference can sit beside the sentence rather than be read out ahead of it. Where the
 * *region* sits in the document is what these tests are about.
 */
function feedbackRegion(alert: HTMLElement): HTMLElement {
  const region = alert.closest(".notice");
  if (!(region instanceof HTMLElement))
    throw new Error("the alert is not inside a feedback region");
  return region;
}

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

/** A complete Content projection whose publication field was removed by field policy. */
function stubRedactedPublicationFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/content"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sessions: [
                {
                  id: sessionId,
                  eventId,
                  proposalId: "proposal-opening",
                  title: "Opening keynote",
                  speakerProfileIds: [],
                },
              ],
              speakers: [],
              tasks: [],
              assets: [],
              messages: [],
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(new Response(JSON.stringify({ agenda: board }), { status: 200 }));
    }),
  );
}

/** Open the rooms, tracks and times drawer the board bar leads to. */
async function openResources() {
  fireEvent.click(await screen.findByRole("button", { name: "Rooms and times" }));
  return screen.findByRole("dialog", { name: "Rooms, tracks and times" });
}

/**
 * The drawer row for a room or track, by the name it is holding. Rooms and tracks are edited
 * in place now — the rename used to be a `window.prompt()` — so the row is a form named after
 * what it currently holds, and the name itself lives in an input.
 */
function rowFor(name: string): HTMLElement {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(".agenda-resources .resource-row"),
  );
  const row = rows.find((candidate) =>
    Array.from(candidate.querySelectorAll("input")).some((input) => input.value === name),
  );
  if (!row) throw new Error(`No resources row is holding “${name}”.`);
  return row;
}

describe("AgendaWorkspace failure feedback", () => {
  const onError = vi.fn<(message: string) => void>();

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    onError.mockReset();
  });

  it("announces a refused room removal under the board bar, not below the workspace", async () => {
    const writes = stubFetch(() => refusal(IN_USE));
    render(<AgendaWorkspace event={event} onError={onError} />);

    const drawer = await openResources();
    const row = rowFor("Main stage");
    fireEvent.click(within(row).getByRole("button", { name: /^Remove/ }));

    await waitFor(() => expect(writes).toHaveLength(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(IN_USE);

    // The live region is the workspace's own — the feedback region directly after the board
    // bar, which is where every successful agenda action already announces itself. The region
    // is the box `useActionFeedback` draws; the alert is the paragraph inside it.
    expect(feedbackRegion(alert).previousElementSibling).toHaveClass("agenda-bar");
    // …and it is not inside the drawer the operator clicked in.
    expect(drawer.contains(alert)).toBe(false);

    // The row that was refused says so too, so the reason is legible from the button.
    expect(within(row).getByText(IN_USE)).toBeInTheDocument();
    // Nothing is handed to the page shell: this is not a page-level failure.
    expect(onError).not.toHaveBeenCalled();
  });

  it("says a room is holding sessions before the organizer clicks Remove", async () => {
    stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);

    await openResources();
    const row = rowFor("Main stage");
    const note = within(row).getByText(
      "Holds 1 scheduled session. Move or unschedule it before removing this room.",
    );
    // A disabled button cannot be focused, so the reason travels with the live one.
    expect(within(row).getByRole("button", { name: /^Remove/ })).toHaveAttribute(
      "aria-describedby",
      note.id,
    );

    // A room with nothing in it carries no warning at all.
    const free = rowFor("Lab");
    expect(within(free).queryByText(/Move or unschedule/)).toBeNull();
    expect(within(free).getByRole("button", { name: /^Remove/ })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  /*
   * Naming a room is now a row of the drawer rather than a `window.prompt()`.
   *
   * The prompt was browser chrome the design language forbids: unstyleable, unlabelled, and with
   * nowhere to report a refusal. Enter commits, Escape puts back what the server holds, and the
   * row's own error slot is where a refusal lands.
   */
  it("renames a room in place, and reverts the row on Escape", async () => {
    const writes = stubFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);

    await openResources();
    const row = rowFor("Main stage");
    const name = within(row).getByRole("textbox") as HTMLInputElement;
    const save = within(row).getByRole("button", { name: /^Save/ });
    expect(save).toBeDisabled();

    fireEvent.change(name, { target: { value: "Great hall" } });
    expect(save).toBeEnabled();
    fireEvent.keyDown(name, { key: "Escape" });
    expect(name.value).toBe("Main stage");
    expect(writes).toHaveLength(0);

    fireEvent.change(name, { target: { value: "Great hall" } });
    fireEvent.submit(row);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatch(/PUT .*\/agenda\/resources$/);
    expect(await screen.findByRole("status")).toHaveTextContent("Room renamed.");
  });

  it("announces a refused track removal in the row that was refused", async () => {
    stubFetch(() => refusal(IN_USE));
    render(<AgendaWorkspace event={event} onError={onError} />);

    await openResources();
    const row = rowFor("Platform");
    fireEvent.click(within(row).getByRole("button", { name: /^Remove/ }));

    expect(await within(row).findByText(IN_USE)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(IN_USE);
    expect(onError).not.toHaveBeenCalled();
  });

  it("announces a refused timeslot removal in the row and under the board bar", async () => {
    stubFetch(() => refusal(IN_USE));
    render(<AgendaWorkspace event={event} onError={onError} />);

    await openResources();
    const remove = await screen.findByRole("button", { name: /^Remove Tue, Sep 1/ });
    fireEvent.click(remove);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(IN_USE);
    expect(feedbackRegion(alert).previousElementSibling).toHaveClass("agenda-bar");
    const row = remove.closest(".resource-row");
    if (!row) throw new Error("the timeslot row is missing");
    expect(within(row as HTMLElement).getByText(IN_USE)).toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
  });

  it("announces a refused publication where every other agenda outcome announces", async () => {
    stubFetch(() => refusal("Schedule conflicts must be resolved before publication"));
    render(<AgendaWorkspace event={event} onError={onError} />);

    // Publication is irreversible, so the press opens a confirmation carrying the preview of
    // what will be public rather than committing on the first click.
    fireEvent.click(await screen.findByRole("button", { name: "Publish schedule" }));
    const confirm = await screen.findByRole("dialog", { name: "Publish the schedule" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Publish schedule" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Schedule conflicts must be resolved before publication");
    expect(feedbackRegion(alert).previousElementSibling).toHaveClass("agenda-bar");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not invent a public count when field policy hides publication readiness", async () => {
    stubRedactedPublicationFetch();
    render(<AgendaWorkspace event={event} onError={onError} />);

    const publish = await screen.findByRole("button", { name: "Publish schedule" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(publish).toHaveAccessibleName("Publish schedule");
    fireEvent.click(publish);
    // No numeric preview at all, rather than a confidently wrong zero.
    expect(
      await screen.findByText(
        "Every scheduled session that is published in Sessions will appear on the public page.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will appear on the public page; the rest/)).toBeNull();
  });

  it("announces a refused placement where the successful one would have announced", async () => {
    stubFetch(() => refusal("Slot not found", 404));
    render(<AgendaWorkspace event={event} onError={onError} />);

    // Pick the placed session up, then drop it in the other room: the same code path a
    // pointer drag ends in, and the one whose failure used to leave the board silent.
    fireEvent.click(await screen.findByRole("button", { name: /^Opening keynote\./ }));
    fireEvent.click(screen.getByRole("gridcell", { name: /Place .+ in Lab/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Slot not found");
    expect(feedbackRegion(alert).previousElementSibling).toHaveClass("agenda-bar");
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
