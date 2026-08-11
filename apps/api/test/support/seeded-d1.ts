import { readdir, readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

interface RunnableDatabase {
  prepare(query: string): { run(): Promise<unknown> };
}

type D1Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

/**
 * Split SQL on statement boundaries. A plain `split(";")` corrupts the trigger migrations,
 * whose bodies carry their own semicolons between BEGIN and END.
 *
 * `--` comments are dropped rather than carried along, because their prose is not SQL: an
 * apostrophe in "the speaker's headshot" used to open a string literal that swallowed every
 * quote after it, and the whole seed then failed to apply with "SQL code did not contain a
 * statement" — a comment nobody would think to suspect.
 */
export function statements(sql: string): string[] {
  const found: string[] = [];
  let current = "";
  let inString = false;
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] as string;

    if (inString) {
      current += character;
      // '' is an escaped quote inside a SQL string, not the end of one.
      if (character === "'") {
        if (sql[index + 1] === "'") {
          current += "'";
          index += 1;
        } else inString = false;
      }
      continue;
    }

    if (character === "'") {
      inString = true;
      current += character;
      continue;
    }

    // A line comment runs to the newline, which is kept so statements stay readable.
    if (character === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      current += "\n";
      continue;
    }

    const upcoming = sql.slice(index);
    const beginMatch = /^BEGIN\b/i.exec(upcoming);
    if (beginMatch) {
      blockDepth += 1;
      current += beginMatch[0];
      index += beginMatch[0].length - 1;
      continue;
    }
    const endMatch = /^END\b/i.exec(upcoming);
    if (endMatch && blockDepth > 0) {
      blockDepth -= 1;
      current += endMatch[0];
      index += endMatch[0].length - 1;
      continue;
    }

    if (character === ";" && blockDepth === 0) {
      if (current.trim()) found.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) found.push(current.trim());
  return found;
}

const MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);
const SEED_FILE = new URL("../../seed/reset.sql", import.meta.url);

/**
 * Every migration filename in the order Wrangler applies them.
 *
 * Read from the directory rather than listed, so a new migration is covered by every test the
 * moment it lands. Hand-maintained subsets are what this replaces: each D1 test carried its
 * own list, adding a migration meant editing tests in domains that had nothing to do with it,
 * and the lists drifted until the shared reset referenced tables several fixtures did not have.
 */
export async function migrationFilenames(): Promise<string[]> {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) throw new Error("no migrations found to apply");
  return names;
}

/** Run one file's statements, naming the file and the statement if any of them fails. */
async function runFile(database: RunnableDatabase, label: string, sql: string): Promise<void> {
  for (const [index, statement] of statements(sql).entries()) {
    try {
      await database.prepare(statement).run();
    } catch (cause) {
      // ERROR-INTENT: rethrown with the file and statement named. The bare driver error says
      // only "no such table", which in a 22-migration replay is the one thing you already knew.
      throw new Error(
        `${label}: statement ${index + 1} failed\n${statement}\n${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
  }
}

/**
 * Apply every migration in canonical order.
 *
 * `through` stops after the named migration. It exists only for a test that has to prove
 * behaviour against an older schema — a migration-compatibility case — and every other test
 * takes the whole set.
 */
export async function applyMigrations(
  database: RunnableDatabase,
  options: { through?: string; from?: string } = {},
): Promise<string[]> {
  const names = await migrationFilenames();
  for (const [option, value] of Object.entries(options))
    if (value && !names.includes(value))
      throw new Error(
        `applyMigrations({ ${option}: "${value}" }) names a migration that does not exist`,
      );
  const applied: string[] = [];
  let started = options.from === undefined;
  for (const name of names) {
    if (name === options.from) started = true;
    if (started) {
      await runFile(database, name, await readFile(new URL(name, MIGRATIONS_DIRECTORY), "utf8"));
      applied.push(name);
    }
    if (options.through === name) break;
  }
  return applied;
}

/** Apply `seed/reset.sql`, the same deterministic fixture `npm run reset` writes. */
export async function applySeedData(database: RunnableDatabase): Promise<void> {
  await runFile(database, "seed/reset.sql", await readFile(SEED_FILE, "utf8"));
}

/**
 * Apply every migration in order and then `seed/reset.sql`, exactly as `npm run reset` does.
 */
export async function applySeed(database: RunnableDatabase): Promise<void> {
  await applyMigrations(database);
  await applySeedData(database);
}

let created = 0;

export interface MigratedDatabase {
  runtime: Miniflare;
  database: D1Database;
  /** The migrations this database was built from, in the order they were applied. */
  applied: string[];
  dispose(): Promise<void>;
}

/**
 * An isolated, fully migrated D1 database.
 *
 * Each call gets its own Miniflare instance and its own database name, so two tests — or two
 * cases in one test — cannot see each other's rows. Dispose it in `afterEach`.
 */
export async function createMigratedDatabase(
  options: { seed?: boolean; through?: string; label?: string } = {},
): Promise<MigratedDatabase> {
  created += 1;
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() {} }",
    d1Databases: { DB: `${options.label ?? "greenroom"}-${created}-${crypto.randomUUID()}` },
  });
  try {
    const database = await runtime.getD1Database("DB");
    const applied = await applyMigrations(database as RunnableDatabase, {
      ...(options.through ? { through: options.through } : {}),
    });
    if (options.seed) await applySeedData(database as RunnableDatabase);
    return { runtime, database, applied, dispose: () => runtime.dispose() };
  } catch (error) {
    // ERROR-INTENT: a runtime that failed to migrate still holds a socket and a temp
    // directory, so it is disposed before the failure is rethrown unchanged.
    await runtime.dispose();
    throw error;
  }
}

/** The bytes `npm run reset` writes into the local R2 bucket for the seeded headshot. */
export async function seededAssetBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL("../../seed/assets/speaker-portrait.png", import.meta.url)),
  );
}
