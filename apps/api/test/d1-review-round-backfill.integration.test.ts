// @acceptance ACC-REVIEW ACC-INTEGRATION
/*
 * Migration `1312`, run over review history that already exists.
 *
 * This is the risky part of issue #191 and it is the reason this file exists separately. Numbered
 * rounds are in the deployed database: assignments, evaluations, declared conflicts, aggregates,
 * decisions and AI suggestions all carry a round integer, and the obvious way to make rounds
 * first-class — a surrogate `review_rounds.id` with a foreign key on `review_assignments` —
 * cannot be reached without rebuilding that table and, with it, four children. `1301` is the
 * repository's own record of what that costs, and `1310` made the chain one link longer since.
 *
 * So `1312` alters nothing, copies nothing and drops nothing, and the way to prove that is to run
 * it against a database that is **already populated the way a deployment is** rather than against
 * the empty tables every migration meets in a fresh fixture. Every test below builds the schema
 * as it stood *before* `1312`, loads the deterministic seed into it minus the two tables that do
 * not exist yet, extends that history to three rounds, and only then applies the migration.
 */
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrationFile,
  applyMigrations,
  createMigratedDatabase,
  statements,
} from "./support/seeded-d1";

const EVENT = "00000000-0000-4000-8000-000000000001";
const OTHER_EVENT = "00000000-0000-4000-8000-000000000002";
const TYPED = "10000000-0000-4000-8000-000000000002";
const BACKFILL = "1312_review_plans.sql";

type Runnable = {
  prepare(query: string): {
    bind(...values: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results?: T[] }> };
    run(): Promise<unknown>;
    all<T>(): Promise<{ results?: T[] }>;
  };
};

/** A database at the schema `1312` will meet, holding the review history a deployment holds. */
async function preMigrationHistory() {
  /*
   * Every migration except `1312`.
   *
   * Two calls rather than one `through`, because stopping at `1311` would also withhold content,
   * crm, agenda, communications, publishing and platform — and then the seed cannot load at all,
   * which is how this was found. What this database is meant to be is the *review* schema as it
   * stood before rounds became first-class, with everything else current, which is exactly the
   * shape a deployment has the moment before it applies `1312`.
   */
  const migrated = await createMigratedDatabase({
    label: "review-round-backfill",
    through: "1311_review_decision_revision.sql",
  });
  await applyMigrations(migrated.database as never, { from: "1400_content_resources.sql" });
  const database = migrated.database as unknown as Runnable;
  /*
   * The real seed, minus the two tables that do not exist yet.
   *
   * Hand-writing a fixture would have meant hand-writing every column of `organizations`,
   * `events`, `users`, `cfp_submissions` and six review tables — and a hand-written fixture is
   * only ever as realistic as whoever wrote it remembered to be. The seed is the shape a
   * deployment actually holds, so it is used, with the statements that touch `review_rounds` and
   * `review_round_members` filtered out because `1312` is the migration that creates them and
   * this database has deliberately not applied it.
   */
  const sql = await readFile(new URL("../seed/reset.sql", import.meta.url), "utf8");
  for (const statement of statements(sql)) {
    // `statements` strips both comment forms, so this matches SQL rather than the prose beside it
    // — the seed's own comments name both tables while explaining the cleanup ordering.
    if (/\breview_rounds\b|\breview_round_members\b/.test(statement)) continue;
    try {
      await database.prepare(statement).run();
    } catch (error) {
      // A seed load that fails here reports a bare `FOREIGN KEY constraint failed` naming no
      // table, which is a long way from the statement that caused it.
      throw new Error(`seed statement failed: ${statement.slice(0, 200)}`, { cause: error });
    }
  }

  /*
   * Two more rounds of history than the seed carries, each chosen for a case the backfill has to
   * get right.
   *
   * A **declared conflict** joins round 1 — a child of `review_assignments` and therefore one of
   * the rows a rebuild-based design would have had to copy, and one the seed has no instance of.
   * It goes on the one assignment nobody has scored, because `review_conflict_rejects_completion`
   * refuses a conflict over a completed evaluation and that refusal is correct. Round 3 exists
   * **only** in
   * `review_outcomes` — no assignment mentions it — because the backfill unions all three
   * round-carrying tables rather than trusting `review_assignments` to name every round. Today it
   * would; a backfill that silently assumed so would drop a round the day it stopped being true,
   * and a dropped round is one whose work becomes unreachable.
   */
  await database
    .prepare(
      "INSERT INTO review_conflicts (assignment_id, reviewer_id, reason, declared_at) VALUES (?, ?, ?, ?)",
    )
    .bind(
      "20000000-0000-4000-8000-000000000001",
      "seed-reviewer",
      "Co-authored with the submitter",
      "2026-08-11T09:00:00.000Z",
    )
    .run();
  await database
    .prepare(
      "INSERT INTO review_outcomes (event_id, proposal_id, round, completed_evaluation_count, average_score, updated_at) VALUES (?, ?, 3, 1, 2.25, ?)",
    )
    .bind(EVENT, TYPED, "2026-08-12T09:00:00.000Z")
    .run();
  return { migrated, database };
}

/** Everything the migration must not touch, counted and fingerprinted in one read. */
const censusOf = async (database: Runnable) =>
  (
    await database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM review_assignments) AS assignments, (SELECT COUNT(*) FROM review_evaluations) AS evaluations, (SELECT COUNT(*) FROM review_conflicts) AS conflicts, (SELECT COUNT(*) FROM review_outcomes) AS outcomes, (SELECT COUNT(*) FROM review_suggestions) AS suggestions, (SELECT COUNT(*) FROM review_decisions) AS decisions, (SELECT SUM(average_score) FROM review_outcomes) AS scoreSum, (SELECT SUM(revision) FROM review_decisions) AS revisionSum",
      )
      .all<Record<string, number>>()
  ).results?.[0];

describe("first-class rounds over existing numbered history", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("loses no assignment, evaluation, conflict, outcome, decision or AI provenance", async () => {
    const { migrated, database } = await preMigrationHistory();
    runtime = migrated.runtime;

    const before = await censusOf(database);
    // The fixture is asserted to be populated rather than trusted to be: a backfill test over
    // empty tables proves that nothing happened to nothing.
    expect(before).toMatchObject({
      assignments: 4,
      evaluations: 3,
      conflicts: 1,
      outcomes: 4,
      suggestions: 1,
      decisions: 2,
    });

    await applyMigrationFile(migrated.database, BACKFILL);

    // Byte-for-byte the same census, including the summed aggregates and the decision revision —
    // the two values a copy that dropped or defaulted a column would move without changing a count.
    expect(await censusOf(database)).toEqual(before);

    // The written comment is the thing #221 is about, so it is read back rather than counted.
    const evaluation = (
      await database
        .prepare(
          "SELECT notes, scores_json, source FROM review_evaluations WHERE assignment_id = ?",
        )
        .bind("20000000-0000-4000-8000-0000000000a2")
        .all<{ notes: string; scores_json: string; source: string }>()
    ).results?.[0];
    expect(evaluation).toEqual({
      notes: "Clear argument, would attend.",
      scores_json:
        '[{"criterionId":"relevance","value":4,"score":4},{"criterionId":"format","value":"Talk"},{"criterionId":"feedback","value":"Well scoped, and the examples are concrete."}]',
      source: "manual",
    });

    // All four provenance columns, which is the shape `1310` chose specifically so that a
    // suggestion whose provenance cannot be read is impossible.
    const suggestion = (
      await database
        .prepare(
          "SELECT provenance_model, provenance_prompt_version, provenance_generated_at, provenance_proposal_revision, state, responded_by FROM review_suggestions WHERE id = ?",
        )
        .bind("20000000-0000-4000-8000-0000000000a1")
        .all<Record<string, string | null>>()
    ).results?.[0];
    expect(suggestion).toEqual({
      provenance_model: "fixture-suggester-v1",
      provenance_prompt_version: "review-suggestion/v1",
      provenance_generated_at: "2026-08-09T12:30:00.000Z",
      provenance_proposal_revision: "rev-f2833987",
      state: "offered",
      responded_by: null,
    });

    const violations = await database.prepare("PRAGMA foreign_key_check").all();
    expect(violations.results ?? []).toEqual([]);
  });

  it("describes every round the history mentions, including one only an aggregate names", async () => {
    const { migrated, database } = await preMigrationHistory();
    runtime = migrated.runtime;

    await applyMigrationFile(migrated.database, BACKFILL);

    const rounds = (
      await database
        .prepare(
          "SELECT sequence, name, state, anonymized, criteria_json, pool_mode, opens_at, closes_at FROM review_rounds WHERE event_id = ? ORDER BY sequence",
        )
        .bind(EVENT)
        .all<Record<string, unknown>>()
    ).results;
    /*
     * Three rounds, and round 3 is the load-bearing one: no assignment mentions it, only an
     * outcome does. The backfill unions all three round-carrying tables for exactly this case.
     *
     * The values are claims about how those rounds actually behaved, not defaults. Every round
     * below the highest is `closed`, because that is what advancing meant. All are `anonymized`,
     * because the reviewer projection masked the submitter unconditionally until this migration.
     * `criteria_json` is NULL — the event plan *is* the rubric they were judged under, and it is
     * locked by `review_plan_lock` once an assignment exists, so a snapshot could only drift.
     * `pool_mode` is `event`, because a restriction invented retroactively would refuse
     * assignments that used to succeed. And the window is NULL on both sides rather than derived
     * from `created_at`: nobody set one, and a window the product enforces must not be one this
     * migration made up.
     */
    expect(rounds).toEqual([
      {
        sequence: 1,
        name: "Round 1",
        state: "open",
        anonymized: 1,
        criteria_json: null,
        pool_mode: "event",
        opens_at: null,
        closes_at: null,
      },
      {
        sequence: 2,
        name: "Round 2",
        state: "open",
        anonymized: 1,
        criteria_json: null,
        pool_mode: "event",
        opens_at: null,
        closes_at: null,
      },
      {
        sequence: 3,
        name: "Round 3",
        state: "open",
        anonymized: 1,
        criteria_json: null,
        pool_mode: "event",
        opens_at: null,
        closes_at: null,
      },
    ]);

    // The pool records who actually reviewed in each round. Under `event` it restricts nothing,
    // which is the point — it is the list an organizer sees before choosing to restrict.
    const members = (
      await database
        .prepare(
          "SELECT round_sequence, reviewer_id FROM review_round_members WHERE event_id = ? ORDER BY round_sequence, reviewer_id",
        )
        .bind(EVENT)
        .all<{ round_sequence: number; reviewer_id: string }>()
    ).results;
    expect(members).toEqual([
      { round_sequence: 1, reviewer_id: "review-nina-alvarez" },
      { round_sequence: 1, reviewer_id: "seed-reviewer" },
      { round_sequence: 2, reviewer_id: "review-nina-alvarez" },
    ]);

    // An event with no review history gains no rounds. The backfill describes what happened; it
    // does not invent a first round for an event nobody has reviewed.
    const other = (
      await database
        .prepare("SELECT COUNT(*) AS total FROM review_rounds WHERE event_id = ?")
        .bind(OTHER_EVENT)
        .all<{ total: number }>()
    ).results?.[0];
    expect(other?.total).toBe(0);
  });

  it("keeps every backfilled round assignable, so nothing that worked before stops", async () => {
    const { migrated, database } = await preMigrationHistory();
    runtime = migrated.runtime;
    await applyMigrationFile(migrated.database, BACKFILL);

    /*
     * The compatibility claim, driven rather than described.
     *
     * `1312` installs three `BEFORE INSERT` guards on `review_assignments`, and the failure mode
     * that matters most is not one of them rejecting something it should — it is one of them
     * rejecting an assignment a deployed organizer could make yesterday. Round 3 is `open` and
     * `event`-pooled, so a reviewer who has never held work in it is still admissible.
     */
    await database
      .prepare(
        "INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES (?, ?, ?, ?, 3, ?)",
      )
      .bind(
        "30000000-0000-4000-8000-0000000000a1",
        EVENT,
        TYPED,
        "seed-reviewer",
        "2026-08-13T09:00:00.000Z",
      )
      .run();
    const landed = (
      await database
        .prepare("SELECT COUNT(*) AS total FROM review_assignments WHERE round = 3")
        .all<{ total: number }>()
    ).results?.[0];
    expect(landed?.total).toBe(1);

    /*
     * And the guards do refuse what they are for — but only once an organizer has actually closed
     * a round, which the backfill deliberately does not do for them.
     *
     * That is the "preserve immutable completed-round history" property, and it is worth being
     * precise about when it starts applying: closing is a decision, so `1312` leaves every
     * backfilled round `open` and this test closes one by hand before expecting the refusal.
     */
    await database
      .prepare("UPDATE review_rounds SET state = 'closed' WHERE event_id = ? AND sequence = 1")
      .bind(EVENT)
      .run();
    await expect(
      database
        .prepare(
          "INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        )
        .bind(
          "30000000-0000-4000-8000-0000000000a2",
          EVENT,
          TYPED,
          "seed-reviewer",
          "2026-08-13T09:00:00.000Z",
        )
        .run(),
    ).rejects.toThrow(/REVIEW_ROUND_NOT_OPEN/);
    // A round nobody configured is refused rather than silently created.
    await expect(
      database
        .prepare(
          "INSERT INTO review_assignments (id, event_id, proposal_id, reviewer_id, round, created_at) VALUES (?, ?, ?, ?, 9, ?)",
        )
        .bind(
          "30000000-0000-4000-8000-0000000000a3",
          EVENT,
          TYPED,
          "seed-reviewer",
          "2026-08-13T09:00:00.000Z",
        )
        .run(),
    ).rejects.toThrow(/REVIEW_ROUND_REQUIRED/);
  });

  it("is idempotent enough to be diagnosed: a second application is refused, not doubled", async () => {
    const { migrated, database } = await preMigrationHistory();
    runtime = migrated.runtime;
    await applyMigrationFile(migrated.database, BACKFILL);
    const before = (
      await database.prepare("SELECT COUNT(*) AS total FROM review_rounds").all<{ total: number }>()
    ).results?.[0];

    /*
     * Applied twice, which a migration runner will never do — and that is the point of asserting
     * what happens if one somehow does. The second application fails on `CREATE TABLE`, loudly,
     * rather than duplicating the backfill into rounds that already exist. A migration whose
     * re-run silently doubles its own data is far worse than one that refuses.
     */
    await expect(applyMigrationFile(migrated.database, BACKFILL)).rejects.toThrow();
    const after = (
      await database.prepare("SELECT COUNT(*) AS total FROM review_rounds").all<{ total: number }>()
    ).results?.[0];
    expect(after).toEqual(before);
  });
});
