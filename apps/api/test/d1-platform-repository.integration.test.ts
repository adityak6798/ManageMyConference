// @acceptance ACC-OPS
/*
 * Inbox dismissals against a real D1, because the properties that matter here are the storage's
 * rather than the service's: the primary key that makes a repeated dismissal one row, the
 * foreign keys that keep a dismissal inside an event and an actor that exist, and the write-count
 * contract that refuses a driver which cannot say what it did.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  D1AuditRecordStore,
  MemoryAuditRecordStore,
  preparedAuditWriter,
} from "../src/adapters/persistence/d1-audit-repository";
import {
  D1InboxDismissalStore,
  MemoryInboxDismissalStore,
} from "../src/adapters/persistence/d1-platform-repository";
import type { Actor } from "../src/application/identity/actor";
import type { AuditRecord } from "../src/application/platform/public";
import { AuditRecorder, createRequestIdentity } from "../src/application/platform/public";
import { applySeedData, createMigratedDatabase, type MigratedDatabase } from "./support/seeded-d1";

const EVENT = "00000000-0000-4000-8000-000000000001";
const ORGANIZER = "seed-organizer";
const REVIEWER = "seed-reviewer";
const OTHER_EVENT = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const KEY = "speaker-task:30000000-0000-4000-8000-000000000001:2026-08-20T23:59:00.000Z";

let harness: MigratedDatabase | undefined;

async function store() {
  harness = await createMigratedDatabase({ seed: true, label: "platform" });
  return new D1InboxDismissalStore(harness.database as never);
}

/** Its own database, disposed by the test that made it — the audit cases need two at once. */
async function migrated() {
  return createMigratedDatabase({ seed: true, label: "audit" });
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe("inbox dismissals in D1", () => {
  it("stores a dismissal and reads it back for its own actor only", async () => {
    const dismissals = await store();

    await dismissals.dismiss({
      eventId: EVENT,
      itemKey: KEY,
      actorId: ORGANIZER,
      dismissedAt: "2026-08-12T09:00:00.000Z",
    });

    await expect(dismissals.list(EVENT, ORGANIZER)).resolves.toEqual([
      {
        eventId: EVENT,
        itemKey: KEY,
        actorId: ORGANIZER,
        dismissedAt: "2026-08-12T09:00:00.000Z",
      },
    ]);
    // A dismissal is one person's decision, so nobody else's list changes.
    await expect(dismissals.list(EVENT, REVIEWER)).resolves.toEqual([]);
  });

  it("keeps a repeated dismissal to one row and to its first timestamp", async () => {
    const dismissals = await store();
    const dismissal = {
      eventId: EVENT,
      itemKey: KEY,
      actorId: ORGANIZER,
      dismissedAt: "2026-08-12T09:00:00.000Z",
    };

    await dismissals.dismiss(dismissal);
    await dismissals.dismiss({ ...dismissal, dismissedAt: "2026-08-12T18:00:00.000Z" });

    // The surface shows when the operator set this aside; a double click on a list that had not
    // repainted yet must not rewrite that answer.
    await expect(dismissals.list(EVENT, ORGANIZER)).resolves.toEqual([dismissal]);
  });

  it("reports whether a restore actually removed anything", async () => {
    const dismissals = await store();
    await dismissals.dismiss({
      eventId: EVENT,
      itemKey: KEY,
      actorId: ORGANIZER,
      dismissedAt: "2026-08-12T09:00:00.000Z",
    });

    await expect(dismissals.restore(EVENT, KEY, ORGANIZER)).resolves.toBe(true);
    await expect(dismissals.restore(EVENT, KEY, ORGANIZER)).resolves.toBe(false);
    await expect(dismissals.list(EVENT, ORGANIZER)).resolves.toEqual([]);
  });

  it("refuses a dismissal naming an event or an actor that does not exist", async () => {
    const dismissals = await store();
    // Foreign keys are the storage's own guard, behind the service's check that the item is one
    // this actor can currently derive. Both exist because either alone can be reached first.
    await expect(
      dismissals.dismiss({
        eventId: "00000000-0000-4000-8000-0000000000ff",
        itemKey: KEY,
        actorId: ORGANIZER,
        dismissedAt: "2026-08-12T09:00:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      dismissals.dismiss({
        eventId: EVENT,
        itemKey: KEY,
        actorId: "nobody",
        dismissedAt: "2026-08-12T09:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("lets `npm run reset` run again over a fixture that has been used", async () => {
    /*
     * The gate this lane was missing, and the defect it hides is total.
     *
     * `platform_inbox_dismissals` references `events(id)` and `users(id)`. `seed/reset.sql` is a
     * full teardown of both, and D1 enforces foreign keys, so before the `ON DELETE CASCADE` in
     * migration 1900 a single dismissed inbox item made every subsequent reset fail with a bare
     * `FOREIGN KEY constraint failed` naming no table — and both Playwright configs bootstrap
     * through `npm run reset`, so the browser gate stopped coming up before a single spec ran.
     *
     * Nothing else covers this. `seed:check` only compares `reset.sql` against the fragments it
     * was generated from, and every other D1 test builds a fresh database, so "reset over a
     * fixture somebody has actually used" is a path no suite walked. A new domain that adds a
     * table referencing `events` or `users` without a cascade or a cleanup fails here.
     */
    harness = await createMigratedDatabase({ seed: true, label: "platform-reset" });
    const dismissals = new D1InboxDismissalStore(harness.database as never);
    await dismissals.dismiss({
      eventId: EVENT,
      itemKey: KEY,
      actorId: ORGANIZER,
      dismissedAt: "2026-08-12T09:00:00.000Z",
    });

    await expect(applySeedData(harness.database as never)).resolves.toBeUndefined();

    // The reset really did clear them, rather than merely surviving the attempt.
    await expect(dismissals.list(EVENT, ORGANIZER)).resolves.toEqual([]);
  });

  it("refuses a driver that cannot say how many rows it changed", async () => {
    const silent = new D1InboxDismissalStore({
      prepare: () => ({
        bind() {
          return this;
        },
        run: async () => ({ success: true, meta: {} }) as never,
        all: async () => ({ success: true, results: [] }),
      }),
    } as never);

    // A missing count is a failure, never a silent zero or a silent one: the caller cannot tell
    // "already dismissed" from "did not write" without it.
    await expect(
      silent.dismiss({
        eventId: EVENT,
        itemKey: KEY,
        actorId: ORGANIZER,
        dismissedAt: "2026-08-12T09:00:00.000Z",
      }),
    ).rejects.toThrow(/row count/);
  });

  it("answers the same questions as the in-memory twin the service suites drive", async () => {
    const real = await store();
    const memory = new MemoryInboxDismissalStore();
    const dismissal = {
      eventId: EVENT,
      itemKey: KEY,
      actorId: ORGANIZER,
      dismissedAt: "2026-08-12T09:00:00.000Z",
    };

    for (const target of [real, memory]) {
      await target.dismiss(dismissal);
      await target.dismiss({ ...dismissal, dismissedAt: "2026-08-12T18:00:00.000Z" });
    }

    // The twin is only worth having while it agrees; this is what keeps the service suites
    // meaningful about production behaviour rather than about the fake.
    await expect(memory.list(EVENT, ORGANIZER)).resolves.toEqual(await real.list(EVENT, ORGANIZER));
    await expect(memory.restore(EVENT, KEY, ORGANIZER)).resolves.toBe(
      await real.restore(EVENT, KEY, ORGANIZER),
    );
  });
});

describe("the audit timeline in D1", () => {
  const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
    id: "audit-1",
    organizationId: ORGANIZATION,
    eventId: EVENT,
    occurredAt: "2026-08-12T09:00:00.000Z",
    actorId: ORGANIZER,
    actorName: "Olivia Organizer",
    source: "human",
    action: "review.reviewer_assigned",
    targetType: "review-round",
    targetId: "seed-reviewer:r1",
    correlationId: "corr-1",
    idempotencyKey: "audit:review.reviewer_assigned:seed-reviewer:r1",
    ...overrides,
  });

  it("refuses an UPDATE and a DELETE, whoever attempts them", async () => {
    const harness = await migrated();
    const store = new D1AuditRecordStore(harness.database as never);
    await store.append(record());

    /*
     * Driven as raw SQL rather than through the store, deliberately: the store has no method that
     * edits or removes a record, so going through it would only prove that an API with no such
     * method has no such method. What is being asserted is that the *table* refuses, which is
     * what makes this evidence rather than a convention one future writer can break.
     */
    await expect(
      harness.database.prepare("UPDATE platform_audit_records SET action = 'tampered'").run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      harness.database.prepare("DELETE FROM platform_audit_records").run(),
    ).rejects.toThrow(/append-only/);

    const page = await store.page(EVENT, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.action).toBe("review.reviewer_assigned");
    await harness.dispose();
  });

  it("writes one row for a replayed idempotency key and keeps the first", async () => {
    const harness = await migrated();
    const store = new D1AuditRecordStore(harness.database as never);

    await store.append(record());
    // A retried command: same key, a different id and a later instant. The unique constraint is
    // what makes the replay converge, and `DO NOTHING` is what keeps the first record intact —
    // an upsert would be an UPDATE, which this table refuses outright.
    await store.append(
      record({ id: "audit-2", occurredAt: "2026-08-12T10:00:00.000Z", actorName: "Someone else" }),
    );

    const page = await store.page(EVENT, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "audit-1", actorName: "Olivia Organizer" });
    await harness.dispose();
  });

  it("pages newest first, deterministically, through records sharing one instant", async () => {
    const harness = await migrated();
    const store = new D1AuditRecordStore(harness.database as never);
    for (const index of [1, 2, 3])
      await store.append(
        record({ id: `audit-${index}`, idempotencyKey: `key-${index}`, targetId: `t${index}` }),
      );
    await store.append(
      record({
        id: "audit-later",
        idempotencyKey: "key-later",
        occurredAt: "2026-08-12T11:00:00.000Z",
      }),
    );

    const first = await store.page(EVENT, { limit: 2 });
    expect(first.items.map(({ id }) => id)).toEqual(["audit-later", "audit-3"]);
    expect(first.hasMore).toBe(true);
    const last = first.items.at(-1);
    const second = await store.page(EVENT, {
      limit: 2,
      before: { occurredAt: last?.occurredAt ?? "", id: last?.id ?? "" },
    });
    expect(second.items.map(({ id }) => id)).toEqual(["audit-2", "audit-1"]);
    expect(second.hasMore).toBe(false);
    await harness.dispose();
  });

  it("scopes a page to one event", async () => {
    const harness = await migrated();
    const store = new D1AuditRecordStore(harness.database as never);
    await store.append(record());
    await store.append(
      record({ id: "audit-other", idempotencyKey: "key-other", eventId: OTHER_EVENT }),
    );

    expect((await store.page(EVENT, { limit: 10 })).items).toHaveLength(1);
    expect((await store.page(OTHER_EVENT, { limit: 10 })).items).toHaveLength(1);
    await harness.dispose();
  });

  it("commits a prepared record inside the caller's own batch, or neither", async () => {
    const harness = await migrated();
    const store = new D1AuditRecordStore(harness.database as never);
    const write = preparedAuditWriter(harness.database as never);
    const database = harness.database as unknown as {
      batch(statements: readonly unknown[]): Promise<unknown>;
    };

    /*
     * The property the prepared writer exists for. A schedule publication and the record of who
     * published it have to survive or fail together; a crash between two statements leaves a
     * published schedule nobody can account for. Here the batch's *other* statement is invalid,
     * so the whole batch must roll back and leave no audit row behind.
     */
    await expect(
      database.batch([
        ...write(record({ id: "audit-batched", idempotencyKey: "key-batched" })),
        // A second statement the table itself refuses — `source` is constrained to four values —
        // so the failure is real storage behaviour rather than a fabricated rejection.
        ...write(
          record({
            id: "audit-invalid",
            idempotencyKey: "key-invalid",
            source: "nonsense" as never,
          }),
        ),
      ]),
    ).rejects.toThrow();
    expect((await store.page(EVENT, { limit: 10 })).items).toHaveLength(0);

    // And the same statements in a batch that succeeds do write the record.
    await database.batch([
      ...write(record({ id: "audit-batched", idempotencyKey: "key-batched" })),
    ]);
    expect((await store.page(EVENT, { limit: 10 })).items).toHaveLength(1);
    await harness.dispose();
  });

  it("refuses a driver that cannot say how many rows it changed", async () => {
    const silent = new D1AuditRecordStore({
      prepare: () => ({
        bind() {
          return this;
        },
        run: async () => ({ success: true, meta: {} }) as never,
        all: async () => ({ success: true, results: [] }),
      }),
    } as never);

    await expect(silent.append(record())).rejects.toThrow(/row count/);
  });

  it("answers the same questions as the in-memory twin the service suites drive", async () => {
    const harness = await migrated();
    const real = new D1AuditRecordStore(harness.database as never);
    const memory = new MemoryAuditRecordStore();

    for (const target of [real, memory]) {
      await target.append(record());
      await target.append(record({ id: "audit-2", actorName: "Someone else" }));
      await target.append(
        record({
          id: "audit-3",
          idempotencyKey: "key-3",
          occurredAt: "2026-08-12T11:00:00.000Z",
        }),
      );
    }

    // The twin is only worth having while it agrees, which is what keeps the service suites
    // meaningful about production behaviour rather than about the fake.
    expect(await memory.page(EVENT, { limit: 2 })).toEqual(await real.page(EVENT, { limit: 2 }));
    await harness.dispose();
  });
});

/*
 * Four domains' mutations, in one ordered timeline, with the right actor and source.
 *
 * **What this proves and what it does not.** It drives the audit half of the composition root
 * exactly as `apps/api/src/index.ts` wires it: the same recorder on the same D1 table, the same
 * per-request identity, the same `recordLifecycle` shape for the three ports, and the same
 * prepared-writer batch for a schedule publication. What it does not re-prove is that the domains
 * call those ports at all — `content-service.test.ts` and `review-service.test.ts` already assert
 * that, and repeating it here would be a second copy of somebody else's evidence rather than this
 * lane's. The chain is: those suites prove the ports fire; this proves a firing port produces the
 * record the timeline shows.
 *
 * Publishing is exercised through the port it now declares — `publication-notifications.test.ts`
 * proves the service reports the fact, and the browser journey proves the record reaches the
 * timeline; what this asserts is the ordering and attribution once a record is produced.
 */
describe("one ordered timeline across domains", () => {
  it("records review, content, agenda and communications mutations with correct actor and source", async () => {
    const harness = await migrated();
    const store = new D1AuditRecordStore(harness.database as never);
    const report = vi.fn();
    const identity = createRequestIdentity({ report });
    let issued = 0;
    let tick = 0;
    const audit = new AuditRecorder({
      store,
      identity,
      newId: () => {
        issued += 1;
        return `record-${issued}`;
      },
      // Distinct instants, so "in one order" is a claim about the order rather than about the
      // tie-break. The same-millisecond case is covered separately above.
      now: () => {
        tick += 60_000;
        return new Date(Date.parse("2026-08-12T09:00:00.000Z") + tick);
      },
      report,
    });
    const organizer: Actor = {
      id: ORGANIZER,
      name: "Olivia Organizer",
      persona: "organizer",
      organizations: [{ id: ORGANIZATION }],
      eventAccess: [
        {
          eventId: EVENT,
          role: "organizer",
          capabilities: new Set(["events:read", "events:settings:read"] as const),
        },
      ],
      capabilities: new Set(["events:read", "events:settings:read"] as const),
    };

    // A request: three lifecycle consequences of things an organizer did.
    const request = identity.begin({ actor: organizer, correlationId: "corr-request" });
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "review.reviewer_assigned",
      targetType: "review-round",
      targetId: "seed-reviewer:r1",
      idempotencyKey: "audit:review.reviewer_assigned:seed-reviewer:r1",
    });
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "review.decision_accepted",
      targetType: "proposal",
      targetId: "10000000-0000-4000-8000-000000000011",
      idempotencyKey: "audit:review.decision_accepted:10000000-0000-4000-8000-000000000011",
    });
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "content.speaker_accepted",
      targetType: "speaker-profile",
      targetId: "10000000-0000-4000-8000-000000000002",
      idempotencyKey: "audit:content.speaker_accepted:10000000-0000-4000-8000-000000000002",
    });
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "communications.delivery_enqueued",
      targetType: "delivery",
      targetId: "delivery-speaker-invite",
      idempotencyKey: "audit:communications.delivery_enqueued:delivery-speaker-invite",
    });

    // The agenda's publication, committed in the batch its own write runs in — and with nobody
    // signed in, which is how a record with no request behind it reaches the log. Ending the
    // request's scope is what empties the holder: a consequence that outlives its request is
    // attributed to nobody rather than to whoever was last through the door.
    request.end();
    const write = preparedAuditWriter(harness.database as never);
    const database = harness.database as unknown as {
      batch(statements: readonly unknown[]): Promise<unknown>;
    };
    await database.batch([
      ...write(
        audit.prepare({
          organizationId: ORGANIZATION,
          eventId: EVENT,
          action: "agenda.schedule_published",
          targetType: "agenda-publication",
          targetId: "schedule:v2",
          idempotencyKey: "audit:agenda.schedule_published:schedule:v2",
        }),
      ),
    ]);

    const page = await audit.timeline(organizer, EVENT, { limit: 50 });

    // One list, newest first, naming every domain that changed something.
    expect(page.records.map(({ action }) => action)).toEqual([
      "agenda.schedule_published",
      "communications.delivery_enqueued",
      "content.speaker_accepted",
      "review.decision_accepted",
      "review.reviewer_assigned",
    ]);
    // The four that happened inside a request name the organizer and carry its correlation id.
    for (const record of page.records.filter(
      ({ action }) => action !== "agenda.schedule_published",
    ))
      expect(record).toMatchObject({
        actorId: ORGANIZER,
        actorName: "Olivia Organizer",
        source: "human",
        correlationId: "corr-request",
      });
    // The one that did not names nobody rather than inventing somebody.
    expect(page.records[0]).toMatchObject({
      actorId: null,
      actorName: "System",
      source: "system",
      correlationId: null,
    });
    expect(report).not.toHaveBeenCalled();
    await harness.dispose();
  });
});
