// @acceptance ACC-OPS

import { describe, expect, it, vi } from "vitest";
import { AgendaNotFoundError } from "../src/application/agenda/public";
import {
  type Actor,
  AuthenticationRequiredError,
  type Capability,
  CapabilityDeniedError,
} from "../src/application/identity/actor";
import {
  type PlatformSearchDependencies,
  PlatformSearchService,
  SearchQueryTooShortError,
} from "../src/application/platform/public";

const EVENT_ONE = "00000000-0000-4000-8000-000000000001";
const EVENT_TWO = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";

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
    "content:read",
    "review:manage",
    "agenda:manage",
    "communications:manage",
    "crm:manage",
  ],
);

const reviewer = actorOf(
  "seed-reviewer",
  "reviewer",
  [{ eventId: EVENT_ONE, role: "reviewer" }],
  ["events:read", "review:evaluate"],
);

/**
 * The rows each source holds, keyed by event.
 *
 * Both seeded events carry a record whose title contains "keynote", which is what makes the
 * cross-event negative below mean something: a scope bug would show event two's row, not
 * nothing.
 */
const sessionsByEvent: Record<string, { id: string; title: string }[]> = {
  [EVENT_ONE]: [{ id: "session-1", title: "Opening keynote" }],
  [EVENT_TWO]: [{ id: "session-2", title: "Sibling keynote" }],
};

const refuse = (capability: string) => () =>
  Promise.reject(new CapabilityDeniedError(`Actor lacks ${capability} for event`));

function dependencies(
  overrides: Partial<PlatformSearchDependencies> = {},
): PlatformSearchDependencies {
  return {
    events: { organizationOf: async () => ORGANIZATION },
    content: {
      workspace: async (_actor, eventId) => ({
        sessions: (sessionsByEvent[eventId] ?? []).map((session) => ({
          ...session,
          abstract: "",
          format: "talk",
          tracks: [],
        })),
        speakers: [
          {
            id: "speaker-1",
            name: "Keynote Speaker",
            email: "speaker@example.test",
            bio: "",
            organization: "Greenroom",
          },
        ],
        tasks: [
          {
            id: "task-1",
            title: "Upload keynote slides",
            status: "open",
            speakerProfileId: "speaker-1",
          },
        ],
      }),
    },
    review: {
      organizerWorkspace: async () => ({
        proposals: [
          {
            id: "proposal-1",
            title: "A keynote proposal",
            abstract: "",
            submitterName: "Priya Presenter",
            status: "submitted",
          },
        ],
      }),
      reviewerQueue: async () => [
        {
          proposal: { id: "proposal-1", title: "A keynote proposal", abstract: "" },
          evaluation: { state: "draft" },
        },
      ],
    },
    agenda: {
      draft: async () => ({
        rooms: [{ id: "room-1", name: "Keynote hall" }],
        slots: [
          {
            id: "slot-1",
            startsAt: "2026-09-01T09:00:00.000Z",
            endsAt: "2026-09-01T10:00:00.000Z",
          },
        ],
        sessions: [{ id: "session-1", title: "Opening keynote" }],
        placements: [
          { id: "placement-1", sessionId: "session-1", roomId: "room-1", slotId: "slot-1" },
        ],
      }),
    },
    communications: {
      history: async () => ({
        history: [
          {
            delivery: {
              id: "delivery-1",
              recipientRef: "speaker@example.test",
              renderedSubject: "Your keynote is confirmed",
              triggerType: "schedule.published",
              state: "succeeded",
            },
          },
        ],
      }),
    },
    crm: {
      list: async () => [
        {
          id: "prospect-1",
          name: "Keynote candidate",
          stage: "identified",
          contacts: [{ email: "candidate@example.test" }],
        },
      ],
      /*
       * Honours the event filter, because the whole point of the cross-event assertion below is
       * that the directory is organization-wide and only this filter keeps a sibling event's
       * contacts out of the answer. A fake that ignored it would make that assertion vacuous and
       * leave the real `EXISTS (… crm_contact_events …)` clause resting on nothing in this lane.
       */
      listContacts: async (_actor: unknown, _organizationId: string, query) => ({
        contacts:
          query.eventId === EVENT_ONE
            ? [{ id: "contact-1", name: "Keynote alumna", company: "Prior Year" }]
            : [{ id: "contact-2", name: "Sibling keynote alumna", company: "Other Event" }],
      }),
    },
    ...overrides,
  };
}

const service = (overrides: Partial<PlatformSearchDependencies> = {}) =>
  new PlatformSearchService(dependencies(overrides));

describe("permission-aware search", () => {
  it("composes every source an organizer can read, each hit carrying its own event-scoped link", async () => {
    const answer = await service().search(organizer, EVENT_ONE, "keynote", 10);

    const kinds = Object.values(answer.sections).flatMap((section) =>
      section.state === "ok" ? section.results.map(({ kind }) => kind) : [],
    );
    expect(new Set(kinds)).toEqual(
      new Set(["session", "speaker", "task", "proposal", "agenda-item", "delivery", "contact"]),
    );
    const links = Object.values(answer.sections).flatMap((section) =>
      section.state === "ok" ? section.results.map(({ href }) => href) : [],
    );
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toContain(`?event=${EVENT_ONE}`);
    expect(links).toContain(`/sessions?event=${EVENT_ONE}`);
    expect(links).toContain(`/abstracts?event=${EVENT_ONE}`);
    expect(links).toContain(`/agenda?event=${EVENT_ONE}`);
    expect(links).toContain(`/communications?event=${EVENT_ONE}`);
  });

  it("omits a source the actor may not read instead of failing the request", async () => {
    const answer = await service({
      crm: {
        list: refuse("crm:manage"),
        listContacts: refuse("crm:manage"),
      },
    }).search(organizer, EVENT_ONE, "keynote", 10);

    expect(answer.sections.crm).toEqual({ state: "unauthorized" });
    // The point of the rule: everything else still answered.
    expect(answer.sections.content.state).toBe("ok");
    expect(answer.sections.review.state).toBe("ok");
  });

  it("degrades only the section whose source genuinely rejected, and keeps the reason", async () => {
    const outage = new Error("communications history is unreachable");
    const answer = await service({
      communications: { history: () => Promise.reject(outage) },
    }).search(organizer, EVENT_ONE, "keynote", 10);

    expect(answer.sections.communications).toEqual({ state: "failed", reason: outage });
    expect(answer.sections.content.state).toBe("ok");
    expect(answer.sections.agenda.state).toBe("ok");
    expect(answer.sections.crm.state).toBe("ok");
  });

  it("names an unwired source as a failure rather than answering it empty", async () => {
    const answer = await service({ agenda: undefined }).search(organizer, EVENT_ONE, "keynote", 10);

    expect(answer.sections.agenda.state).toBe("failed");
  });

  it("answers a reviewer from the masked queue and never reaches the organizer projection", async () => {
    const organizerWorkspace = vi.fn();
    const answer = await service({
      review: {
        organizerWorkspace,
        reviewerQueue: async () => [
          {
            proposal: { id: "proposal-1", title: "A keynote proposal", abstract: "" },
            evaluation: null,
          },
        ],
      },
    }).search(reviewer, EVENT_ONE, "keynote", 10);

    expect(organizerWorkspace).not.toHaveBeenCalled();
    const review = answer.sections.review;
    expect(review.state).toBe("ok");
    if (review.state !== "ok") throw new Error("unreachable");
    expect(review.results.map(({ href }) => href)).toEqual([`/reviews?event=${EVENT_ONE}`]);
    // Blind review asserted the way ACC-REVIEW asserts it: over what actually serializes.
    expect(JSON.stringify(answer)).not.toContain("Priya Presenter");
  });

  it("omits the sections a reviewer's role does not include", async () => {
    const answer = await service({
      content: { workspace: refuse("content:read") },
      agenda: { draft: refuse("agenda:manage") },
      communications: { history: refuse("communications:manage") },
      crm: { list: refuse("crm:manage"), listContacts: refuse("crm:manage") },
    }).search(reviewer, EVENT_ONE, "keynote", 10);

    expect(answer.sections.content.state).toBe("unauthorized");
    expect(answer.sections.agenda.state).toBe("unauthorized");
    expect(answer.sections.communications.state).toBe("unauthorized");
    expect(answer.sections.crm.state).toBe("unauthorized");
    expect(answer.sections.review.state).toBe("ok");
  });

  it("refuses the proposal section for a role that holds neither review capability", async () => {
    const speaker = actorOf(
      "seed-speaker",
      "speaker",
      [{ eventId: EVENT_ONE, role: "speaker" }],
      ["events:read", "content:read"],
    );

    const answer = await service().search(speaker, EVENT_ONE, "keynote", 10);

    expect(answer.sections.review).toEqual({ state: "unauthorized" });
    // A speaker's own records still answer, through the portal rather than the organizer surface.
    const content = answer.sections.content;
    if (content.state !== "ok") throw new Error("unreachable");
    expect(content.results.every(({ href }) => href.startsWith("/portal?"))).toBe(true);
  });

  it("returns nothing from a sibling event of the same organization", async () => {
    const answer = await service().search(organizer, EVENT_ONE, "sibling", 10);

    const titles = Object.values(answer.sections).flatMap((section) =>
      section.state === "ok" ? section.results.map(({ title }) => title) : [],
    );
    expect(titles).not.toContain("Sibling keynote");
    // And the same query against the other event does find it, so the negative is about scope
    // rather than about the row being unmatchable.
    const sibling = await service().search(organizer, EVENT_TWO, "sibling", 10);
    const siblingContent = sibling.sections.content;
    if (siblingContent.state !== "ok") throw new Error("unreachable");
    expect(siblingContent.results.map(({ title }) => title)).toContain("Sibling keynote");
  });

  it("refuses an anonymous caller and a caller without events:read on this event", async () => {
    await expect(service().search(null, EVENT_ONE, "keynote", 10)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    const stranger = actorOf(
      "stranger",
      "organizer",
      [{ eventId: EVENT_TWO, role: "organizer" }],
      ["events:read"],
    );
    await expect(service().search(stranger, EVENT_ONE, "keynote", 10)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it("refuses a query shorter than the minimum before reading any source", async () => {
    const workspace = vi.fn();
    await expect(
      service({ content: { workspace } }).search(organizer, EVENT_ONE, " k ", 10),
    ).rejects.toBeInstanceOf(SearchQueryTooShortError);
    expect(workspace).not.toHaveBeenCalled();
  });

  it("caps each section and keeps every kind represented within the cap", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index}`,
      title: `Keynote ${index}`,
      abstract: "",
      format: "talk",
      tracks: [],
    }));
    const answer = await service({
      content: {
        workspace: async () => ({
          sessions: many,
          speakers: [
            {
              id: "speaker-1",
              name: "Keynote Speaker",
              email: "speaker@example.test",
              bio: "",
              organization: "Greenroom",
            },
          ],
          tasks: [],
        }),
      },
    }).search(organizer, EVENT_ONE, "keynote", 5);

    const content = answer.sections.content;
    if (content.state !== "ok") throw new Error("unreachable");
    expect(content.results).toHaveLength(5);
    // Concatenation would have spent all five on sessions and hidden the speaker entirely.
    expect(content.results.map(({ kind }) => kind)).toContain("speaker");
  });

  it("treats an event with no agenda board as an empty section rather than a failure", async () => {
    const answer = await service({
      agenda: { draft: () => Promise.reject(new AgendaNotFoundError("Agenda not found")) },
    }).search(organizer, EVENT_ONE, "keynote", 10);

    expect(answer.sections.agenda).toEqual({ state: "ok", results: [] });
  });

  it("recovers from the agenda's own not-found error rather than from anything named like it", async () => {
    class NotConfiguredYet extends Error {}
    const answer = await service({
      agenda: { draft: () => Promise.reject(new NotConfiguredYet("Agenda not found")) },
    }).search(organizer, EVENT_ONE, "keynote", 10);

    // Recovery is by type, not by message: an unrelated rejection carrying the same words is
    // still an outage, and reporting it as "no agenda yet" would hide a broken source.
    expect(answer.sections.agenda.state).toBe("failed");
  });
});
