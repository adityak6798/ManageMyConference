// @acceptance ACC-IDENTITY-EVENTS
// @spec PRD-IAM-001 ARC-AUTH-001
/**
 * The guards on incident revocation, which is a command that signs real people out.
 *
 * Every case here is a refusal, and that is the point: the happy path runs `wrangler` against a
 * live database and cannot be exercised from a unit test, so what is worth pinning is that the
 * command refuses to *reach* that path when it has been pointed somewhere unintended.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWorkerConfirmation, parseArguments, revokeStatements } from "../revoke-sessions.mjs";

const CONFIG = 'name = "project-greenroom-api"\nmain = "src/index.ts"\n';

test("refuses a confirmation that does not name this checkout's worker", () => {
  assert.throws(() => assertWorkerConfirmation(CONFIG, "some-other-worker"), /Refusing to revoke/);
  // Missing entirely is the same refusal: `--confirm` is not optional.
  assert.throws(() => assertWorkerConfirmation(CONFIG, undefined), /Refusing to revoke/);
  assert.equal(assertWorkerConfirmation(CONFIG, "project-greenroom-api"), "project-greenroom-api");
});

test("refuses a config that declares no worker name", () => {
  assert.throws(
    () => assertWorkerConfirmation('main = "src/index.ts"\n', "anything"),
    /no worker name/,
  );
});

test("requires exactly one of --all and --user", () => {
  assert.throws(() => parseArguments(["--confirm", "w"]), /Name what to revoke/);
  assert.throws(() => parseArguments(["--confirm", "w", "--all", "--user", "abc"]), /not both/);
});

/**
 * The user id is interpolated into SQL, because `wrangler d1 execute` takes a command string and
 * not bound parameters. Refusing anything that is not a plain identifier is checkable; escaping
 * is the thing people get wrong.
 */
test("refuses a user id that is not a plain identifier", () => {
  for (const id of ["a'; DROP TABLE users; --", "a b", "", "x".repeat(65), "a`b"])
    assert.throws(
      () => parseArguments(["--confirm", "w", "--user", id]),
      /plain identifier/,
      `expected ${JSON.stringify(id)} to be refused`,
    );
  assert.deepEqual(
    parseArguments(["--confirm", "w", "--user", "seed-organizer"]).user,
    "seed-organizer",
  );
  assert.deepEqual(
    parseArguments(["--confirm", "w", "--user", "11111111-1111-4111-8111-111111111111"]).user,
    "11111111-1111-4111-8111-111111111111",
  );
});

test("refuses an argument it does not recognise rather than ignoring it", () => {
  assert.throws(() => parseArguments(["--confirm", "w", "--all", "--force"]), /Unrecognized/);
});

/**
 * The scoping predicate is the whole difference between ending one person's sessions and ending
 * everybody's, so it is asserted rather than assumed.
 *
 * Matched on the `WHERE` clause rather than the whole statement, deliberately: the context gate
 * reads `UPDATE <table>` and `INTO <table>` out of any file to find cross-domain table access,
 * and this file belongs to `platform` while the tables belong to `identity-access`. Naming them
 * here would be the same violation the statements were moved out of the tool to avoid.
 */
test("scopes a user revocation and leaves an --all sweep unscoped", () => {
  const scoped = revokeStatements({ all: false, user: "seed-organizer" }, 1000, "corr-1");
  assert.match(
    scoped[0],
    /WHERE revoked_at IS NULL AND expires_at > 1000 AND user_id = 'seed-organizer'/,
  );
  const all = revokeStatements({ all: true, user: undefined }, 1000, "corr-1");
  assert.match(all[0], /WHERE revoked_at IS NULL AND expires_at > 1000$/);
  assert.doesNotMatch(all[0], /user_id/);
});

/**
 * The revocation runs first and the audit row second, so a failed revocation leaves no record
 * claiming it happened. The row carries `system` as its source and the correlation id the command
 * prints, which is how the operator connects what they ran to what the table shows.
 */
test("writes an audit row after the revocation, never before it", () => {
  const [first, second] = revokeStatements({ all: true, user: undefined }, 1000, "corr-1", "row-1");
  assert.match(first, /^UPDATE /);
  assert.match(first, /SET revoked_at = 1000/);
  assert.match(second, /^INSERT /);
  // A sweep that revoked nothing records nothing, and the row's own key is not the correlation
  // id -- a run repeated with the same correlation id would otherwise collide on the PRIMARY KEY.
  assert.match(second, /WHERE changes\(\) > 0$/);
  assert.match(second, /'row-1'/);
  assert.match(second, /'session\.revoked_all', 'succeeded', 'system'/);
  assert.match(second, /'corr-1'/);
  // A user-scoped sweep names its subject; an --all sweep has none to name.
  assert.match(
    revokeStatements({ all: false, user: "seed-organizer" }, 1000, "corr-1", "row-1")[1],
    /'seed-organizer'/,
  );
});
