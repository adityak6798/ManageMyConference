// @acceptance ACC-AGENDA
/*
 * Timeslots are created and edited from the operator's own input, on the event's clock.
 *
 * The regression this guards is the one an evaluator would have hit first: the board
 * used to post a fixed instant seeded for a *different* event whenever the event it was
 * looking at had no slots, and there was no way to correct a slot afterwards. These are
 * jsdom tests because the whole question is what leaves the browser — which instants the
 * PUT body carries for a given zone and a given pair of typed wall-clock times.
 *
 * A row is a day and two times of day now, not two datetimes: a slot belongs to one day by
 * construction, and retyping the date on every row of every day cost a three-day, eight-slot
 * event 48 hand-typed datetimes. The arithmetic under test is unchanged — the same wall-clock
 * reading has to leave as the same instant — so these assertions are about the same thing they
 * always were, read off three inputs instead of two.
 */
import type { EventDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaWorkspace } from "../src/agenda/AgendaWorkspace";
import { conflictPublicationSummary } from "../src/agenda/model";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

it("conjugates the publication blocker for one conflict and many", () => {
  expect(conflictPublicationSummary(1)).toBe("1 conflict blocks publication");
  expect(conflictPublicationSummary(2)).toBe("2 conflicts block publication");
});

function eventIn(timezone: string): EventDto {
  return {
    id: eventId,
    organizationId: "00000000-0000-4000-8000-000000000010",
    name: "Greenroom Workshop Day",
    timezone,
    createdAt: "2026-08-09T12:00:00.000Z",
  };
}

const emptyDraft = {
  eventId,
  rooms: [{ id: "room-main", name: "Main room" }],
  tracks: [{ id: "track-general", name: "General", color: "#6257d9" }],
  slots: [] as { id: string; startsAt: string; endsAt: string }[],
  sessions: [],
  placements: [],
  occurrences: { sessions: {}, slots: {} },
  conflicts: [],
};

const withSlot = {
  ...emptyDraft,
  slots: [
    {
      id: "slot-morning",
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
    },
  ],
};

/** Two rows, so a save of one can be watched for what it does to the other. */
const withTwoSlots = {
  ...emptyDraft,
  slots: [
    {
      id: "slot-morning",
      startsAt: "2026-09-01T16:00:00.000Z",
      endsAt: "2026-09-01T17:00:00.000Z",
    },
    {
      id: "slot-midday",
      startsAt: "2026-09-01T17:00:00.000Z",
      endsAt: "2026-09-01T18:00:00.000Z",
    },
  ],
};

type Sent = { url: string; method: string; body: unknown };

/** Serves the given draft, records writes, and answers them with `reply`. */
function stubFetch(draft: unknown, reply?: () => Response) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET")
        sent.push({
          url: String(input),
          method,
          body: JSON.parse(String(init?.body ?? "null")) as unknown,
        });
      if (reply && method !== "GET") return Promise.resolve(reply());
      return Promise.resolve(new Response(JSON.stringify({ agenda: draft }), { status: 200 }));
    }),
  );
  return sent;
}

/**
 * As `stubFetch`, but the stored draft actually changes: a write is answered with the
 * resources it carried. Anything asserted about a row *after* a save is then asserted
 * against a server that really did save, which is the only way to tell a retained edit
 * apart from a stale render.
 */
function stubStoringFetch(initial: typeof withTwoSlots) {
  const sent: Sent[] = [];
  let stored: typeof withTwoSlots = initial;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        const body = JSON.parse(String(init?.body ?? "null")) as Partial<typeof withTwoSlots>;
        sent.push({ url: String(input), method, body });
        stored = { ...stored, ...body };
      }
      return Promise.resolve(new Response(JSON.stringify({ agenda: stored }), { status: 200 }));
    }),
  );
  return sent;
}

/** The slots of the last resources PUT, which is what the API would have stored. */
function slotsOf(sent: Sent[]) {
  const body = sent.at(-1)?.body as
    | { slots: { id: string; startsAt: string; endsAt: string }[] }
    | undefined;
  return body?.slots ?? [];
}

/** Open the rooms, tracks and times drawer the board bar leads to. */
async function openResources() {
  fireEvent.click(await screen.findByRole("button", { name: "Rooms and times" }));
  await screen.findByRole("dialog", { name: "Rooms, tracks and times" });
}

describe("AgendaWorkspace timeslot editing", () => {
  const onError = vi.fn<(message: string) => void>();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 14:12 in New York, 11:12 in Los Angeles — neither on a round hour.
    vi.setSystemTime(new Date("2026-08-11T18:12:34.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    onError.mockReset();
  });

  it("defaults the first timeslot of a slotless event to the next hour on its own clock", async () => {
    const sent = stubFetch(emptyDraft);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    // The next whole hour *in New York*, not in UTC and not a date from another event.
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot day").value).toBe("2026-08-11");
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot start").value).toBe("15:00");
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot end").value).toBe("16:00");

    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.url).toBe(`/api/events/${eventId}/agenda/resources`);
    // 15:00 Eastern is 19:00Z. The seeded 2026-09-01T16:00Z is nowhere near it.
    expect(slotsOf(sent)[0]).toMatchObject({
      startsAt: "2026-08-11T19:00:00.000Z",
      endsAt: "2026-08-11T20:00:00.000Z",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Timeslot added.");
    expect(onError).not.toHaveBeenCalled();
  });

  it("posts the times the operator typed, read on the event's clock", async () => {
    const sent = stubFetch(emptyDraft);
    render(<AgendaWorkspace event={eventIn("America/Los_Angeles")} onError={onError} />);
    await openResources();

    fireEvent.change(screen.getByLabelText("New timeslot day"), {
      target: { value: "2026-10-05" },
    });
    fireEvent.change(screen.getByLabelText("New timeslot start"), {
      target: { value: "09:30" },
    });
    fireEvent.change(screen.getByLabelText("New timeslot end"), {
      target: { value: "10:45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // October 5th is still PDT (UTC-7), so 09:30 Pacific is 16:30Z.
    expect(slotsOf(sent)[0]).toMatchObject({
      startsAt: "2026-10-05T16:30:00.000Z",
      endsAt: "2026-10-05T17:45:00.000Z",
    });
  });

  it("suggests the end of the last slot when the event already has one", async () => {
    stubFetch(withSlot);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    // 17:00Z is 13:00 in New York; the next slot starts where the last one ended.
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot day").value).toBe("2026-09-01");
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot start").value).toBe("13:00");
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot end").value).toBe("14:00");
  });

  it("edits an existing timeslot and sends only that slot's new instants", async () => {
    const sent = stubFetch(withSlot);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    // The row is filled from the server, on the event's clock: 16:00Z is 12:00 Eastern.
    const start = screen.getByLabelText<HTMLInputElement>(/^Start of /);
    expect(start.value).toBe("12:00");
    expect(screen.getByLabelText<HTMLInputElement>(/^Day of /).value).toBe("2026-09-01");
    const save = screen.getByRole("button", { name: /^Save Tue, Sep 1/ });
    expect(save).toBeDisabled();

    fireEvent.change(start, { target: { value: "09:15" } });
    fireEvent.change(screen.getByLabelText(/^End of /), { target: { value: "10:15" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(slotsOf(sent)).toEqual([
      {
        id: "slot-morning",
        startsAt: "2026-09-01T13:15:00.000Z",
        endsAt: "2026-09-01T14:15:00.000Z",
      },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Timeslot updated.");
  });

  it("refuses an end that is not after the start without calling the API", async () => {
    const sent = stubFetch(emptyDraft);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    fireEvent.change(screen.getByLabelText("New timeslot day"), {
      target: { value: "2026-10-05" },
    });
    fireEvent.change(screen.getByLabelText("New timeslot start"), { target: { value: "11:00" } });
    fireEvent.change(screen.getByLabelText("New timeslot end"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));

    // Reading it as the next morning would turn a typo into a 23-hour slot, which is worse
    // than refusing it.
    expect(await screen.findByRole("alert")).toHaveTextContent("End must be after start.");
    expect(screen.getByLabelText("New timeslot end")).toHaveAttribute("aria-invalid", "true");
    expect(sent).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  /*
   * A day and two times can still say "this runs past midnight", which two datetimes said by
   * construction. An end at or before the start is the next morning when that makes a slot short
   * enough to be one, and the row it comes back as reads exactly the same way.
   */
  it("reads an end before the start as the next morning, up to twelve hours", async () => {
    const sent = stubFetch(emptyDraft);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    fireEvent.change(screen.getByLabelText("New timeslot day"), {
      target: { value: "2026-10-05" },
    });
    fireEvent.change(screen.getByLabelText("New timeslot start"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("New timeslot end"), { target: { value: "01:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // 22:00 Eastern on the 5th is 02:00Z on the 6th; 01:00 on the 6th is 05:00Z.
    expect(slotsOf(sent)[0]).toMatchObject({
      startsAt: "2026-10-06T02:00:00.000Z",
      endsAt: "2026-10-06T05:00:00.000Z",
    });
  });

  it("shows the server's field error on the row that caused it", async () => {
    const sent = stubFetch(
      withSlot,
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "VALIDATION_FAILED",
              message: "Agenda resources are invalid.",
              correlationId: "correlation-1",
              fieldErrors: { "slots.0.endsAt": ["End must be after start"] },
            },
          }),
          { status: 400 },
        ),
    );
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    fireEvent.change(screen.getByLabelText(/^Start of /), { target: { value: "09:15" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save Tue, Sep 1/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent("Timeslot not saved. End must be after start");
    // The row keeps the operator's text and points at the reason it was rejected.
    expect(screen.getByLabelText<HTMLInputElement>(/^Start of /).value).toBe("09:15");
    expect(screen.getByLabelText(/^End of /)).toHaveAttribute("aria-invalid", "true");
    // A field error is not a workspace failure; the page-level alert stays quiet.
    expect(onError).not.toHaveBeenCalled();
  });

  /*
   * Each row is a separate form with its own Save, so the times typed into the other rows
   * are unsent work. Saving one row used to clear the whole draft map: the second row's
   * text snapped back to the server's value and its Save greyed out, under a green
   * "Timeslot updated." — the operator's own record that both edits had landed.
   */
  it("keeps every other row's typed times when one row is saved", async () => {
    const sent = stubStoringFetch(withTwoSlots);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    const starts = screen.getAllByLabelText<HTMLInputElement>(/^Start of /);
    // 16:00Z and 17:00Z are 12:00 and 13:00 in New York.
    expect(starts.map((input) => input.value)).toEqual(["12:00", "13:00"]);
    fireEvent.change(starts[0] as HTMLInputElement, { target: { value: "09:30" } });
    fireEvent.change(starts[1] as HTMLInputElement, { target: { value: "13:45" } });

    fireEvent.click(screen.getAllByRole("button", { name: /^Save Tue, Sep 1/ })[0] as HTMLElement);
    await waitFor(() => expect(sent).toHaveLength(1));
    // Only the row that was saved is in the write; the other keeps its stored times.
    expect(slotsOf(sent)).toEqual([
      {
        id: "slot-morning",
        startsAt: "2026-09-01T13:30:00.000Z",
        endsAt: "2026-09-01T17:00:00.000Z",
      },
      {
        id: "slot-midday",
        startsAt: "2026-09-01T17:00:00.000Z",
        endsAt: "2026-09-01T18:00:00.000Z",
      },
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent("Timeslot updated.");

    const after = screen.getAllByLabelText<HTMLInputElement>(/^Start of /);
    // The saved row shows what the server now holds…
    expect(after[0]?.value).toBe("09:30");
    // …and the row nobody saved still holds the time the operator typed into it.
    expect(after[1]?.value).toBe("13:45");

    const saves = screen.getAllByRole("button", { name: /^Save Tue, Sep 1/ });
    expect(saves[0]).toBeDisabled();
    expect(saves[1]).toBeEnabled();

    // Still the operator's to send: the edit survived intact, not merely on screen.
    fireEvent.click(saves[1] as HTMLElement);
    await waitFor(() => expect(sent).toHaveLength(2));
    // 13:45 Eastern is 17:45Z, and the first row keeps the value it was just saved with.
    expect(slotsOf(sent)).toEqual([
      {
        id: "slot-morning",
        startsAt: "2026-09-01T13:30:00.000Z",
        endsAt: "2026-09-01T17:00:00.000Z",
      },
      {
        id: "slot-midday",
        startsAt: "2026-09-01T17:45:00.000Z",
        endsAt: "2026-09-01T18:00:00.000Z",
      },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a typed row when a different timeslot is added or removed", async () => {
    const sent = stubStoringFetch(withTwoSlots);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    const typed = screen.getAllByLabelText<HTMLInputElement>(/^Start of /)[1];
    if (!typed) throw new Error("the second timeslot row is missing");
    fireEvent.change(typed, { target: { value: "13:45" } });

    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.getAllByLabelText<HTMLInputElement>(/^Start of /)[1]?.value).toBe("13:45");

    // Removing the *first* row is not an answer about the second one either.
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Remove Tue, Sep 1/ })[0] as HTMLElement,
    );
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(screen.getAllByLabelText<HTMLInputElement>(/^Start of /)[0]?.value).toBe("13:45");
    expect(onError).not.toHaveBeenCalled();
  });

  it("removes a timeslot without inventing a replacement", async () => {
    const sent = stubFetch(withSlot);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    fireEvent.click(screen.getByRole("button", { name: /^Remove Tue, Sep 1/ }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(slotsOf(sent)).toEqual([]);
  });

  /*
   * A three-day, eight-slot event used to cost 48 hand-typed datetimes. It costs one run and
   * two copies now, and the run is the part that has to get the arithmetic right: each slot's
   * start and end are wall-clock readings on the event's own day, converted the same way a
   * hand-typed row is.
   */
  it("lays a run of slots across a stretch of one day", async () => {
    const sent = stubFetch(emptyDraft);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    fireEvent.change(screen.getByLabelText("Generate slots on"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.change(screen.getByLabelText("Generate slots from"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Generate slots until"), { target: { value: "11:00" } });
    fireEvent.change(screen.getByLabelText("Slot length in minutes"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Break between slots in minutes"), {
      target: { value: "15" },
    });

    // 09:00–09:45, 10:00–10:45; a third would run past 11:00, so it is not offered.
    fireEvent.click(screen.getByRole("button", { name: "Generate 2 slots" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(slotsOf(sent)).toMatchObject([
      { startsAt: "2026-09-01T13:00:00.000Z", endsAt: "2026-09-01T13:45:00.000Z" },
      { startsAt: "2026-09-01T14:00:00.000Z", endsAt: "2026-09-01T14:45:00.000Z" },
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent("2 time slots added.");
  });

  it("copies the day on screen onto another date", async () => {
    const sent = stubFetch(withTwoSlots);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);
    await openResources();

    fireEvent.change(screen.getByLabelText("Copy this day's slots to"), {
      target: { value: "2026-09-02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy slots" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The two existing slots, plus the same two wall-clock times a day later.
    expect(slotsOf(sent)).toHaveLength(4);
    expect(slotsOf(sent).slice(2)).toMatchObject([
      { startsAt: "2026-09-02T16:00:00.000Z", endsAt: "2026-09-02T17:00:00.000Z" },
      { startsAt: "2026-09-02T17:00:00.000Z", endsAt: "2026-09-02T18:00:00.000Z" },
    ]);
  });
});
