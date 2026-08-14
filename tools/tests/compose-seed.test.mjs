// @acceptance ACC-HARNESS
// @spec ARC-DOM-001 ENG-CI-001
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { composeSeed, SEED_HEADER, seedFragments, unscopedDeletes } from "../compose-seed.mjs";

const root = new URL("../../", import.meta.url);

test("the applied seed is the byte-stable composition of every domain fragment", async () => {
  const first = await composeSeed();
  const second = await composeSeed();
  assert.equal(first, second);
  assert.equal(first, await readFile(new URL("apps/api/seed/reset.sql", root), "utf8"));
  assert.equal(new Set(seedFragments).size, seedFragments.length);
});

test("the composed file names the command that regenerates it, before any SQL", async () => {
  // "Do not edit generated files. Their header identifies the generating command." — CLAUDE.md.
  // A reader who opens `reset.sql` because a reset misbehaved has to be told there, not by
  // knowing already, that the edit belongs in a fragment.
  const composed = await composeSeed();
  assert.ok(composed.startsWith(SEED_HEADER), "the header is the first thing in the file");
  assert.match(SEED_HEADER, /npm run seed:generate/);
  assert.match(SEED_HEADER, /tools\/compose-seed\.mjs/);
  // Every header line is a SQL line comment, or applying the file would fail on its own preamble.
  for (const line of SEED_HEADER.split("\n").filter(Boolean))
    assert.match(line, /^--/, `header line is not SQL: ${line}`);
});

test("a fragment never runs into its neighbour's first line", async () => {
  /*
   * The defect this replaced: two fragments end without a newline, so the composed file carried
   * the CFP forms cleanup — and the seeded event roles insert — with the next fragment's opening
   * `--` comment welded onto the end of the statement's own line. Harmless to SQLite and to the
   * statement splitter, and exactly the wrong thing to be reading when a reset has just failed.
   * Asserted on the composition rather than on the fragments, because the fragments belong to
   * nine domains and the guarantee is the composer's.
   */
  const composed = await composeSeed();
  const offenders = composed.split("\n").filter((line) => line.includes(";--"));
  assert.deepEqual(offenders, [], "a statement has run into the next fragment's comment");
  for (const [index, fragment] of seedFragments.entries()) {
    const source = await readFile(new URL(`apps/api/seed/domains/${fragment}`, root), "utf8");
    const body = source.trim();
    assert.ok(composed.includes(`\n${body}\n`), `${fragment} is not composed as whole lines`);
    // One blank line between neighbours, whatever either fragment happens to end with.
    if (index > 0) assert.ok(composed.includes(`\n\n${body}\n`), `${fragment} has no boundary`);
  }
});

test("no cleanup in the composed seed empties a table", async () => {
  /*
   * The demo and a real conference share one deployment, so an unscoped `DELETE FROM <table>` in
   * `seed/reset.sql` reads as "restore the demo" and means "empty the table". Every cleanup is
   * scoped to the ids the seed inserts; this is what keeps it that way, and it is asserted on the
   * composition because the fragments belong to nine domains and the guarantee is the file's.
   */
  assert.deepEqual(unscopedDeletes(await composeSeed()), []);
});

test("the scope check catches a bare delete, and honours a stated exemption", () => {
  // A guard nobody has seen fail is a guard nobody knows works.
  assert.deepEqual(unscopedDeletes("DELETE FROM widgets;"), ["widgets"]);
  assert.deepEqual(unscopedDeletes("DELETE FROM widgets WHERE id IN ('a');"), []);
  // The `WHERE` on its own line, which is how every scoped statement here is written.
  assert.deepEqual(unscopedDeletes("DELETE FROM widgets\nWHERE id IN (\n  'a'\n);"), []);
  // Prose between the two lines does not satisfy it.
  assert.deepEqual(unscopedDeletes("DELETE FROM widgets\n-- why\nWHERE id IN ('a');"), ["widgets"]);
  assert.deepEqual(unscopedDeletes("-- SEED-SCOPE-EXEMPT: demo-only\nDELETE FROM widgets;"), []);
  // The exemption covers one statement, not the rest of the file.
  assert.deepEqual(
    unscopedDeletes("-- SEED-SCOPE-EXEMPT: demo-only\nDELETE FROM a;\nDELETE FROM b;"),
    ["b"],
  );
});
