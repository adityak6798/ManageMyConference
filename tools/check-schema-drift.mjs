// @spec ARC-003 TST-002
//
// Keeps the domain declarations under `apps/api/src/adapters/persistence/schema/` honest against
// `apps/api/migrations/*.sql` (deployed history).
//
// How it works
//   1. Build SQLite database A by executing every migration file, in order.
//   2. Build SQLite database B by executing the DDL this file renders from the Drizzle schema.
//   3. Read a normalised structural model out of each database (`sqlite_master` plus the
//      `table_info` / `foreign_key_list` / `index_list` / `index_xinfo` pragmas) and diff them.
//
// What the comparison covers, per table: column order, column names, declared types, NOT NULL,
// DEFAULT expressions, primary-key columns and their order, foreign keys (columns, parent table
// and columns, ON DELETE / ON UPDATE), UNIQUE constraints (as column tuples), named indexes
// (name, uniqueness, column order, DESC, partial WHERE clause) and CHECK constraint expressions.
// It also covers the set of tables, and the set of triggers and views.
//
// What it deliberately does NOT cover:
//   * Constraint *names* for UNIQUE and CHECK. SQLite does not expose them through pragmas and the
//     migrations declare them anonymously, so only their effect is compared.
//   * Trigger and view bodies. Drizzle cannot express either, so migration-created triggers are
//     listed in UNMODELLED_OBJECTS below; adding a trigger in a migration fails this check until
//     the new trigger is added to that list, which is the point — it forces an explicit
//     acknowledgement that schema.ts cannot describe it.
//   * Data. Migrations that backfill rows are executed but their effects are not compared.
//   * CHECK expression differences that survive normalisation (quotes, table qualifiers,
//     whitespace and spacing around `(`, `)` and `,` are normalised away; case is not).
//
// Why not `drizzle-kit generate`: drizzle-kit is not a dependency, but more importantly it diffs
// the schema against its own snapshot, and this repo has none — the migrations are hand-written
// and contain ALTER TABLE, a table rename, triggers and data backfills that drizzle-kit never
// emits. Its output could therefore never equal the migration history, whatever the diff.
// This check reads the same runtime table metadata drizzle-kit reads, and compares the database
// each source actually produces, which is the property the migrations exist to guarantee.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { SQL, getTableName, is } from "drizzle-orm";
import { SQLiteSyncDialect, SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";

const root = new URL("../", import.meta.url);
const migrationsDirectory = new URL("apps/api/migrations/", root);
const schemaRegistry = new URL("apps/api/src/adapters/persistence/schema/registry.ts", root);

/** Objects the migrations create that a Drizzle schema cannot declare. */
export const UNMODELLED_OBJECTS = [
  "trigger:cfp_status_delete_rejects_in_use",
  "trigger:cfp_submission_initializes_default_status",
  "trigger:cfp_transition_requires_configured_status",
  "trigger:review_assignment_requires_plan",
  "trigger:review_completion_rejects_conflict",
  "trigger:review_conflict_rejects_completion",
  "trigger:review_plan_lock",
];

const dialect = new SQLiteSyncDialect();

function quote(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function renderSql(fragment) {
  const query = dialect.sqlToQuery(fragment);
  if (query.params.length > 0)
    throw new Error(`schema.ts SQL fragments must be literal, but found parameters: ${query.sql}`);
  return query.sql;
}

/** `"events"."name" > 0` -> `name > 0`, so migration text and rendered Drizzle text can meet. */
function normaliseExpression(text, tableName) {
  return text
    .replaceAll(`${quote(tableName)}.`, "")
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function renderDefault(column) {
  const value = column.default;
  if (is(value, SQL)) return renderSql(value);
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  throw new Error(`Unsupported default on ${column.name}: ${JSON.stringify(value)}`);
}

function columnDdl(column) {
  if (column.defaultFn || column.onUpdateFn || column.generated)
    throw new Error(
      `Column ${column.name} uses a runtime default or generated expression, which cannot be rendered as DDL.`,
    );
  const parts = [quote(column.name), column.getSQLType().toUpperCase()];
  if (column.primary) parts.push("PRIMARY KEY");
  if (column.notNull) parts.push("NOT NULL");
  if (column.hasDefault) parts.push(`DEFAULT ${renderDefault(column)}`);
  if (column.isUnique) parts.push("UNIQUE");
  return parts.join(" ");
}

function columnList(columns) {
  return columns.map((column) => quote(column.name)).join(", ");
}

function tableDdl(config) {
  const parts = config.columns.map(columnDdl);
  for (const key of config.primaryKeys) parts.push(`PRIMARY KEY (${columnList(key.columns)})`);
  for (const constraint of config.uniqueConstraints)
    parts.push(`UNIQUE (${columnList(constraint.columns)})`);
  for (const constraint of config.checks)
    parts.push(`CONSTRAINT ${quote(constraint.name)} CHECK (${renderSql(constraint.value)})`);
  for (const key of config.foreignKeys) {
    const reference = key.reference();
    const clause = [
      `FOREIGN KEY (${columnList(reference.columns)})`,
      `REFERENCES ${quote(getTableName(reference.foreignTable))} (${columnList(reference.foreignColumns)})`,
    ];
    if (key.onDelete) clause.push(`ON DELETE ${key.onDelete}`);
    if (key.onUpdate) clause.push(`ON UPDATE ${key.onUpdate}`);
    parts.push(clause.join(" "));
  }
  return `CREATE TABLE ${quote(config.name)} (\n  ${parts.join(",\n  ")}\n);`;
}

function indexDdl(config) {
  return config.indexes.map((builder) => {
    const declared = builder.config;
    const columns = declared.columns
      .map((column) =>
        is(column, SQL)
          ? renderSql(column).replaceAll(`${quote(config.name)}.`, "")
          : quote(column.name),
      )
      .join(", ");
    const where = declared.where
      ? ` WHERE ${renderSql(declared.where).replaceAll(`${quote(config.name)}.`, "")}`
      : "";
    const unique = declared.unique ? "UNIQUE " : "";
    return `CREATE ${unique}INDEX ${quote(declared.name)} ON ${quote(config.name)} (${columns})${where};`;
  });
}

/** Renders the full DDL the declared schema stands for, as one statement per array entry. */
export function generateDdl(schema) {
  const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
  const configs = tables.map((table) => getTableConfig(table));
  return [...configs.map(tableDdl), ...configs.flatMap(indexDdl)];
}

export async function loadDeclaredSchema() {
  const { schema } = await import(schemaRegistry.href);
  return schema;
}

export async function loadDeclaredDdl() {
  return generateDdl(await loadDeclaredSchema());
}

export function migrationFiles() {
  return readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function applyMigrations(database) {
  for (const name of migrationFiles())
    database.exec(readFileSync(new URL(name, migrationsDirectory), "utf8"));
}

function skipLiteral(text, start) {
  const quoteCharacter = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] !== quoteCharacter) continue;
    if (text[index + 1] === quoteCharacter) index += 1;
    else return index + 1;
  }
  return text.length;
}

/** Index of the character after the `(` group that starts at `start`. */
function closeParenthesis(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" || character === '"' || character === "`") {
      index = skipLiteral(text, index) - 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

/**
 * Walks a `CREATE …` statement, yielding every bare keyword found outside string literals and
 * outside parentheses when `topLevelOnly`, with the index just past it.
 */
function* keywords(text, topLevelOnly) {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'" || character === '"' || character === "`") {
      index = skipLiteral(text, index) - 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (/[A-Za-z_]/.test(character)) {
      let end = index;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
      if (!topLevelOnly || depth === 0)
        yield { word: text.slice(index, end).toUpperCase(), end, depth };
      index = end - 1;
    }
  }
}

function extractChecks(statement, tableName) {
  const checks = [];
  for (const { word, end } of keywords(statement, false)) {
    if (word !== "CHECK") continue;
    const open = statement.indexOf("(", end);
    if (open === -1) continue;
    const close = closeParenthesis(statement, open);
    checks.push(normaliseExpression(statement.slice(open + 1, close), tableName));
  }
  return checks.sort();
}

function extractIndexWhere(statement, tableName) {
  for (const { word, end } of keywords(statement, true))
    if (word === "WHERE") return normaliseExpression(statement.slice(end), tableName);
  return "";
}

function indexColumns(database, indexName) {
  return database
    .prepare(`PRAGMA index_xinfo(${quote(indexName)})`)
    .all()
    .filter((row) => row.key === 1)
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => `${row.name ?? "<expression>"}${row.desc === 1 ? " DESC" : ""}`);
}

function readForeignKeys(database, tableName) {
  const grouped = new Map();
  for (const row of database.prepare(`PRAGMA foreign_key_list(${quote(tableName)})`).all()) {
    const entry = grouped.get(row.id) ?? {
      table: row.table,
      from: [],
      to: [],
      onDelete: row.on_delete,
      onUpdate: row.on_update,
    };
    entry.from[row.seq] = row.from;
    entry.to[row.seq] = row.to ?? "<primary key>";
    grouped.set(row.id, entry);
  }
  return [...grouped.values()]
    .map(
      (entry) =>
        `(${entry.from.join(", ")}) -> ${entry.table}(${entry.to.join(", ")}) ` +
        `ON DELETE ${entry.onDelete} ON UPDATE ${entry.onUpdate}`,
    )
    .sort();
}

function readTable(database, tableName, statement) {
  const info = database.prepare(`PRAGMA table_info(${quote(tableName)})`).all();
  const indexList = database.prepare(`PRAGMA index_list(${quote(tableName)})`).all();
  const indexSql = (name) =>
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)
      ?.sql ?? "";
  return {
    columns: info.map(
      (column) =>
        `${column.name} ${String(column.type).toUpperCase()}` +
        `${column.notnull === 1 ? " NOT NULL" : ""}` +
        `${column.dflt_value === null ? "" : ` DEFAULT ${String(column.dflt_value).replace(/\s+/g, " ").trim()}`}`,
    ),
    primaryKey: info
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
    foreignKeys: readForeignKeys(database, tableName),
    uniqueConstraints: indexList
      .filter((row) => row.origin === "u")
      .map((row) => indexColumns(database, row.name).join(", "))
      .sort(),
    indexes: indexList
      .filter((row) => row.origin === "c")
      .map((row) => {
        const where = extractIndexWhere(indexSql(row.name), tableName);
        return (
          `${row.unique === 1 ? "UNIQUE " : ""}${row.name} ` +
          `(${indexColumns(database, row.name).join(", ")})${where ? ` WHERE ${where}` : ""}`
        );
      })
      .sort(),
    checks: extractChecks(statement, tableName),
  };
}

/** Reads the structural model this check compares. */
export function readModel(database) {
  const tables = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all();
  const model = { tables: {}, objects: [] };
  for (const row of tables) model.tables[row.name] = readTable(database, row.name, row.sql ?? "");
  model.objects = database
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY type, name",
    )
    .all()
    .map((row) => `${row.type}:${row.name}`);
  return model;
}

function diffLists(label, expected, actual, differences) {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  for (const entry of missing) differences.push(`${label}: missing in schema.ts: ${entry}`);
  for (const entry of extra) differences.push(`${label}: not in migrations: ${entry}`);
}

/**
 * Differences between the migrated database (`expected`) and the declared schema (`actual`).
 * An empty array means the two agree on everything this check compares.
 */
export function diffModels(expected, actual) {
  const differences = [];
  diffLists("tables", Object.keys(expected.tables), Object.keys(actual.tables), differences);
  for (const [name, expectedTable] of Object.entries(expected.tables)) {
    const actualTable = actual.tables[name];
    if (!actualTable) continue;
    if (expectedTable.columns.join(" | ") !== actualTable.columns.join(" | "))
      differences.push(
        `${name}: columns differ\n    migrations: ${expectedTable.columns.join(", ")}\n    schema.ts:  ${actualTable.columns.join(", ")}`,
      );
    if (expectedTable.primaryKey.join(", ") !== actualTable.primaryKey.join(", "))
      differences.push(
        `${name}: primary key differs (migrations: [${expectedTable.primaryKey.join(", ")}], schema.ts: [${actualTable.primaryKey.join(", ")}])`,
      );
    for (const facet of ["foreignKeys", "uniqueConstraints", "indexes", "checks"])
      diffLists(`${name}.${facet}`, expectedTable[facet], actualTable[facet], differences);
  }
  return differences;
}

function build(statements) {
  const database = new DatabaseSync(":memory:");
  for (const statement of statements) database.exec(statement);
  return database;
}

function buildMigrated() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  return database;
}

/** Removes a constraint line from a rendered CREATE TABLE, keeping the result valid SQL. */
function dropTableLine(statement, pattern) {
  const lines = statement.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return statement;
  lines.splice(index, 1);
  const last = lines.length - 2;
  lines[last] = lines[last].replace(/,$/, "");
  return lines.join("\n");
}

const MUTATIONS = [
  [
    "a dropped column default",
    (statements) => statements.map((text) => text.replace(" DEFAULT 'submitted'", "")),
  ],
  [
    "a dropped NOT NULL",
    (statements) =>
      statements.map((text) => text.replace('"submitted_at" TEXT NOT NULL', '"submitted_at" TEXT')),
  ],
  [
    "a changed column type",
    (statements) =>
      statements.map((text) => text.replace('"sort_order" INTEGER', '"sort_order" TEXT')),
  ],
  [
    "a dropped unique constraint",
    (statements) =>
      statements.map((text) => dropTableLine(text, /^ {2}UNIQUE \("event_id", "proposal_id"\)/)),
  ],
  [
    "a dropped check constraint",
    (statements) =>
      statements.map((text) => dropTableLine(text, /^ {2}CONSTRAINT "speaker_tasks_status"/)),
  ],
  [
    "a dropped foreign key",
    (statements) =>
      statements.map((text) => dropTableLine(text, /^ {2}FOREIGN KEY \("actor_id"\)/)),
  ],
  [
    "a dropped index",
    (statements) =>
      statements.filter((text) => !text.startsWith('CREATE INDEX "content_sessions_event_id_idx"')),
  ],
  [
    "a dropped table",
    (statements) => statements.filter((text) => !text.includes('"speaker_messages"')),
  ],
];

/**
 * Proves the differ is not vacuous before trusting it: every mutation above must be reported.
 * Returns the mutations that slipped through, which must be empty.
 */
export function selfTest(ddl) {
  const migrated = readModel(buildMigrated());
  const undetected = [];
  for (const [label, mutate] of MUTATIONS) {
    const mutated = mutate(ddl);
    if (mutated.join("\n") === ddl.join("\n")) {
      undetected.push(`${label} (the mutation did not change the generated DDL)`);
      continue;
    }
    let mutatedModel;
    try {
      mutatedModel = readModel(build(mutated));
    } catch (error) {
      throw new Error(
        `The self-test mutation for ${label} no longer produces valid DDL; update MUTATIONS in tools/check-schema-drift.mjs.`,
        { cause: error },
      );
    }
    if (diffModels(migrated, mutatedModel).length === 0) undetected.push(label);
  }
  return undetected;
}

async function main() {
  const ddl = await loadDeclaredDdl();
  if (process.argv.includes("--emit-ddl")) {
    process.stdout.write(`${ddl.join("\n")}\n`);
    return;
  }
  const migrated = readModel(buildMigrated());
  const declared = readModel(build(ddl));
  const differences = diffModels(migrated, declared);
  const unmodelled = migrated.objects.filter((entry) => !UNMODELLED_OBJECTS.includes(entry));
  for (const entry of unmodelled)
    differences.push(
      `${entry} exists in the migrations but not in schema.ts. Drizzle cannot declare triggers or views: add it to UNMODELLED_OBJECTS in tools/check-schema-drift.mjs to record that gap deliberately.`,
    );
  for (const entry of UNMODELLED_OBJECTS.filter((entry) => !migrated.objects.includes(entry)))
    differences.push(`${entry} is listed in UNMODELLED_OBJECTS but no migration creates it.`);
  if (declared.objects.length > 0)
    differences.push(`schema.ts DDL created unexpected objects: ${declared.objects.join(", ")}`);
  if (differences.length > 0) {
    process.stderr.write(
      `apps/api/src/adapters/persistence/schema.ts does not describe apps/api/migrations:\n  ${differences.join("\n  ")}\n` +
        "Migrations are immutable history: fix schema.ts, or add a migration for the intent it declares.\n",
    );
    process.exitCode = 1;
    return;
  }
  // The comparison agrees; prove it would have disagreed, so a green run means something.
  const undetected = selfTest(ddl);
  if (undetected.length > 0) {
    process.stderr.write(
      `Schema drift check is not trustworthy: it failed to notice ${undetected.join("; ")}.\n` +
        "Update MUTATIONS in tools/check-schema-drift.mjs so the self-test keeps biting.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Schema drift checks passed (${Object.keys(migrated.tables).length} tables, ${migrationFiles().length} migrations, ${MUTATIONS.length} self-test mutations detected).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
