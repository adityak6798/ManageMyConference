// @acceptance ACC-HARNESS
import assert from "node:assert/strict";
import test from "node:test";
import { EVALUATOR_COMMIT, sanitizedConfiguration } from "../run-sbek-evaluator.mjs";

test("the evaluator is immutable and its committed configuration contains no credentials", () => {
  assert.match(EVALUATOR_COMMIT, /^[a-f0-9]{40}$/);
  const config = sanitizedConfiguration("http://127.0.0.1:8787");
  assert.equal(config.includeOptional, false);
  assert.deepEqual(config.areas, []);
  assert.equal(JSON.stringify(config).includes("password"), false);
  assert.equal(JSON.stringify(config).includes("email"), false);
});
