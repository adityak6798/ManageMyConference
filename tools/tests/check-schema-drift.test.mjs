// @acceptance ACC-HARNESS
// @spec ARC-003 TST-002
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  applyMigrations,
  diffModels,
  generateDdl,
  loadDeclaredDdl,
  loadDeclaredSchema,
  readModel,
  selfTest,
} from "../check-schema-drift.mjs";

function modelOf(statements) {
  const database = new DatabaseSync(":memory:");
  for (const statement of statements) database.exec(statement);
  return readModel(database);
}

const baseline = [
  `CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL);`,
  `CREATE TABLE child (
     id TEXT PRIMARY KEY NOT NULL,
     parent_id TEXT NOT NULL REFERENCES parent(id),
     state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','done')),
     UNIQUE (parent_id, state)
   );`,
  `CREATE INDEX child_parent_idx ON child(parent_id);`,
];

test("identical DDL produces no differences", () => {
  assert.deepEqual(diffModels(modelOf(baseline), modelOf(baseline)), []);
});

/**
 * A comment is prose, not SQL, and reading it as SQL used to lose constraints silently.
 *
 * `sqlite_master.sql` keeps comments written inside a CREATE body, and the walkers here treated
 * an apostrophe in one as opening a string literal — so every CHECK between it and the next
 * quote in the statement vanished from the extracted model. The loud direction is a gate that
 * fails on a constraint both models declare, which is how this was found. The quiet direction is
 * the one worth a test: a migration whose CHECK is swallowed *and* whose author forgot to
 * declare it in Drizzle passes green, because neither side can see it.
 *
 * Every quote character SQLite accepts as a delimiter is covered, because the bug is in the
 * delimiter handling rather than in the apostrophe.
 */
test("a comment cannot hide a constraint from either model", () => {
  const commented = [
    `CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL);`,
    `CREATE TABLE child (
       id TEXT PRIMARY KEY NOT NULL,
       parent_id TEXT NOT NULL REFERENCES parent(id),
       -- the operator's note, a "quoted" aside and a \`backticked\` one
       /* and a block comment carrying an apostrophe: don't lose the CHECK below */
       state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','done')),
       UNIQUE (parent_id, state)
     );`,
    `CREATE INDEX child_parent_idx ON child(parent_id);`,
  ];
  assert.deepEqual(modelOf(commented).tables.child.checks, ["state IN('new','done')"]);
  // And the commented form is indistinguishable from the bare one, which is the property the
  // gate rests on.
  assert.deepEqual(diffModels(modelOf(baseline), modelOf(commented)), []);
});

test("a comment does not hide a genuinely missing constraint", () => {
  const withoutCheck = [
    `CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL);`,
    `CREATE TABLE child (
       id TEXT PRIMARY KEY NOT NULL,
       parent_id TEXT NOT NULL REFERENCES parent(id),
       -- the operator's note
       state TEXT NOT NULL DEFAULT 'new',
       UNIQUE (parent_id, state)
     );`,
    `CREATE INDEX child_parent_idx ON child(parent_id);`,
  ];
  assert.ok(diffModels(modelOf(baseline), modelOf(withoutCheck)).length > 0);
});

test("cosmetic differences are normalised away", () => {
  const restyled = [
    `CREATE TABLE parent ( id TEXT PRIMARY KEY NOT NULL );`,
    `CREATE TABLE "child" (
       "id" TEXT PRIMARY KEY NOT NULL,
       "parent_id" TEXT NOT NULL,
       "state" TEXT NOT NULL DEFAULT 'new',
       CONSTRAINT "child_state" CHECK ("child"."state" IN ('new', 'done')),
       CONSTRAINT "child_unique" UNIQUE ("parent_id", "state"),
       FOREIGN KEY ("parent_id") REFERENCES "parent" ("id")
     );`,
    `CREATE INDEX "child_parent_idx" ON "child" ("parent_id");`,
  ];
  assert.deepEqual(diffModels(modelOf(baseline), modelOf(restyled)), []);
});

for (const [label, statements] of [
  ["a missing default", baseline.map((statement) => statement.replace(" DEFAULT 'new'", ""))],
  [
    "a missing check",
    baseline.map((statement) => statement.replace(" CHECK (state IN ('new','done'))", "")),
  ],
  [
    "a missing unique constraint",
    baseline.map((statement) => statement.replace(",\n     UNIQUE (parent_id, state)", "")),
  ],
  ["a missing index", baseline.slice(0, 2)],
  [
    "a missing foreign key",
    baseline.map((statement) => statement.replace(" REFERENCES parent(id)", "")),
  ],
  [
    "a reordered column",
    [
      baseline[0],
      `CREATE TABLE child (
         id TEXT PRIMARY KEY NOT NULL,
         state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','done')),
         parent_id TEXT NOT NULL REFERENCES parent(id),
         UNIQUE (parent_id, state)
       );`,
      baseline[2],
    ],
  ],
]) {
  test(`the diff reports ${label}`, () => {
    const differences = diffModels(modelOf(baseline), modelOf(statements));
    assert.ok(differences.length > 0, `expected ${label} to be reported`);
  });
}

test("the declared schema reproduces the migrated database", async () => {
  const migrated = new DatabaseSync(":memory:");
  applyMigrations(migrated);
  assert.deepEqual(diffModels(readModel(migrated), modelOf(await loadDeclaredDdl())), []);
});

test("the registry and public aggregate expose all 74 domain-owned tables", async () => {
  const registry = await loadDeclaredSchema();
  const aggregate = await import(
    new URL("../../apps/api/src/adapters/persistence/schema.ts", import.meta.url).href
  );
  assert.equal(
    generateDdl(registry).filter((statement) => statement.startsWith("CREATE TABLE")).length,
    74,
  );
  assert.deepEqual(diffModels(modelOf(generateDdl(aggregate)), modelOf(generateDdl(registry))), []);
});

test("dropping a domain fragment cannot leave the schema check green", async () => {
  const declared = await loadDeclaredSchema();
  const withoutPublishing = Object.fromEntries(
    Object.entries(declared).filter(([name]) => name !== "publicEventProjections"),
  );
  const migrated = new DatabaseSync(":memory:");
  applyMigrations(migrated);
  assert.ok(diffModels(readModel(migrated), modelOf(generateDdl(withoutPublishing))).length > 0);
});

test("every mutation of the declared schema is detected", async () => {
  assert.deepEqual(selfTest(await loadDeclaredDdl()), []);
});
