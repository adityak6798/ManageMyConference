// @acceptance ACC-SPEAKER ACC-INTEGRATION
import { describe, expect, it } from "vitest";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import {
  CommunicationsService,
  type DeliveryRequest,
} from "../src/application/communications/public";
import type { ContentWorkspaceView } from "../src/application/content/content-service";
import {
  CalendarOrganizerUnconfiguredError,
  SpeakerCalendarInviteService,
} from "../src/application/content/speaker-calendar-invites";
import type { Actor } from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000010";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  eventAccess: [
    {
      eventId,
      role: "organizer",
      capabilities: new Set(["events:read", "content:read", "content:manage"]),
    },
  ],
  capabilities: new Set(["content:manage"]),
};

const speaker = (id: string, email: string | null) => ({
  id,
  eventId,
  userId: `user-${id}`,
  sourcePersonId: `person-${id}`,
  name: `Speaker ${id}`,
  email: email ?? "",
  bio: "",
  pronouns: "",
  organization: "",
  workflowStatus: "ready" as const,
  logistics: {},
  customFields: {},
});

const session = (
  id: string,
  speakerProfileIds: string[],
  schedule?: { startsAt: string; endsAt: string; location: string },
) => ({
  id,
  eventId,
  proposalId: `proposal-${id}`,
  title: `Session ${id}`,
  abstract: "",
  format: "talk",
  speakerProfileIds,
  tags: [],
  tracks: [],
  publicationState: "published" as const,
  ...(schedule ? { schedule } : {}),
});

const placed = {
  startsAt: "2026-09-01T16:00:00.000Z",
  endsAt: "2026-09-01T17:00:00.000Z",
  location: "Main stage",
};

function harness(
  workspace: Partial<ContentWorkspaceView>,
  options: { organizerEmail?: string | undefined } = { organizerEmail: "programme@greenroom.test" },
) {
  // A standing outbox, so a second send sees what the first one wrote — which is the whole point
  // of the idempotency assertions below.
  const enqueued = new Map<string, DeliveryRequest>();
  const requests: DeliveryRequest[] = [];
  const service = new SpeakerCalendarInviteService({
    content: {
      workspace: async () =>
        ({
          sessions: [],
          speakers: [],
          tasks: [],
          assets: [],
          messages: [],
          ...workspace,
        }) as ContentWorkspaceView,
    },
    communications: {
      enqueue: async (request) => {
        requests.push(request);
        const existing = enqueued.get(request.idempotencyKey);
        if (existing)
          return {
            id: "existing",
            idempotencyKey: request.idempotencyKey,
            state: "queued",
            created: false,
          };
        enqueued.set(request.idempotencyKey, request);
        return {
          id: `delivery-${enqueued.size}`,
          idempotencyKey: request.idempotencyKey,
          state: "queued",
          created: true,
        };
      },
    },
    events: {
      get: async () => ({
        id: eventId,
        organizationId,
        name: "Greenroom Conf",
        timezone: "UTC",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    },
    ...options,
    now: () => new Date("2026-08-12T09:00:00.000Z"),
  });
  return { service, requests, enqueued };
}

describe("sending speaker calendar invitations", () => {
  it("writes one delivery per speaker per session, carrying the invitation", async () => {
    const test = harness({
      sessions: [session("s1", ["p1", "p2"], placed), session("s2", ["p1"], placed)],
      speakers: [speaker("p1", "ada@example.test"), speaker("p2", "grace@example.test")],
    } as Partial<ContentWorkspaceView>);

    expect(await test.service.send(organizer, eventId)).toEqual({
      sent: 3,
      alreadySent: 0,
      unreachable: [],
    });
    // Addressed to the speaker, not to an opaque profile reference the mail adapter would refuse.
    expect(test.requests.map(({ recipientRef }) => recipientRef)).toEqual([
      "ada@example.test",
      "grace@example.test",
      "ada@example.test",
    ]);
    const payload = test.requests[0]?.payload as { calendarInvite: { content: string } };
    expect(payload.calendarInvite.content).toContain("METHOD:REQUEST");
    expect(payload.calendarInvite.content).toContain("mailto:ada@example.test");
    expect(test.requests[0]?.triggerType).toBe("speaker.calendar_invite");
    expect(test.requests[0]?.channel).toBe("email");
  });

  it("sends once for an unchanged agenda however often it is pressed", async () => {
    const test = harness({
      sessions: [session("s1", ["p1"], placed)],
      speakers: [speaker("p1", "ada@example.test")],
    } as Partial<ContentWorkspaceView>);

    expect(await test.service.send(organizer, eventId)).toMatchObject({ sent: 1, alreadySent: 0 });
    // The second press reports honestly rather than claiming to have sent again.
    expect(await test.service.send(organizer, eventId)).toMatchObject({ sent: 0, alreadySent: 1 });
    expect(test.enqueued.size).toBe(1);
  });

  it("treats a moved session as a new invitation, not a suppressed duplicate", async () => {
    const before = harness({
      sessions: [session("s1", ["p1"], placed)],
      speakers: [speaker("p1", "ada@example.test")],
    } as Partial<ContentWorkspaceView>);
    await before.service.send(organizer, eventId);
    const firstKey = before.requests[0]?.idempotencyKey ?? "";

    const after = harness({
      sessions: [session("s1", ["p1"], { ...placed, startsAt: "2026-09-01T18:00:00.000Z" })],
      speakers: [speaker("p1", "ada@example.test")],
    } as Partial<ContentWorkspaceView>);
    await after.service.send(organizer, eventId);

    // A different key, so the outbox does not swallow it — and the invitation carries the new
    // time, which is what a client applies over the entry it already holds.
    expect(after.requests[0]?.idempotencyKey).not.toBe(firstKey);
    const payload = after.requests[0]?.payload as { calendarInvite: { content: string } };
    expect(payload.calendarInvite.content).toContain("DTSTART:20260901T180000Z");
  });

  it("names who could not be invited rather than quietly reaching fewer people", async () => {
    const test = harness({
      sessions: [session("s1", ["p1", "p2", "p3"], placed), session("s2", ["p1"])],
      speakers: [speaker("p1", "ada@example.test"), speaker("p2", null)],
    } as Partial<ContentWorkspaceView>);

    const result = await test.service.send(organizer, eventId);
    expect(result.sent).toBe(1);
    expect(result.unreachable).toEqual([
      { session: "Session s1", reason: "Speaker p2 has no email address on their speaker profile" },
      {
        session: "Session s1",
        reason: "A speaker on this session has no profile in this workspace",
      },
    ]);
    // An unscheduled session is not a failure — the organizer simply has not placed it yet.
    expect(result.unreachable.some(({ session: name }) => name === "Session s2")).toBe(false);
  });

  it("refuses when no sender is configured instead of inventing an organizer", async () => {
    const test = harness(
      {
        sessions: [session("s1", ["p1"], placed)],
        speakers: [speaker("p1", "ada@example.test")],
      } as Partial<ContentWorkspaceView>,
      { organizerEmail: undefined },
    );
    // A calendar client refuses an invitation whose ORGANIZER is not the sender, so a fabricated
    // address would produce one that looks delivered and does nothing.
    await expect(test.service.send(organizer, eventId)).rejects.toBeInstanceOf(
      CalendarOrganizerUnconfiguredError,
    );
    expect(test.requests).toHaveLength(0);
  });

  /**
   * The send, composed against the real communications service rather than a double.
   *
   * Every other test here stubs `enqueue`, which is the right shape for asserting *this* module's
   * decisions but proves nothing about whether communications will accept what it produces. Four
   * of that service's coherence rules apply to an invitation — the event must belong to the
   * organization, an email delivery must name a template, the template's channel must match, and
   * a projection trigger may not ride `email` — and a fifth, template rendering, refuses the
   * enqueue outright when a placeholder has no value.
   *
   * The rendering rule is the one worth pinning. `payload.calendarInvite` is an object, and
   * `resolve` throws `TemplateValueError` for any placeholder resolving to a non-scalar. It is
   * safe only because nothing substitutes a key the template does not mention — an invariant that
   * holds today and that no test named until this one. A template author writing
   * `{{calendarInvite}}` would break every send, and should find that out here.
   */
  it("produces a delivery the real communications service accepts and renders", async () => {
    const repository = new MemoryCommunicationsRepository();
    let id = 0;
    const communications = new CommunicationsService({
      repository,
      eventDirectory: {
        belongsToOrganization: async (candidateEvent, candidateOrganization) =>
          candidateEvent === eventId && candidateOrganization === organizationId,
      },
      newId: () => `delivery-${++id}`,
      now: () => new Date("2026-08-12T09:00:00.000Z"),
    });
    // The template the seed ships, verbatim in the placeholders that matter.
    await communications.createTemplate(
      { ...organizer, capabilities: new Set(["communications:manage"]) },
      {
        organizationId,
        key: "speaker-calendar-invite",
        version: 1,
        channel: "email",
        subject: "Your session at {{eventName}}",
        body: "Hello {{speakerName}}, here is the calendar invitation for {{sessionTitle}}.",
      },
    );
    const service = new SpeakerCalendarInviteService({
      content: {
        workspace: async () =>
          ({
            sessions: [session("s1", ["p1"], placed)],
            speakers: [speaker("p1", "ada@example.test")],
            tasks: [],
            assets: [],
            messages: [],
          }) as ContentWorkspaceView,
      },
      communications,
      events: {
        get: async () => ({ id: eventId, organizationId, name: "Greenroom Conf" }),
      },
      organizerEmail: "programme@greenroom.test",
      now: () => new Date("2026-08-12T09:00:00.000Z"),
    });

    expect(await service.send(organizer, eventId)).toMatchObject({ sent: 1, alreadySent: 0 });

    const [delivery] = await repository.list(organizationId, eventId);
    if (!delivery) throw new Error("the send wrote no delivery");
    // The covering note is rendered and stored, so a retry re-sends what was composed.
    expect(delivery).toMatchObject({
      channel: "email",
      triggerType: "speaker.calendar_invite",
      recipientRef: "ada@example.test",
      renderedSubject: "Your session at Greenroom Conf",
      renderedBody: "Hello Speaker p1, here is the calendar invitation for Session s1.",
    });
    // The invitation survives the enqueue intact — this is what the email adapter attaches.
    const { calendarInvite } = delivery.payload as {
      calendarInvite: { method: string; filename: string; content: string };
    };
    expect(calendarInvite).toMatchObject({ method: "REQUEST", filename: "invite.ics" });
    expect(calendarInvite.content).toContain("METHOD:REQUEST");

    // And it is genuinely idempotent through the real service, not just through the double.
    expect(await service.send(organizer, eventId)).toMatchObject({ sent: 0, alreadySent: 1 });
    expect(await repository.list(organizationId, eventId)).toHaveLength(1);
  });

  it("refuses an actor without content:manage on the event", async () => {
    const test = harness({
      sessions: [session("s1", ["p1"], placed)],
      speakers: [speaker("p1", "ada@example.test")],
    } as Partial<ContentWorkspaceView>);
    const speakerActor: Actor = {
      ...organizer,
      persona: "speaker",
      eventAccess: [{ eventId, role: "speaker", capabilities: new Set(["content:read"]) }],
      capabilities: new Set(["content:read"]),
    };
    await expect(test.service.send(speakerActor, eventId)).rejects.toThrow("content:manage");
    await expect(test.service.send(null, eventId)).rejects.toThrow();
    expect(test.requests).toHaveLength(0);
  });
});
