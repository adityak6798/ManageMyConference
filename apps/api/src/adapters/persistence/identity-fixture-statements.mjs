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
 * One scalar subquery, counting the users who are people rather than demo state.
 *
 * `idLists` is already-quoted SQL, supplied by the caller from the seed file it parsed; the caller
 * is responsible for having refused anything that is not a plain identifier, because
 * `wrangler d1 execute` takes a command string rather than bound parameters.
 *
 * **"Not seeded" is not the same as "signed up", and assuming it was made the guard cry wolf.**
 * Demo usage writes `users` rows: accepting a proposal converts a speaker, and `provisionSpeaker`
 * inserts one with no provider account and no membership. The first live reading of the deployed
 * database returned three non-seeded users where one person had signed up — the other two were
 * speakers converted against the *seeded* event, which a reset is supposed to clear.
 *
 * So a row counts when something attaches it to a person rather than to the fixture:
 *
 *   - a **provider account**, which only a completed sign-in writes;
 *   - an **organization membership**, which only signup or an accepted invitation writes;
 *   - an **event role on an event the seed did not create**, which means they hold work in
 *     somebody's own workspace rather than in the demo's.
 *
 * A speaker whose only role is on a seeded event matches none of them and is regenerable by using
 * the demo again, which is the definition this guard is supposed to hold to. If that same person
 * later signs in, the provider account appears and they start counting — the rule follows the
 * evidence rather than a snapshot of it.
 *
 * Every table named here belongs to identity-access. The seeded **event** ids arrive as values to
 * compare against, so this still reads none of the events domain's tables.
 */
export function unseededIdentityCountExpressions(idLists) {
  return [
    `(SELECT COUNT(*) FROM users u WHERE u.id NOT IN (${idLists.users}) AND (` +
      "EXISTS (SELECT 1 FROM identity_provider_accounts a WHERE a.user_id = u.id) OR " +
      "EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = u.id) OR " +
      `EXISTS (SELECT 1 FROM event_roles r WHERE r.user_id = u.id AND r.event_id NOT IN (${idLists.events}))` +
      ")) AS users",
  ];
}
