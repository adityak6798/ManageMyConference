// @acceptance ACC-INTEGRATION
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1CommunicationsRepository } from "../src/adapters/persistence/d1-communications-repository";

const statements = (sql: string) =>
  sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

describe("D1CommunicationsRepository", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("persists idempotent deliveries and atomically records attempts with projection state", async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() {} }",
      d1Databases: { DB: "communications-test" },
    });
    const database = await runtime.getD1Database("DB");
    for (const migration of [
      "0001_create_events.sql",
      "0002_identity_event_foundation.sql",
      "0003_communications_outbox.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      for (const statement of statements(sql)) await database.prepare(statement).run();
    }
    const reset = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
    for (const statement of statements(reset)) await database.prepare(statement).run();
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
  });
});
