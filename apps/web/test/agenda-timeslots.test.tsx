// @acceptance ACC-AGENDA
/*
 * Timeslots are created and edited from the operator's own input, on the event's clock.
 *
 * The regression this guards is the one an evaluator would have hit first: the board
 * used to post a fixed instant seeded for a *different* event whenever the event it was
 * looking at had no slots, and there was no way to correct a slot afterwards. These are
 * jsdom tests because the whole question is what leaves the browser — which instants the
 * PUT body carries for a given zone and a given pair of typed wall-clock times.
 */
import type { EventDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaWorkspace } from "../src/AgendaWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

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

/** The slots of the last resources PUT, which is what the API would have stored. */
function slotsOf(sent: Sent[]) {
  const body = sent.at(-1)?.body as
    | { slots: { id: string; startsAt: string; endsAt: string }[] }
    | undefined;
  return body?.slots ?? [];
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

    // The next whole hour *in New York*, not in UTC and not a date from another event.
    const start = await screen.findByLabelText<HTMLInputElement>("New timeslot start");
    expect(start.value).toBe("2026-08-11T15:00");
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot end").value).toBe(
      "2026-08-11T16:00",
    );

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

    const start = await screen.findByLabelText("New timeslot start");
    fireEvent.change(start, { target: { value: "2026-10-05T09:30" } });
    fireEvent.change(screen.getByLabelText("New timeslot end"), {
      target: { value: "2026-10-05T10:45" },
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

    // 17:00Z is 13:00 in New York; the next slot starts where the last one ended.
    const start = await screen.findByLabelText<HTMLInputElement>("New timeslot start");
    expect(start.value).toBe("2026-09-01T13:00");
    expect(screen.getByLabelText<HTMLInputElement>("New timeslot end").value).toBe(
      "2026-09-01T14:00",
    );
  });

  it("edits an existing timeslot and sends only that slot's new instants", async () => {
    const sent = stubFetch(withSlot);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);

    // The row is filled from the server, on the event's clock: 16:00Z is 12:00 Eastern.
    const start = await screen.findByLabelText<HTMLInputElement>(/^Start of /);
    expect(start.value).toBe("2026-09-01T12:00");
    const save = screen.getByRole("button", { name: /^Save / });
    expect(save).toBeDisabled();

    fireEvent.change(start, { target: { value: "2026-09-01T09:15" } });
    fireEvent.change(screen.getByLabelText(/^End of /), { target: { value: "2026-09-01T10:15" } });
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

    fireEvent.change(await screen.findByLabelText("New timeslot start"), {
      target: { value: "2026-10-05T11:00" },
    });
    fireEvent.change(screen.getByLabelText("New timeslot end"), {
      target: { value: "2026-10-05T10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add timeslot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("End must be after start.");
    expect(screen.getByLabelText("New timeslot end")).toHaveAttribute("aria-invalid", "true");
    expect(sent).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
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

    const start = await screen.findByLabelText(/^Start of /);
    fireEvent.change(start, { target: { value: "2026-09-01T09:15" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save / }));

    await waitFor(() => expect(sent).toHaveLength(1));
    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent("Timeslot not saved. End must be after start");
    // The row keeps the operator's text and points at the reason it was rejected.
    expect(screen.getByLabelText<HTMLInputElement>(/^Start of /).value).toBe("2026-09-01T09:15");
    expect(screen.getByLabelText(/^End of /)).toHaveAttribute("aria-invalid", "true");
    // A field error is not a workspace failure; the page-level alert stays quiet.
    expect(onError).not.toHaveBeenCalled();
  });

  it("removes a timeslot without inventing a replacement", async () => {
    const sent = stubFetch(withSlot);
    render(<AgendaWorkspace event={eventIn("America/New_York")} onError={onError} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Remove / }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(slotsOf(sent)).toEqual([]);
  });
});
