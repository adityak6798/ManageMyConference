import { readdir, readFile } from "node:fs/promises";

interface RunnableDatabase {
  prepare(query: string): { run(): Promise<unknown> };
}

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

/**
 * Apply every migration in order and then `seed/reset.sql`, exactly as `npm run reset` does.
 * The migration list is read from the directory rather than hard-coded so a new migration is
 * covered the moment it lands.
 */
export async function applySeed(database: RunnableDatabase): Promise<void> {
  const migrationsDirectory = new URL("../../migrations/", import.meta.url);
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrations.length === 0) throw new Error("no migrations found to apply");
  for (const migration of migrations) {
    const sql = await readFile(new URL(migration, migrationsDirectory), "utf8");
    for (const statement of statements(sql)) await database.prepare(statement).run();
  }
  const reset = await readFile(new URL("../../seed/reset.sql", import.meta.url), "utf8");
  for (const statement of statements(reset)) await database.prepare(statement).run();
}

/** The bytes `npm run reset` writes into the local R2 bucket for the seeded headshot. */
export async function seededAssetBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(new URL("../../seed/assets/speaker-portrait.png", import.meta.url)),
  );
}
