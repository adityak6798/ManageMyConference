// @acceptance ACC-INTEGRATION
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./support/seeded-d1";
import { D1CommunicationsRepository } from "../src/adapters/persistence/d1-communications-repository";
import apiWorker, { type Environment } from "../src/index";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

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

    const row = await database
      .prepare(
        "SELECT state, attempt_count FROM communication_deliveries WHERE id = 'delivery-queued'",
      )
      .first<{ state: string; attempt_count: number }>();
    expect(row).toEqual({ state: "succeeded", attempt_count: 1 });
  });
});
