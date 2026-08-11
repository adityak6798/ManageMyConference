// @acceptance ACC-CRM
import { describe, expect, it, vi } from "vitest";
import { MemoryCrmRepository } from "../src/adapters/persistence/memory-crm-repository";
import { CrmService } from "../src/application/crm/crm-service";
import {
  ProspectContactRequiredError,
  ProspectOwnerNotEligibleError,
} from "../src/application/crm/errors";
import {
  CapabilityDeniedError,
  type Actor,
  type Capability,
} from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const otherEventId = "00000000-0000-4000-8000-000000000002";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [],
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
};
const setup = () => {
  const repository = new MemoryCrmRepository();
  const createOrLink = vi
    .fn()
    .mockResolvedValue({ speakerId: "40000000-0000-4000-8000-000000000001" });
  const listAssignableOwnersForEvent = vi.fn(
    async (scopedEventId: string) => staffByEvent[scopedEventId] ?? [],
  );
  const service = new CrmService({
    repository,
    speakerConversion: { createOrLink },
    identities: { listAssignableOwnersForEvent },
    newId: () => ids.shift() ?? crypto.randomUUID(),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return { repository, service, createOrLink, listAssignableOwnersForEvent };
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
    const reviewer: Actor = { ...organizer, capabilities: new Set<Capability>() };
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
      service.listOwners({ ...organizer, capabilities: new Set<Capability>() }, eventId),
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
        summary: "identified → contacted",
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
    ).toEqual(["identified → contacted", "contacted → engaged"]);
  });
});
