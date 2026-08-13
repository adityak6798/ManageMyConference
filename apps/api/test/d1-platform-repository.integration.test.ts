// @acceptance ACC-OPS
/*
 * Inbox dismissals against a real D1, because the properties that matter here are the storage's
 * rather than the service's: the primary key that makes a repeated dismissal one row, the
 * foreign keys that keep a dismissal inside an event and an actor that exist, and the write-count
 * contract that refuses a driver which cannot say what it did.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  D1InboxDismissalStore,
  MemoryInboxDismissalStore,
} from "../src/adapters/persistence/d1-platform-repository";
import { applySeedData, createMigratedDatabase, type MigratedDatabase } from "./support/seeded-d1";

const EVENT = "00000000-0000-4000-8000-000000000001";
const ORGANIZER = "seed-organizer";
const REVIEWER = "seed-reviewer";
const KEY = "speaker-task:30000000-0000-4000-8000-000000000001:2026-08-20T23:59:00.000Z";

let harness: MigratedDatabase | undefined;

async function store() {
  harness = await createMigratedDatabase({ seed: true, label: "platform" });
  return new D1InboxDismissalStore(harness.database as never);
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
