// @acceptance ACC-DEMO-SMOKE
// @spec ENG-DEV-001
/**
 * The demo restore's data guard, against the database it is a guard for (`GAP-019`).
 *
 * `tools/tests/remote-demo-reset.test.mjs` drives the guard's decisions over supplied counts.
 * What it cannot do is prove that the **query** those counts come from is right, because the
 * only thing that can answer that is the migrated, seeded schema itself: a `NOT IN` list naming
 * a column that moved, or a seed identifier the parser read wrongly, would pass every unit case
 * and then either refuse forever or — far worse — report a clean database that is not.
 *
 * So this file runs the shipped guard's own SQL, on a database built exactly as
 * `npm run reset` builds it, and attempts the destructive thing: it seeds an organization nobody
 * seeded and asserts the reset refuses. The final case is the one that makes the refusal worth
 * having — it applies `seed/reset.sql` to that same database and watches the row disappear.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOnlySeededData,
  parseUnseededCounts,
  seededFixtureIds,
  unseededCountQuery,
  type UnseededCounts,
} from "../../../tools/remote-demo-reset.mjs";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";
import {
  D1IdentityDirectory,
  type IdentityDatabasePort,
  preparedOrganizerGrant,
} from "../src/adapters/persistence/d1-identity-directory";
import { EventService } from "../src/application/events/event-service";
import { SignupService } from "../src/application/identity/signup";
import { applySeedData, createMigratedDatabase } from "./support/seeded-d1";
import { readFile } from "node:fs/promises";

type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

const seedSql = () => readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");

/**
 * The counts, taken the way the command takes them: the shipped query, then the shipped parser
 * over an answer shaped like wrangler's `--json`. Nothing here re-implements either.
 */
async function unseededCounts(database: Database): Promise<UnseededCounts> {
  const ids = seededFixtureIds(await seedSql());
  const result = await database.prepare(unseededCountQuery(ids)).all();
  expect(result.success).toBe(true);
  return parseUnseededCounts(JSON.stringify([{ results: result.results, success: true }]));
}

describe("the remote demo reset guard, against a real seeded database", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("proceeds on a database that holds only the fixture", async () => {
    const migrated = await createMigratedDatabase({ label: "demo-reset-clean", seed: true });
    runtime = migrated.runtime;

    const counts = await unseededCounts(migrated.database);

    // Every seeded row is recognised as seeded: two organizations, five users, three events in
    // the fixture, and none of them counted as somebody's real data. This is the routine path —
    // `npm run reset:demo` has to keep working here without a second flag.
    expect(counts).toEqual({ organizations: 0, events: 0, users: 0 });
    expect(() => assertOnlySeededData(counts, undefined)).not.toThrow();
    // And the fixture really is populated: if it were empty, the case above would pass for the
    // wrong reason. Read through the domains that own the rows rather than by counting tables.
    const directory = new D1IdentityDirectory(migrated.database as IdentityDatabasePort);
    const events = new EventService({
      repository: new D1EventRepository(migrated.database as D1DatabasePort),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-13T09:00:00.000Z"),
    });
    await expect(directory.findByUserId("seed-organizer")).resolves.toMatchObject({
      id: "seed-organizer",
    });
    await expect(
      events.listEventIdsForOrganization("00000000-0000-4000-8000-000000000010"),
    ).resolves.toHaveLength(2);
  });

  /**
   * The very first restore against a freshly provisioned database, which is the one run the
   * guard could most easily get wrong.
   *
   * `0002_identity_event_foundation.sql` inserts `Imported organization` to give the
   * pre-organization events a home, and `seed/reset.sql` never re-inserts it. A guard that knows
   * only the seed counts that row as somebody's workspace, refuses the bootstrap, states
   * something false about it, and offers `--destroy-real-data` as the only way through — which
   * is precisely the habit the flag exists to prevent. The command applies migrations before it
   * counts, so this is the state it actually meets.
   */
  it("proceeds on a migrated database that has never been seeded", async () => {
    const migrated = await createMigratedDatabase({ label: "demo-reset-bootstrap" });
    runtime = migrated.runtime;

    const counts = await unseededCounts(migrated.database);

    expect(counts).toEqual({ organizations: 0, events: 0, users: 0 });
    expect(() => assertOnlySeededData(counts, undefined)).not.toThrow();
  });

  it("refuses when the database holds an organization nobody seeded", async () => {
    const migrated = await createMigratedDatabase({ label: "demo-reset-real", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    /*
     * A self-serve Google signup, written through the same services the callback composes rather
     * than as SQL — this file belongs to `platform`, and these three tables do not.
     *
     * The identifiers it mints are ordinary UUIDs, indistinguishable in shape from the seeded
     * ones, which is exactly why the guard identifies the seed positively rather than by pattern.
     */
    const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
    const events = new EventService({
      repository: new D1EventRepository(database as D1DatabasePort, preparedOrganizerGrant),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-13T09:00:00.000Z"),
    });
    const signup = new SignupService({
      directory,
      workspace: {
        provisionOrganization: (command) => events.provisionOrganization(command),
        createFirstEvent: (actor, command) => events.provisionFirstEvent(actor, command),
        eventsInOrganization: async (actor, organizationId) =>
          (await events.list(actor)).filter((event) => event.organizationId === organizationId),
        discardUnusedOrganization: (organizationId) =>
          events.discardUnusedOrganization(organizationId),
      },
      newId: () => crypto.randomUUID(),
      now: () => 1_760_000_000_000,
    });
    const signedUp = await signup.signInWithGoogle({
      subject: "104729183746501928374",
      email: "nadia@example.test",
      emailVerified: true,
      name: "Nadia Newcomer",
    });
    const realUserId = signedUp.actor.id;
    const realEventId = signedUp.actor.eventAccess[0]?.eventId as string;

    const counts = await unseededCounts(database);
    expect(counts).toEqual({ organizations: 1, events: 1, users: 1 });
    expect(() => assertOnlySeededData(counts, undefined)).toThrow(/Refusing remote reset/);
    expect(() => assertOnlySeededData(counts, undefined)).toThrow(/1 organization/);
    // The refusal says what proceeding costs, because there is no way back from it.
    expect(() => assertOnlySeededData(counts, undefined)).toThrow(/no backup and no export/);
    // The override exists, is separate from `--confirm`, and names these counts and no others.
    expect(() => assertOnlySeededData(counts, "1/1/1")).not.toThrow();
    expect(() => assertOnlySeededData(counts, "0/1/1")).toThrow(/does not match what is there now/);

    /*
     * And the claim the refusal makes is true, which is the only reason it is worth making:
     * `seed/reset.sql` is a full teardown, so applying it takes all three rows with it. This is
     * what would have happened silently, with a successful exit and the message
     * `Remote demo restored`, to the first person who signed up on the deployed demo.
     */
    await applySeedData(database);
    // The person is gone, and so is everything that made them an organizer: no user, no provider
    // link, no event. The organization goes with them — the count below is of organizations the
    // seed did not create, and it is back to zero.
    await expect(directory.findByUserId(realUserId)).resolves.toBeNull();
    await expect(
      directory.findByProviderAccount("google", "104729183746501928374"),
    ).resolves.toBeNull();
    await expect(events.organizationOf(realEventId)).resolves.toBeNull();
    // The fixture is back, unharmed: the teardown is right for the database it is written for.
    expect(await unseededCounts(database)).toEqual({ organizations: 0, users: 0, events: 0 });
  });
});
