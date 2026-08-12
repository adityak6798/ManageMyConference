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

test("the registry and public aggregate expose all 48 domain-owned tables", async () => {
  const registry = await loadDeclaredSchema();
  const aggregate = await import(
    new URL("../../apps/api/src/adapters/persistence/schema.ts", import.meta.url).href
  );
  assert.equal(
    generateDdl(registry).filter((statement) => statement.startsWith("CREATE TABLE")).length,
    48,
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
