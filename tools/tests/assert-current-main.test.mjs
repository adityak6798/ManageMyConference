// @acceptance ACC-HARNESS
// @spec ENG-CI-001
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCurrentMain } from "../assert-current-main.mjs";

const head = "a".repeat(40);

test("the release admits only the current main push", () => {
  assert.doesNotThrow(() =>
    assertCurrentMain({ eventName: "push", ref: "refs/heads/main", sha: head, remoteMain: head }),
  );
});

test("the release refuses a superseded main workflow", () => {
  assert.throws(
    () =>
      assertCurrentMain({
        eventName: "push",
        ref: "refs/heads/main",
        sha: head,
        remoteMain: "b".repeat(40),
      }),
    /Refusing stale deploy/,
  );
});

test("the release refuses another event or branch", () => {
  assert.throws(
    () =>
      assertCurrentMain({
        eventName: "pull_request",
        ref: "refs/pull/1/merge",
        sha: head,
        remoteMain: head,
      }),
    /not a push to refs\/heads\/main/,
  );
});
