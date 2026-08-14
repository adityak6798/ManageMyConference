// @acceptance ACC-DEMO-SMOKE
// @spec ENG-CI-001
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertDemoConfig,
  assertOnlySeededData,
  DEMO_TARGET,
  destroyToken,
  GUARDED_TABLES,
  main,
  parseArguments,
  parseUnseededCounts,
  remoteResetCommands,
  seededFixtureIds,
  unseededCountCommand,
  unseededCountQuery,
} from "../remote-demo-reset.mjs";

const config = readFileSync(new URL("../../apps/api/wrangler.toml", import.meta.url), "utf8");
const seed = readFileSync(new URL("../../apps/api/seed/reset.sql", import.meta.url), "utf8");
/** What wrangler's `--json` answers with, around whichever counts a case is about. */
const wranglerJson = (counts) =>
  `${JSON.stringify([{ results: [counts], success: true, meta: { duration: 1 } }])}\n`;

test("the remote reset is pinned to the checked-in disposable demo resources", () => {
  assert.doesNotThrow(() => assertDemoConfig(config));
  assert.deepEqual(remoteResetCommands(), [
    ["d1", "migrations", "apply", "DB", "--remote"],
    ["d1", "execute", "DB", "--remote", "--file", "seed/reset.sql", "--yes"],
    [
      "r2",
      "object",
      "put",
      DEMO_TARGET.assetPath,
      "--remote",
      "--file",
      "seed/assets/speaker-portrait.png",
      "--content-type",
      "image/png",
    ],
  ]);
});

test("resource validation is independent of TOML table order", () => {
  const d1Start = config.indexOf("[[d1_databases]]");
  const r2Start = config.indexOf("[[r2_buckets]]");
  const d1Block = config.slice(d1Start, r2Start);
  const r2Block = config.slice(r2Start);
  assert.doesNotThrow(() => assertDemoConfig(`${config.slice(0, d1Start)}${r2Block}\n${d1Block}`));
});

test("D1 identity fields must belong to the same table block", () => {
  const splitIdentity = config.replace(
    `database_id = "${DEMO_TARGET.databaseId}"`,
    `database_id = "production-id"\n\n[[d1_databases]]\nbinding = "PRODUCTION"\ndatabase_name = "production"\ndatabase_id = "${DEMO_TARGET.databaseId}"`,
  );
  assert.throws(() => assertDemoConfig(splitIdentity), /exact demo D1 database/);
});

test("R2 binding and bucket name must belong to the same table block", () => {
  const splitIdentity = config.replace(
    `bucket_name = "${DEMO_TARGET.bucketName}"`,
    `bucket_name = "production-assets"\n\n[[r2_buckets]]\nbinding = "PRODUCTION"\nbucket_name = "${DEMO_TARGET.bucketName}"`,
  );
  assert.throws(() => assertDemoConfig(splitIdentity), /exact demo R2 bucket/);
});

for (const [label, changed] of [
  [
    "production authentication",
    config.replace('ENVIRONMENT = "development"', 'ENVIRONMENT = "production"'),
  ],
  ["disabled demo mode", config.replace('DEMO_MODE = "true"', 'DEMO_MODE = "false"')],
  ["another Worker", config.replace('name = "project-greenroom-api"', 'name = "production"')],
  ["another database", config.replace(DEMO_TARGET.databaseId, "production-database-id")],
  [
    "another bucket",
    config.replace('bucket_name = "manage-my-conf"', 'bucket_name = "production-assets"'),
  ],
])
  test(`the remote reset refuses ${label}`, () => {
    assert.throws(() => assertDemoConfig(changed), /Refusing remote reset/);
  });

/*
 * The data guard (`GAP-019`). Every case below is about the same question the configuration
 * checks above cannot answer: does this database contain an organization nobody seeded?
 */

test("the seeded identifiers are read from the fixture rather than guessed", () => {
  const ids = seededFixtureIds(seed);
  // Every guarded table, and exactly what `seed/reset.sql` inserts today. This asserts the
  // values rather than the shape on purpose: an id the parser silently missed would be read as
  // real data and refuse every reset, and one it invented would be read as seeded and deleted.
  // The migration-planted `Imported organization` comes first, then the fixture's own two.
  assert.deepEqual(ids.organizations, [
    "00000000-0000-4000-8000-000000000000",
    "00000000-0000-4000-8000-000000000010",
    "00000000-0000-4000-8000-000000000020",
  ]);
  assert.deepEqual(ids.users, [
    "seed-organizer",
    "seed-reviewer",
    // The event's second reviewer (issue #191). She is a seeded *user* and deliberately not a
    // demo persona: a round's pool, a two-reviewer aggregate and a reminder list are not
    // demonstrable with one reviewer in the directory, but `seed-<persona>` is the only shape the
    // demo door resolves and adding a fifth would be an identity-domain product change.
    "review-nina-alvarez",
    "seed-speaker",
    "speaker-jordan-bell",
    "seed-public",
  ]);
  assert.deepEqual(ids.events, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000099",
  ]);
  // Every guarded table is counted, and each count excludes the fixture's own identifiers. The
  // shape past that belongs to the domains that own the tables — `users` additionally requires
  // something that attaches the row to a person, because demo usage writes users too.
  const query = unseededCountQuery(ids);
  for (const table of GUARDED_TABLES) {
    assert.match(query, new RegExp(`FROM ${table}[\\s\\S]*?AS ${table}`));
    assert.match(query, new RegExp(`AS ${table}`));
  }
  // Built from `GUARDED_TABLES` rather than written out: naming another domain's tables in this
  // file is the boundary `npm run context -- check` enforces, and this file belongs to platform.
  for (const table of GUARDED_TABLES)
    assert.match(query, new RegExp(`\\b${table}\\b[\\s\\S]*?NOT IN`));
});

// Built from `GUARDED_TABLES` rather than written out: the tables belong to the events and
// identity-access domains, and this file belongs to platform.
const [organizationsTable, , usersTable] = GUARDED_TABLES;
const insertInto = (table) => `INSERT INTO ${table}`;

for (const [label, broken] of [
  [
    "a table the fixture no longer inserts",
    seed.replace(insertInto(organizationsTable), insertInto("renamed_table")),
  ],
  [
    "a column list that no longer starts with id",
    seed.replace(
      `${insertInto(usersTable)} (id, name, persona)`,
      `${insertInto(usersTable)} (name, id, persona)`,
    ),
  ],
  [
    "an identifier this guard would have to escape rather than refuse",
    seed.replace("'seed-organizer', 'Olivia Organizer'", "'seed''--organizer', 'Olivia Organizer'"),
  ],
])
  test(`reading the fixture refuses ${label}`, () => {
    // Fails closed: each of these would otherwise understate what the reset is about to delete.
    assert.throws(() => seededFixtureIds(broken), /Refusing remote reset/);
  });

test("a database holding only the fixture proceeds, which is the routine path", () => {
  const counts = parseUnseededCounts(wranglerJson({ organizations: 0, users: 0, events: 0 }));
  assert.deepEqual(counts, { organizations: 0, users: 0, events: 0 });
  assert.doesNotThrow(() => assertOnlySeededData(counts, undefined));
});

test("a database holding one real organization refuses, and says what and why", () => {
  const counts = parseUnseededCounts(wranglerJson({ organizations: 1, users: 1, events: 1 }));
  assert.throws(
    () => assertOnlySeededData(counts, undefined),
    (error) => {
      assert.match(error.message, /Refusing remote reset/);
      // What it found.
      assert.match(error.message, /1 organization, 1 event, 1 user/);
      // What proceeding costs, in the words an operator needs: permanent, and unrecoverable.
      assert.match(error.message, /destroys them permanently/);
      assert.match(error.message, /no backup and no export/);
      // And what to do, including the override that cannot be typed from habit.
      assert.match(error.message, /--destroy-real-data 1\/1\/1/);
      return true;
    },
  );
});

test("the override is separate from --confirm, and must state the counts that are there now", () => {
  // Written organizations/events/users, the order the refusal prints them in.
  const counts = { organizations: 2, events: 1, users: 3 };
  // Stale numbers from an earlier run are refused rather than rounded up to "yes".
  assert.throws(() => assertOnlySeededData(counts, "1/1/3"), /does not match what is there now/);
  // So is a permutation of the right numbers: the flag names counts per table, not a set.
  assert.throws(() => assertOnlySeededData(counts, "2/3/1"), /does not match what is there now/);
  assert.throws(() => assertOnlySeededData(counts, ""), /Refusing remote reset/);
  assert.doesNotThrow(() => assertOnlySeededData(counts, "2/1/3"));
  // `--confirm` alone never carries it, and never gains the power to.
  assert.deepEqual(parseArguments(["--confirm", DEMO_TARGET.worker]), {
    confirm: DEMO_TARGET.worker,
    destroy: undefined,
  });
  assert.deepEqual(
    parseArguments(["--confirm", DEMO_TARGET.worker, "--destroy-real-data", "2/1/3"]),
    { confirm: DEMO_TARGET.worker, destroy: "2/1/3" },
  );
  assert.throws(() => parseArguments(["--destroy-real-data", "2/1/3"]), /Refusing remote reset/);
  assert.throws(
    () => parseArguments(["--confirm", DEMO_TARGET.worker, "--destroy-real-data", "yes"]),
    /exact counts/,
  );
  assert.throws(() => parseArguments(["--confirm", DEMO_TARGET.worker, "--force"]), /Unrecognized/);

  /*
   * A flag typed without its value. Both of these end in a refusal either way — the value reads
   * as `undefined`, which is what "not supplied" looks like — but the refusal an operator then
   * sees describes the wrong problem: `--destroy-real-data` with no counts used to be answered
   * with advice to add `--destroy-real-data`, and a following flag was swallowed as the value,
   * losing the confirmation. Raised by the automated review on #208.
   */
  assert.throws(
    () => parseArguments(["--confirm", DEMO_TARGET.worker, "--destroy-real-data"]),
    /--destroy-real-data needs a value/,
  );
  assert.throws(
    () => parseArguments(["--destroy-real-data", "--confirm", DEMO_TARGET.worker]),
    /--destroy-real-data needs a value/,
  );
  assert.throws(() => parseArguments(["--confirm"]), /--confirm needs a value/);
});

for (const [label, output] of [
  ["nothing at all, which is what an unreachable database leaves", ""],
  ["an error wrangler printed instead of rows", "✘ [ERROR] Network connection lost.\n"],
  ["output that is not JSON", "[this is not json"],
  ["a JSON answer carrying no rows", JSON.stringify([{ results: [], success: true }])],
  ["a row missing one of the counts", wranglerJson({ organizations: 0, users: 0 })],
  ["a count that is not a whole number", wranglerJson({ organizations: 0, users: 0, events: "0" })],
  ["a negative count", wranglerJson({ organizations: -1, users: 0, events: 0 })],
])
  test(`an inconclusive check refuses: ${label}`, () => {
    // The property that matters more than any single case here: there is no path from a
    // question this guard could not answer to a teardown that runs anyway.
    assert.throws(() => parseUnseededCounts(output), /Refusing remote reset/);
  });

/*
 * The command as a whole, not only its decisions.
 *
 * Every function above can be right while the command is destructive: a refusal that still runs
 * the teardown, or a count query pointed at the local database, would pass all of them. Both
 * seams are injected here rather than executed, because the real ones talk to a live deployment.
 */

const migrateCommand = remoteResetCommands()[0];
const teardownCommands = remoteResetCommands().slice(1);
/** A runner that records what it was asked to run and answers with the supplied counts. */
function recorder(counts) {
  const ran = [];
  return {
    ran,
    run: (command) => ran.push(command),
    capture: (command) => {
      ran.push(command);
      return wranglerJson(counts);
    },
  };
}

test("the count query is asked of the remote database, as JSON", () => {
  const command = unseededCountCommand(seededFixtureIds(seed));
  // `--remote` is the whole difference between reading the deployed database and reading this
  // checkout's local one — which would answer "clean" about a database the command never saw,
  // and then tear down the deployed one.
  assert.ok(command.includes("--remote"), "the count query must name the remote database");
  assert.ok(command.includes("--json"), "the answer has to be parseable");
  assert.equal(command[0], "d1");
  assert.equal(command[1], "execute");
  assert.equal(command[2], DEMO_TARGET.databaseBinding);
});

test("a clean database is migrated, counted, and only then torn down — in that order", () => {
  const { ran, run, capture } = recorder({ organizations: 0, events: 0, users: 0 });

  main(["--confirm", DEMO_TARGET.worker], { run, capture });

  assert.deepEqual(ran[0], migrateCommand, "migrations apply before the tables are read");
  assert.ok(ran[1].includes("--json"), "the count query runs before anything destructive");
  assert.deepEqual(ran.slice(2), teardownCommands);
});

test("a refusal runs nothing destructive at all", () => {
  const counts = { organizations: 1, events: 0, users: 0 };
  const { ran, run, capture } = recorder(counts);

  assert.throws(
    () => main(["--confirm", DEMO_TARGET.worker], { run, capture }),
    /Refusing remote reset/,
  );

  // The migration and the count ran; the teardown did not. This is the property `GAP-019` rests
  // on, and it is the one thing no assertion about `assertOnlySeededData` alone can establish.
  assert.equal(ran.length, 2);
  for (const command of ran) assert.ok(!command.includes("seed/reset.sql"));
});

test("the override lets the same run through, and only for the counts it names", () => {
  const counts = { organizations: 1, events: 2, users: 3 };
  const refused = recorder(counts);
  assert.throws(
    () =>
      main(["--confirm", DEMO_TARGET.worker, "--destroy-real-data", "9/9/9"], {
        run: refused.run,
        capture: refused.capture,
      }),
    /does not match what is there now/,
  );
  assert.equal(refused.ran.length, 2);

  const allowed = recorder(counts);
  main(["--confirm", DEMO_TARGET.worker, "--destroy-real-data", destroyToken(counts)], {
    run: allowed.run,
    capture: allowed.capture,
  });
  assert.deepEqual(allowed.ran.slice(2), teardownCommands);
});

test("a count query that cannot be answered stops the command before the teardown", () => {
  const ran = [];
  const run = (command) => ran.push(command);
  const capture = () => {
    throw new Error("Refusing remote reset: the row count query could not run");
  };

  assert.throws(
    () => main(["--confirm", DEMO_TARGET.worker], { run, capture }),
    /Refusing remote reset/,
  );

  assert.deepEqual(ran, [migrateCommand]);
});

test("a stale override is refused even when the database is clean", () => {
  // The one place the "state exactly what you are destroying" property used to not hold: a
  // command line left in shell history naming counts this database does not have.
  assert.throws(
    () => assertOnlySeededData({ organizations: 0, events: 0, users: 0 }, "3/1/2"),
    /does not match what is there now/,
  );
  assert.doesNotThrow(() =>
    assertOnlySeededData({ organizations: 0, events: 0, users: 0 }, "0/0/0"),
  );
});

test("a migration-planted row is not mistaken for somebody's workspace", () => {
  // `0002_identity_event_foundation.sql` inserts `Imported organization` to re-parent the
  // pre-organization events, and `seed/reset.sql` never re-inserts it. Counting it as real data
  // would refuse the first restore against a freshly provisioned database and offer
  // `--destroy-real-data` as the way through — teaching the habit the flag exists to prevent.
  const ids = seededFixtureIds(seed);
  assert.ok(ids.organizations.includes("00000000-0000-4000-8000-000000000000"));
});

test("every insert into a guarded table is read, not only the first", () => {
  // The seed is composed from nine domain fragments, so a second insert statement is an
  // ordinary future edit. Reading only the first would report a seeded persona as somebody who
  // signed up, and refuse for ever.
  const second = `${insertInto(usersTable)} (id, name, persona) VALUES ('seed-extra', 'Extra Persona', 'public');`;
  const extended = seed.replace(
    `${insertInto(usersTable)} (id, name, persona) VALUES`,
    `${second}\n${insertInto(usersTable)} (id, name, persona) VALUES`,
  );
  const ids = seededFixtureIds(extended).users;
  assert.ok(ids.includes("seed-extra"));
  assert.ok(ids.includes("seed-organizer"));
});
