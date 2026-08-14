// @spec ENG-CI-001
/**
 * Restore the one public demo deployment without weakening the local reset boundary.
 *
 * **Two guards, and they answer different questions** (`GAP-019`).
 *
 * `assertDemoConfig` reads the repository: this checkout still describes the disposable demo —
 * that worker, that database id, that bucket, `ENVIRONMENT=development`, `DEMO_MODE=true` — and
 * the CLI additionally requires `--confirm project-greenroom-api`. Every one of those is a
 * statement about *configuration*, and each of them can be true of a database holding real
 * accounts.
 *
 * `assertOnlySeededData` reads the **data**, because `seed/reset.sql` is a full teardown: it
 * `DELETE`s every row of `users`, `organizations` and `events` — not the seeded ones, all of
 * them — before inserting the fixture back. That is exactly right for a database holding nothing
 * but seed data and catastrophic for one holding an organization somebody signed up for, since
 * there is no backup and no export. So the reset asks the database what it contains first, and
 * refuses if it finds anything the seed does not name.
 *
 * **It fails closed.** An unreachable database, a query that errors, output that does not parse,
 * a column missing from the answer: each of those is a refusal, never a proceed. A guard that
 * opens when it cannot see is not a guard, and this one stands between a routine command and an
 * irreversible deletion of somebody else's work.
 *
 * The override is `--destroy-real-data <organizations>/<events>/<users>` and it is deliberately
 * awkward: it must state the exact counts the guard just found, so it cannot be typed from
 * habit, cannot be pasted from an earlier run once the numbers move, and cannot be reached at
 * all without first being shown what would be destroyed. `--confirm` is untouched by it — one
 * flag that says "this deployment", one that says "and I am destroying these rows".
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENTS_FIXTURE_TABLES,
  EVENTS_MIGRATION_PLANTED_IDS,
  unseededEventsCountExpressions,
} from "../apps/api/src/adapters/persistence/events-fixture-statements.mjs";
import {
  IDENTITY_FIXTURE_TABLES,
  IDENTITY_MIGRATION_PLANTED_IDS,
  unseededIdentityCountExpressions,
} from "../apps/api/src/adapters/persistence/identity-fixture-statements.mjs";

const TOOLS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TOOLS_ROOT, "..");
const API_ROOT = path.join(REPOSITORY_ROOT, "apps", "api");
const CONFIG_PATH = path.join(API_ROOT, "wrangler.toml");
const SEED_PATH = path.join(API_ROOT, "seed", "reset.sql");

export const DEMO_TARGET = Object.freeze({
  worker: "project-greenroom-api",
  databaseBinding: "DB",
  databaseName: "manage-my-conf",
  databaseId: "5aa5ed70-b4f8-443a-a3a4-f3a4e41cce7b",
  bucketBinding: "ASSETS",
  bucketName: "manage-my-conf",
  assetPath:
    "manage-my-conf/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/90000000-0000-4000-8000-000000000001",
});

function quotedValue(text, key) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(text)?.[1];
}

function tableBlocks(text, table) {
  const heading = `[[${table}]]`;
  return text
    .split(/^\[\[([^\]]+)\]\]\s*$/m)
    .flatMap((part, index, parts) => (index > 0 && parts[index - 1] === table ? [part] : []));
}

function hasBlock(text, table, expected) {
  return tableBlocks(text, table).some((block) =>
    Object.entries(expected).every(([key, value]) => quotedValue(block, key) === value),
  );
}

/**
 * Refuse before authenticating if this checkout no longer describes the disposable demo.
 * Exact resource identities make copying this command into a production config fail closed.
 */
export function assertDemoConfig(text) {
  const expected = [
    ["name", DEMO_TARGET.worker],
    ["ENVIRONMENT", "development"],
    ["DEMO_MODE", "true"],
  ];
  for (const [key, value] of expected) {
    if (quotedValue(text, key) !== value)
      throw new Error(
        `Refusing remote reset: apps/api/wrangler.toml must declare ${key} = "${value}".`,
      );
  }
  if (
    !hasBlock(text, "d1_databases", {
      binding: DEMO_TARGET.databaseBinding,
      database_name: DEMO_TARGET.databaseName,
      database_id: DEMO_TARGET.databaseId,
    })
  )
    throw new Error(
      "Refusing remote reset: apps/api/wrangler.toml must bind the exact demo D1 database as DB.",
    );
  if (
    !hasBlock(text, "r2_buckets", {
      binding: DEMO_TARGET.bucketBinding,
      bucket_name: DEMO_TARGET.bucketName,
    })
  )
    throw new Error(
      "Refusing remote reset: apps/api/wrangler.toml must bind the exact demo R2 bucket as ASSETS.",
    );
}

/**
 * The three tables `seed/reset.sql` empties and refills, in the order the refusal reports them.
 *
 * Named by the domains that own them rather than listed here, and their SQL comes from the same
 * two modules: this command belongs to `platform`, `organizations` and `events` belong to
 * `events`, `users` belongs to `identity-access`, and a tool is not exempt from the boundary
 * every other cross-domain read respects (`identity-revocation-statements.mjs` set the pattern).
 *
 * Only these three. Every other table the reset clears holds state *about* a demo snapshot —
 * itineraries, sync runs, deliveries, sessions — which is regenerable by using the demo again. A
 * row in one of these is a person, an organization they signed up for, or an event they made,
 * and losing it cannot be undone by re-running anything.
 */
export const GUARDED_TABLES = Object.freeze([...EVENTS_FIXTURE_TABLES, ...IDENTITY_FIXTURE_TABLES]);

/** A seed identifier this tool is willing to interpolate into SQL. */
const SEED_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Rows the restore is entitled to delete without asking: the fixture's own, plus the ones a
 * migration planted, declared by the domains that own those tables.
 *
 * A migration-planted row is schema rather than data — `0002` inserts `Imported organization` to
 * give the pre-organization events a home, and the seed never re-inserts it — so counting it as
 * somebody's workspace would refuse the very first restore against a freshly provisioned
 * database and offer `--destroy-real-data` as the way through.
 */
const MIGRATION_PLANTED_IDS = {
  ...EVENTS_MIGRATION_PLANTED_IDS,
  ...IDENTITY_MIGRATION_PLANTED_IDS,
};

/**
 * The identifiers the fixture inserts, read out of `seed/reset.sql` itself.
 *
 * Read rather than listed here, and positively rather than by pattern: the seed is generated
 * (`npm run seed:generate`), so a fragment that adds a persona or an event must not silently
 * become "real data" the next reset refuses on — and an id *pattern* would be worse than
 * useless, because a self-serve organization's UUID looks exactly like a seeded one.
 *
 * **Every** insert into each table, not the first: the seed is composed from nine domain
 * fragments, and a fragment adding a second insert statement of its own is an ordinary future
 * edit. Taking
 * only the first would read the rest as real data — safe in direction, since the reset refuses,
 * but the refusal would name a person who does not exist and offer the destructive flag as the
 * remedy.
 *
 * Refuses rather than guessing if the file's shape moves under it: a table whose insert it
 * cannot find, a column list that does not start with `id`, or an identifier outside the
 * grammar above are each a reason to stop, since every one of them would understate what the
 * reset is about to delete.
 */
export function seededFixtureIds(sql) {
  const found = {};
  for (const table of GUARDED_TABLES) {
    const statements = [
      ...sql.matchAll(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)\\s*VALUES(.*?);`, "gis")),
    ];
    if (statements.length === 0)
      throw new Error(
        `Refusing remote reset: apps/api/seed/reset.sql has no INSERT INTO ${table}, so the seeded rows cannot be identified.`,
      );
    const ids = new Set();
    // Declared rather than parsed, and checked all the same: these reach the same interpolated
    // `NOT IN` list, and a guard that exempts its own inputs from its own grammar is not a guard.
    for (const id of MIGRATION_PLANTED_IDS[table] ?? []) {
      if (!SEED_ID.test(id))
        throw new Error(
          `Refusing remote reset: migration-planted ${table} identifier ${JSON.stringify(id)} is not a plain identifier, and this guard interpolates it into SQL rather than binding it.`,
        );
      ids.add(id);
    }
    for (const statement of statements) {
      const [firstColumn] = (statement[1] ?? "").split(",");
      if ((firstColumn ?? "").trim() !== "id")
        throw new Error(
          `Refusing remote reset: a seeded INSERT INTO ${table} does not list id first, so its identifiers cannot be read.`,
        );
      // `(?:[^']|'')*` rather than `[^']*`: a SQL-escaped quote inside a literal is part of the
      // value, and stopping at it would read `'seed''-organizer'` as the id `seed`, which then
      // matches no row. That fails safe — the guard refuses — but it refuses for the wrong reason
      // and would be read as real data on the deployment. Captured whole and refused below.
      for (const [, id] of statement[2].matchAll(/\(\s*'((?:[^']|'')*)'/g)) {
        if (!SEED_ID.test(id))
          throw new Error(
            `Refusing remote reset: seeded ${table} identifier ${JSON.stringify(id)} is not a plain identifier, and this guard interpolates it into SQL rather than binding it.`,
          );
        ids.add(id);
      }
    }
    if (ids.size === 0)
      throw new Error(
        `Refusing remote reset: the seeded INSERT INTO ${table} names no identifiers.`,
      );
    found[table] = [...ids];
  }
  return found;
}

/**
 * One statement that counts what the seed does not name, per guarded table.
 *
 * `wrangler d1 execute` takes a command string and no bound parameters, which is why
 * `seededFixtureIds` refuses anything that is not a plain identifier rather than escaping it —
 * refusing is checkable, escaping is the thing people get wrong (the same rule
 * `revoke-sessions.mjs` follows).
 */
export function unseededCountQuery(ids) {
  const idLists = Object.fromEntries(
    GUARDED_TABLES.map((table) => [table, (ids[table] ?? []).map((id) => `'${id}'`).join(", ")]),
  );
  return `SELECT ${[
    ...unseededEventsCountExpressions(idLists),
    ...unseededIdentityCountExpressions(idLists),
  ].join(", ")};`;
}

/** The wrangler invocation that asks the deployed database the question above. */
export function unseededCountCommand(ids) {
  return [
    "d1",
    "execute",
    DEMO_TARGET.databaseBinding,
    "--remote",
    "--command",
    unseededCountQuery(ids),
    "--json",
    "--yes",
  ];
}

/**
 * The counts, or a refusal — never a guess.
 *
 * Wrangler's `--json` answers with an array of results, and anything else it prints is a reason
 * to stop rather than to look harder: the whole value of this check is that a proceed means the
 * database was read and found clean.
 */
export function parseUnseededCounts(stdout) {
  const start = stdout.search(/[[{]/);
  if (start === -1)
    throw new Error(
      `Refusing remote reset: the row count query returned no JSON, so what this database holds is unknown.\n${stdout.trim()}`,
    );
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (error) {
    // ERROR-INTENT: an unreadable answer is an inconclusive check, and an inconclusive check
    // refuses. The parser's message is carried so the operator can see what came back.
    throw new Error(
      `Refusing remote reset: the row count query returned output that is not JSON (${error instanceof Error ? error.message : String(error)}), so what this database holds is unknown.`,
    );
  }
  const row = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(
    (result) => result?.results ?? [],
  )[0];
  if (!row || typeof row !== "object")
    throw new Error(
      "Refusing remote reset: the row count query returned no rows, so what this database holds is unknown.",
    );
  const counts = {};
  for (const table of GUARDED_TABLES) {
    const value = row[table];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new Error(
        `Refusing remote reset: the row count query did not report a whole number of non-seeded ${table}, so what this database holds is unknown.`,
      );
    counts[table] = value;
  }
  return counts;
}

/** "1 organization", "2 organizations" — the refusal is read by a person under pressure. */
function countOf(total, table) {
  return `${total} ${total === 1 ? table.replace(/s$/, "") : table}`;
}

/** How the override must be written for these counts. Deliberately not memorable. */
export function destroyToken(counts) {
  return GUARDED_TABLES.map((table) => counts[table]).join("/");
}

/**
 * Refuse unless the database holds only the fixture, or the operator named exactly what they are
 * destroying.
 *
 * The message states what was found and what proceeding costs, because an operator who reaches
 * this has already typed `--confirm` and is one habit away from deleting somebody's workspace.
 */
export function assertOnlySeededData(counts, override) {
  const total = GUARDED_TABLES.reduce((sum, table) => sum + counts[table], 0);
  const token = destroyToken(counts);
  // Checked before the clean-database exit, not after: an override naming counts this database
  // does not have is a stale command line, and accepting it silently on a clean database is the
  // one place the "state exactly what you are destroying" property would not hold.
  if (override !== undefined && override !== token)
    throw new Error(
      `Refusing remote reset: --destroy-real-data ${override} does not match what is there now (${token}), so nothing was deleted.`,
    );
  if (total === 0) return;
  if (override === token) return;
  const found = GUARDED_TABLES.map((table) => countOf(counts[table], table)).join(", ");
  throw new Error(
    `Refusing remote reset: this database holds ${found} that the seed did not create.\n` +
      (counts.organizations > 0
        ? `${countOf(counts.organizations, "organizations")} means ${counts.organizations === 1 ? "a workspace somebody" : "workspaces people"} signed up for and made things in.\n`
        : "") +
      "`seed/reset.sql` DELETEs every row of organizations, users and events before reinserting the fixture, so proceeding destroys them permanently: there is no backup and no export, and nothing re-creates them.\n" +
      (override === undefined
        ? `If that is genuinely what you intend, re-run with --destroy-real-data ${token} alongside --confirm ${DEMO_TARGET.worker}. The counts are part of the flag on purpose: they change as the data does, so this cannot be pasted from an earlier run.`
        : `--destroy-real-data ${override} does not match what is there now (${token}), so nothing was deleted. Re-read the counts above before repeating it.`),
  );
}

export function remoteResetCommands() {
  return [
    ["d1", "migrations", "apply", DEMO_TARGET.databaseBinding, "--remote"],
    ["d1", "execute", DEMO_TARGET.databaseBinding, "--remote", "--file", "seed/reset.sql", "--yes"],
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
  ];
}

function runWrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], { cwd: API_ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`wrangler ${args.slice(0, 2).join(" ")} exited with status ${result.status}`);
}

/**
 * Ask the deployed database what it holds, and refuse if anything at all gets in the way.
 *
 * Captured rather than inherited, because this is the one command here whose *output* is read.
 * A spawn that fails, a non-zero exit, an empty answer — the database was not read, so the
 * check is inconclusive, so it refuses.
 */
export function readUnseededCounts(runner = runWranglerCapturing) {
  const ids = seededFixtureIds(readFileSync(SEED_PATH, "utf8"));
  return parseUnseededCounts(runner(unseededCountCommand(ids)));
}

function runWranglerCapturing(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Refusing remote reset: the row count query could not run (wrangler exited with status ${result.status}), so what this database holds is unknown.`,
    );
  return result.stdout ?? "";
}

/** `--confirm <worker>`, and optionally `--destroy-real-data <organizations>/<events>/<users>`. Nothing else. */
export function parseArguments(argv) {
  const parsed = { confirm: undefined, destroy: undefined };
  /**
   * The value that follows a flag, or a refusal.
   *
   * A flag with nothing after it used to read as `undefined`, which is indistinguishable here
   * from "not supplied" — so `--destroy-real-data` typed with no counts fell through to the
   * ordinary refusal and told the operator to add the flag they had just typed. And a flag
   * followed by another flag swallowed it, so `--destroy-real-data --confirm <worker>` lost the
   * confirmation. Both end in a refusal rather than a deletion, but a guard that misreports what
   * is wrong with a command is one an operator argues with instead of reading.
   */
  const valueFor = (flag, value) => {
    if (value === undefined || value.startsWith("--"))
      throw new Error(`Refusing remote reset: ${flag} needs a value, and none followed it.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm") {
      parsed.confirm = valueFor(flag, argv[index + 1]);
      index += 1;
    } else if (flag === "--destroy-real-data") {
      parsed.destroy = valueFor(flag, argv[index + 1]);
      index += 1;
    } else throw new Error(`Unrecognized argument: ${flag}`);
  }
  if (parsed.confirm !== DEMO_TARGET.worker)
    throw new Error(
      `Refusing remote reset. Re-run with: npm run reset:demo -- --confirm ${DEMO_TARGET.worker}`,
    );
  // Deliberately separate from `--confirm`, and never implied by it: one flag says which
  // deployment, the other says that destroying real rows on it is intended.
  if (parsed.destroy !== undefined && !/^\d+\/\d+\/\d+$/.test(parsed.destroy))
    throw new Error(
      "Refusing remote reset: --destroy-real-data takes the exact counts the guard reports, written <organizations>/<events>/<users>, in the order the refusal prints them.",
    );
  return parsed;
}

/**
 * The whole command, with its two Wrangler seams injectable so the ordering can be tested.
 *
 * The seams exist because the ordering *is* the guard: a refusal that still ran the teardown, or
 * a count query that reached the local database instead of the remote one, would leave every
 * statement in this file individually correct and the command as a whole destructive. Both are
 * asserted in `tools/tests/remote-demo-reset.test.mjs` by driving this function with recorders.
 */
export function main(
  argv = process.argv.slice(2),
  { run = runWrangler, capture = runWranglerCapturing } = {},
) {
  const { destroy } = parseArguments(argv);
  assertDemoConfig(readFileSync(CONFIG_PATH, "utf8"));
  const [migrate, ...teardown] = remoteResetCommands();
  /*
   * Migrations first, then the data check, then the teardown. The order is load-bearing in both
   * directions: applying migrations is additive and makes the tables the count query reads
   * exist on a database that has never been migrated, and the count has to happen before the
   * first statement that deletes anything.
   *
   * Migrating before the check does mean a *destructive* migration would land ahead of the
   * guard. None exists — the block is additive by convention — and a migration that deleted
   * rows would need this ordering revisited rather than merely noted.
   */
  run(migrate);
  assertOnlySeededData(readUnseededCounts(capture), destroy);
  for (const command of teardown) run(command);
  process.stdout.write(`Remote demo restored: ${DEMO_TARGET.worker}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    main();
  } catch (error) {
    // ERROR-INTENT: this CLI boundary turns a guard or provider failure into one actionable
    // message and a non-zero exit; the underlying Wrangler command has already printed details.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
