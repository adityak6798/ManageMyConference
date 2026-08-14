// @acceptance ACC-CFP
import { describe, expect, it } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import {
  CfpDraftConflictError,
  CfpService,
  CfpUnavailableError,
  CfpValidationError,
} from "../src/application/cfp/cfp-service";
import type { Actor } from "../src/application/identity/actor";

const eventId = "00000000-0000-4000-8000-000000000001";
const actor: Actor = {
  id: "organizer",
  name: "O",
  persona: "organizer",
  organizations: [],
  capabilities: new Set(),
  eventAccess: [
    { eventId, role: "organizer", capabilities: new Set(["events:settings:update" as const]) },
  ],
};
const fields = [
  {
    id: "title",
    type: "short_text" as const,
    label: "Talk title",
    guidance: "Be concise",
    required: true,
    options: [],
  },
  {
    id: "email",
    type: "email" as const,
    label: "Email",
    guidance: "",
    required: true,
    options: [],
  },
];
describe("CFP service", () => {
  it("supports draft, publish, close, and reopen", async () => {
    const service = new CfpService(
      new MemoryCfpRepository(),
      crypto.randomUUID,
      () => new Date("2026-08-10T12:00:00Z"),
    );
    expect(
      (
        await service.save(actor, {
          eventId,
          title: "Speak",
          description: "Join us",
          fields,
          expectedVersion: 0,
        })
      ).status,
    ).toBe("draft");
    expect((await service.changeState(actor, eventId, "publish")).status).toBe("open");
    expect((await service.changeState(actor, eventId, "close")).status).toBe("closed");
    expect((await service.changeState(actor, eventId, "reopen")).status).toBe("open");
  });
  it("validates fields and makes retries idempotent", async () => {
    let sequence = 0;
    const service = new CfpService(
      new MemoryCfpRepository(),
      () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      () => new Date("2026-08-10T12:00:00Z"),
    );
    await service.save(actor, {
      eventId,
      title: "Speak",
      description: "",
      fields,
      expectedVersion: 0,
    });
    await service.changeState(actor, eventId, "publish");
    await expect(
      service.submit(eventId, "retry-key", { title: "", email: "bad" }),
    ).rejects.toBeInstanceOf(CfpValidationError);
    const first = await service.submit(eventId, "retry-key-1", {
      title: "Typed forms",
      email: "a@example.com",
    });
    const retry = await service.submit(eventId, "retry-key-1", {
      title: "Changed",
      email: "b@example.com",
    });
    expect(retry).toEqual(first);
    await expect(service.proposalReference(first.id, eventId)).resolves.toEqual({
      proposalId: first.id,
      eventId,
      cfpVersion: first.cfpVersion,
      submittedAt: first.submittedAt,
    });
  });
  it("honours conditional visibility on the server and snapshots the resolved route", async () => {
    const service = new CfpService(
      new MemoryCfpRepository(),
      () => "00000000-0000-4000-8000-000000000049",
      () => new Date("2026-08-11T12:00:00Z"),
      {
        listStatuses: async () => [
          { key: "submitted", label: "Submitted", sortOrder: 0 },
          { key: "under_review", label: "Under review", sortOrder: 1 },
        ],
      },
    );
    const conditionalFields = [
      ...fields,
      {
        id: "category",
        type: "select" as const,
        label: "Category",
        guidance: "",
        required: true,
        options: ["Workshop", "Talk"],
      },
      {
        id: "equipment",
        type: "short_text" as const,
        label: "Equipment",
        guidance: "",
        required: true,
        options: [],
        visibleWhen: { fieldId: "category", operator: "equals" as const, values: ["Workshop"] },
      },
    ];
    await service.save(actor, {
      eventId,
      title: "Speak",
      description: "",
      fields: conditionalFields,
      routing: [
        {
          id: "workshops",
          when: { fieldId: "category", operator: "in", values: ["Workshop"] },
          routeTo: { status: "under_review" },
        },
      ],
      expectedVersion: 0,
    });
    await expect(
      service.save(actor, {
        eventId,
        title: "Invalid route",
        description: "",
        fields: conditionalFields,
        routing: [
          {
            id: "typo",
            when: { fieldId: "category", operator: "equals", values: ["Talk"] },
            routeTo: { status: "under_reveiw" },
          },
        ],
        expectedVersion: 1,
      }),
    ).rejects.toThrow("Choose a configured proposal status");
    await service.changeState(actor, eventId, "publish");

    await expect(
      service.submit(eventId, "hidden-answer", {
        title: "Talk",
        email: "a@example.com",
        category: "Talk",
        equipment: "Projector",
      }),
    ).rejects.toMatchObject({
      fieldErrors: { "answers.equipment": ["This field is hidden for the answers you selected."] },
    });
    await expect(
      service.submit(eventId, "hidden-required-skip", {
        title: "Talk",
        email: "a@example.com",
        category: "Talk",
      }),
    ).resolves.toMatchObject({ resolvedRoute: null });
    await expect(
      service.submit(eventId, "workshop-route", {
        title: "Workshop",
        email: "a@example.com",
        category: "Workshop",
        equipment: "Projector",
      }),
    ).resolves.toMatchObject({
      resolvedRoute: { ruleId: "workshops", status: "under_review" },
    });
  });
  it("does not expose drafts and rejects cross-event organizers", async () => {
    const service = new CfpService(new MemoryCfpRepository(), crypto.randomUUID, () => new Date());
    await service.save(actor, {
      eventId,
      title: "Speak",
      description: "",
      fields,
      expectedVersion: 0,
    });
    await expect(service.getPublished(eventId)).rejects.toBeInstanceOf(CfpUnavailableError);
    await expect(service.changeState(actor, eventId, "close")).rejects.toThrow(
      "Only an open CFP can be closed",
    );
    await expect(service.changeState(actor, eventId, "reopen")).rejects.toThrow(
      "Only a closed CFP can be reopened",
    );
    await expect(
      service.getForOrganizer(actor, "00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow("Organizer event access denied");
  });
  it("rejects a stale draft save without replacing the newer draft", async () => {
    const service = new CfpService(new MemoryCfpRepository(), crypto.randomUUID, () => new Date());
    await service.save(actor, {
      eventId,
      title: "Original",
      description: "",
      fields,
      expectedVersion: 0,
    });
    await service.save(actor, {
      eventId,
      title: "Newer",
      description: "",
      fields,
      expectedVersion: 1,
    });
    await expect(
      service.save(actor, {
        eventId,
        title: "Stale",
        description: "",
        fields,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(CfpDraftConflictError);
    await expect(service.getForOrganizer(actor, eventId)).resolves.toMatchObject({
      title: "Newer",
      version: 2,
    });
  });
  it("keeps the published snapshot public while a replacement draft is edited", async () => {
    const service = new CfpService(new MemoryCfpRepository(), crypto.randomUUID, () => new Date());
    await service.save(actor, {
      eventId,
      title: "Published",
      description: "",
      fields,
      expectedVersion: 0,
    });
    await service.changeState(actor, eventId, "publish");
    await service.save(actor, {
      eventId,
      title: "New draft",
      description: "",
      fields,
      expectedVersion: 1,
    });
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      title: "Published",
      status: "open",
    });
    await service.changeState(actor, eventId, "close");
    await expect(service.getForOrganizer(actor, eventId)).resolves.toMatchObject({
      title: "New draft",
      status: "draft",
    });
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      title: "Published",
      status: "closed",
    });
    await service.changeState(actor, eventId, "reopen");
    await expect(service.getForOrganizer(actor, eventId)).resolves.toMatchObject({
      title: "New draft",
      status: "draft",
    });
    await service.changeState(actor, eventId, "publish");
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      title: "New draft",
      status: "open",
    });
  });

  /*
   * Publishing a new version of the form is not a decision about submissions.
   *
   * An organizer who closed the call after the deadline, then fixed a typo and pressed
   * "Publish changes", used to reopen it: `changeState` wrote `status: "open"` for anything
   * that was not a close, so late proposals started arriving again and the only message on
   * screen talked about the form. Reopening has its own button and that stays the only way.
   */
  it("keeps a closed call closed when a new version of the form is published", async () => {
    const service = new CfpService(
      new MemoryCfpRepository(),
      () => crypto.randomUUID(),
      () => new Date(),
    );
    await service.save(actor, {
      eventId,
      title: "Published",
      description: "",
      fields,
      expectedVersion: 0,
    });
    await service.changeState(actor, eventId, "publish");
    await service.changeState(actor, eventId, "close");

    await service.save(actor, {
      eventId,
      title: "Typo fixed",
      description: "",
      fields,
      expectedVersion: 1,
    });
    const republished = await service.changeState(actor, eventId, "publish");
    expect(republished.publishedStatus).toBe("closed");
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      title: "Typo fixed",
      status: "closed",
    });
    /*
     * The applicant-facing consequence, which is the whole point: no late submissions.
     *
     * Still `CfpUnavailableError` — `404 NOT_FOUND` on the wire — on this door, and deliberately.
     * A closed call is a resource whose *state* refuses the write, so 409 is the better answer and
     * it is what the account-bound routes issue #190 added give. This endpoint is not new: it
     * documented 404, and `api-compatibility.md` makes repurposing a status code a breaking change
     * that ships additively and waits 180 days. The improvement is filed, not smuggled in.
     */
    await expect(
      service.submit(eventId, "after-republish", { title: "Late", email: "a@example.com" }),
    ).rejects.toBeInstanceOf(CfpUnavailableError);

    // Reopening is still one explicit click, and it still works on the republished form.
    await service.changeState(actor, eventId, "reopen");
    await expect(service.getPublished(eventId)).resolves.toMatchObject({
      title: "Typo fixed",
      status: "open",
    });
    await expect(
      service.submit(eventId, "after-reopen", { title: "On time", email: "a@example.com" }),
    ).resolves.toMatchObject({ eventId });
  });
});
