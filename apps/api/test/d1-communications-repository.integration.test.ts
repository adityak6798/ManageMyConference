// @acceptance ACC-INTEGRATION
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./support/seeded-d1";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import {
  D1CommunicationsRepository,
  preparedDeliveryWriter,
} from "../src/adapters/persistence/d1-communications-repository";
import type { PublishedSchedule } from "../src/application/agenda/agenda-repository";
import { CommunicationsService } from "../src/application/communications/communications-service";
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
      tracks: [],
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
    const published = await migrated.database
      .prepare("SELECT version FROM agenda_publications WHERE event_id = ? ORDER BY version DESC")
      .bind(eventId)
      .first<{ version: number }>();
    // The seed publishes version 1; version 2 must not exist.
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
    expect((confirmations.results ?? []).map((row) => row.recipient_ref)).toEqual([
      "speaker@greenroom.test",
    ]);
    expect(confirmations.results?.[0]?.rendered_body).toContain("Sam Speaker");
    expect(confirmations.results?.[0]?.rendered_body).not.toContain("{{");
  });
});
