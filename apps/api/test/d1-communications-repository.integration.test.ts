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

    const row = await database
      .prepare(
        "SELECT state, attempt_count FROM communication_deliveries WHERE id = 'delivery-queued'",
      )
      .first<{ state: string; attempt_count: number }>();
    expect(row).toEqual({ state: "succeeded", attempt_count: 1 });
  });
});
