// @acceptance ACC-HARNESS
// @spec ENG-DEV-001 PRD-IAM-001
/**
 * The half of local setup that has a decision in it.
 *
 * Writing a fresh `.dev.vars` is a template; adding the Google bindings to one that already exists
 * is not, because that file is somebody's local state and the deployed configuration is now
 * half-present without it. Both halves are asserted here: nothing already declared is touched, and
 * nothing missing is left out.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredKeys, withGoogleBindings, withWebhookBindings } from "../setup-local.mjs";

const GOOGLE = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
const WEBHOOK = [
  "WEBHOOK_EGRESS_ENDPOINT",
  "WEBHOOK_EGRESS_TOKEN",
  "WEBHOOK_WRAPPING_KEY_VERSION",
  "WEBHOOK_WRAPPING_KEYS",
];

test("a file that declares none of them gets all three, blank", () => {
  const { text, added } = withGoogleBindings("ENVIRONMENT=development\nSESSION_SECRET=abc\n");
  assert.deepEqual(added, GOOGLE);
  for (const name of GOOGLE) assert.match(text, new RegExp(`^${name}=$`, "m"));
  // Blank, not a placeholder: a value here boots a configuration that then fails at Google, which
  // is the state the all-three-or-none guard exists to prevent.
  assert.doesNotMatch(text, /GOOGLE_CLIENT_ID=\S/);
  // And the existing lines are untouched.
  assert.match(text, /^ENVIRONMENT=development$/m);
  assert.match(text, /^SESSION_SECRET=abc$/m);
});

test("a developer's real client is never overwritten", () => {
  const configured =
    "SESSION_SECRET=abc\nGOOGLE_CLIENT_ID=mine.apps.googleusercontent.com\n" +
    "GOOGLE_CLIENT_SECRET=my-secret\nGOOGLE_REDIRECT_URI=http://127.0.0.1:20192/api/auth/google/callback\n";
  const { text, added } = withGoogleBindings(configured);
  assert.deepEqual(added, []);
  assert.equal(text, configured);
});

test("only the missing ones are added", () => {
  const partial = "SESSION_SECRET=abc\nGOOGLE_CLIENT_ID=mine.apps.googleusercontent.com\n";
  const { text, added } = withGoogleBindings(partial);
  assert.deepEqual(added, ["GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]);
  assert.match(text, /^GOOGLE_CLIENT_ID=mine\.apps\.googleusercontent\.com$/m);
});

test("a file with no trailing newline does not gain a joined line", () => {
  const { text } = withGoogleBindings("SESSION_SECRET=abc");
  assert.match(text, /^SESSION_SECRET=abc$/m);
  assert.match(text, /^GOOGLE_CLIENT_ID=$/m);
});

test("keys are read whatever surrounds them", () => {
  const keys = declaredKeys("# a comment\n\n  SPACED = 1\nEMPTY=\n");
  assert.ok(keys.has("SPACED"));
  assert.ok(keys.has("EMPTY"));
  // A comment mentioning a binding does not count as declaring it, or a developer who wrote a
  // note about Google would get a half-applied configuration and a Worker that refuses everything.
  assert.equal(declaredKeys("# GOOGLE_CLIENT_ID goes here\n").has("GOOGLE_CLIENT_ID"), false);
});

test("deployed webhook configuration is overridden locally as one blank unit", () => {
  const existing = "SESSION_SECRET=abc\nWEBHOOK_EGRESS_TOKEN=developer-token\n";
  const { text, added } = withWebhookBindings(existing);
  assert.deepEqual(added, WEBHOOK);
  for (const name of WEBHOOK) assert.match(text, new RegExp(`^${name}=$`, "m"));
});
