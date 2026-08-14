// @acceptance ACC-OPS
/*
 * The inbox's central claim is that its items are *derived*.
 *
 * So the tests are mostly about absence: the item that disappears when the condition it named is
 * resolved, with nothing written anywhere; the dismissal that survives a re-derivation of the
 * same occurrence and does not survive a new one; the category a role cannot read being omitted
 * rather than refusing the surface.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryInboxDismissalStore } from "../src/adapters/persistence/d1-platform-repository";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import { AgendaNotFoundError, AgendaService } from "../src/application/agenda/public";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import {
  type Actor,
  AuthenticationRequiredError,
  type Capability,
  CapabilityDeniedError,
} from "../src/application/identity/actor";
import {
  InboxItemNotFoundError,
  PlatformInboxService,
  type PlatformSources,
} from "../src/application/platform/public";

const EVENT_ONE = "00000000-0000-4000-8000-000000000001";
const EVENT_TWO = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const NOW = new Date("2026-08-21T12:00:00.000Z");

const actorOf = (
  id: string,
  persona: Actor["persona"],
  access: readonly { eventId: string; role: Actor["eventAccess"][number]["role"] }[],
  capabilities: readonly Capability[],
): Actor => ({
  id,
  name: id,
  persona,
  organizations: [{ id: ORGANIZATION }],
  eventAccess: access.map(({ eventId, role }) => ({
    eventId,
    role,
    capabilities: new Set(capabilities),
  })),
  capabilities: new Set(capabilities),
});

const organizer = actorOf(
  "seed-organizer",
  "organizer",
  [
    { eventId: EVENT_ONE, role: "organizer" },
    { eventId: EVENT_TWO, role: "organizer" },
  ],
  [
    "events:read",
    "events:settings:read",
    "content:read",
    "review:manage",
    "agenda:manage",
    "communications:manage",
  ],
);

const secondOrganizer = actorOf(
  "other-organizer",
  "organizer",
  [{ eventId: EVENT_ONE, role: "organizer" }],
  ["events:read", "events:settings:read", "content:read", "review:manage", "agenda:manage"],
);

const reviewer = actorOf(
  "seed-reviewer",
  "reviewer",
  [{ eventId: EVENT_ONE, role: "reviewer" }],
  ["events:read", "review:evaluate"],
);

const refuse = () => Promise.reject(new CapabilityDeniedError("Actor lacks the capability"));

/** One open task, one outstanding assignment, one unplaced session, one dead delivery. */
function sources(overrides: Partial<PlatformSources> = {}): PlatformSources {
  return {
    events: { organizationOf: async () => ORGANIZATION },
    content: {
      workspace: async (_actor: unknown, eventId: string) => ({
        sessions: [],
        speakers: [
          {
            id: "speaker-1",
            name: "Sam Speaker",
            email: "sam@example.test",
            bio: "",
            organization: "",
          },
        ],
        tasks:
          eventId === EVENT_ONE
            ? [
                {
                  id: "task-1",
                  title: "Confirm profile details",
                  status: "open",
                  dueAt: "2026-08-20T23:59:00.000Z",
                  speakerProfileId: "speaker-1",
                },
              ]
            : [],
      }),
    },
    review: {
      organizerWorkspace: async () => ({
        proposals: [
          {
            id: "proposal-1",
            title: "Designing for the hallway track",
            abstract: "",
            submitterName: "Priya Presenter",
            status: "submitted",
          },
        ],
        assignments: [
          {
            id: "assignment-1",
            proposalId: "proposal-1",
            reviewerId: "seed-reviewer",
            createdAt: "2026-08-09T12:00:00.000Z",
          },
        ],
        evaluations: [],
        reviewerDirectory: [{ id: "seed-reviewer", name: "Ravi Reviewer" }],
      }),
      reviewerQueue: async () => [],
    },
    agenda: {
      draft: async () => ({
        rooms: [{ id: "room-main", name: "Main stage" }],
        slots: [
          {
            id: "slot-0900",
            startsAt: "2026-09-01T16:00:00.000Z",
            endsAt: "2026-09-01T17:00:00.000Z",
          },
        ],
        sessions: [
          { id: "session-1", title: "Designing the calm conference" },
          { id: "session-2", title: "Accessible by default" },
        ],
        placements: [
          { id: "placement-1", sessionId: "session-1", roomId: "room-main", slotId: "slot-0900" },
        ],
        // Session one was placed at revision 1; session two has never been on the board, which is
        // what an absent entry means.
        occurrences: { sessions: { "session-1": 1 } },
        conflicts: [],
      }),
    },
    publishing: {
      preview: async () => ({
        state: "published",
        slug: "greenroom-demo-summit",
        draft: { event: { name: "Greenroom Demo Summit" }, sessions: [] },
        published: { sessions: [], event: { name: "Greenroom Demo Summit" } },
      }),
    },
    communications: {
      history: async () => ({
        history: [
          {
            delivery: {
              id: "delivery-1",
              recipientRef: "reviewer+bounce@greenroom.test",
              renderedSubject: "Abstracts are waiting for your review",
              triggerType: "reviewer.assigned",
              state: "terminal",
              attemptCount: 1,
              updatedAt: "2026-08-10T12:00:01.000Z",
            },
          },
          {
            delivery: {
              id: "delivery-2",
              recipientRef: "sam@example.test",
              renderedSubject: "Welcome to Greenroom",
              triggerType: "speaker.invited",
              state: "succeeded",
              attemptCount: 1,
              updatedAt: "2026-08-10T12:00:01.000Z",
            },
          },
        ],
      }),
    },
    /**
     * Configuration this event was cloned into and never received (issue #203).
     *
     * The events domain does the folding; platform declares one call and renders the answer, so
     * this stub is the whole of what the sixth category depends on.
     */
    eventConfiguration: {
      outstandingConfiguration: async () => [
        {
          key: "agenda",
          label: "Rooms and time slots",
          outcome: "failed",
          reason: "The destination has no room matching “Grand Hall”.",
          templateName: "Annual summit starter",
          outstandingSince: "2026-08-01T09:00:00.000Z",
        },
      ],
    },
    ...overrides,
  };
}

function service(overrides: Partial<PlatformSources> = {}, now: Date = NOW) {
  const dismissals = new MemoryInboxDismissalStore();
  return {
    dismissals,
    inbox: new PlatformInboxService({
      sources: sources(overrides),
      dismissals,
      now: () => now,
    }),
  };
}

const itemsOf = (
  answer: Awaited<ReturnType<PlatformInboxService["inbox"]>>,
  category:
    | "reviews"
    | "speakerWork"
    | "programme"
    | "deliveries"
    | "publication"
    | "configuration",
) => {
  const section = answer.categories[category];
  if (section.state !== "ok") throw new Error(`${category} was ${section.state}`);
  return section.items;
};

describe("the operational inbox", () => {
  it("derives a populated item in each category the sources can answer", async () => {
    const answer = await service().inbox.inbox(organizer, EVENT_ONE);

    expect(itemsOf(answer, "reviews").map(({ title, owner }) => ({ title, owner }))).toEqual([
      { title: "Designing for the hallway track", owner: "Ravi Reviewer" },
    ]);
    expect(itemsOf(answer, "speakerWork")).toHaveLength(1);
    expect(itemsOf(answer, "programme").map(({ title }) => title)).toEqual([
      "Accessible by default",
    ]);
    expect(itemsOf(answer, "deliveries").map(({ title }) => title)).toEqual([
      "Abstracts are waiting for your review",
    ]);
    // Every item is openable, on the surface that owns the condition.
    for (const category of ["reviews", "speakerWork", "programme", "deliveries"] as const)
      for (const item of itemsOf(answer, category))
        expect(item.href).toContain(`?event=${EVENT_ONE}`);
  });

  it("reports an overdue task louder than an open one, measured from the derivation time", async () => {
    const before = await service({}, new Date("2026-08-19T12:00:00.000Z")).inbox.inbox(
      organizer,
      EVENT_ONE,
    );
    expect(itemsOf(before, "speakerWork")[0]).toMatchObject({
      priority: "normal",
      subtitle: "Open",
    });

    // Same task, same row, one day past its deadline. Nothing was written to change this.
    const after = await service({}, new Date("2026-08-21T12:00:00.000Z")).inbox.inbox(
      organizer,
      EVENT_ONE,
    );
    expect(itemsOf(after, "speakerWork")[0]).toMatchObject({
      priority: "high",
      subtitle: "Overdue",
    });
  });

  /**
   * The sixth category, and the residual it closes (issue #203).
   *
   * A partial template application was surfaced only in the templates workspace, which an
   * organizer reaches deliberately, so an operator who never opened that page was never told —
   * #188 recorded that as `GAP-023`'s third residual and left the platform decision unmade.
   * This is the decision taken, and the shape is why it was cheap: the events domain folds the
   * answer, and platform declares one call.
   */
  it("raises configuration this event was cloned into and never received", async () => {
    const answer = await service().inbox.inbox(organizer, EVENT_ONE);

    expect(itemsOf(answer, "configuration")).toEqual([
      {
        // The deciding application's instant is the occurrence: applying again and having the
        // same category refused again is a new thing to know, and writes a new row with a new
        // instant. A re-derivation of the same refusal is not.
        key: `template-category:${EVENT_ONE}:agenda:2026-08-01T09:00:00.000Z`,
        category: "configuration",
        title:
          "Rooms and time slots could not be configured from \u201cAnnual summit starter\u201d",
        subtitle: "The destination has no room matching \u201cGrand Hall\u201d.",
        priority: "high",
        status: "open",
        href: `/event-templates?event=${EVENT_ONE}`,
      },
    ]);
  });

  /**
   * `GAP-023`'s second residual, answered by the mechanism the inbox already had.
   *
   * An organizer who repairs the refused category by hand — creating the room the slot wanted,
   * granting the capability — still holds a stored outcome that says it was refused, because
   * nothing re-reads the destination to find out otherwise. Dismissing is how they say so, and
   * it costs one click rather than a re-application they did not need.
   */
  it("lets an operator dismiss a configuration item they have repaired by hand", async () => {
    const { inbox } = service();

    const key = itemsOf(await inbox.inbox(organizer, EVENT_ONE), "configuration")[0]?.key ?? "";
    await inbox.dismiss(organizer, EVENT_ONE, key);

    expect(itemsOf(await inbox.inbox(organizer, EVENT_ONE), "configuration")[0]).toMatchObject({
      status: "dismissed",
    });
  });

  it("degrades the configuration category rather than the whole inbox", async () => {
    const answer = await service({ eventConfiguration: undefined }).inbox.inbox(
      organizer,
      EVENT_ONE,
    );

    expect(answer.categories.configuration.state).toBe("failed");
    // And the other five still answer, which is the point of degrading a section rather than a
    // request.
    expect(itemsOf(answer, "reviews").length).toBeGreaterThan(0);
  });

  it("drops an item when its condition resolves, with nothing written to close it", async () => {
    const resolved = service({
      content: {
        workspace: async () => ({
          sessions: [],
          speakers: [],
          // The very same task, now complete.
          tasks: [
            {
              id: "task-1",
              title: "Confirm profile details",
              status: "complete",
              dueAt: "2026-08-20T23:59:00.000Z",
              speakerProfileId: "speaker-1",
            },
          ],
        }),
      },
    });
    const dismiss = vi.spyOn(resolved.dismissals, "dismiss");

    const answer = await resolved.inbox.inbox(organizer, EVENT_ONE);

    expect(itemsOf(answer, "speakerWork")).toEqual([]);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("keeps a dismissal across a re-derivation of the same occurrence", async () => {
    const { inbox } = service();
    const first = await inbox.inbox(organizer, EVENT_ONE);
    const key = itemsOf(first, "speakerWork")[0]?.key ?? "";

    await inbox.dismiss(organizer, EVENT_ONE, key);

    const second = await inbox.inbox(organizer, EVENT_ONE);
    expect(itemsOf(second, "speakerWork")[0]).toMatchObject({
      key,
      status: "dismissed",
      dismissedAt: NOW.toISOString(),
    });
  });

  it("brings the item back when the occurrence genuinely changes", async () => {
    const { inbox, dismissals } = service();
    const first = await inbox.inbox(organizer, EVENT_ONE);
    await inbox.dismiss(organizer, EVENT_ONE, itemsOf(first, "speakerWork")[0]?.key ?? "");

    // The organizer moves the deadline. Same task, new thing to be told about.
    const moved = new PlatformInboxService({
      sources: sources({
        content: {
          workspace: async () => ({
            sessions: [],
            speakers: [],
            tasks: [
              {
                id: "task-1",
                title: "Confirm profile details",
                status: "open",
                dueAt: "2026-09-30T23:59:00.000Z",
                speakerProfileId: "speaker-1",
              },
            ],
          }),
        },
      }),
      dismissals,
      now: () => NOW,
    });

    const answer = await moved.inbox(organizer, EVENT_ONE);
    expect(itemsOf(answer, "speakerWork")[0]).toMatchObject({ status: "open" });
  });

  it("keeps one organizer's dismissal out of another organizer's list", async () => {
    const { inbox } = service();
    const first = await inbox.inbox(organizer, EVENT_ONE);
    await inbox.dismiss(organizer, EVENT_ONE, itemsOf(first, "speakerWork")[0]?.key ?? "");

    const colleague = await inbox.inbox(secondOrganizer, EVENT_ONE);
    expect(itemsOf(colleague, "speakerWork")[0]).toMatchObject({ status: "open" });
  });

  it("restores a dismissed item, and treats undoing nothing as done", async () => {
    const { inbox } = service();
    const first = await inbox.inbox(organizer, EVENT_ONE);
    const key = itemsOf(first, "speakerWork")[0]?.key ?? "";
    await inbox.dismiss(organizer, EVENT_ONE, key);

    await inbox.restore(organizer, EVENT_ONE, key);
    expect(itemsOf(await inbox.inbox(organizer, EVENT_ONE), "speakerWork")[0]).toMatchObject({
      status: "open",
    });
    await expect(inbox.restore(organizer, EVENT_ONE, key)).resolves.toBeUndefined();
  });

  it("refuses a dismissal for an item this event is not showing", async () => {
    const { inbox, dismissals } = service();
    const dismiss = vi.spyOn(dismissals, "dismiss");

    await expect(
      inbox.dismiss(organizer, EVENT_ONE, "speaker-task:invented:2026-01-01T00:00:00.000Z"),
    ).rejects.toBeInstanceOf(InboxItemNotFoundError);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("refuses a dismissal for an item derived on a different event", async () => {
    const { inbox } = service();
    const first = await inbox.inbox(organizer, EVENT_ONE);
    const key = itemsOf(first, "speakerWork")[0]?.key ?? "";

    // Event two's sources hold no such task, so the key names nothing there.
    await expect(inbox.dismiss(organizer, EVENT_TWO, key)).rejects.toBeInstanceOf(
      InboxItemNotFoundError,
    );
  });

  it("omits a category the actor's role cannot read and answers the rest", async () => {
    const organizerWorkspace = vi.fn();
    const answer = await service({
      content: { workspace: refuse },
      agenda: { draft: refuse },
      communications: { history: refuse },
      publishing: { preview: refuse },
      review: {
        organizerWorkspace: organizerWorkspace as never,
        reviewerQueue: async () => [
          {
            proposal: { id: "proposal-1", title: "Designing for the hallway track", abstract: "" },
            evaluation: null,
          },
        ],
      },
    }).inbox.inbox(reviewer, EVENT_ONE);

    // Blind review holds by construction: the organizer projection is never reached.
    expect(organizerWorkspace).not.toHaveBeenCalled();
    expect(itemsOf(answer, "reviews")).toEqual([
      expect.objectContaining({
        title: "Designing for the hallway track",
        href: `/reviews?event=${EVENT_ONE}`,
      }),
    ]);

    expect(answer.categories.speakerWork).toEqual({ state: "unauthorized" });
    expect(answer.categories.programme).toEqual({ state: "unauthorized" });
    expect(answer.categories.deliveries).toEqual({ state: "unauthorized" });
    expect(answer.categories.publication).toEqual({ state: "unauthorized" });
    // The one category a reviewer's role does reach still answers, which is the whole rule.
    expect(answer.categories.reviews.state).toBe("ok");
  });

  it("degrades one category and leaves the others usable", async () => {
    const outage = new Error("history is unreachable");
    const answer = await service({
      communications: { history: () => Promise.reject(outage) },
    }).inbox.inbox(organizer, EVENT_ONE);

    expect(answer.categories.deliveries).toEqual({ state: "failed", reason: outage });
    expect(answer.categories.reviews.state).toBe("ok");
    expect(answer.categories.speakerWork.state).toBe("ok");
    expect(answer.categories.programme.state).toBe("ok");
  });

  it("says nothing about publication when the draft and the live page agree", async () => {
    const answer = await service().inbox.inbox(organizer, EVENT_ONE);

    // The two projections in the fixture carry the same content in a different key order, which
    // is exactly what the live composition and the stored snapshot do. A byte comparison would
    // report unpublished changes on an event nobody has touched.
    expect(itemsOf(answer, "publication")).toEqual([]);
  });

  it("raises publication when the draft has moved ahead of the live page", async () => {
    const answer = await service({
      publishing: {
        preview: async () => ({
          state: "published",
          slug: "greenroom-demo-summit",
          draft: { event: { name: "Greenroom Demo Summit" }, sessions: [{ slug: "new-talk" }] },
          published: { event: { name: "Greenroom Demo Summit" }, sessions: [] },
        }),
      },
    }).inbox.inbox(organizer, EVENT_ONE);

    expect(itemsOf(answer, "publication")).toEqual([
      expect.objectContaining({
        title: "The public page has unpublished changes",
        href: `/publishing?event=${EVENT_ONE}`,
      }),
    ]);
  });

  it("raises publication when the page has never been live", async () => {
    const answer = await service({
      publishing: {
        preview: async () => ({ state: "draft", slug: "x", draft: {}, published: null }),
      },
    }).inbox.inbox(organizer, EVENT_ONE);

    expect(itemsOf(answer, "publication")).toEqual([
      expect.objectContaining({ title: "The public page is not live" }),
    ]);
  });

  it("treats an event with no agenda board as empty rather than degraded", async () => {
    const answer = await service({
      agenda: { draft: () => Promise.reject(new AgendaNotFoundError("Agenda not found")) },
    }).inbox.inbox(organizer, EVENT_ONE);

    expect(answer.categories.programme).toEqual({ state: "ok", items: [] });
  });

  it("reports an agenda conflict above an unplaced session", async () => {
    const answer = await service({
      agenda: {
        draft: async () => ({
          rooms: [{ id: "room-main", name: "Main stage" }],
          slots: [
            {
              id: "slot-0900",
              startsAt: "2026-09-01T16:00:00.000Z",
              endsAt: "2026-09-01T17:00:00.000Z",
            },
          ],
          sessions: [{ id: "session-1", title: "Designing the calm conference" }],
          placements: [
            { id: "placement-1", sessionId: "session-1", roomId: "room-main", slotId: "slot-0900" },
          ],
          occurrences: { sessions: { "session-1": 1 } },
          conflicts: [
            {
              kind: "ROOM_OVERLAP",
              placementId: "placement-1",
              conflictingPlacementId: "placement-2",
              message: "Main stage is double-booked at 09:00",
              occurrence: 1,
            },
          ],
        }),
      },
    }).inbox.inbox(organizer, EVENT_ONE);

    expect(itemsOf(answer, "programme")).toEqual([
      expect.objectContaining({
        priority: "high",
        subtitle: "Blocks publication of the schedule",
      }),
    ]);
  });

  it("brings back an unplaced session that was placed and taken off the board again", async () => {
    /*
     * `GAP-022`'s programme half, closed (issue #180). The board is the real one — an
     * `AgendaService` over the in-memory repository, satisfying the platform source structurally
     * — because what is under test is a fact the agenda has to produce on its *write* path, and a
     * hand-written fixture would only prove that the inbox can read a number somebody typed.
     */
    const eventId = EVENT_ONE;
    const board = new MemoryAgendaRepository([
      { eventId, rooms: [], tracks: [], slots: [], sessions: [], placements: [] },
    ]);
    const agenda = new AgendaService(
      board,
      () => NOW,
      new FixtureSchedulableContentQuery(
        new Map([
          [eventId, [{ id: "session-1", title: "Designing the calm conference", speakerIds: [] }]],
        ]),
      ),
    );
    await agenda.configure(organizer, eventId, {
      rooms: [{ id: "room-main", name: "Main stage" }],
      tracks: [{ id: "track-1", name: "General", color: "#123456" }],
      slots: [
        {
          id: "slot-0900",
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
        },
      ],
    });
    const dismissals = new MemoryInboxDismissalStore();
    const inbox = new PlatformInboxService({
      sources: sources({ agenda }),
      dismissals,
      now: () => NOW,
    });

    // Unplaced, and the organizer says they know.
    const first = itemsOf(await inbox.inbox(organizer, eventId), "programme");
    expect(first.map(({ title }) => title)).toEqual(["Designing the calm conference"]);
    const dismissedKey = first[0]?.key ?? "";
    await inbox.dismiss(organizer, eventId, dismissedKey);
    expect(itemsOf(await inbox.inbox(organizer, eventId), "programme")[0]).toMatchObject({
      status: "dismissed",
    });

    // Placed: the condition is resolved and the item is gone, with nothing written to close it.
    await agenda.place(organizer, eventId, {
      id: "placement-1",
      sessionId: "session-1",
      roomId: "room-main",
      trackId: "track-1",
      slotId: "slot-0900",
    });
    expect(itemsOf(await inbox.inbox(organizer, eventId), "programme")).toEqual([]);

    // Taken off again: the same session, the same id, and a condition the organizer has not seen.
    await agenda.remove(organizer, eventId, "placement-1");
    const returned = itemsOf(await inbox.inbox(organizer, eventId), "programme");
    expect(returned).toEqual([
      expect.objectContaining({ title: "Designing the calm conference", status: "open" }),
    ]);
    expect(returned[0]?.key).not.toEqual(dismissedKey);
    // The old dismissal is still stored and still valid — it named an occurrence that is over,
    // which is why nothing has to be cleaned up for this to be correct.
    expect(await dismissals.list(eventId, organizer.id)).toHaveLength(1);
  });

  it("keeps a programme dismissal across an edit to a different session", async () => {
    // The other half of the same rule, and the reason the key carries the *session's* occurrence
    // rather than the board's: a dismissal that evaporated whenever any card moved would be
    // useless on a board anybody is actually working on.
    const withTwo = (occurrences: { sessions: Record<string, number> }) => ({
      agenda: {
        draft: async () => ({
          rooms: [{ id: "room-main", name: "Main stage" }],
          slots: [
            {
              id: "slot-0900",
              startsAt: "2026-09-01T16:00:00.000Z",
              endsAt: "2026-09-01T17:00:00.000Z",
            },
          ],
          sessions: [
            { id: "session-1", title: "Designing the calm conference" },
            { id: "session-2", title: "Accessible by default" },
          ],
          placements: [],
          occurrences,
          conflicts: [],
        }),
      },
    });
    const dismissals = new MemoryInboxDismissalStore();
    const inboxWith = (occurrences: { sessions: Record<string, number> }) =>
      new PlatformInboxService({
        sources: sources(withTwo(occurrences)),
        dismissals,
        now: () => NOW,
      });

    const before = itemsOf(
      await inboxWith({ sessions: {} }).inbox(organizer, EVENT_ONE),
      "programme",
    );
    const dismissed = before.find(({ title }) => title === "Accessible by default")?.key ?? "";
    await inboxWith({ sessions: {} }).dismiss(organizer, EVENT_ONE, dismissed);

    // The organizer places and unplaces the *other* session, twice, and edits the resources.
    const after = itemsOf(
      await inboxWith({ sessions: { "session-1": 7 } }).inbox(organizer, EVENT_ONE),
      "programme",
    );

    expect(after.find(({ title }) => title === "Accessible by default")).toMatchObject({
      key: dismissed,
      status: "dismissed",
    });
  });

  it("brings back a conflict that was resolved and reintroduced between the same placements", async () => {
    const dismissals = new MemoryInboxDismissalStore();
    const clash = (occurrence: number) => ({
      agenda: {
        draft: async () => ({
          rooms: [{ id: "room-main", name: "Main stage" }],
          slots: [
            {
              id: "slot-0900",
              startsAt: "2026-09-01T16:00:00.000Z",
              endsAt: "2026-09-01T17:00:00.000Z",
            },
          ],
          sessions: [{ id: "session-1", title: "Designing the calm conference" }],
          placements: [
            { id: "placement-1", sessionId: "session-1", roomId: "room-main", slotId: "slot-0900" },
          ],
          occurrences: { sessions: { "session-1": occurrence } },
          conflicts: [
            {
              kind: "ROOM_OVERLAP",
              placementId: "placement-1",
              conflictingPlacementId: "placement-2",
              message: "Main stage is double-booked at 09:00",
              occurrence,
            },
          ],
        }),
      },
    });
    const inboxAt = (occurrence: number) =>
      new PlatformInboxService({ sources: sources(clash(occurrence)), dismissals, now: () => NOW });

    const first = itemsOf(await inboxAt(2).inbox(organizer, EVENT_ONE), "programme")[0];
    await inboxAt(2).dismiss(organizer, EVENT_ONE, first?.key ?? "");
    expect(itemsOf(await inboxAt(2).inbox(organizer, EVENT_ONE), "programme")[0]).toMatchObject({
      status: "dismissed",
    });

    // The organizer moved one of the two placements away and then back: the clash is described by
    // the same kind and the same pair of ids, and is a different clash.
    expect(itemsOf(await inboxAt(5).inbox(organizer, EVENT_ONE), "programme")[0]).toMatchObject({
      status: "open",
    });
  });

  it("refuses an anonymous caller and one without events:read on this event", async () => {
    const { inbox } = service();
    await expect(inbox.inbox(null, EVENT_ONE)).rejects.toBeInstanceOf(AuthenticationRequiredError);
    const stranger = actorOf(
      "stranger",
      "organizer",
      [{ eventId: EVENT_TWO, role: "organizer" }],
      ["events:read"],
    );
    await expect(inbox.inbox(stranger, EVENT_ONE)).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});
