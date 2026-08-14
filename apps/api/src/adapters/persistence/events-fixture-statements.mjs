// @spec PRD-EVT-001 ENG-DEV-001
/**
 * How the demo restore asks this domain whether its tables hold anything the seed did not create.
 *
 * `tools/remote-demo-reset.mjs` is the operator's command and belongs to `platform`. These
 * statements name `organizations` and `events`, which belong to `events`
 * (`table-ownership.json`), so they live here for the same reason
 * `identity-revocation-statements.mjs` exists: the tool asks each domain for its statements
 * rather than writing SQL against tables it does not own.
 *
 * Plain `.mjs` rather than TypeScript, and that is why it is not beside the D1 adapters it
 * resembles: the tool that runs it runs in Node, outside the Worker, with no build step.
 *
 * There is no bound-parameter form, because `wrangler d1 execute` takes a command string. The
 * caller is responsible for having refused any identifier that is not a plain one — the tool does
 * that with a pattern, and its test covers the attempts — because refusing is checkable and
 * escaping is what people get wrong.
 *
 * `GAP-019` is why this exists at all: `seed/reset.sql` deletes every row of these two tables
 * before reinserting the fixture, which is right for a database holding only seed data and
 * destroys a real workspace on any other.
 */

/** This domain's tables whose rows a demo restore would delete, in the order it reports them. */
export const EVENTS_FIXTURE_TABLES = Object.freeze(["organizations", "events"]);

/**
 * Rows a **migration** plants, which the seed does not re-insert and a guard must not mistake for
 * somebody's data.
 *
 * `0002_identity_event_foundation.sql` gives the pre-organization events a home by inserting
 * `Imported organization` and re-parenting every existing row onto it. `seed/reset.sql` deletes
 * every organization and inserts only its own two, so on a database that has been migrated and
 * never seeded this row exists and is named nowhere else.
 *
 * Without this list the demo restore refuses the **first** run against a freshly provisioned
 * database, tells the operator that a workspace somebody signed up for is present, and offers
 * `--destroy-real-data` as the remedy — teaching exactly the habit that flag exists to prevent.
 * A row a migration wrote is schema, not data, and the restore is right to remove it.
 */
export const EVENTS_MIGRATION_PLANTED_IDS = Object.freeze({
  organizations: Object.freeze(["00000000-0000-4000-8000-000000000000"]),
  events: Object.freeze([]),
});

/**
 * One scalar subquery per table, counting the rows that are somebody's work rather than the demo's.
 *
 * `idLists` is already-quoted SQL, supplied by the caller from the seed file it parsed. The column
 * alias is the table name, so the caller can report a count per table without learning the query.
 *
 * **An organization is real if the seed did not create it**, full stop: nothing but self-serve
 * signup writes one, so there is no demo path that produces a row here.
 *
 * **An event is real only if it is also outside every seeded organization**, and that second
 * condition is the whole of this refinement. A demo visitor holds `events:create` on the seeded
 * organization through the organizer persona's membership, so "create an event" is an ordinary
 * thing to click in the demo — and the resulting row is demo state that the next reset is meant to
 * clear, not a workspace somebody built. Counting it made the restore refuse over the demo having
 * been *used*, which pushes an operator toward `--destroy-real-data` for a teardown that destroys
 * nothing real. That habit is what the flag exists to prevent, so the false positive is worth
 * removing rather than tolerating.
 */
export function unseededEventsCountExpressions(idLists) {
  return [
    `(SELECT COUNT(*) FROM organizations WHERE id NOT IN (${idLists.organizations})) AS organizations`,
    `(SELECT COUNT(*) FROM events WHERE id NOT IN (${idLists.events}) AND organization_id NOT IN (${idLists.organizations})) AS events`,
  ];
}
