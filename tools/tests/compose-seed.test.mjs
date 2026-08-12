// @acceptance ACC-HARNESS
// @spec ARC-DOM-001 ENG-CI-001
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { composeSeed, seedFragments } from "../compose-seed.mjs";

const root = new URL("../../", import.meta.url);

test("the applied seed is the byte-stable composition of every domain fragment", async () => {
  const first = await composeSeed();
  const second = await composeSeed();
  assert.equal(first, second);
  assert.equal(first, await readFile(new URL("apps/api/seed/reset.sql", root), "utf8"));
  assert.equal(new Set(seedFragments).size, seedFragments.length);
});
