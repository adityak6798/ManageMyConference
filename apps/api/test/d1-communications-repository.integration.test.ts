// @acceptance ACC-INTEGRATION
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, createMigratedDatabase } from "./support/seeded-d1";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import { D1ContentRepository } from "../src/adapters/persistence/d1-content-repository";
import {
  D1CommunicationsRepository,
  preparedDeliveryWriter,
} from "../src/adapters/persistence/d1-communications-repository";
import { TemplateVersionTakenError } from "../src/application/communications/ports";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import { CommunicationsService } from "../src/application/communications/communications-service";
import apiWorker, { type Environment } from "../src/index";

describe("D1CommunicationsRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("enqueues an audience larger than D1's bound-parameter limit in one go", async () => {
    const migrated = await createMigratedDatabase({ label: "communications-batch", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CommunicationsRepository(migrated.database);
    // 150 crosses the 100-parameter ceiling on the reload that follows the insert batch. The
    // batch has already committed by then, so getting this wrong queued every delivery and then
    // answered the organizer with an error.
    const audience = Array.from({ length: 150 }, (_, index) => ({
      id: `delivery-${index}`,
      organizationId: "00000000-0000-4000-8000-000000000010",
      eventId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: `broadcast:welcome:v1:event:user-${index}`,
      triggerType: "speaker.invited" as const,
      channel: "email" as const,
      templateId: "template-speaker-v1",
      templateVersion: 1,
      recipientRef: `speaker${index}@example.test`,
      recipientTrust: "account" as const,
      payload: { speakerName: `Speaker ${index}` },
      renderedSubject: "Welcome",
      renderedBody: `Hello Speaker ${index}`,
      projectionVersion: null,
      state: "queued" as const,
      attemptCount: 0,
      nextAttemptAt: "2026-08-10T12:00:00.000Z",
      leaseToken: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    }));

    const stored = await repository.enqueueMany(audience);

    expect(stored).toHaveLength(150);
    // Request order is preserved, so a caller can pair each stored row with what it prepared.
    expect(stored.map(({ id }) => id)).toEqual(audience.map(({ id }) => id));

    // And re-sending returns the original rows rather than writing a second set.
    const repeated = await repository.enqueueMany(
      audience.map((delivery) => ({ ...delivery, id: `${delivery.id}-second` })),
    );
    expect(repeated.map(({ id }) => id)).toEqual(audience.map(({ id }) => id));
  });

  it("atomically advances calendar invitation state and its delivery sequence", async () => {
    const migrated = await createMigratedDatabase({ label: "calendar-invite-state", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CommunicationsRepository(migrated.database);
    let id = 0;
    const communications = new CommunicationsService({
      repository,
      eventDirectory: { belongsToOrganization: async () => true },
      newId: () => `calendar-delivery-${++id}`,
      now: () => new Date("2026-08-12T09:00:00.000Z"),
    });
    const organizationId = "00000000-0000-4000-8000-000000000010";
    const eventId = "00000000-0000-4000-8000-000000000001";
    const send = (scheduleRef: string, recipientRef = "ada@example.test") =>
      communications.enqueueCalendarInvite({
        organizationId,
        eventId,
        sessionId: "session-1",
        speakerProfileId: "speaker-1",
        scheduleRef,
        scheduleRevisedAt: "2026-08-12T08:00:00.000Z",
        recipientRef,
        deliveryFor: (sequence) => ({
          organizationId,
          eventId,
          idempotencyKey: `calendar-invite:session-1:speaker-1:${sequence}`,
          triggerType: "speaker.calendar_invite",
          channel: "email",
          recipientRef,
          templateKey: "speaker-calendar-invite",
          payload: {
            speakerName: "Ada",
            sessionTitle: "State",
            eventName: "Greenroom Demo Summit",
            calendarInvite: {
              method: "REQUEST",
              filename: "invite.ics",
              content: `SEQUENCE:${sequence}`,
            },
          },
        }),
      });

    await expect(send("A")).resolves.toMatchObject({ created: true, sequence: 0 });
    await expect(send("A")).resolves.toMatchObject({ created: false, sequence: 0 });
    await expect(send("B")).resolves.toMatchObject({ created: true, sequence: 1 });
    await expect(send("A")).resolves.toMatchObject({ created: true, sequence: 2 });
    await expect(send("A", "corrected@example.test")).resolves.toMatchObject({
      created: true,
      sequence: 3,
    });

    const deliveries = (await repository.list(organizationId, eventId)).filter(
      ({ triggerType }) => triggerType === "speaker.calendar_invite",
    );
    expect(deliveries.map(({ recipientRef, payload }) => ({ recipientRef, payload }))).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          calendarInvite: expect.objectContaining({ content: "SEQUENCE:0" }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          calendarInvite: expect.objectContaining({ content: "SEQUENCE:1" }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          calendarInvite: expect.objectContaining({ content: "SEQUENCE:2" }),
        }),
      }),
      expect.objectContaining({
        recipientRef: "corrected@example.test",
        payload: expect.objectContaining({
          calendarInvite: expect.objectContaining({ content: "SEQUENCE:3" }),
        }),
      }),
    ]);
  });

  it("persists idempotent deliveries and atomically records attempts with projection state", async () => {
    const migrated = await createMigratedDatabase({ label: "communications", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const repository = new D1CommunicationsRepository(database);
    const delivery = {
      id: "delivery-new",
      organizationId: "00000000-0000-4000-8000-000000000010",
      eventId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "projection:session:99:v2",
      triggerType: "projection.requested" as const,
      channel: "airtable" as const,
      templateId: null,
      templateVersion: null,
      recipientRef: "session:99",
      recipientTrust: "account" as const,
      payload: { title: "D1 Session" },
      renderedSubject: null,
      renderedBody: null,
      projectionVersion: 2,
      state: "queued" as const,
      attemptCount: 0,
      nextAttemptAt: "2026-08-10T11:00:00.000Z",
      leaseToken: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    expect((await repository.enqueue(delivery)).id).toBe(delivery.id);
    expect((await repository.enqueue({ ...delivery, id: "duplicate" })).id).toBe(delivery.id);
    const leased = await repository.leaseNext("2026-08-10T12:00:00.000Z", "lease-1");
    expect(leased?.id).toBe(delivery.id);
    await repository.complete(
      "lease-1",
      {
        id: "attempt-new",
        deliveryId: delivery.id,
        sequence: 1,
        startedAt: delivery.createdAt,
        completedAt: "2026-08-10T12:00:01.000Z",
        outcome: "succeeded",
        providerReference: "fake:airtable:delivery-new",
        errorCode: null,
      },
      {
        state: "succeeded",
        nextAttemptAt: "2026-08-10T12:00:01.000Z",
        updatedAt: "2026-08-10T12:00:01.000Z",
      },
      {
        destination: "airtable",
        eventId: delivery.eventId,
        resourceRef: delivery.recipientRef,
        version: 2,
        deliveryId: delivery.id,
        projectedAt: "2026-08-10T12:00:01.000Z",
      },
    );
    expect(await repository.attempts(delivery.id)).toHaveLength(1);
    expect(await repository.get(delivery.id)).toMatchObject({
      state: "succeeded",
      attemptCount: 1,
      leaseToken: null,
    });
    const firstPage = await repository.historyPage(delivery.organizationId, delivery.eventId, {
      limit: 2,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.items.some(({ attempts }) => attempts.length > 0)).toBe(true);
    await repository.enqueue({
      ...delivery,
      id: "delivery-newer",
      idempotencyKey: "projection:session:99:v3",
      projectionVersion: 3,
      state: "queued",
      attemptCount: 0,
      leaseToken: null,
    });
    await expect(repository.isProjectionSuperseded(delivery)).resolves.toBe(true);
  });

  /**
   * The same repair as `communications-service.test.ts` proves against the in-memory model, run
   * against the SQL that actually ships — because both halves of it live in SQL and nowhere else:
   * the refusal is a `WHERE excluded.version >= …` on an upsert, and the repair is a conditional
   * `UPDATE` in the same batch. A model that agrees with a statement it does not execute proves
   * nothing about `meta.changes`, about the batch's atomicity, or about the guards on the update.
   */
  it("reports a refused projection and re-queues the delivery that owns the newer version", async () => {
    const migrated = await createMigratedDatabase({ label: "communications-stale", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CommunicationsRepository(migrated.database);
    const base = {
      organizationId: "00000000-0000-4000-8000-000000000010",
      eventId: "00000000-0000-4000-8000-000000000001",
      triggerType: "projection.requested" as const,
      channel: "airtable" as const,
      templateId: null,
      templateVersion: null,
      recipientRef: "session:77",
      recipientTrust: "account" as const,
      renderedSubject: null,
      renderedBody: null,
      state: "queued" as const,
      attemptCount: 0,
      nextAttemptAt: "2026-08-10T11:00:00.000Z",
      leaseToken: null,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    const stale = {
      ...base,
      id: "stale-v1",
      idempotencyKey: "projection:session:77:v1",
      payload: { title: "Old" },
      projectionVersion: 1,
    };
    const winner = { ...base, id: "winner-v2", idempotencyKey: "projection:session:77:v2" };
    await repository.enqueue(stale);
    await repository.enqueue({ ...winner, payload: { title: "New" }, projectionVersion: 2 });
    // Leases are taken by hand rather than through `leaseNext`, which orders by due time and would
    // pick between these two — and the seeded event's own queued deliveries — arbitrarily. What
    // is under test is `complete`, and it needs a named delivery on each side of the race.
    const lease = async (deliveryId: string, token: string) => {
      const result = await migrated.database
        .prepare("UPDATE communication_deliveries SET lease_token = ? WHERE id = ?")
        .bind(token, deliveryId)
        .run();
      expect(result.meta?.changes).toBe(1);
    };

    // v2 completes first and records the projection state.
    await lease(winner.id, "lease-v2");
    const winnerCompletion = await repository.complete(
      "lease-v2",
      {
        id: "attempt-v2",
        deliveryId: winner.id,
        sequence: 1,
        startedAt: "2026-08-10T12:00:00.000Z",
        completedAt: "2026-08-10T12:00:01.000Z",
        outcome: "succeeded",
        providerReference: "fake:airtable:winner-v2",
        errorCode: null,
      },
      {
        state: "succeeded",
        nextAttemptAt: "2026-08-10T12:00:01.000Z",
        updatedAt: "2026-08-10T12:00:01.000Z",
      },
      {
        destination: "airtable",
        eventId: base.eventId,
        resourceRef: base.recipientRef,
        version: 2,
        deliveryId: winner.id,
        projectedAt: "2026-08-10T12:00:01.000Z",
      },
    );
    expect(winnerCompletion.projectionApplied).toBe(true);

    // v1's provider call was already in flight and lands afterwards, overwriting v2 remotely.
    await lease(stale.id, "lease-v1");
    const staleCompletion = await repository.complete(
      "lease-v1",
      {
        id: "attempt-v1",
        deliveryId: stale.id,
        sequence: 1,
        startedAt: "2026-08-10T12:00:00.000Z",
        completedAt: "2026-08-10T12:00:03.000Z",
        outcome: "succeeded",
        providerReference: "fake:airtable:stale-v1",
        errorCode: null,
      },
      {
        state: "succeeded",
        nextAttemptAt: "2026-08-10T12:00:03.000Z",
        updatedAt: "2026-08-10T12:00:03.000Z",
      },
      {
        destination: "airtable",
        eventId: base.eventId,
        resourceRef: base.recipientRef,
        version: 1,
        deliveryId: stale.id,
        projectedAt: "2026-08-10T12:00:03.000Z",
      },
    );

    expect(staleCompletion.projectionApplied).toBe(false);
    // The projection row still names v2 — the version guard held.
    const recorded = await migrated.database
      .prepare(
        "SELECT version, delivery_id FROM outbound_projection_state WHERE destination = ? AND event_id = ? AND resource_ref = ?",
      )
      .bind("airtable", base.eventId, base.recipientRef)
      .all<{ version: number; delivery_id: string }>();
    expect(recorded.results?.[0]).toMatchObject({ version: 2, delivery_id: winner.id });
    // v1's own attempt is still recorded as the success it was.
    expect(await repository.attempts(stale.id)).toHaveLength(1);
    // The repair: v2 is queued again, so the winning payload is re-sent to the external system.
    expect(await repository.get(winner.id)).toMatchObject({
      state: "queued",
      nextAttemptAt: "2026-08-10T12:00:03.000Z",
    });
    // The re-queued row still carries v2's payload, so what gets re-sent is the winning data
    // rather than an empty replay.
    expect(await repository.get(winner.id)).toMatchObject({
      payload: { title: "New" },
      projectionVersion: 2,
    });
    await lease(winner.id, "lease-repair");

    // Re-sending an equal version is accepted, so the repair does not queue another repair.
    const repairCompletion = await repository.complete(
      "lease-repair",
      {
        id: "attempt-repair",
        deliveryId: winner.id,
        sequence: 2,
        startedAt: "2026-08-10T12:00:04.000Z",
        completedAt: "2026-08-10T12:00:05.000Z",
        outcome: "succeeded",
        providerReference: "fake:airtable:winner-v2-again",
        errorCode: null,
      },
      {
        state: "succeeded",
        nextAttemptAt: "2026-08-10T12:00:05.000Z",
        updatedAt: "2026-08-10T12:00:05.000Z",
      },
      {
        destination: "airtable",
        eventId: base.eventId,
        resourceRef: base.recipientRef,
        version: 2,
        deliveryId: winner.id,
        projectedAt: "2026-08-10T12:00:05.000Z",
      },
    );
    expect(repairCompletion.projectionApplied).toBe(true);
    expect(await repository.get(winner.id)).toMatchObject({ state: "succeeded" });
    expect(await repository.attempts(winner.id)).toHaveLength(2);
  });

  it("executes queued work through the deployed scheduled entrypoint", async () => {
    const migrated = await createMigratedDatabase({
      label: "communications-scheduled",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;

    await apiWorker.scheduled({}, { DB: database } as Environment);

    // The seeded queued row is a speaker's schedule confirmation, shaped as the publication
    // fan-out writes it. Draining it proves the deployed entrypoint reaches a delivery the
    // product itself would have produced, rather than one invented for this assertion.
    const row = await database
      .prepare(
        "SELECT state, attempt_count FROM communication_deliveries WHERE id = 'delivery-schedule-confirmation'",
      )
      .first<{ state: string; attempt_count: number }>();
    expect(row).toEqual({ state: "succeeded", attempt_count: 1 });
  });

  it("counts the unverified-recipient cap by mailbox and by trust, in SQL", async () => {
    /*
     * `countDeliveriesTo` states one rule twice — once as `recipientCapKey` in the domain, for the
     * value it binds, and once as a `CASE` expression over the stored column. Two statements of
     * one rule drift, and the direction of drift here is an attacker getting a fresh budget per
     * spelling, so this drives real rows through the SQL rather than through the fake.
     */
    const migrated = await createMigratedDatabase({ label: "communications-cap", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CommunicationsRepository(migrated.database);
    const organizationId = "00000000-0000-4000-8000-000000000010";
    const eventId = "00000000-0000-4000-8000-000000000001";
    const write = (id: string, recipientRef: string, recipientTrust: "account" | "declared") =>
      repository.enqueue({
        id,
        organizationId,
        eventId,
        idempotencyKey: id,
        triggerType: "decision.recorded" as const,
        channel: "email" as const,
        templateId: null,
        templateVersion: null,
        recipientRef,
        recipientTrust,
        payload: {},
        renderedSubject: "Subject",
        renderedBody: "Body",
        projectionVersion: null,
        state: "queued" as const,
        attemptCount: 0,
        nextAttemptAt: "2026-08-10T12:00:00.000Z",
        leaseToken: null,
        createdAt: "2026-08-10T12:00:00.000Z",
        updatedAt: "2026-08-10T12:00:00.000Z",
      });

    await write("cap-1", "victim@example.test", "declared");
    await write("cap-2", "Victim@Example.test", "declared");
    await write("cap-3", "victim+conference@example.test", "declared");
    // Account-trust mail to the same mailbox, which must not consume the guest's budget.
    await write("cap-4", "victim@example.test", "account");
    // A different mailbox entirely.
    await write("cap-5", "someone@example.test", "declared");

    // All three spellings are one mailbox, and the account row is not counted.
    await expect(
      repository.countDeliveriesTo(organizationId, eventId, "VICTIM+anything@example.test"),
    ).resolves.toBe(3);
    await expect(
      repository.countDeliveriesTo(organizationId, eventId, "someone@example.test"),
    ).resolves.toBe(1);
    // And the count is per event: another event's rows are a different budget.
    await expect(
      repository.countDeliveriesTo(
        organizationId,
        "00000000-0000-4000-8000-000000000002",
        "victim@example.test",
      ),
    ).resolves.toBe(0);
  });
});

describe("migration 1704, after invitations already exist", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("preserves the last legacy schedule and client-visible sequence", async () => {
    const migrated = await createMigratedDatabase({
      label: "calendar-invite-backfill",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    await database.prepare("DROP TABLE calendar_invite_states").run();
    await database.batch([
      database.prepare(
        "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, rendered_subject, rendered_body, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at) VALUES ('legacy-a', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'calendar-invite:session:profile:2026-09-01T16:00:00.000Z|2026-09-01T17:00:00.000Z|Main stage', 'speaker.calendar_invite', 'email', 'template-calendar-invite-v1', 1, 'old@example.test', json_object('calendarInvite', json_object('content', 'BEGIN:VCALENDAR' || char(13) || char(10) || 'SEQUENCE:19000000' || char(13) || char(10) || 'END:VCALENDAR')), 'Invite', 'Body', NULL, 'succeeded', 1, '2026-08-12T08:00:00.000Z', NULL, '2026-08-12T08:00:00.000Z', '2026-08-12T08:00:00.000Z')",
      ),
      database.prepare(
        "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, rendered_subject, rendered_body, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at) VALUES ('legacy-b', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'calendar-invite:session:profile:2026-09-01T18:00:00.000Z|2026-09-01T19:00:00.000Z|Main stage', 'speaker.calendar_invite', 'email', 'template-calendar-invite-v1', 1, 'new@example.test', json_object('calendarInvite', json_object('content', 'BEGIN:VCALENDAR' || char(13) || char(10) || 'SEQUENCE:19000001' || char(13) || char(10) || 'END:VCALENDAR')), 'Invite', 'Body', NULL, 'succeeded', 1, '2026-08-12T09:00:00.000Z', NULL, '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z')",
      ),
      database.prepare(
        "INSERT INTO communication_deliveries (id, organization_id, event_id, idempotency_key, trigger_type, channel, template_id, template_version, recipient_ref, payload_json, rendered_subject, rendered_body, projection_version, state, attempt_count, next_attempt_at, lease_token, created_at, updated_at) VALUES ('legacy-return', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'calendar-invite:returned-session:returned-profile:2026-09-01T18:00:00.000Z|2026-09-01T19:00:00.000Z|Main stage', 'speaker.calendar_invite', 'email', 'template-calendar-invite-v1', 1, 'return@example.test', json_object('calendarInvite', json_object('content', 'BEGIN:VCALENDAR' || char(13) || char(10) || 'SEQUENCE:19000001' || char(13) || char(10) || 'END:VCALENDAR')), 'Invite', 'Body', NULL, 'succeeded', 1, '2026-08-12T09:00:00.000Z', NULL, '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z')",
      ),
    ]);

    await applyMigrations(database as never, {
      from: "1704_calendar_invite_states.sql",
      through: "1704_calendar_invite_states.sql",
    });

    const state = await new D1CommunicationsRepository(database).calendarInviteState(
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000001",
      "session",
      "profile",
    );
    expect(state).toEqual({
      organizationId: "00000000-0000-4000-8000-000000000010",
      eventId: "00000000-0000-4000-8000-000000000001",
      sessionId: "session",
      speakerProfileId: "profile",
      scheduleRef: "2026-09-01T18:00:00.000Z|2026-09-01T19:00:00.000Z|Main stage",
      recipientRef: "new@example.test",
      sequence: 19000001,
      deliveryId: "legacy-b",
    });

    const communications = new CommunicationsService({
      repository: new D1CommunicationsRepository(database),
      eventDirectory: { belongsToOrganization: async () => true },
      newId: () => "post-upgrade",
      now: () => new Date("2026-08-12T10:00:00.000Z"),
    });
    await expect(
      communications.enqueueCalendarInvite({
        organizationId: "00000000-0000-4000-8000-000000000010",
        eventId: "00000000-0000-4000-8000-000000000001",
        sessionId: "session",
        speakerProfileId: "profile",
        scheduleRef: "3|2026-09-01T18:00:00.000Z|2026-09-01T19:00:00.000Z|Main stage",
        scheduleRevisedAt: "2026-08-12T08:00:00.000Z",
        recipientRef: "new@example.test",
        deliveryFor: () => {
          throw new Error("an unchanged legacy invitation must not be rebuilt");
        },
      }),
    ).resolves.toMatchObject({ created: false, sequence: 19000001, id: "legacy-b" });

    await expect(
      communications.enqueueCalendarInvite({
        organizationId: "00000000-0000-4000-8000-000000000010",
        eventId: "00000000-0000-4000-8000-000000000001",
        sessionId: "returned-session",
        speakerProfileId: "returned-profile",
        scheduleRef: "5|2026-09-01T18:00:00.000Z|2026-09-01T19:00:00.000Z|Main stage",
        scheduleRevisedAt: "2026-08-12T09:30:00.000Z",
        recipientRef: "return@example.test",
        deliveryFor: (sequence) => ({
          organizationId: "00000000-0000-4000-8000-000000000010",
          eventId: "00000000-0000-4000-8000-000000000001",
          idempotencyKey: `calendar-invite:returned-session:returned-profile:${sequence}`,
          triggerType: "speaker.calendar_invite",
          channel: "email",
          recipientRef: "return@example.test",
          recipientTrust: "account" as const,
          templateKey: "speaker-calendar-invite",
          payload: {
            speakerName: "Speaker",
            sessionTitle: "Session",
            eventName: "Greenroom Demo Summit",
            calendarInvite: {
              method: "REQUEST",
              filename: "invite.ics",
              content: `SEQUENCE:${sequence}`,
            },
          },
        }),
      }),
    ).resolves.toMatchObject({ created: true, sequence: 19000002 });
  });
});

describe("migration 1703, against tables that already have rows", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("carries every delivery, attempt and projection row across the rebuild", async () => {
    /*
     * The path the rest of this suite cannot reach, and the one that matters on deploy.
     *
     * `createMigratedDatabase` applies every migration and *then* the seed, so 1703's copy always
     * runs against three empty tables there. The first version of this migration passed the
     * entire suite while being unable to run at all on a database holding a single delivery
     * attempt: `PRAGMA foreign_keys = OFF` does not survive between statements on D1, so
     * `DROP TABLE communication_deliveries` was refused with `FOREIGN KEY constraint failed`.
     *
     * Applying the migration a second time over the seeded fixture is what exercises the copy
     * with rows present — the seed leaves deliveries, attempts and a projection-state row, which
     * is the shape a real database has.
     */
    const migrated = await createMigratedDatabase({ label: "delivery-rebuild", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const counts = () =>
      database
        .prepare(
          "SELECT (SELECT COUNT(*) FROM communication_deliveries) AS deliveries, (SELECT COUNT(*) FROM communication_attempts) AS attempts, (SELECT COUNT(*) FROM outbound_projection_state) AS projections",
        )
        .first<{ deliveries: number; attempts: number; projections: number }>();

    const before = await counts();
    expect(before?.deliveries, "the seed should leave deliveries to carry across").toBeGreaterThan(
      0,
    );
    expect(before?.attempts, "and attempts referencing them").toBeGreaterThan(0);
    expect(before?.projections, "and projection state referencing them").toBeGreaterThan(0);

    await applyMigrations(database as never, {
      from: "1703_delivery_domain_event_triggers.sql",
      through: "1703_delivery_domain_event_triggers.sql",
    });

    expect(await counts()).toEqual(before);

    // Every column, not just the row count: a rebuild that dropped one would still count right.
    expect(
      await database
        .prepare("SELECT * FROM communication_deliveries WHERE id = 'delivery-speaker-invite'")
        .first<Record<string, unknown>>(),
    ).toMatchObject({
      idempotency_key:
        "speaker-invite:00000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000001",
      trigger_type: "speaker.invited",
      channel: "email",
      recipient_ref: "sam@example.test",
      state: "succeeded",
      attempt_count: 1,
      rendered_subject: "Welcome to Greenroom",
    });

    // The children still resolve through their foreign keys to the recreated parent.
    const joined = await database
      .prepare(
        "SELECT a.id FROM communication_attempts a JOIN communication_deliveries d ON d.id = a.delivery_id WHERE a.delivery_id = 'delivery-speaker-invite'",
      )
      .all<{ id: string }>();
    expect((joined.results ?? []).map((attempt: { id: string }) => attempt.id)).toEqual([
      "attempt-speaker-invite-1",
    ]);

    // The uniqueness the rebuild had to preserve is still enforced on the new table.
    await expect(
      database
        .prepare(
          "UPDATE communication_deliveries SET idempotency_key = (SELECT idempotency_key FROM communication_deliveries WHERE id = 'delivery-speaker-invite') WHERE id = 'delivery-speaker-task-1'",
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("the open speaker work reminders are built from", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("returns the seeded open tasks with the address each speaker can be reached at", async () => {
    /*
     * `CommunicationsContentQuery.listOpenSpeakerWork` is reached through content's repository
     * rather than by querying its tables here — this suite belongs to communications, and the
     * point of the declared interface is that this domain never learns a `speaker_tasks` column.
     *
     * Worth a real-D1 case rather than a fake: the scheduled-entrypoint test above already runs
     * this SQL, but against the seed's due dates it returns nothing, so a wrong join or a wrong
     * predicate would execute cleanly and the reminder pass would simply never find anybody.
     */
    const migrated = await createMigratedDatabase({ label: "open-speaker-work", seed: true });
    runtime = migrated.runtime;
    const content = new D1ContentRepository(migrated.database as never);

    const due = await content.listOpenSpeakerWork("2027-01-01T00:00:00.000Z", 100);

    // Oldest first, so a bounded batch works through the most overdue rather than an arbitrary
    // slice; both seeded tasks belong to the speaker whose profile carries an address.
    expect(due.map(({ taskId, title, dueAt }) => ({ taskId, title, dueAt }))).toEqual([
      {
        taskId: "30000000-0000-4000-8000-000000000001",
        title: "Confirm profile details",
        dueAt: "2026-08-20T23:59:00.000Z",
      },
      {
        taskId: "30000000-0000-4000-8000-000000000002",
        title: "Upload a headshot",
        dueAt: "2026-08-22T23:59:00.000Z",
      },
    ]);
    expect(due[0]).toMatchObject({
      eventId: "00000000-0000-4000-8000-000000000001",
      profileId: "10000000-0000-4000-8000-000000000001",
      userId: "seed-speaker",
      speakerName: "Sam Speaker",
      email: "sam@example.test",
    });

    // The window is a filter, not decoration: nothing is due before the earliest task.
    expect(await content.listOpenSpeakerWork("2026-08-19T00:00:00.000Z", 100)).toEqual([]);
    // And the bound is honoured, so one tick cannot meet an unbounded backlog.
    expect(await content.listOpenSpeakerWork("2027-01-01T00:00:00.000Z", 1)).toHaveLength(1);
  });

  it("omits a completed task, because there is nothing left to remind anybody about", async () => {
    const migrated = await createMigratedDatabase({ label: "open-speaker-work-done", seed: true });
    runtime = migrated.runtime;
    const content = new D1ContentRepository(migrated.database as never);
    // Completed through content's own repository rather than by an UPDATE on `speaker_tasks`:
    // this suite belongs to communications and does not get to name another domain's columns,
    // which is the same rule the query under test exists to honour.
    const workspace = await content.workspace("00000000-0000-4000-8000-000000000001");
    const task = workspace.tasks.find(({ id }) => id === "30000000-0000-4000-8000-000000000001");
    if (!task) throw new Error("the seeded speaker task is missing");
    await content.updateTask({
      ...task,
      status: "complete",
      completedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(
      (await content.listOpenSpeakerWork("2027-01-01T00:00:00.000Z", 100)).map(
        ({ taskId }) => taskId,
      ),
    ).toEqual(["30000000-0000-4000-8000-000000000002"]);
  });
});

describe("publishing a template version against real D1", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("reports a taken version as a typed conflict rather than an opaque failure", async () => {
    /*
     * The matcher this exercises reads SQLite's message text, because D1 exposes no error code.
     * Proving it in memory would prove nothing: the memory repository throws the typed error
     * directly, so a wrong pattern here would restore the `500` this change exists to remove and
     * every unit test would stay green.
     */
    const migrated = await createMigratedDatabase({ label: "template-conflict", seed: true });
    runtime = migrated.runtime;
    const repository = new D1CommunicationsRepository(migrated.database);
    const template = {
      id: "template-conflict-1",
      organizationId: "00000000-0000-4000-8000-000000000010",
      key: "speaker-invite",
      version: 1,
      channel: "email" as const,
      subject: "Welcome",
      body: "Hello {{speakerName}}",
      createdAt: "2026-08-10T12:00:00.000Z",
    };

    // The seed already publishes `speaker-invite` version 1.
    await expect(repository.createTemplate(template)).rejects.toBeInstanceOf(
      TemplateVersionTakenError,
    );
    // And the allocator's read is what turns that into the next number.
    expect(await repository.latestTemplateVersion(template.organizationId, "speaker-invite")).toBe(
      1,
    );
    await repository.createTemplate({ ...template, version: 2 });
    expect(await repository.latestTemplateVersion(template.organizationId, "speaker-invite")).toBe(
      2,
    );
  });

  it("lets the service allocate consecutive versions over real storage", async () => {
    const migrated = await createMigratedDatabase({ label: "template-allocate", seed: true });
    runtime = migrated.runtime;
    let id = 0;
    const service = new CommunicationsService({
      repository: new D1CommunicationsRepository(migrated.database),
      eventDirectory: { belongsToOrganization: async () => true },
      newId: () => `allocated-${++id}`,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const organizer = {
      id: "seed-organizer",
      name: "Olivia",
      persona: "organizer" as const,
      organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
      eventAccess: [],
      capabilities: new Set(["communications:manage" as const]),
    };

    // Version 1 is seeded, so an allocator that ignored storage would collide on its first try.
    const next = await service.createTemplate(organizer, {
      organizationId: "00000000-0000-4000-8000-000000000010",
      key: "speaker-invite",
      channel: "email",
      subject: "Corrected",
      body: "Hello again {{speakerName}}",
    });

    expect(next.version).toBe(2);
  });
});

/**
 * `#22`'s remaining criterion, against real D1: every committed publication has exactly one
 * durable `EVT-SCHEDULE-PUBLISHED` record, and a failed publication has none.
 *
 * PR #113 delivered the atomic versions, the transaction and the command-key idempotency, and
 * could not deliver this: the outbox modelled a delivery to a provider and had no channel for a
 * domain event, so the payload was derived on every commit and dropped (`DEBT-006`). These
 * exercise the binding that closes it — the same `prepareEnqueue` + `preparedDeliveryWriter`
 * pair `index.ts` wires, over the same SQL, in one batch with the publication.
 */
describe("a schedule publication and the record announcing it", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  const eventId = "00000000-0000-4000-8000-000000000001";
  const organizationId = "00000000-0000-4000-8000-000000000010";

  const snapshot = (version: number, commandKey?: string): PublishedSchedule => ({
    eventId,
    version,
    publishedAt: "2026-08-11T10:00:00.000Z",
    publishedBy: "seed-organizer",
    ...(commandKey ? { commandKey } : {}),
    agenda: {
      eventId,
      rooms: [{ id: "room-main", name: "Main stage" }],
      tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
      slots: [
        {
          id: "slot-0900",
          startsAt: "2026-09-01T16:00:00.000Z",
          endsAt: "2026-09-01T17:00:00.000Z",
        },
      ],
      sessions: [{ id: "20000000-0000-4000-8000-000000000001", title: "Opening", speakerIds: [] }],
      placements: [
        {
          id: "placement-opening",
          sessionId: "20000000-0000-4000-8000-000000000001",
          roomId: "room-main",
          trackId: "track-platform",
          slotId: "slot-0900",
        },
      ],
    },
  });

  /** The composition root's binding, over the test database. */
  const publishing = (
    database: Parameters<typeof preparedDeliveryWriter>[0] & {
      prepare(query: string): { bind(...values: unknown[]): unknown };
    },
    options: { organizationOf?: (eventId: string) => Promise<string | null> } = {},
  ) => {
    const communications = new CommunicationsService({
      repository: new D1CommunicationsRepository(database),
      eventDirectory: {
        belongsToOrganization: async (candidate, organization) =>
          candidate === eventId && organization === organizationId,
      },
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-11T10:00:00.000Z"),
    });
    const write = preparedDeliveryWriter(database);
    const resolve = options.organizationOf ?? (async () => organizationId);
    return new D1AgendaRepository(
      database as never,
      () => new Date("2026-08-11T10:00:00.000Z"),
      async (_database, event) => {
        const owner = await resolve(event.eventId);
        if (!owner) throw new Error("Event has no owning organization to announce to");
        return write(
          await communications.prepareEnqueue({
            organizationId: owner,
            eventId: event.eventId,
            idempotencyKey: event.id,
            triggerType: "schedule.published",
            channel: "event",
            recipientRef: `event:${event.eventId}`,
            recipientTrust: "account" as const,
            payload: { ...event },
          }),
        ) as never[];
      },
    );
  };

  const records = (database: {
    prepare(query: string): { all<T>(): Promise<{ results?: T[] }> };
  }) =>
    database
      .prepare(
        "SELECT idempotency_key, channel, trigger_type, payload_json, state FROM communication_deliveries WHERE trigger_type = 'schedule.published' ORDER BY idempotency_key",
      )
      .all<{
        idempotency_key: string;
        channel: string;
        trigger_type: string;
        payload_json: string;
        state: string;
      }>();

  it("writes exactly one record per committed publication, carrying the event id and version", async () => {
    const migrated = await createMigratedDatabase({ label: "publication-event", seed: true });
    runtime = migrated.runtime;

    expect(await publishing(migrated.database).publish(snapshot(2))).toBe("committed");

    const stored = (await records(migrated.database)).results ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      idempotency_key: `EVT-SCHEDULE-PUBLISHED:${eventId}:2`,
      channel: "event",
      state: "queued",
    });
    // The criterion is the payload, not just the row: a consumer must learn which event and
    // which publication without reading agenda's tables.
    expect(JSON.parse(stored[0]?.payload_json ?? "{}")).toMatchObject({
      type: "EVT-SCHEDULE-PUBLISHED",
      version: 1,
      eventId,
      publicationVersion: 2,
    });
  });

  it("leaves neither a publication nor a record when the announcement cannot be written", async () => {
    const migrated = await createMigratedDatabase({
      label: "publication-event-rollback",
      seed: true,
    });
    runtime = migrated.runtime;

    // An event whose organization cannot be resolved: there is nobody to announce the
    // publication to, so it must not commit either.
    await expect(
      publishing(migrated.database, { organizationOf: async () => null }).publish(snapshot(2)),
    ).rejects.toThrow(/owning organization/);

    expect((await records(migrated.database)).results ?? []).toHaveLength(0);
    // Read through agenda's own reader rather than its table: this suite belongs to
    // communications, and querying `agenda_publications` here would cross the boundary the
    // whole design exists to keep. The seed publishes version 1; version 2 must not exist.
    const published = await publishing(migrated.database).getPublished(eventId);
    expect(published?.version).toBe(1);
  });

  it("produces one record, not two, when the same publish command is replayed", async () => {
    const migrated = await createMigratedDatabase({
      label: "publication-event-replay",
      seed: true,
    });
    runtime = migrated.runtime;
    const repository = publishing(migrated.database);

    expect(await repository.publish(snapshot(2, "command-abc"))).toBe("committed");
    // The client never saw the first response and sent the identical command again.
    expect(await repository.publish(snapshot(3, "command-abc"))).toBe("command-replayed");

    expect((await records(migrated.database)).results ?? []).toHaveLength(1);
  });

  it("announces a genuinely new publication separately from the one before it", async () => {
    const migrated = await createMigratedDatabase({
      label: "publication-event-second",
      seed: true,
    });
    runtime = migrated.runtime;
    const repository = publishing(migrated.database);

    expect(await repository.publish(snapshot(2))).toBe("committed");
    expect(await repository.publish(snapshot(3))).toBe("committed");

    // Republishing after an edit is a different schedule, so its speakers hear about it again.
    expect(
      ((await records(migrated.database)).results ?? []).map((row) => row.idempotency_key),
    ).toEqual([`EVT-SCHEDULE-PUBLISHED:${eventId}:2`, `EVT-SCHEDULE-PUBLISHED:${eventId}:3`]);
  });

  it("drains into one schedule confirmation per reachable speaker", async () => {
    const migrated = await createMigratedDatabase({ label: "publication-event-drain", seed: true });
    runtime = migrated.runtime;

    expect(await publishing(migrated.database).publish(snapshot(2))).toBe("committed");
    await apiWorker.scheduled({}, { DB: migrated.database } as Environment);

    const confirmations = await migrated.database
      .prepare(
        "SELECT recipient_ref, rendered_body FROM communication_deliveries WHERE trigger_type = 'speaker.scheduled' AND idempotency_key LIKE ?",
      )
      .bind(`schedule:${eventId}:v2:%`)
      .all<{ recipient_ref: string; rendered_body: string }>();
    // Sam has an address on their identity; Jordan Bell does not, and is not written to rather
    // than being written to at a guessed address.
    const reached = (confirmations.results ?? []).map(
      (row: { recipient_ref: string }) => row.recipient_ref,
    );
    expect(reached).toEqual(["speaker@greenroom.test"]);
    expect(confirmations.results?.[0]?.rendered_body).toContain("Sam Speaker");
    expect(confirmations.results?.[0]?.rendered_body).not.toContain("{{");
  });
});
