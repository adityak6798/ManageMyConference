// @acceptance ACC-CRM
import { contactListResponseSchema, importPreviewResponseSchema } from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryCrmRepository } from "../src/adapters/persistence/memory-crm-repository";
import { CrmService } from "../src/application/crm/crm-service";
import {
  PipelineStageInUseError,
  PipelineStageInvalidError,
  PipelineStageNotFoundError,
  ProspectContactRequiredError,
  ProspectOwnerNotEligibleError,
} from "../src/application/crm/errors";
import type { OutreachMessage } from "../src/application/crm/outreach-dispatch";
import {
  type Actor,
  type Capability,
  CapabilityDeniedError,
} from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";
/** An event of a different organization entirely. */
const outsideEventId = "00000000-0000-4000-8000-000000000099";
const organizationId = "00000000-0000-4000-8000-000000000010";
const otherOrganizationId = "00000000-0000-4000-8000-000000000020";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  capabilities: new Set(["crm:manage"]),
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["crm:manage"]) }],
};
/**
 * The same identity, staffing both of the organization's events.
 *
 * Deliberately a second actor rather than an extra grant on `organizer`: the prospect suites
 * above rely on `organizer` holding exactly one event, and that cross-event negative is the
 * property they exist to prove.
 */
const organizerOfBothEvents: Actor = {
  ...organizer,
  eventAccess: [
    ...organizer.eventAccess,
    { eventId: otherEventId, role: "organizer", capabilities: new Set(["crm:manage"]) },
  ],
};
/** Staff on an event of this organization, but with no CRM capability anywhere. */
const reviewer: Actor = {
  id: "reviewer",
  name: "Ravi Reviewer",
  persona: "reviewer",
  organizations: [{ id: organizationId }],
  capabilities: new Set(["review:evaluate"] as Capability[]),
  eventAccess: [{ eventId, role: "reviewer", capabilities: new Set(["review:evaluate"]) }],
};
/** Runs another organization's event. Holds a perfectly good actor-wide `crm:manage`. */
const outsideOrganizer: Actor = {
  id: "outside-organizer",
  name: "Olive Outsider",
  persona: "organizer",
  organizations: [{ id: otherOrganizationId }],
  capabilities: new Set(["crm:manage"]),
  eventAccess: [
    { eventId: outsideEventId, role: "organizer", capabilities: new Set(["crm:manage"]) },
  ],
};
/**
 * The mixed-role case `#27` was opened for: `crm:manage` earned by organizing an event of one
 * organization, membership held of a second, and no CRM role inside that second one.
 */
const borrowedCapability: Actor = {
  id: "borrower",
  name: "Bo Borrower",
  persona: "organizer",
  organizations: [{ id: otherOrganizationId }],
  capabilities: new Set(["crm:manage"]),
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["crm:manage"]) }],
};
const ids = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
];
/**
 * The identity directory as the CRM sees it: an event-scoped staff list. `reviewer` is
 * assignable here but holds no `crm:manage` capability anywhere, and `other-organizer` is staff
 * on the neighbouring event only.
 */
const staffByEvent: Record<string, readonly { id: string; name: string }[]> = {
  [eventId]: [
    { id: "organizer", name: "Organizer" },
    { id: "reviewer", name: "Ravi Reviewer" },
  ],
  [otherEventId]: [{ id: "other-organizer", name: "Otto Organizer" }],
  [outsideEventId]: [{ id: "outside-organizer", name: "Olive Outsider" }],
};
/**
 * Which organization owns which event, as the events domain answers it. Both in-house events
 * belong to one organization and `outsideEventId` to another, which is what makes the
 * cross-organization negatives below distinguishable from cross-event ones.
 */
const eventOrg: Record<string, string> = {
  [eventId]: organizationId,
  [otherEventId]: organizationId,
  [outsideEventId]: otherOrganizationId,
};
const setup = () => {
  const repository = new MemoryCrmRepository();
  const createOrLink = vi
    .fn()
    .mockResolvedValue({ speakerId: "40000000-0000-4000-8000-000000000001" });
  const listAssignableOwnersForEvent = vi.fn(
    async (scopedEventId: string) => staffByEvent[scopedEventId] ?? [],
  );
  // Typed parameters, so the assertions below can read the message the CRM handed the port.
  const send = vi.fn(async (_message: OutreachMessage) => ({
    deliveryId: `delivery-${send.mock.calls.length}`,
    created: true,
  }));
  const prepare = vi.fn(async (_message: OutreachMessage) => undefined);
  const belongsToOrganization = vi.fn(
    async (event: string, organization: string) => eventOrg[event] === organization,
  );
  const listEventIdsInOrganization = vi.fn(
    async (organization: string, candidateEventIds: readonly string[]) =>
      candidateEventIds.filter((event) => eventOrg[event] === organization),
  );
  const service = new CrmService({
    repository,
    speakerConversion: { createOrLink },
    identities: { listAssignableOwnersForEvent },
    events: { belongsToOrganization, listEventIdsInOrganization },
    outreach: { prepare, send },
    newId: () => ids.shift() ?? crypto.randomUUID(),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return {
    repository,
    service,
    createOrLink,
    listAssignableOwnersForEvent,
    belongsToOrganization,
    listEventIdsInOrganization,
    send,
    prepare,
  };
};

describe("ACC-CRM prospect lifecycle", () => {
  it("operates an event-scoped prospect with next actions, filters, and private history", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      nextAction: "Send invitation",
      nextActionAt: "2026-08-09T12:00:00.000Z",
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, {
      stage: "contacted",
      activity: { kind: "note", summary: "Private availability details", private: true },
    });
    expect(
      await service.list(organizer, eventId, {
        stage: "contacted",
        overdueBefore: "2026-08-10T12:00:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        name: "Ada Rivera",
        nextAction: "Send invitation",
        activities: [
          expect.objectContaining({ kind: "stage-change", private: false }),
          expect.objectContaining({ private: true }),
        ],
      }),
    ]);
    expect(() => service.list(organizer, otherEventId, {})).toThrow(CapabilityDeniedError);
  });

  it("converts idempotently through the content port and keeps private CRM data out of the command", async () => {
    const { service, createOrLink } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, {
      activity: { kind: "note", summary: "Do not publish", private: true },
    });
    const [first, second] = await Promise.all([
      service.convert(organizer, eventId, prospect.id, "conversion-correlation"),
      service.convert(organizer, eventId, prospect.id, "conversion-correlation"),
    ]);
    expect(first.speakerId).toBe(second.speakerId);
    expect(
      (await service.convert(organizer, eventId, prospect.id, "conversion-correlation")).speakerId,
    ).toBe(first.speakerId);
    expect(createOrLink).toHaveBeenCalledWith({
      eventId,
      source: { kind: "crm-prospect", id: prospect.id },
      name: "Ada Rivera",
      email: "ada@example.test",
      actorId: organizer.id,
      occurredAt: "2026-08-10T12:00:00.000Z",
      correlationId: "conversion-correlation",
      idempotencyKey: `crm-conversion:${eventId}:${prospect.id}`,
    });
    expect(JSON.stringify(createOrLink.mock.calls)).not.toContain("Do not publish");
    await expect(
      service.update(organizer, eventId, prospect.id, { stage: "contacted" }),
    ).rejects.toThrow("Converted prospects are immutable");
  });

  it("rejects unauthenticated, unauthorized, cross-event, and contactless conversion", async () => {
    const { repository, service } = setup();
    expect(() => service.list(null, eventId, {})).toThrow();
    const reviewer: Actor = {
      ...organizer,
      capabilities: new Set<Capability>(),
      eventAccess: [{ eventId, role: "reviewer", capabilities: new Set(["events:read"]) }],
    };
    expect(() => service.list(reviewer, eventId, {})).toThrow(CapabilityDeniedError);
    await repository.create({
      id: "50000000-0000-4000-8000-000000000001",
      eventId,
      name: "No Contact",
      stage: "identified",
      ownerId: organizer.id,
      nextAction: null,
      nextActionAt: null,
      contacts: [],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    });
    await expect(
      service.convert(
        organizer,
        eventId,
        "50000000-0000-4000-8000-000000000001",
        "conversion-correlation",
      ),
    ).rejects.toBeInstanceOf(ProspectContactRequiredError);
  });
});

describe("ACC-CRM prospect ownership", () => {
  const seed = async (service: CrmService) =>
    service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });

  it("offers only the identity directory's staff for this event", async () => {
    const { service, listAssignableOwnersForEvent } = setup();
    await expect(service.listOwners(organizer, eventId)).resolves.toEqual([
      { id: "organizer", name: "Organizer" },
      { id: "reviewer", name: "Ravi Reviewer" },
    ]);
    expect(listAssignableOwnersForEvent).toHaveBeenCalledWith(eventId);
    // Listing owners is CRM work: it needs the same event capability as the pipeline itself.
    expect(() =>
      service.listOwners(
        {
          ...organizer,
          capabilities: new Set<Capability>(),
          eventAccess: [{ eventId, role: "reviewer", capabilities: new Set(["events:read"]) }],
        },
        eventId,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it("refuses an owner the directory does not know, on create and on reassignment", async () => {
    const { service } = setup();
    await expect(
      service.create(organizer, {
        eventId,
        name: "Typo",
        ownerId: "not-a-real-user-at-all",
        contact: { name: "Typo", email: "typo@example.test" },
      }),
    ).rejects.toBeInstanceOf(ProspectOwnerNotEligibleError);
    // Nothing was written: a refused owner cannot leave a half-created prospect behind.
    await expect(service.list(organizer, eventId, {})).resolves.toEqual([]);

    const prospect = await seed(service);
    const reassign = () =>
      service.update(organizer, eventId, prospect.id, { ownerId: "not-a-real-user-at-all" });
    await expect(reassign()).rejects.toBeInstanceOf(ProspectOwnerNotEligibleError);
    // The error names the control the organizer must fix, which is what the transport renders.
    await expect(reassign()).rejects.toMatchObject({
      fields: { ownerId: ["Choose an organizer or reviewer assigned to this event."] },
    });
    await expect(service.get(organizer, eventId, prospect.id)).resolves.toMatchObject({
      ownerId: organizer.id,
    });
  });

  it("refuses an owner who is staff on another event only", async () => {
    const { service } = setup();
    const prospect = await seed(service);
    // `other-organizer` is assignable — on event two. Eligibility does not travel between events.
    await expect(
      service.update(organizer, eventId, prospect.id, { ownerId: "other-organizer" }),
    ).rejects.toBeInstanceOf(ProspectOwnerNotEligibleError);
    await expect(
      service.create(organizer, {
        eventId,
        name: "Foreign owner",
        ownerId: "other-organizer",
        contact: { name: "Foreign", email: "foreign@example.test" },
      }),
    ).rejects.toBeInstanceOf(ProspectOwnerNotEligibleError);
  });

  it("accepts a reviewer as owner without giving that reviewer CRM access", async () => {
    const { service } = setup();
    const prospect = await seed(service);
    await expect(
      service.update(organizer, eventId, prospect.id, { ownerId: "reviewer" }),
    ).resolves.toMatchObject({ ownerId: "reviewer" });
    // Being assignable is an addressing fact, not a grant: the reviewer still cannot read the
    // pipeline they now own a prospect in.
    const assignedReviewer: Actor = {
      id: "reviewer",
      name: "Ravi Reviewer",
      persona: "reviewer",
      organizations: [],
      capabilities: new Set(["review:evaluate"]),
      eventAccess: [{ eventId, role: "reviewer", capabilities: new Set(["review:evaluate"]) }],
    };
    expect(() => service.list(assignedReviewer, eventId, {})).toThrow(CapabilityDeniedError);
  });

  it("re-sending the stored owner needs no directory lookup and is never refused", async () => {
    const { service, listAssignableOwnersForEvent } = setup();
    const prospect = await seed(service);
    listAssignableOwnersForEvent.mockClear();
    await expect(
      service.update(organizer, eventId, prospect.id, {
        ownerId: organizer.id,
        nextAction: "Send invitation",
      }),
    ).resolves.toMatchObject({ ownerId: organizer.id, nextAction: "Send invitation" });
    expect(listAssignableOwnersForEvent).not.toHaveBeenCalled();
  });
});

describe("ACC-CRM stage history", () => {
  it("records exactly one stage-change per transition, in the same write as the note", async () => {
    const { repository, service } = setup();
    const write = vi.spyOn(repository, "update");
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });

    const moved = await service.update(organizer, eventId, prospect.id, {
      stage: "contacted",
      activity: { kind: "note", summary: "Left a voicemail", private: true },
    });
    expect(moved.activities).toEqual([
      expect.objectContaining({
        kind: "stage-change",
        summary: "Identified → Contacted",
        private: false,
        actorId: organizer.id,
        occurredAt: "2026-08-10T12:00:00.000Z",
      }),
      expect.objectContaining({ kind: "note", summary: "Left a voicemail", private: true }),
    ]);
    // One repository call carrying both entries: the transition cannot outlive a failed note.
    expect(write).toHaveBeenCalledTimes(1);
    const [, activities] = write.mock.calls[0] ?? [];
    expect(activities?.map(({ kind }) => kind)).toEqual(["stage-change", "note"]);

    // A stage the prospect already holds is not a transition, and neither is a command that
    // never mentions the stage — a retry of the same PATCH appends nothing.
    const unchanged = await service.update(organizer, eventId, prospect.id, {
      stage: "contacted",
      nextAction: "Call again",
    });
    expect(unchanged.activities).toHaveLength(2);
    const noStage = await service.update(organizer, eventId, prospect.id, {
      nextAction: "Call once more",
    });
    expect(noStage.activities).toHaveLength(2);

    const engaged = await service.update(organizer, eventId, prospect.id, { stage: "engaged" });
    expect(
      engaged.activities
        .filter(({ kind }) => kind === "stage-change")
        .map(({ summary }) => summary),
    ).toEqual(["Identified → Contacted", "Contacted → Engaged"]);
  });
});

const csv = [
  "name,email,company,title,tags,field:topic",
  "Ada Rivera,ADA@Example.test,Northwind,Principal Engineer,keynote;ai,accessibility",
  "Morgan Chen,morgan@example.test,Southwind,Staff Engineer,workshop,platform",
  ",broken@example.test,,,,",
].join("\n");

const contactOf = (
  service: CrmService,
  input: { name: string; email: string; company?: string; title?: string; tags?: string[] },
) => service.createContact(organizer, organizationId, input);

describe("ACC-CRM organization directory authorization", () => {
  it("authorizes a large event grant with one organization query", async () => {
    const { service, belongsToOrganization, listEventIdsInOrganization } = setup();
    const eventAccess = Array.from({ length: 40 }, (_, index) => ({
      eventId: `bulk-event-${index}`,
      role: "organizer" as const,
      capabilities: new Set(["crm:manage" as const]),
    }));
    listEventIdsInOrganization.mockImplementation(async (organization, candidates) =>
      organization === organizationId && candidates.includes("bulk-event-39")
        ? ["bulk-event-39"]
        : [],
    );
    await service.listContacts({ ...organizer, eventAccess }, organizationId);
    expect(listEventIdsInOrganization).toHaveBeenCalledTimes(1);
    expect(listEventIdsInOrganization).toHaveBeenCalledWith(
      organizationId,
      eventAccess.map(({ eventId: id }) => id),
    );
    expect(belongsToOrganization).not.toHaveBeenCalled();
  });

  it("admits an organizer of this organization and refuses every neighbouring identity", async () => {
    const { service } = setup();
    await expect(service.listContacts(organizer, organizationId)).resolves.toEqual({
      contacts: [],
      filters: {},
    });

    // Staffed on this organization's event, but the directory is not something event staffing
    // grants: a reviewer holds no `crm:manage` anywhere.
    await expect(service.listContacts(reviewer, organizationId)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    // Runs another organization's events. The actor-wide capability is real and irrelevant.
    await expect(service.listContacts(outsideOrganizer, organizationId)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    // Membership of one organization plus a capability earned inside another is access to
    // neither: this identity passes a naive `requireCapability` + membership test, and must not
    // pass this one.
    await expect(
      service.listContacts(borrowedCapability, otherOrganizationId),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(service.listContacts(null, organizationId)).rejects.toThrow();
  });

  it("keeps one organization's contacts invisible to the other", async () => {
    const { service } = setup();
    await contactOf(service, { name: "Ada Rivera", email: "ada@example.test" });
    // `outsideOrganizer` is a legitimate organizer of their own organization, which has none.
    await expect(service.listContacts(outsideOrganizer, otherOrganizationId)).resolves.toEqual({
      contacts: [],
      filters: {},
    });
  });
});

describe("ACC-CRM organization directory", () => {
  it("holds a contact once across two events, with both event histories", async () => {
    const { service } = setup();
    const contact = await contactOf(service, { name: "Ada Rivera", email: "ada@example.test" });

    await service.pushContactToEvent(
      organizer,
      organizationId,
      contact.id,
      { eventId, ownerId: "organizer", convert: false },
      "correlation-one",
    );
    await service.pushContactToEvent(
      organizerOfBothEvents,
      organizationId,
      contact.id,
      { eventId: otherEventId, ownerId: "other-organizer", convert: false },
      "correlation-two",
    );

    const { contacts } = await service.listContacts(organizer, organizationId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.events.map(({ eventId: id }) => id)).toEqual([eventId, otherEventId]);
    // Each event's pipeline still sees only its own prospect.
    expect(await service.list(organizer, eventId, {})).toHaveLength(1);
    expect(await service.list(organizerOfBothEvents, otherEventId, {})).toHaveLength(1);
  });

  it("converts a pushed contact exactly once and keeps the prospect provenance", async () => {
    const { service, createOrLink } = setup();
    const contact = await contactOf(service, { name: "Ada Rivera", email: "ada@example.test" });
    const first = await service.pushContactToEvent(
      organizer,
      organizationId,
      contact.id,
      { eventId, ownerId: "organizer", convert: true },
      "correlation-one",
    );
    expect(first.prospect.speakerId).toBe("40000000-0000-4000-8000-000000000001");
    expect(first.prospect.activities.map(({ kind }) => kind)).toContain("conversion");
    // The conversion crossed the boundary as the existing command, with the existing key.
    expect(createOrLink).toHaveBeenCalledTimes(1);
    expect(createOrLink.mock.calls[0]?.[0]).toMatchObject({
      eventId,
      source: { kind: "crm-prospect", id: first.prospect.id },
      idempotencyKey: `crm-conversion:${eventId}:${first.prospect.id}`,
    });

    const again = await service.pushContactToEvent(
      organizer,
      organizationId,
      contact.id,
      { eventId, ownerId: "organizer", convert: true },
      "correlation-two",
    );
    expect(again.prospect.id).toBe(first.prospect.id);
    expect(createOrLink).toHaveBeenCalledTimes(1);
    expect(again.contact.events).toHaveLength(1);
    expect(again.contact.activities.filter(({ kind }) => kind === "conversion")).toHaveLength(1);
  });

  it("adopts an event prospect with the same normalized address instead of duplicating it", async () => {
    const { service, repository, createOrLink } = setup();
    const tracked = await service.create(organizer, {
      eventId,
      name: "Ada before the directory",
      ownerId: organizer.id,
      nextAction: "Keep the original provenance",
      contact: { name: "Ada Rivera", email: "  ADA@Example.Test " },
    });
    const contact = await contactOf(service, {
      name: "Dr. Ada Rivera",
      email: "ada@example.test",
    });

    const pushed = await service.pushContactToEvent(
      organizer,
      organizationId,
      contact.id,
      { eventId, ownerId: organizer.id, convert: true },
      "correlation-adopt",
    );

    expect(pushed.prospect).toMatchObject({
      id: tracked.id,
      name: tracked.name,
      ownerId: tracked.ownerId,
      nextAction: tracked.nextAction,
    });
    expect(await service.list(organizer, eventId, {})).toHaveLength(1);
    expect(pushed.contact.events).toEqual([
      expect.objectContaining({ eventId, prospectId: tracked.id }),
    ]);
    expect(pushed.contact.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "note",
          summary: `Already tracked on event ${eventId}; linked existing prospect`,
        }),
      ]),
    );
    expect(createOrLink).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: "crm-prospect", id: tracked.id } }),
    );
    await expect(
      repository.linkContactToExistingProspect({
        contact: pushed.contact,
        prospect: pushed.prospect,
        activity: {
          id: "71000000-0000-4000-8000-000000000099",
          kind: "note",
          summary: "Duplicate link must not land",
          private: false,
          occurredAt: "2026-08-12T12:00:00.000Z",
          actorId: organizer.id,
        },
      }),
    ).rejects.toThrow("already in that event's pipeline");
    const otherContact = await contactOf(service, {
      name: "Another Ada",
      email: "another-ada@example.test",
    });
    await expect(
      repository.linkContactToExistingProspect({
        contact: otherContact,
        prospect: pushed.prospect,
        activity: {
          id: "71000000-0000-4000-8000-000000000098",
          kind: "note",
          summary: "Prospect cannot belong to two directory contacts",
          private: false,
          occurredAt: "2026-08-12T12:00:00.000Z",
          actorId: organizer.id,
        },
      }),
    ).rejects.toThrow("already in that event's pipeline");
  });

  it("refuses to source a contact into an event outside the organization or outside its reach", async () => {
    const { service } = setup();
    const contact = await contactOf(service, { name: "Ada Rivera", email: "ada@example.test" });
    // The organizer holds no `crm:manage` on the outside event, so this is refused as a
    // capability failure before the organization mismatch is even reached.
    await expect(
      service.pushContactToEvent(
        organizer,
        organizationId,
        contact.id,
        { eventId: outsideEventId, ownerId: "outside-organizer", convert: false },
        "correlation",
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    // And the outside organizer cannot reach this organization's contact at all.
    await expect(
      service.pushContactToEvent(
        outsideOrganizer,
        organizationId,
        contact.id,
        { eventId: outsideEventId, ownerId: "outside-organizer", convert: false },
        "correlation",
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("filters on company, title, tags and custom fields, and clears back to everybody", async () => {
    const { service } = setup();
    await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      company: "Northwind",
      title: "Principal Engineer",
      tags: ["keynote", "ai"],
    });
    await contactOf(service, {
      name: "Morgan Chen",
      email: "morgan@example.test",
      company: "Southwind",
      title: "Staff Engineer",
      tags: ["workshop"],
    });

    const names = async (query: Parameters<typeof service.listContacts>[2]) =>
      (await service.listContacts(organizer, organizationId, query)).contacts.map(
        ({ name }) => name,
      );
    expect(await names({ company: "northwind" })).toEqual(["Ada Rivera"]);
    expect(await names({ title: "Staff Engineer" })).toEqual(["Morgan Chen"]);
    // Every named tag, not any of them.
    expect(await names({ tags: ["keynote", "ai"] })).toEqual(["Ada Rivera"]);
    expect(await names({ tags: ["keynote", "workshop"] })).toEqual([]);
    expect(await names({ search: "morgan@" })).toEqual(["Morgan Chen"]);
    expect(await names({})).toEqual(["Ada Rivera", "Morgan Chen"]);
  });

  it("reopens a saved segment by its definition, not by a frozen membership list", async () => {
    const { service } = setup();
    await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      company: "Northwind",
      tags: ["keynote"],
    });
    const segment = await service.createSegment(organizer, organizationId, {
      name: "Keynote shortlist",
      filters: { tags: ["keynote"] },
    });
    await expect(
      service.createSegment(organizer, organizationId, {
        name: "keynote shortlist",
        filters: {},
      }),
    ).rejects.toThrow(/segment with this name already exists/i);

    // Somebody who matches the definition but did not exist when it was saved.
    await contactOf(service, {
      name: "Zoe Kim",
      email: "zoe@example.test",
      company: "Eastwind",
      tags: ["keynote"],
    });
    const reopened = await service.listContacts(organizer, organizationId, {
      segmentId: segment.id,
    });
    expect(reopened.filters).toEqual({ tags: ["keynote"] });
    expect(reopened.contacts.map(({ name }) => name)).toEqual(["Ada Rivera", "Zoe Kim"]);
    // Another organization cannot open it, and its id is not a way in.
    await expect(
      service.listContacts(outsideOrganizer, otherOrganizationId, { segmentId: segment.id }),
    ).rejects.toThrow(/not found/i);
  });

  it("previews an import, then commits it durably without erasing typed notes", async () => {
    const { service } = setup();
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "speakers.csv",
      csv,
    });
    expect(preview.summary).toEqual({ create: 2, update: 0, skip: 1 });
    expect(preview.rows.at(-1)?.errors).toEqual(["A name is required."]);

    const first = await service.importContacts(organizer, organizationId, {
      filename: "speakers.csv",
      csv,
    });
    expect(first.record.createdCount).toBe(2);
    expect(first.rejected).toHaveLength(1);
    const { contacts } = await service.listContacts(organizer, organizationId);
    expect(contacts.map(({ name }) => name)).toEqual(["Ada Rivera", "Morgan Chen"]);
    // The address is normalized on the way in, so a case-varied re-import is the same person.
    expect(contacts[0]?.email).toBe("ada@example.test");
    expect(contacts[0]?.fields).toEqual([{ key: "topic", value: "accessibility" }]);

    const typed = await service.updateContact(organizer, organizationId, contacts[0]?.id ?? "", {
      notes: "Prefers a morning slot",
    });
    const second = await service.previewImport(organizer, organizationId, {
      filename: "speakers.csv",
      csv,
    });
    expect(second.summary).toEqual({ create: 0, update: 2, skip: 1 });
    await service.importContacts(organizer, organizationId, { filename: "speakers.csv", csv });
    const after = await service.getContact(organizer, organizationId, typed.id);
    expect(after.notes).toBe("Prefers a morning slot");
    expect(after.activities.map(({ kind }) => kind)).toContain("import");
    // Re-importing the same file updates rather than duplicating.
    expect((await service.listContacts(organizer, organizationId)).contacts).toHaveLength(2);
  });

  it("refuses an imported row that breaks a contract bound, and keeps the response decodable", async () => {
    const { service } = setup();
    /*
     * The read contract reuses the same limits the create path enforces, so a value the import
     * let through made every later directory response fail the client's decode — and the
     * workspace offers no way to delete the row that did it. The file still imports; the row
     * that broke a bound is refused by name.
     */
    const overlong = [
      "name,email,company,field:topic",
      `Fine Person,fine@example.test,Northwind,${"x".repeat(300)}`,
      `Long Field,long@example.test,Northwind,${"x".repeat(301)}`,
      `Long Company,company@example.test,${"y".repeat(161)},ok`,
    ].join("\n");
    // Both ends of every bound, not just the maximums: an empty custom-field key fails the
    // contract's `min(1)` exactly as firmly as an over-long one, and wedges the same response.
    const unnamedField = ["name,email,field:", "Ada Rivera,ada@example.test,something"].join("\n");
    const empty = await service.previewImport(organizer, organizationId, {
      filename: "unnamed.csv",
      csv: unnamedField,
    });
    expect(empty.rows[0]?.errors).toEqual(['A "field:" column needs a name after the colon.']);
    expect(empty.summary).toEqual({ create: 0, update: 0, skip: 1 });
    // And the counts the create path bounds, which a spreadsheet can exceed just as easily.
    const tooMany = [
      `name,email,tags,${Array.from({ length: 31 }, (_, index) => `field:k${index}`).join(",")}`,
      `Many,many@example.test,${Array.from({ length: 21 }, (_, index) => `t${index}`).join(";")},${Array.from(
        { length: 31 },
        () => "v",
      ).join(",")}`,
    ].join("\n");
    const counted = await service.previewImport(organizer, organizationId, {
      filename: "counts.csv",
      csv: tooMany,
    });
    expect(counted.rows[0]?.errors).toEqual([
      "A contact may carry 20 tags, and this row has 21.",
      "A contact may carry 30 custom fields, and this row has 31.",
    ]);
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "overlong.csv",
      csv: overlong,
    });
    expect(preview.summary).toEqual({ create: 1, update: 0, skip: 2 });
    expect(preview.rows[1]?.errors).toEqual([
      'The value for "topic" is longer than 300 characters.',
    ]);
    expect(preview.rows[2]?.errors).toEqual(["The company is longer than 160 characters."]);

    await service.importContacts(organizer, organizationId, {
      filename: "overlong.csv",
      csv: overlong,
    });
    const { contacts } = await service.listContacts(organizer, organizationId);
    expect(contacts.map(({ email }) => email)).toEqual(["fine@example.test"]);
    // The stored row satisfies the published read schema, which is the property that broke.
    expect(() => contactListResponseSchema.parse({ contacts, filters: {} })).not.toThrow();
    // And so does the message that explains the refusal. The rejected rows are echoed back
    // carrying the very values that broke a bound, so a response contract applying those same
    // bounds to the echo made the preview undecodable exactly when it had something to say.
    const rejected = await service.previewImport(organizer, organizationId, {
      filename: "overlong.csv",
      csv: [overlong, unnamedField.split("\n")[1]].join("\n"),
    });
    expect(() =>
      importPreviewResponseSchema.parse({
        filename: rejected.filename,
        rows: rejected.rows,
        notices: rejected.notices,
        summary: rejected.summary,
      }),
    ).not.toThrow();
  });

  it("refuses an import row that would overfill a contact, rather than truncating what it holds", async () => {
    const { service } = setup();
    /*
     * A cap applied by slicing the union looked like a bound and behaved like a delete: the
     * sliced list is what the repository writes, and the write removes everything not in it.
     * So an import that only meant to enrich destroyed tags it never mentioned — and, because
     * the union listed the stored values first, dropped the organizer's new ones instead.
     */
    const nineteen = Array.from({ length: 19 }, (_, index) => `t${index}`);
    const contact = await contactOf(service, {
      name: "Full Person",
      email: "full@example.test",
      tags: [...nineteen, "keep-me"],
    });
    expect(contact.tags).toHaveLength(20);

    const overfilling = ["name,email,tags", "Full Person,full@example.test,brand-new"].join("\n");
    // The preview says what the commit will do. A capacity check that ran only at commit time
    // showed a green "update" row and then quietly refused it.
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "overfill.csv",
      csv: overfilling,
    });
    expect(preview.summary).toEqual({ create: 0, update: 0, skip: 1 });
    expect(preview.rows[0]?.errors.at(-1)).toMatch(/would take full@example.test to 21 tags/);

    const result = await service.importContacts(organizer, organizationId, {
      filename: "overfill.csv",
      csv: overfilling,
    });
    // The row is refused by name, and counted as skipped rather than reported as an update.
    expect(result.record.updatedCount).toBe(0);
    expect(result.record.skippedCount).toBe(1);
    expect(result.rejected[0]?.errors.at(-1)).toMatch(/would take full@example.test to 21 tags/);
    // Nothing was lost, and nothing was silently added.
    const after = await service.getContact(organizer, organizationId, contact.id);
    expect(after.tags).toHaveLength(20);
    expect(after.tags).toContain("keep-me");
    expect(after.tags).not.toContain("brand-new");
  });

  it("still accepts a row that adds nothing to a contact already over the limit", async () => {
    const { service, repository } = setup();
    /*
     * A merge unions tags with no cap, so a contact above the limit legitimately exists.
     * Measuring the *result* rather than the increase refused every later row against that
     * address — including rows with no tags at all, whose write would have been identical to
     * what was already stored — and told the organizer the row would do something it does not.
     */
    const contact = await contactOf(service, {
      name: "Overfull",
      email: "overfull@example.test",
    });
    await repository.updateContact({
      ...contact,
      tags: Array.from({ length: 25 }, (_, index) => `t${index}`),
    });

    const result = await service.importContacts(organizer, organizationId, {
      filename: "correction.csv",
      csv: ["name,email,company", "Overfull Corrected,overfull@example.test,Northwind"].join("\n"),
    });
    expect(result.record.updatedCount).toBe(1);
    expect(result.record.skippedCount).toBe(0);
    const after = await service.getContact(organizer, organizationId, contact.id);
    expect(after.name).toBe("Overfull Corrected");
    expect(after.tags).toHaveLength(25);
  });

  it("collapses a repeated field key sent directly, as the CSV path does", async () => {
    const { service } = setup();
    // The API accepts a fields array; storage is keyed on (contact, key) and upserts. Returning
    // both entries described a contact that never existed, and counted one extra toward the
    // thirty-field limit — the same pair of defects the CSV path was corrected for.
    const contact = await service.createContact(organizer, organizationId, {
      name: "Direct Person",
      email: "direct@example.test",
      fields: [
        { key: "topic", value: "first" },
        { key: "topic", value: "second" },
      ],
    });
    expect(contact.fields).toEqual([{ key: "topic", value: "second" }]);

    const updated = await service.updateContact(organizer, organizationId, contact.id, {
      fields: [
        { key: "zone", value: "EU" },
        { key: "zone", value: "US" },
      ],
    });
    expect(updated.fields).toEqual([{ key: "zone", value: "US" }]);
  });

  it("collapses a repeated field column the way storage does", async () => {
    const { service } = setup();
    // `crm_contact_fields` is keyed on (contact_id, field_key) and the write upserts, so a sheet
    // with two `field:topic` columns stores one. Returning two described something that was
    // never stored, and counted one extra against the capacity limit.
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "repeated.csv",
      csv: [
        "name,email,field:topic,field:topic",
        "Repeat Person,repeat@example.test,first,second",
      ].join("\n"),
    });
    expect(preview.rows[0]?.fields).toEqual([{ key: "topic", value: "second" }]);

    await service.importContacts(organizer, organizationId, {
      filename: "repeated.csv",
      csv: [
        "name,email,field:topic,field:topic",
        "Repeat Person,repeat@example.test,first,second",
      ].join("\n"),
    });
    const { contacts } = await service.listContacts(organizer, organizationId, {
      search: "repeat@example.test",
    });
    expect(contacts[0]?.fields).toEqual([{ key: "topic", value: "second" }]);
  });

  it("enriches the survivor when a merged-away address is imported again", async () => {
    const { service } = setup();
    // Without alias resolution the re-import created a fresh contact on the loser's address,
    // recreating exactly the duplicate the merge had just resolved.
    const primary = await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      company: "Northwind",
    });
    const duplicate = await contactOf(service, {
      name: "Ada Rivera",
      email: "ada.rivera@personal.test",
      company: "Northwind",
    });
    await service.mergeContacts(organizer, organizationId, {
      primaryId: primary.id,
      duplicateIds: [duplicate.id],
    });

    const again = ["name,email,title", "Ada Rivera,ada.rivera@personal.test,Principal"].join("\n");
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "again.csv",
      csv: again,
    });
    expect(preview.summary).toEqual({ create: 0, update: 1, skip: 0 });
    await service.importContacts(organizer, organizationId, { filename: "again.csv", csv: again });
    const { contacts } = await service.listContacts(organizer, organizationId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.id).toBe(primary.id);
    expect(contacts[0]?.title).toBe("Principal");
  });

  it("refuses a file with more rows than one import may carry", async () => {
    const { service } = setup();
    const rows = Array.from(
      { length: 501 },
      (_, index) => `Person ${index},person-${index}@example.test`,
    );
    // The refusal names the number on the field, which is where the transport renders it.
    await expect(
      service.previewImport(organizer, organizationId, {
        filename: "huge.csv",
        csv: ["name,email", ...rows].join("\n"),
      }),
    ).rejects.toMatchObject({
      fields: { csv: [expect.stringMatching(/501 rows, and an import may carry 500/)] },
    });
  });

  it("records a send once when the delivery it converged on already existed", async () => {
    const { service, send } = setup();
    const contact = await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      tags: ["keynote"],
    });
    // The dispatcher reports a reused delivery, which is what a repeat of one campaign produces.
    send.mockImplementation(async () => ({ deliveryId: "delivery-1", created: false }));
    const result = await service.sendOutreach(organizer, organizationId, {
      eventId,
      templateKey: "speaker-invite",
      contactIds: [contact.id],
    });
    expect(result.sent[0]).toMatchObject({ deliveryId: "delivery-1", created: false });
    const after = await service.getContact(organizer, organizationId, contact.id);
    expect(after.activities.filter(({ kind }) => kind === "outreach")).toHaveLength(0);
  });

  it("keeps the record of every message it managed to send before one failed", async () => {
    const { service, send } = setup();
    const first = await contactOf(service, { name: "First", email: "first@example.test" });
    const second = await contactOf(service, { name: "Second", email: "second@example.test" });
    let call = 0;
    send.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("provider refused");
      return { deliveryId: `delivery-${call}`, created: true };
    });
    await expect(
      service.sendOutreach(organizer, organizationId, {
        eventId,
        templateKey: "speaker-invite",
        contactIds: [first.id, second.id],
      }),
    ).rejects.toThrow(/provider refused/);
    // The first message really was queued; a batched write would have recorded neither.
    const recorded = await service.getContact(organizer, organizationId, first.id);
    expect(recorded.activities.filter(({ kind }) => kind === "outreach")).toHaveLength(1);
    const missed = await service.getContact(organizer, organizationId, second.id);
    expect(missed.activities.filter(({ kind }) => kind === "outreach")).toHaveLength(0);
  });

  it("names both limits when a row breaks both", async () => {
    const { service, repository } = setup();
    const contact = await contactOf(service, { name: "Both", email: "both@example.test" });
    await repository.updateContact({
      ...contact,
      tags: Array.from({ length: 20 }, (_, index) => `t${index}`),
      fields: Array.from({ length: 30 }, (_, index) => ({ key: `k${index}`, value: "v" })),
    });
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "both.csv",
      csv: ["name,email,tags,field:brand", "Both,both@example.test,extra,new"].join("\n"),
    });
    // Fixing the one a single message named, only to earn a second refusal for the one it did
    // not, is a poor way to learn what a file needs.
    expect(preview.rows[0]?.errors).toEqual([
      "This row would take both@example.test to 21 tags, and a contact may carry 20.",
      "This row would take both@example.test to 31 custom fields, and a contact may carry 30.",
    ]);
  });

  it("keeps the file's own values when an import enriches a contact", async () => {
    const { service } = setup();
    const contact = await contactOf(service, {
      name: "Growing Person",
      email: "growing@example.test",
      tags: ["existing"],
    });
    await service.importContacts(organizer, organizationId, {
      filename: "enrich.csv",
      csv: [
        "name,email,tags,field:topic",
        "Growing Person,growing@example.test,added,Platform",
      ].join("\n"),
    });
    const after = await service.getContact(organizer, organizationId, contact.id);
    // Both, and the row's own value first — a file is authoritative about what it names.
    expect(after.tags).toEqual(["added", "existing"]);
    expect(after.fields).toEqual([{ key: "topic", value: "Platform" }]);
  });

  it("names the earlier row when one file imports an address twice", async () => {
    const { service } = setup();
    const preview = await service.previewImport(organizer, organizationId, {
      filename: "twice.csv",
      csv: [
        "name,email",
        "First,dup@example.test",
        "Other,other@example.test",
        "Second,dup@example.test",
      ].join("\n"),
    });
    // Line 4 conflicts with line 2, not with itself.
    expect(preview.rows[2]?.errors).toEqual(["Line 2 already imports dup@example.test."]);
    expect(preview.summary).toEqual({ create: 2, update: 0, skip: 1 });
  });

  it("detects near duplicates and merges them into an explicit primary, keeping history", async () => {
    const { service } = setup();
    const primary = await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      company: "Northwind",
      tags: ["keynote"],
    });
    const duplicate = await contactOf(service, {
      name: "ada  rivera",
      email: "ada.rivera@personal.test",
      company: "NORTHWIND",
      tags: ["ai"],
    });
    await service.pushContactToEvent(
      organizerOfBothEvents,
      organizationId,
      duplicate.id,
      { eventId: otherEventId, ownerId: "other-organizer", convert: false },
      "correlation",
    );
    await service.updateContact(organizer, organizationId, duplicate.id, {
      activity: { kind: "call", summary: "Spoke at the meetup", private: true },
    });

    const groups = await service.duplicates(organizer, organizationId);
    expect(groups).toHaveLength(1);
    // Matched on the name and company despite the different addresses and the stray casing and
    // spacing — an exact address collision is impossible among live contacts.
    expect(groups[0]?.reason).toBe("name-company");
    expect([...(groups[0]?.contactIds ?? [])].sort()).toEqual([primary.id, duplicate.id].sort());
    // The group offers a primary, and it is a member of the group. Which one it is falls to the
    // id tie-break here, because this fixture's clock makes both records the same age.
    expect(groups[0]?.contactIds).toContain(groups[0]?.suggestedPrimaryId);

    await expect(
      service.mergeContacts(organizer, organizationId, {
        primaryId: primary.id,
        duplicateIds: [primary.id],
      }),
    ).rejects.toThrow(/cannot also be a duplicate/);

    const merged = await service.mergeContacts(organizer, organizationId, {
      primaryId: primary.id,
      duplicateIds: [duplicate.id],
    });
    // Nothing is lost: the loser's address survives as an alias, its history and its event link
    // move across, and its tags are absorbed.
    expect(merged.aliases.map(({ email }) => email)).toEqual(["ada.rivera@personal.test"]);
    expect(merged.events.map(({ eventId: id }) => id)).toEqual([otherEventId]);
    expect(merged.activities.map(({ summary }) => summary)).toContain("Spoke at the meetup");
    expect([...merged.tags].sort()).toEqual(["ai", "keynote"]);
    // And the directory now holds one person, searchable under the merged-away address.
    const live = await service.listContacts(organizer, organizationId);
    expect(live.contacts).toHaveLength(1);
    expect(
      (await service.listContacts(organizer, organizationId, { search: "ada.rivera@personal" }))
        .contacts,
    ).toHaveLength(1);
    // A merge cannot be undone by a second merge.
    await expect(
      service.mergeContacts(organizer, organizationId, {
        primaryId: duplicate.id,
        duplicateIds: [primary.id],
      }),
    ).rejects.toThrow(/already been merged away/);
  });

  it("sends segmented outreach through the dispatch port and logs it on each contact", async () => {
    const { service, send } = setup();
    const contact = await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      tags: ["keynote"],
    });
    const segment = await service.createSegment(organizer, organizationId, {
      name: "Keynote shortlist",
      filters: { tags: ["keynote"] },
    });

    const preview = await service.previewOutreach(organizer, organizationId, {
      eventId,
      templateKey: "speaker-invite",
      segmentId: segment.id,
    });
    expect(preview.recipients).toEqual([
      { contactId: contact.id, name: "Ada Rivera", email: "ada@example.test" },
    ]);
    // A preview writes nothing.
    expect(send).not.toHaveBeenCalled();

    const sent = await service.sendOutreach(organizer, organizationId, {
      eventId,
      templateKey: "speaker-invite",
      segmentId: segment.id,
    });
    expect(sent.sent[0]?.deliveryId).toBe("delivery-1");
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      organizationId,
      eventId,
      templateKey: "speaker-invite",
      recipientRef: `crm-contact:${contact.id}`,
      idempotencyKey: `crm-outreach:${eventId}:${contact.id}:speaker-invite:vlatest`,
    });
    // The renderer refuses a placeholder nothing fills, so the greeting name travels with it.
    expect(send.mock.calls[0]?.[0].payload).toMatchObject({ speakerName: "Ada Rivera" });
    const after = await service.getContact(organizer, organizationId, contact.id);
    expect(after.activities.filter(({ kind }) => kind === "outreach")).toHaveLength(1);
  });

  it("refuses outreach that would reach nobody, or that names another organization's event", async () => {
    const { service, send } = setup();
    await contactOf(service, { name: "Ada Rivera", email: "ada@example.test" });
    const empty = await service.createSegment(organizer, organizationId, {
      name: "Nobody",
      filters: { tags: ["nonexistent"] },
    });
    await expect(
      service.sendOutreach(organizer, organizationId, {
        eventId,
        templateKey: "speaker-invite",
        segmentId: empty.id,
      }),
    ).rejects.toThrow(/matches no contacts/);
    await expect(
      service.sendOutreach(organizer, organizationId, {
        eventId: outsideEventId,
        templateKey: "speaker-invite",
        contactIds: ["missing"],
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(send).not.toHaveBeenCalled();
  });

  it("derives dashboard metrics from stored contacts rather than constants", async () => {
    const { service } = setup();
    const empty = await service.dashboard(organizer, organizationId);
    expect(empty).toMatchObject({ contacts: 0, convertedContacts: 0, byStage: [] });

    const contact = await contactOf(service, {
      name: "Ada Rivera",
      email: "ada@example.test",
      company: "Northwind",
    });
    await service.pushContactToEvent(
      organizer,
      organizationId,
      contact.id,
      { eventId, ownerId: "organizer", convert: true },
      "correlation",
    );
    await service.pushContactToEvent(
      organizerOfBothEvents,
      organizationId,
      contact.id,
      { eventId: otherEventId, ownerId: "other-organizer", convert: false },
      "correlation",
    );

    const populated = await service.dashboard(organizer, organizationId);
    expect(populated.contacts).toBe(1);
    expect(populated.contactsInMultipleEvents).toBe(1);
    expect(populated.convertedContacts).toBe(1);
    expect(populated.topCompanies).toEqual([{ company: "Northwind", contacts: 1 }]);
    expect(populated.byStage).toEqual([
      { stage: "converted", contacts: 1 },
      { stage: "identified", contacts: 1 },
    ]);
  });

  it("refuses a second live contact on one address and points at the merge instead", async () => {
    const { service } = setup();
    await contactOf(service, { name: "Ada Rivera", email: "ada@example.test" });
    await expect(
      contactOf(service, { name: "A. Rivera", email: "ADA@example.test" }),
    ).rejects.toThrow(/contact with this email already exists/i);
  });
});

/**
 * The configurable board (#197).
 *
 * What is under test is the set of promises a configurable pipeline has to keep that a fixed
 * one did not: a rename must not move anybody, a category must survive a rename, a stage
 * holding prospects must not vanish, and every move must be on the record.
 */
describe("ACC-CRM configurable pipeline", () => {
  const stageKeys = async (service: CrmService) =>
    (await service.pipelineStages(organizer, eventId)).map(({ key }) => key);

  it("gives an event with no board the default one, and does not re-seed it after an edit", async () => {
    const { service } = setup();
    expect(await stageKeys(service)).toEqual([
      "identified",
      "contacted",
      "engaged",
      "invited",
      "confirmed",
      "converted",
      "future-fit",
      "declined",
    ]);
    // Healing is `INSERT OR IGNORE`, so a rename survives the next read rather than being
    // quietly put back — which is the difference between self-healing and self-undoing.
    await service.savePipelineStages(
      organizer,
      eventId,
      (await service.pipelineStages(organizer, eventId)).map(({ key, label, category }) =>
        key === "engaged" ? { key, label: "In conversation", category } : { key, label, category },
      ),
    );
    const stages = await service.pipelineStages(organizer, eventId);
    expect(stages.find(({ key }) => key === "engaged")?.label).toBe("In conversation");
    expect(stages).toHaveLength(8);
  });

  it("keeps a renamed stage's key, so nobody standing in it moves", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, { stage: "engaged" });
    await service.savePipelineStages(
      organizer,
      eventId,
      (await service.pipelineStages(organizer, eventId)).map(({ key, label, category }) =>
        key === "engaged"
          ? { key, label: "Warm", category: "nurture" as const }
          : { key, label, category },
      ),
    );
    // The card is where it was; only what the column is called and counts as has changed.
    expect((await service.get(organizer, eventId, prospect.id)).stage).toBe("engaged");
    const stage = (await service.pipelineStages(organizer, eventId)).find(
      ({ key }) => key === "engaged",
    );
    expect(stage).toMatchObject({ label: "Warm", category: "nurture" });
  });

  it("refuses to drop a stage that still holds prospects, and names it", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, { stage: "engaged" });
    const without = (await service.pipelineStages(organizer, eventId))
      .filter(({ key }) => key !== "engaged")
      .map(({ key, label, category }) => ({ key, label, category }));
    await expect(service.savePipelineStages(organizer, eventId, without)).rejects.toBeInstanceOf(
      PipelineStageInUseError,
    );
    // An empty stage may simply go: the refusal is about stranding people, not about tidiness.
    const withoutEmpty = (await service.pipelineStages(organizer, eventId))
      .filter(({ key }) => key !== "declined")
      .map(({ key, label, category }) => ({ key, label, category }));
    await expect(
      service.savePipelineStages(organizer, eventId, withoutEmpty),
    ).resolves.toHaveLength(7);
  });

  it("moves everybody out when a stage is deleted, and records where they went", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, { stage: "engaged" });
    const remaining = await service.deletePipelineStage(organizer, eventId, "engaged", "contacted");

    expect(remaining.map(({ key }) => key)).not.toContain("engaged");
    expect((await service.get(organizer, eventId, prospect.id)).stage).toBe("contacted");
    // Sort order is normalized, so "third from the left" is 2 for everybody after a delete.
    expect(remaining.map(({ sortOrder }) => sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Asserted by presence rather than by position: this fixture's clock is frozen, so every
    // transition shares an instant and the tiebreak is a random id. Order is a property of real
    // time, not of this test.
    const history = await service.pipelineHistory(organizer, eventId);
    expect(history).toContainEqual(
      expect.objectContaining({
        prospectId: prospect.id,
        fromStage: "engaged",
        toStage: "contacted",
        actorId: organizer.id,
      }),
    );
  });

  it("refuses a destination that is not on the board, and Converted either way", async () => {
    const { service } = setup();
    await expect(
      service.deletePipelineStage(organizer, eventId, "engaged", "not-a-stage"),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
    // Converting is what puts a card in Converted, so it is neither removable nor a destination.
    await expect(
      service.deletePipelineStage(organizer, eventId, "converted", "engaged"),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
    await expect(
      service.deletePipelineStage(organizer, eventId, "engaged", "converted"),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
    await expect(
      service.deletePipelineStage(organizer, eventId, "no-such-stage", "engaged"),
    ).rejects.toBeInstanceOf(PipelineStageNotFoundError);
  });

  it("refuses a board with two stages sharing a key or a name", async () => {
    const { service } = setup();
    const stages = (await service.pipelineStages(organizer, eventId)).map(
      ({ key, label, category }) => ({ key, label, category }),
    );
    await expect(
      service.savePipelineStages(organizer, eventId, [...stages, stages[0] as never]),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
    await expect(
      service.savePipelineStages(organizer, eventId, [
        ...stages,
        { key: "another", label: "Engaged", category: "open" },
      ]),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
  });

  it("refuses a board without Converted, dropped or renamed away", async () => {
    const { service } = setup();
    const stages = (await service.pipelineStages(organizer, eventId)).map(
      ({ key, label, category }) => ({ key, label, category }),
    );
    // Nobody is standing in Converted on this fixture, so an ordinary "you may drop an empty
    // stage" board is what is being sent: the refusal can only be the Converted guard, not
    // `PipelineStageInUseError` shadowing it.
    await expect(
      service.savePipelineStages(
        organizer,
        eventId,
        stages.filter(({ key }) => key !== "converted"),
      ),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
    // A rename of the key is the same loss wearing a familiar label. `convert` writes the key
    // `converted`, so a column still called Converted under the key `won` is a column every
    // converted card misses — the board would render them nowhere.
    await expect(
      service.savePipelineStages(
        organizer,
        eventId,
        stages.map((stage) => (stage.key === "converted" ? { ...stage, key: "won" } : stage)),
      ),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
    // A refused save writes nothing: the column `convert` targets is still there.
    expect(await stageKeys(service)).toContain("converted");
  });

  it("refuses a move to a stage this board does not have, and into Converted", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await expect(
      service.update(organizer, eventId, prospect.id, { stage: "not-a-stage" }),
    ).rejects.toBeInstanceOf(PipelineStageNotFoundError);
    await expect(
      service.update(organizer, eventId, prospect.id, { stage: "converted" }),
    ).rejects.toBeInstanceOf(PipelineStageInvalidError);
  });

  it("records the arrival, every move and the conversion in one history", async () => {
    const { service } = setup();
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    await service.update(organizer, eventId, prospect.id, { stage: "engaged", source: "board" });
    await service.convert(organizer, eventId, prospect.id, "correlation-1");

    const history = await service.pipelineHistory(organizer, eventId);
    // Sorted here rather than trusted in order, for the same reason: the clock is frozen.
    expect(
      history
        .map(({ fromStage, toStage, source }) => `${fromStage ?? "-"}>${toStage}:${source}`)
        .toSorted(),
    ).toEqual(
      [
        "->identified:created",
        "identified>engaged:board",
        "engaged>converted:conversion",
      ].toSorted(),
    );
    expect(history.every(({ actorId }) => actorId === organizer.id)).toBe(true);
  });

  it("lands a new prospect in the board's first open stage, wherever that is", async () => {
    const { service } = setup();
    // An organizer who reordered their intake column: new cards follow it rather than the
    // literal `identified`, which is the difference between a board that is configurable and
    // one that is configurable everywhere except where things enter it.
    await service.savePipelineStages(organizer, eventId, [
      { key: "declined", label: "Declined", category: "lost" },
      { key: "sourcing", label: "Sourcing", category: "open" },
      { key: "identified", label: "Identified", category: "open" },
      { key: "converted", label: "Converted", category: "won" },
    ]);
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    expect(prospect.stage).toBe("sourcing");
  });

  it("never lands a new prospect in Converted, whatever the board's first column is", async () => {
    const { service } = setup();
    // A board with no `open` stage at all, beginning with Converted. It is a board this service
    // accepts — nothing requires an open column — and taking the leftmost stage as the fallback
    // made every new card arrive in Converted with no `speakerId` and no `convertedAt`: a card
    // reading "converted" that nothing ever converted, which is the one state this domain says
    // cannot exist and which `update` and the board both refuse to produce.
    await service.savePipelineStages(organizer, eventId, [
      { key: "converted", label: "Converted", category: "won" },
      { key: "shortlist", label: "Shortlist", category: "nurture" },
    ]);
    const prospect = await service.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    expect(prospect.stage).toBe("shortlist");
    expect(prospect.speakerId).toBeNull();
    // The arrival is recorded where the card actually is, so the history cannot claim a
    // conversion the speaker domain never heard about.
    expect(await service.pipelineHistory(organizer, eventId)).toContainEqual(
      expect.objectContaining({ prospectId: prospect.id, toStage: "shortlist", source: "created" }),
    );
  });

  it("refuses a creation with only Converted to land in, in the words it refuses a move", async () => {
    const { service } = setup();
    // The board reduced to the one column the product writes. Nowhere honest is left to put a
    // new prospect, and putting it in Converted anyway is the failure the case above pins — so
    // this asks instead that the refusal an organizer reads here is the refusal they would read
    // dragging a card into that column, rather than a second sentence about the same rule.
    await service.savePipelineStages(organizer, eventId, [
      { key: "converted", label: "Converted", category: "won" },
    ]);
    const refusal = await service
      .create(organizer, {
        eventId,
        name: "Ada Rivera",
        ownerId: organizer.id,
        contact: { name: "Ada", email: "ada@example.test" },
      })
      .then(
        () => "the prospect was created",
        (reason: unknown) => reason,
      );
    expect(refusal).toBeInstanceOf(PipelineStageInvalidError);

    // The wording is compared against the live move refusal rather than pinned as a string here,
    // so the two can be reworded together and cannot be reworded apart. A second fixture,
    // because a board holding a prospect cannot be reduced to Converted alone.
    const { service: elsewhere } = setup();
    const prospect = await elsewhere.create(organizer, {
      eventId,
      name: "Ada Rivera",
      ownerId: organizer.id,
      contact: { name: "Ada", email: "ada@example.test" },
    });
    const move = await elsewhere
      .update(organizer, eventId, prospect.id, { stage: "converted" })
      .then(
        () => "the move was allowed",
        (reason: unknown) => reason,
      );
    expect((refusal as Error).message).toBe((move as Error).message);
  });

  it("is closed to somebody without crm:manage on this event", async () => {
    const { service } = setup();
    await expect(service.pipelineStages(reviewer, eventId)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    // A board this service would otherwise accept, and the named error rather than a bare
    // `toThrow`. Sending `[]` proved nothing: validation refuses an empty list before the
    // capability check is ever reached, so that version stayed green with the check deleted.
    // What this case is about is who is asking, not what they sent.
    await expect(
      service.savePipelineStages(reviewer, eventId, [
        { key: "identified", label: "Identified", category: "open" },
        { key: "converted", label: "Converted", category: "won" },
      ]),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(
      service.deletePipelineStage(reviewer, eventId, "engaged", "contacted"),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(service.pipelineHistory(reviewer, eventId)).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    // And the refusals were refusals: the board is still the untouched default, not the
    // two-column one the reviewer tried to save.
    expect(await stageKeys(service)).toHaveLength(8);
  });
});
