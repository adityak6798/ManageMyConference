// @spec PRD-IAM-001 ENG-DEV-001
/**
 * How the demo restore asks this domain whether its tables hold anyone the seed did not create.
 *
 * The sibling of `events-fixture-statements.mjs`, and here for the same reason
 * `identity-revocation-statements.mjs` is: `users` belongs to `identity-access`
 * (`table-ownership.json`), and `tools/remote-demo-reset.mjs` belongs to `platform`, so the tool
 * asks this domain for the statement instead of writing SQL against its table.
 *
 * Only `users`. The rest of this domain's tables — sessions, attempts, audit events, provider
 * accounts — are also emptied by `seed/reset.sql`, and every one of them is state *about* a
 * sign-in rather than a person: re-signing in re-creates them. A `users` row that the fixture did
 * not insert is somebody who signed up, which is what `GAP-019` is about.
 */

/** This domain's tables whose rows a demo restore would delete, in the order it reports them. */
export const IDENTITY_FIXTURE_TABLES = Object.freeze(["users"]);

/**
 * Rows a migration plants in this domain's guarded tables: none.
 *
 * Declared rather than omitted, so the answer is this domain's own and a future migration that
 * inserts a `users` row has an obvious place to say so. `events` has one — see
 * `EVENTS_MIGRATION_PLANTED_IDS` for what such a row costs a guard that does not know about it.
 */
export const IDENTITY_MIGRATION_PLANTED_IDS = Object.freeze({ users: Object.freeze([]) });

/**
 * One scalar subquery, counting the users the fixture's own identifiers do not name.
 *
 * `idList` is already-quoted SQL, supplied by the caller from the seed file it parsed; the caller
 * is responsible for having refused anything that is not a plain identifier, because
 * `wrangler d1 execute` takes a command string rather than bound parameters.
 */
export function unseededIdentityCountExpressions(idLists) {
  return [`(SELECT COUNT(*) FROM users WHERE id NOT IN (${idLists.users})) AS users`];
}
