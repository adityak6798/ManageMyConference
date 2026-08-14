import type { ReviewCriterion } from "./review";

/**
 * Where a round is in its life.
 *
 * - `draft`: configured but not yet taking work. Assignments are refused.
 * - `open`: taking work. The only state in which an assignment can be created or an evaluation
 *   saved.
 * - `closed`: view-only, permanent history. Its scorecard, dates, anonymization policy and pool
 *   are frozen by storage (`review_round_closed_terms_locked`), because an aggregate computed
 *   under one rubric must not be re-explained by another, and a blind round must not become an
 *   open one after the fact and retroactively expose authors to reviewers who scored them blind.
 *
 * Reopening a closed round is allowed — an organizer who closed one early has to be able to undo
 * that — and it is the *terms* rather than the state that storage freezes.
 */
export type ReviewRoundState = "draft" | "open" | "closed";

/**
 * Who may be given work in a round.
 *
 * - `event`: any reviewer staffed on the event. What every round did before rounds existed, and
 *   therefore what migration `1312` backfills, because a restriction invented retroactively would
 *   refuse assignments that used to succeed.
 * - `named`: only the reviewers in this round's pool. The default for a round an organizer
 *   creates, and what makes "a reviewer in round 1 is absent from round 2 until explicitly added"
 *   true: the pool is keyed on the round, so there is nothing to inherit.
 */
export type ReviewRoundPoolMode = "event" | "named";

/**
 * A named, date-bounded review round with its own scorecard, anonymization policy and pool.
 *
 * Identified by `(eventId, sequence)`, where `sequence` is exactly the integer that
 * `review_assignments.round`, `review_outcomes.round` and `review_suggestions.round` have carried
 * since migration `1300`. That is deliberate and it is the whole reason this could ship over a
 * deployed database without rebuilding a table: the round history was already keyed on a number,
 * so rounds became first-class by describing that number rather than by re-keying everything that
 * points at it. See `1312_review_plans.sql`.
 *
 * @spec PRD-REV-001 PRD-ABS-001
 */
export type ReviewRound = {
  readonly eventId: string;
  readonly sequence: number;
  readonly name: string;
  /** NULL is unbounded on that side. A round with no window is governed by `state` alone. */
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly state: ReviewRoundState;
  /**
   * Whether reviewers in this round see the author.
   *
   * A correctness property rather than a display preference: it decides which projection
   * `reviewerQueue` builds, so a blind round and an open one send genuinely different bytes for
   * the same abstract. It is the *only* consumer, and saying so is the point — the export and the
   * audit timeline do not read it and do not need to, because both are `review:manage` surfaces
   * where the author is visible in every round. An earlier version of this sentence claimed all
   * three read it, which a later reader could take as a guarantee that the export is
   * anonymization-aware. It is not, and it does not have to be.
   *
   * The AI suggestion port deliberately ignores it too: its input is identity-free in every round,
   * blind or open, because "the provider never receives an author" is a stronger promise than
   * "the provider receives what this round's reviewers receive" and there is no reason to weaken
   * it.
   */
  readonly anonymized: boolean;
  /**
   * This round's own scorecard, or `null` to score against the event's `review_plans` row.
   *
   * A round created without an override keeps scoring against the event plan, which is what every
   * round did before this type existed. An override is a copy at the moment it is taken: the event
   * plan can go on changing (until it locks) without restating what a round already judged under.
   */
  readonly criteria: readonly ReviewCriterion[] | null;
  readonly poolMode: ReviewRoundPoolMode;
  /** The pool, as stored. Under `event` it records who is there rather than restricting who may be. */
  readonly reviewerIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** The rubric a round is actually scored against. */
export const roundCriteria = (
  round: Pick<ReviewRound, "criteria"> | null,
  planCriteria: readonly ReviewCriterion[] | undefined,
): readonly ReviewCriterion[] => round?.criteria ?? planCriteria ?? [];

/**
 * Why this round cannot take work right now, or `null` if it can.
 *
 * One function, several callers — assignment, distribution, round advancement, evaluation saves
 * and suggestion drafting all ask the same question — because "this round is accepting work" has
 * to mean exactly the same thing on every path. A round that refuses an assignment but accepts an
 * evaluation is a round whose window means nothing.
 *
 * The clock is passed in rather than read here: this is a domain rule, and a domain rule that
 * reads the wall clock cannot be tested at a boundary.
 */
export const roundClosedReason = (round: ReviewRound, now: Date): string | null => {
  if (round.state === "draft")
    return `“${round.name}” is still a draft. Open it before assigning or scoring work in it.`;
  if (round.state === "closed")
    return `“${round.name}” is closed. Its assignments, evaluations and results stay readable, but no new work can be recorded in it.`;
  const instant = now.toISOString();
  if (round.opensAt && instant < round.opensAt)
    return `“${round.name}” does not open until ${round.opensAt}.`;
  if (round.closesAt && instant >= round.closesAt)
    return `“${round.name}” closed at ${round.closesAt}.`;
  return null;
};

/** Whether this reviewer is allowed to hold work in this round. */
export const roundAdmits = (round: ReviewRound, reviewerId: string): boolean =>
  round.poolMode === "event" || round.reviewerIds.includes(reviewerId);
