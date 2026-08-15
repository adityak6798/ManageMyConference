// @acceptance ACC-INTEGRATION
// @spec PRD-COM-001 PRD-INT-001 ARC-FLOW-002
import { describe, expect, it } from "vitest";
import { preparedDeliveryWriter } from "../src/adapters/persistence/d1-communications-repository";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { MAX_BROADCAST_RECIPIENTS } from "../src/application/communications/communications-service";
import {
  CommunicationsInputError,
  CommunicationsNotFoundError,
  CommunicationsService,
  type DeliveryRequest,
  UnverifiedRecipientCapError,
} from "../src/application/communications/public";
import type { Actor } from "../src/application/identity/actor";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
/** A second event in the same organization, for the half of the cap that is per event. */
const otherEventId = "00000000-0000-4000-8000-000000000002";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  eventAccess: [{ eventId, role: "organizer", capabilities: new Set(["communications:manage"]) }],
  capabilities: new Set(["communications:manage"]),
};

const SPEAKERS = [
  { id: "user-ada", name: "Ada Lovelace", email: "ada@example.test" },
  { id: "user-grace", name: "Grace Hopper", email: "grace@example.test" },
  { id: "user-unlinked", name: "Alan Turing", email: null },
];

const harness = (speakers: typeof SPEAKERS = SPEAKERS) => {
  let id = 0;
  const repository = new MemoryCommunicationsRepository();
  const service = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidateEventId, candidateOrganizationId) =>
        (candidateEventId === eventId || candidateEventId === otherEventId) &&
        candidateOrganizationId === organizationId,
    },
    speakerDirectory: { listSpeakersForEvent: async () => speakers },
    newId: () => `id-${++id}`,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  return { repository, service };
};

const seedTemplate = (service: CommunicationsService, version = 1) =>
  service.createTemplate(organizer, {
    organizationId,
    key: "speaker-welcome",
    version,
    channel: "email",
    subject: "You're speaking",
    body: "Hello {{speakerName}}",
  });

const request = (overrides: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  organizationId,
  eventId,
  idempotencyKey: "speaker-welcome:session-1",
  triggerType: "speaker.invited",
  channel: "email",
  recipientRef: "speaker:profile-1",
  payload: { speakerName: "Ada" },
  templateKey: "speaker-welcome",
  ...overrides,
});

describe("communications public enqueue interface", () => {
  it("enqueues a lifecycle delivery with no actor at all", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const enqueued = await service.enqueue(request());

    expect(enqueued.state).toBe("queued");
    const [delivery] = await repository.list(organizationId, eventId);
    expect(delivery?.id).toBe(enqueued.id);
    expect(delivery?.recipientRef).toBe("speaker:profile-1");
    expect(delivery?.templateVersion).toBe(1);
  });

  it("converges on one delivery when the same lifecycle action runs twice", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const first = await service.enqueue(request());
    const second = await service.enqueue(request());

    expect(second.id).toBe(first.id);
    expect(await repository.list(organizationId, eventId)).toHaveLength(1);
  });

  it("refuses an event that belongs to another organization", async () => {
    const { service } = harness();
    await seedTemplate(service);

    await expect(service.enqueue(request({ eventId: "someone-elses-event" }))).rejects.toThrow(
      CommunicationsInputError,
    );
  });

  it("refuses a template version that does not exist", async () => {
    const { service } = harness();
    await seedTemplate(service);

    await expect(service.enqueue(request({ templateVersion: 7 }))).rejects.toThrow(
      CommunicationsNotFoundError,
    );
  });

  it("refuses an email delivery with no template, because there would be nothing to say", async () => {
    const { service } = harness();

    await expect(service.enqueue(request({ templateKey: undefined }))).rejects.toThrow(
      CommunicationsInputError,
    );
  });

  it("prepares a delivery without writing it, for a caller committing its own batch", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const prepared = await service.prepareEnqueue(
      request({ idempotencyKey: "schedule-published:event-1:3" }),
    );

    expect(prepared.state).toBe("queued");
    expect(prepared.templateVersion).toBe(1);
    expect(await repository.list(organizationId, eventId)).toHaveLength(0);

    // What the caller's batch would have written is exactly what enqueue writes.
    await repository.enqueue(prepared);
    expect(await repository.list(organizationId, eventId)).toHaveLength(1);
  });

  it("renders a prepared delivery into an idempotent insert the caller can batch", async () => {
    const { service } = harness();
    await seedTemplate(service);
    const prepared = await service.prepareEnqueue(request());
    const bound: unknown[][] = [];
    const queries: string[] = [];
    const database = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind(...values: unknown[]) {
            bound.push(values);
            return statement;
          },
          run: async () => ({ success: true, meta: { changes: 1 } }),
          all: async () => ({ success: true, results: [] }),
        };
        return statement;
      },
      batch: async () => [{ success: true, meta: { changes: 1 } }],
    };

    const statements = preparedDeliveryWriter(database)(prepared);

    expect(statements).toHaveLength(1);
    expect(queries[0]).toContain("INSERT INTO communication_deliveries");
    // Only the duplicate key is absorbed. `INSERT OR IGNORE` would also swallow a CHECK or
    // NOT NULL violation, and this statement is committed inside another domain's batch with
    // nothing reloading it afterwards — a silently dropped row there is a published schedule
    // with no delivery to announce it.
    expect(queries[0]).toContain("ON CONFLICT (organization_id, idempotency_key) DO NOTHING");
    expect(queries[0]).not.toContain("INSERT OR IGNORE");
    expect(bound[0]).toContain(prepared.idempotencyKey);
    expect(bound[0]).toContain(JSON.stringify(prepared.payload));
  });

  it("returns the delivery that already holds the key rather than an id nobody will write", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);
    const first = await service.prepareEnqueue(request());
    await repository.enqueue(first);

    const second = await service.prepareEnqueue(request());

    // The caller is going to store this id — in its own table, in an event payload. A retried
    // publish command must end up pointing at the delivery the first attempt created, because
    // its own insert will not write a second row for the same key.
    expect(second.id).toBe(first.id);
  });
});

describe("sending a template to an event's speakers", () => {
  it("gives every reachable speaker their own delivery and their own message", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const result = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(result.enqueued).toBe(2);
    const deliveries = await repository.list(organizationId, eventId);
    expect(deliveries.map((delivery) => delivery.recipientRef)).toEqual([
      "ada@example.test",
      "grace@example.test",
    ]);
    // One row per person, each addressed by name: "the send failed" is never true of an
    // audience, only of one address at a time.
    expect(deliveries.map((delivery) => delivery.renderedBody)).toEqual([
      "Hello Ada Lovelace",
      "Hello Grace Hopper",
    ]);
  });

  it("reports the speaker it cannot reach instead of quietly sending to fewer people", async () => {
    const { service } = harness();
    await seedTemplate(service);

    const result = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(result.unreachable).toEqual([
      { userId: "user-unlinked", name: "Alan Turing", address: null },
    ]);
  });

  it("does not mail anyone twice when Send is pressed twice", async () => {
    const { service, repository } = harness();
    await seedTemplate(service);

    const first = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });
    const second = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(await repository.list(organizationId, eventId)).toHaveLength(2);
    expect(second.deliveries.map(({ id }) => id)).toEqual(first.deliveries.map(({ id }) => id));
    // And it says so. Reporting `enqueued: 2` for a send that wrote nothing would promise mail
    // that will never go out — the organizer pressed Send precisely because they were unsure.
    expect(first).toMatchObject({ enqueued: 2, alreadySent: 0 });
    expect(second).toMatchObject({ enqueued: 0, alreadySent: 2 });
  });

  it("refuses an audience too large to send in one durable round trip", async () => {
    const crowd = Array.from({ length: MAX_BROADCAST_RECIPIENTS + 1 }, (_, index) => ({
      id: `user-${index}`,
      name: `Speaker ${index}`,
      email: `speaker${index}@example.test`,
    }));
    const { service, repository } = harness(crowd);
    await seedTemplate(service);

    await expect(
      service.broadcast(organizer, { organizationId, eventId, templateKey: "speaker-welcome" }),
    ).rejects.toThrow(CommunicationsInputError);
    // It fails before writing anything, rather than partway through with half the event queued
    // and the organizer told the send failed.
    expect(await repository.list(organizationId, eventId)).toHaveLength(0);
  });

  it("sends again for a new template version, which is how a wrong message is corrected", async () => {
    const { service, repository } = harness();
    await seedTemplate(service, 1);
    await service.broadcast(organizer, { organizationId, eventId, templateKey: "speaker-welcome" });

    await service.createTemplate(organizer, {
      organizationId,
      key: "speaker-welcome",
      version: 2,
      channel: "email",
      subject: "Correction",
      body: "Sorry {{speakerName}}, the previous note was wrong",
    });
    const corrected = await service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
    });

    expect(corrected.enqueued).toBe(2);
    expect(await repository.list(organizationId, eventId)).toHaveLength(4);
    expect(corrected.deliveries[0]?.renderedSubject).toBe("Correction");
  });

  it("refuses a template that does not exist rather than sending nothing silently", async () => {
    const { service } = harness();

    await expect(
      service.broadcast(organizer, { organizationId, eventId, templateKey: "no-such-template" }),
    ).rejects.toThrow(CommunicationsNotFoundError);
  });

  describe("the unverified-recipient cap", () => {
    /*
     * Issue #132. `POST /api/public/events/:id/submissions` takes no session, so a guest
     * proposal's address is a form answer anybody can type — including somebody else's. The
     * decision notification is the one message the product sends to such an address, so a hundred
     * guest proposals naming one victim turned an organizer's decision run into a hundred
     * messages to a stranger.
     */
    const toGuest = (key: string) =>
      request({
        idempotencyKey: key,
        recipientRef: "victim@example.test",
        recipientTrust: "declared",
      });

    it("stops after three messages to one address on one event", async () => {
      const { service, repository } = harness();
      await seedTemplate(service);

      for (const key of ["d1", "d2", "d3"]) await service.enqueue(toGuest(key));

      await expect(service.enqueue(toGuest("d4"))).rejects.toThrow(UnverifiedRecipientCapError);
      expect(await repository.list(organizationId, eventId)).toHaveLength(3);
    });

    it("counts per event, because agreeing to hear from one conference agrees to nothing else", async () => {
      const { service, repository } = harness();
      await seedTemplate(service);
      for (const key of ["d1", "d2", "d3"]) await service.enqueue(toGuest(key));

      // Same address, different event: the cap is not a global suppression list, and treating it
      // as one would let one conference silence another's messages to a person.
      await service.enqueue({
        ...toGuest("other-event"),
        eventId: otherEventId,
      });

      expect(await repository.list(organizationId, otherEventId)).toHaveLength(1);
    });

    it("does not cap an address the recipient signed in with", async () => {
      // The default is `account`, and every message in the product except a guest decision uses
      // it. Capping those would silently stop a speaker's own mail after three messages.
      const { service, repository } = harness();
      await seedTemplate(service);

      for (const key of ["a1", "a2", "a3", "a4", "a5"])
        await service.enqueue(request({ idempotencyKey: key, recipientRef: "ada@example.test" }));

      expect(await repository.list(organizationId, eventId)).toHaveLength(5);
    });

    it("does not spend the guest's budget on the product's own follow-up mail", async () => {
      /*
       * The composition a review pass reproduced, and the reason the count is scoped to
       * `declared` rather than to the address.
       *
       * Accepting a guest proposal writes the decision to the form address — and then acceptance
       * *itself* generates more mail to the same address: the speaker welcome the conversion
       * provisions, and the first onboarding task. That is three, which is the cap. The organizer
       * then reverses the decision, and the decline was refused: the applicant was never told they
       * had been declined, and nothing about any step was abusive.
       */
      const { service, repository } = harness();
      await seedTemplate(service);

      await service.enqueue(toGuest("decision-accepted"));
      // The product's own follow-up to the same address, on the account-trust path.
      for (const key of ["speaker-invite", "task-1"])
        await service.enqueue(
          request({ idempotencyKey: key, recipientRef: "victim@example.test" }),
        );

      // The reversal still goes out: two declared messages have been written, not three.
      await expect(service.enqueue(toGuest("decision-declined"))).resolves.toMatchObject({
        created: true,
      });
      expect(await repository.list(organizationId, eventId)).toHaveLength(4);
    });

    it("counts the mailbox rather than the string an attacker chose", async () => {
      /*
       * The attacker types the address, so comparing `recipient_ref` byte-for-byte handed them a
       * fresh budget per spelling: a hundred guest proposals naming `victim+1@…`, `victim+2@…` or
       * a different capitalisation is a hundred messages to one inbox, which is exactly the bound
       * the cap claims to impose.
       *
       * `recipientCapKey` folds case and strips a `+tag` — for counting only. The delivery still
       * goes to the exact address that was typed.
       */
      const { service, repository } = harness();
      await seedTemplate(service);

      for (const [key, address] of [
        ["d1", "victim@example.test"],
        ["d2", "Victim@Example.test"],
        ["d3", "victim+conference@example.test"],
      ] as const)
        await service.enqueue(
          request({
            idempotencyKey: key,
            recipientRef: address,
            recipientTrust: "declared",
          }),
        );

      await expect(
        service.enqueue(
          request({
            idempotencyKey: "d4",
            recipientRef: "VICTIM+another@example.test",
            recipientTrust: "declared",
          }),
        ),
      ).rejects.toThrow(UnverifiedRecipientCapError);
      expect(await repository.list(organizationId, eventId)).toHaveLength(3);
      // And the three that were sent kept the address as typed — the normalization is a counting
      // rule, not a rewrite.
      expect(
        (await repository.list(organizationId, eventId)).map(({ recipientRef }) => recipientRef),
      ).toEqual(["victim@example.test", "Victim@Example.test", "victim+conference@example.test"]);
    });

    it("lets a retry of a capped-out message converge instead of refusing it", async () => {
      /*
       * The ordering bug this guards. The third message is written; its retry carries the same
       * key, and a cap checked before the key would refuse it — reporting to an organizer that a
       * decision had not been sent when it had. The key is consulted first for exactly this.
       */
      const { service } = harness();
      await seedTemplate(service);
      for (const key of ["d1", "d2", "d3"]) await service.enqueue(toGuest(key));

      const retried = await service.enqueue(toGuest("d3"));

      expect(retried.created).toBe(false);
      expect(retried.state).toBe("queued");
    });
  });

  it("lists every immutable version so an organizer can read what was sent", async () => {
    const { service } = harness();
    await seedTemplate(service, 1);
    await seedTemplate(service, 2);

    const templates = await service.templates(organizer, organizationId);

    // Filtered to the key under test: listing also provisions this organization's lifecycle
    // defaults (issue #217), each at version 1, and they are not what this asserts.
    expect(
      templates.filter(({ key }) => key === "speaker-welcome").map(({ version }) => version),
    ).toEqual([2, 1]);
  });
});
