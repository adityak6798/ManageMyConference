// @acceptance ACC-HARNESS
/*
 * The overview composes three independent workspaces. These tests hold it to the rule that
 * makes that safe: every source answers for itself. A source that has nothing to say yet
 * (an event nobody has scheduled has no agenda draft at all) is not a failure, a source that
 * fails degrades its own card, and a failed background poll never takes down a dashboard
 * that is already on screen.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import type { EventDto } from "@greenroom/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "../src/OverviewPage";
import { clearOrganizerOverviewCache, getOrganizerOverview } from "../src/api/overview";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000002";
const speakerId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const proposalId = "44444444-4444-4444-8444-444444444444";

const event: EventDto = {
  id: eventId,
  organizationId,
  name: "Greenroom Workshop Day",
  timezone: "UTC",
  createdAt: "2026-08-01T12:00:00.000Z",
};

/** What the *published* agenda says about this session, or nothing when it places none. */
type PublishedSchedule = { startsAt: string; endsAt: string; location: string };

function contentWorkspace(taskTitle = "Send your slides", schedule?: PublishedSchedule) {
  return {
    sessions: [
      {
        id: sessionId,
        eventId,
        proposalId,
        title: "Designing the calm conference",
        abstract: "Quiet rooms.",
        format: "talk",
        speakerProfileIds: [speakerId],
        tags: [],
        tracks: [],
        publicationState: "ready",
        ...(schedule ? { schedule } : {}),
      },
    ],
    speakers: [
      {
        id: speakerId,
        eventId,
        userId: "seed-speaker",
        sourcePersonId: "person-1",
        name: "Sam Speaker",
        email: "sam@example.com",
        bio: "",
        pronouns: "",
        organization: "Calm Co",
      },
    ],
    tasks: [
      {
        id: taskId,
        eventId,
        speakerProfileId: speakerId,
        title: taskTitle,
        dueAt: "2026-08-20T23:59:00.000Z",
        status: "open",
      },
    ],
    assets: [],
    messages: [],
  };
}

const reviewWorkspace = {
  proposals: [
    {
      id: proposalId,
      eventId,
      title: "Typed boundaries at scale",
      abstract: "Types.",
      submitterName: "Jordan Lee",
      submitter: null,
      answers: [],
      status: "submitted",
    },
  ],
  plan: null,
  assignments: [],
  outcomes: [],
  audit: [],
  statuses: [],
  reviewers: [],
};

const agendaDraft = {
  eventId,
  rooms: [],
  tracks: [],
  slots: [],
  sessions: [],
  placements: [],
  occurrences: { sessions: {}, slots: {} },
  conflicts: [],
};

const OPENING = {
  id: "slot-0900",
  startsAt: "2026-09-01T16:00:00.000Z",
  endsAt: "2026-09-01T17:00:00.000Z",
};
const LATER = {
  id: "slot-1000",
  startsAt: "2026-09-01T17:00:00.000Z",
  endsAt: "2026-09-01T18:00:00.000Z",
};

/** The working draft with the one session dropped into `slotId`. */
function placedAgenda(slotId: string, roomId = "room-main") {
  return {
    ...agendaDraft,
    rooms: [{ id: "room-main", name: "Main stage" }],
    tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
    slots: [OPENING, LATER],
    placements: [{ id: "placement-opening", sessionId, roomId, trackId: "track-platform", slotId }],
  };
}

/** The value rendered under a stat's own label, so two stats cannot be confused. */
function stat(label: string) {
  return screen.getByText(label).closest(".stat")?.querySelector("dd")?.textContent;
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const panel = (value: unknown | false | "missing") =>
  value === false
    ? { ok: false, error: { code: "INTERNAL_ERROR", message: "Failed", correlationId: "t-1" } }
    : value === "missing"
      ? { ok: false, error: { code: "NOT_FOUND", message: "Missing", correlationId: "t-1" } }
      : { ok: true, data: value };

function overviewResponse(
  options: {
    content?: unknown | false;
    review?: unknown | false;
    agenda?: unknown | false | "missing";
  } = {},
) {
  return {
    content: panel(options.content ?? contentWorkspace()),
    review: panel(options.review ?? reviewWorkspace),
    agenda: panel(options.agenda ?? agendaDraft),
    publication: panel({
      eventId,
      slug: "greenroom-workshop-day",
      state: "published",
      draft: {
        event: {
          eventId,
          slug: "greenroom-workshop-day",
          name: "Workshop day",
          summary: "A workshop.",
          startsOn: "2026-09-01",
          endsOn: "2026-09-01",
          timezone: "UTC",
          venue: "Online",
        },
        cfp: {
          title: "CFP",
          description: "Submit.",
          status: "closed",
          publishedAt: null,
          submissionUrl: "/cfp",
        },
        sessions: [],
        speakers: [],
      },
      published: null,
      publishedAt: null,
    }),
  };
}

/** Routes the three overview reads; `false` makes that source fail with a 500. */
function stubOverviewFetch(sources: {
  content?: unknown | false;
  review?: unknown | false;
  agenda?: unknown | false | "missing";
}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/overview")) return json(overviewResponse(sources));
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("overview dashboard", () => {
  beforeEach(() => {
    clearOrganizerOverviewCache();
    // waitFor still needs a clock that moves, so the fake timers advance with real time
    // and the 15s refresh is fired explicitly where a test needs it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the dashboard for an event whose agenda has never been drafted", async () => {
    // The draft is created by the first placement, so every event before its first
    // placement answers 404 here — the second seeded event and every event an organizer
    // creates. That is "nothing is scheduled", not a broken dashboard.
    stubOverviewFetch({ agenda: "missing" });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    expect(await screen.findByText("Sam Speaker")).toBeInTheDocument();
    expect(screen.getByText("Typed boundaries at scale")).toBeInTheDocument();
    // Nothing is placed, so the one accepted session is the one that needs a slot.
    expect(screen.getByText("Designing the calm conference")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/The overview could not be loaded/)).not.toBeInTheDocument();
  });

  it("uses one request for first paint and reuses it across a remount", async () => {
    const fetchMock = stubOverviewFetch({});
    const first = render(<OverviewPage event={event} query={`?event=${eventId}`} />);
    await screen.findByText("Sam Speaker");
    const firstStamp = screen.getByText(/^Updated /).textContent;
    first.unmount();
    vi.setSystemTime(new Date("2026-08-11T13:00:00.000Z"));
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);
    await screen.findByText("Sam Speaker");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Updated /)).toHaveTextContent(firstStamp ?? "Updated");
  });

  it("deduplicates callers while the overview request is still in flight", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ) as unknown as typeof fetch;

    const first = getOrganizerOverview(eventId, { fetcher });
    const second = getOrganizerOverview(eventId, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish?.(new Response(JSON.stringify(overviewResponse())));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("degrades only the panel whose workspace failed", async () => {
    stubOverviewFetch({ content: false });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    // Review answered, so its card is fully live…
    expect(await screen.findByText("Typed boundaries at scale")).toBeInTheDocument();
    // …while the content-backed panels say what is missing, in place, and the page survives.
    expect(screen.getByText("Speaker onboarding could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText(/The overview could not be loaded/)).not.toBeInTheDocument();
  });

  it("reports the whole page only when no source answered at all", async () => {
    stubOverviewFetch({ content: false, review: false, agenda: false });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The overview could not be loaded. Reload to try again.",
    );
  });

  it("renders a terminal error when the aggregate response itself drifts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Reference: unavailable");
  });

  it("keeps a rendered dashboard when a background refresh fails", async () => {
    let contentFails = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/overview"))
          return json(overviewResponse({ content: contentFails ? false : contentWorkspace() }));
        throw new Error(`unexpected request ${url}`);
      }),
    );
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);
    await screen.findByText("Send your slides");

    contentFails = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // The data that was on screen is still on screen, and the freshness stamp — not the
    // page — carries the failure.
    expect(screen.getByText("Send your slides")).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh — showing data from/)).toBeInTheDocument();
    expect(screen.queryByText(/The overview could not be loaded/)).not.toBeInTheDocument();
  });

  it("ignores a poll that lands after a newer one", async () => {
    let releaseFirst: (response: Response) => void = () => undefined;
    const deferred = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    let contentCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/overview")) {
          contentCalls += 1;
          return contentCalls === 1
            ? deferred
            : json(overviewResponse({ content: contentWorkspace("Fresh task") }));
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(await screen.findByText("Fresh task")).toBeInTheDocument();

    // The first poll finally answers, with what the dashboard knew 15 seconds ago.
    await act(async () => {
      releaseFirst(
        new Response(JSON.stringify(overviewResponse({ content: contentWorkspace("Stale task") }))),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Fresh task")).toBeInTheDocument();
    expect(screen.queryByText("Stale task")).not.toBeInTheDocument();
  });
});

/*
 * "Scheduled" is two questions, and the organizer console answers both — Overview from the
 * working board, Sessions & speakers from the published snapshot. They used to answer them
 * under the same word, so a session dropped into a slot read as scheduled on one screen and
 * "Not on the published schedule" on the other, one click apart. The screens still read
 * different sources on purpose: placing is the work Overview counts, and publishing is what
 * the portal, the .ics and the public programme wait for. These hold both halves in place —
 * every label names its own source, and the gap between them is counted rather than hidden.
 */
describe("the board and the published schedule", () => {
  beforeEach(() => clearOrganizerOverviewCache());
  afterEach(() => {
    clearOrganizerOverviewCache();
    cleanup();
    vi.unstubAllGlobals();
  });

  it("counts the board, and reports the placement the published schedule has not caught up with", async () => {
    // Placed on the board this morning; the agenda has not been published since.
    stubOverviewFetch({ agenda: placedAgenda(OPENING.id) });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    await screen.findByText("Sam Speaker");
    // Nothing is waiting to be placed: the board's question is answered, and the stat says
    // which question that is rather than claiming the session is "scheduled".
    expect(stat("Not on the board")).toBe("0");
    expect(screen.getByText("Every accepted session is on the board")).toBeInTheDocument();
    // …and the other question is answered next to it instead of being left to a second screen.
    expect(
      screen.getByText(/The board and the published schedule differ on 1 session\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 board change not published yet/)).toBeInTheDocument();
    expect(stat("Not on the board")).toBe("0");
  });

  it("says the two agree when the published snapshot matches the board", async () => {
    stubOverviewFetch({
      content: contentWorkspace("Send your slides", {
        startsAt: OPENING.startsAt,
        endsAt: OPENING.endsAt,
        location: "Main stage",
      }),
      agenda: placedAgenda(OPENING.id),
    });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    await screen.findByText("Sam Speaker");
    expect(screen.getByText(/The board and the published schedule agree\./)).toBeInTheDocument();
    expect(screen.queryByText(/differ on/)).toBeNull();
    expect(screen.queryByText(/board change/)).toBeNull();
  });

  it("reports a session moved on the board since the last agenda publication", async () => {
    // The published snapshot still holds the 16:00 slot; the board now says 17:00. Presence
    // on both sides is not agreement — this is the case a "has it got a schedule?" check misses.
    stubOverviewFetch({
      content: contentWorkspace("Send your slides", {
        startsAt: OPENING.startsAt,
        endsAt: OPENING.endsAt,
        location: "Main stage",
      }),
      agenda: placedAgenda(LATER.id),
    });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    await screen.findByText("Sam Speaker");
    expect(stat("Not on the board")).toBe("0");
    expect(
      screen.getByText(/The board and the published schedule differ on 1 session\./),
    ).toBeInTheDocument();
  });

  it("treats a placement whose slot the board no longer holds as unplaced, exactly as the agenda does", async () => {
    // `placedSessionTimes` drops a placement with no slot: a session with an unusable start is
    // unplaced, not placed at an unknown hour. Counting the raw placement instead would report
    // this session as on the board and leave the organizer with nothing to fix.
    const orphaned = { ...placedAgenda(OPENING.id), slots: [] };
    stubOverviewFetch({
      // The published schedule still carries the session, so the two sides genuinely
      // disagree and the card that lists it has to say so alongside the list.
      content: contentWorkspace("Send your slides", {
        startsAt: OPENING.startsAt,
        endsAt: OPENING.endsAt,
        location: "Main stage",
      }),
      agenda: orphaned,
    });
    render(<OverviewPage event={event} query={`?event=${eventId}`} />);

    await screen.findByText("Sam Speaker");
    expect(stat("Not on the board")).toBe("1");
    expect(screen.getByText(/1 accepted session not on the agenda board/)).toBeInTheDocument();
    // It is unplaced *and* unpublished, and the card that lists it still says so.
    expect(
      screen.getByText(/The board and the published schedule differ on 1 session\./),
    ).toBeInTheDocument();
    expect(screen.getByText("Designing the calm conference")).toBeInTheDocument();
  });
});
