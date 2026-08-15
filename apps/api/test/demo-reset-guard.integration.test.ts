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
const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const DEMO_ORGANIZATION = "00000000-0000-4000-8000-000000000010";

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

/**
 * The composition `index.ts` builds for a request, so what these cases write is what production
 * writes rather than SQL shaped to suit the assertion.
 */
function signupStack(database: Database) {
  const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
  const events = new EventService({
    repository: new D1EventRepository(database as D1DatabasePort, preparedOrganizerGrant),
    newId: () => crypto.randomUUID(),
    now: () => new Date("2026-08-14T09:00:00.000Z"),
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
  return { directory, events, signup };
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

  /**
   * Demo usage is not somebody's data, and the guard learned that the hard way.
   *
   * The first live reading of the deployed database returned three non-seeded users where exactly
   * one person had signed up. The other two were speakers: accepting a proposal converts one, and
   * `provisionSpeaker` writes a `users` row with no provider account and no membership. Counting
   * them made the restore refuse over the demo having been *used* — and an operator who meets that
   * reaches for `--destroy-real-data` on a teardown that destroys nothing real, which is the habit
   * that flag exists to prevent.
   *
   * The same shape exists one table over: the organizer persona holds `events:create` on the
   * seeded organization, so creating an event is an ordinary thing to click in the demo.
   *
   * Everything here goes through the services that write those rows in production, so the fixture
   * is the real shape rather than an approximation of it.
   */
  it("counts nothing for demo usage that converts a speaker or adds an event", async () => {
    const migrated = await createMigratedDatabase({ label: "demo-reset-demo-usage", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
    const events = new EventService({
      repository: new D1EventRepository(database as D1DatabasePort, preparedOrganizerGrant),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-14T09:00:00.000Z"),
    });

    // A speaker converted against the seeded event, exactly as accepting a proposal does.
    await directory.provisionSpeaker(crypto.randomUUID(), "Converted Speaker", DEMO_EVENT);
    await directory.provisionSpeaker(crypto.randomUUID(), "Another Speaker", DEMO_EVENT);
    // And an event a demo visitor made in the seeded organization, through the ordinary route.
    const persona = await directory.findByPersona("organizer");
    await events.create(persona, {
      organizationId: DEMO_ORGANIZATION,
      idempotencyKey: "00000000-0000-4000-8000-000000000168",
      name: "A visitor's event",
      timezone: "UTC",
    });

    // None of it is somebody's workspace, so the restore stays the one command it is meant to be.
    const counts = await unseededCounts(database);
    expect(counts).toEqual({ organizations: 0, events: 0, users: 0 });
    expect(() => assertOnlySeededData(counts, undefined)).not.toThrow();
  });

  /**
   * The other half of the same rule: the moment a row is attached to a person rather than to the
   * fixture, it counts — including a speaker who only ever appears in somebody's own workspace.
   */
  it("counts a speaker who holds a role in a self-serve workspace", async () => {
    const migrated = await createMigratedDatabase({ label: "demo-reset-real-speaker", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { directory, events, signup } = signupStack(database);

    const owner = await signup.signInWithGoogle({
      subject: "104729183746501928374",
      email: "nadia@example.test",
      emailVerified: true,
      name: "Nadia Newcomer",
    });
    const ownEvent = owner.actor.eventAccess[0]?.eventId as string;
    // A speaker in *their* event, not the demo's: a person in somebody's workspace.
    await directory.provisionSpeaker(crypto.randomUUID(), "Their Speaker", ownEvent);
    // And one more against the seeded event, which still does not count.
    await directory.provisionSpeaker(crypto.randomUUID(), "Demo Speaker", DEMO_EVENT);
    expect(events).toBeDefined();

    // The organizer and their speaker; the demo conversion is not among them.
    await expect(unseededCounts(database)).resolves.toEqual({
      organizations: 1,
      events: 1,
      users: 2,
    });
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
    const { signup } = signupStack(database);
    const signedUp = await signup.signInWithGoogle({
      subject: "104729183746501928374",
      email: "nadia@example.test",
      emailVerified: true,
      name: "Nadia Newcomer",
    });
    const { directory, events } = signupStack(database);
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
     * **And applying the seed no longer makes that refusal's claim true, which is the point of
     * this lane.**
     *
     * `seed/reset.sql` used to be a full teardown — an unscoped delete of every row in the three
     * guarded tables — so overriding the guard silently destroyed this person's workspace and
     * exited with `Remote demo restored`. Every cleanup is scoped now, and to the right thing
     * rather than to the narrowest thing: an organization-scoped table names the two seeded
     * organizations, and an event-scoped one resolves *every* event those organizations own,
     * including events the demo itself created. So the restore does reach rows the seed did not
     * insert — inside the demo's own organizations, which is what makes a second reset work at
     * all — and reaches nothing in anybody else's, which is the property this case asserts.
     *
     * The guard is unchanged and still refuses, deliberately: it reads what the database holds,
     * and a real organization on the demo deployment is still worth stopping for. What has
     * changed is what proceeding costs.
     */
    await applySeedData(database);
    // The person is still here, still linked to Google, still holding their own event.
    await expect(directory.findByUserId(realUserId)).resolves.not.toBeNull();
    await expect(
      directory.findByProviderAccount("google", "104729183746501928374"),
    ).resolves.not.toBeNull();
    await expect(events.organizationOf(realEventId)).resolves.not.toBeNull();
    // So the counts are unchanged rather than back to zero: the reset restored the demo beside
    // them instead of in place of them.
    expect(await unseededCounts(database)).toEqual({ organizations: 1, users: 1, events: 1 });
    // And the demo itself is back, which is the other half of "restored": the seeded organizer
    // resolves again, with the membership and the event role the fixture gives them.
    const seededOrganizer = await directory.findByUserId("seed-organizer");
    expect(seededOrganizer?.organizations).toEqual([
      { id: "00000000-0000-4000-8000-000000000010" },
    ]);
    expect(seededOrganizer?.eventAccess.map(({ eventId }) => eventId)).toContain(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("restores the demo twice in a row with a real conference in the same database", async () => {
    /*
     * Idempotence is what a restore is *for*, and the scoping pass is exactly where it could have
     * been lost: a cleanup that misses a row leaves the second run failing on a primary key or a
     * foreign key, and the demo then cannot be restored at all. Run twice, with somebody else's
     * workspace present the whole time.
     */
    const migrated = await createMigratedDatabase({ label: "demo-reset-twice", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { signup } = signupStack(database);
    const signedUp = await signup.signInWithGoogle({
      subject: "104729183746501928374",
      email: "nadia@example.test",
      emailVerified: true,
      name: "Nadia Newcomer",
    });

    await applySeedData(database);
    await applySeedData(database);

    const { directory } = signupStack(database);
    await expect(directory.findByUserId(signedUp.actor.id)).resolves.not.toBeNull();
    expect(await unseededCounts(database)).toEqual({ organizations: 1, users: 1, events: 1 });
  });
});
