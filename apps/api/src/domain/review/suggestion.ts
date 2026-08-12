/**
 * An AI-drafted review suggestion, and the provenance that makes it readable as one.
 *
 * The single rule this file exists to encode: **a suggestion is never a score.** It lives in its
 * own table, nothing that computes an aggregate reads it, and the only way its numbers reach
 * `review_outcomes` is a reviewer pressing accept and then completing their own evaluation. Two
 * human actions, both attributed, neither of which this type can perform on its own.
 *
 * That is `PRD-AI-001` stated as a data model rather than as a paragraph: if the suggestion had
 * been a nullable column on `review_evaluations`, "AI may draft but never silently changes
 * canonical state" would be a convention that one careless `UPDATE` breaks. Here it is a
 * different table with no path into the aggregate.
 *
 * @spec PRD-AI-001 PRD-REV-001 PORT-AI
 */

/**
 * Where a suggestion came from, recorded on the row rather than derived at read time.
 *
 * All four fields are required, and that is deliberate: a stored suggestion whose provenance
 * cannot be read is worse than no suggestion, because a reviewer looking at a draft score has no
 * way to weigh it. The provider is asked for the model it actually served; nothing here is
 * defaulted from configuration, so a suggestion drafted by yesterday's model still says so after
 * the binding changes.
 */
export type SuggestionProvenance = {
  /** The model that produced it, as the provider named it — never the model we asked for. */
  readonly model: string;
  /** The prompt this repository sent, versioned so a wording change is visible in the record. */
  readonly promptVersion: string;
  /** When the provider answered. */
  readonly generatedAt: string;
  /**
   * A digest of the proposal text the suggestion was drafted against.
   *
   * A proposal can be edited after a suggestion is drafted, and a draft score about a paragraph
   * that no longer exists is misleading in a way no timestamp reveals. Recomputing the digest at
   * read time and comparing is what lets the reviewer's surface say "this was drafted against an
   * earlier version of the abstract" instead of quietly presenting it as current.
   */
  readonly proposalRevision: string;
};

/** One criterion's drafted value, with the model's reason for it. */
export type SuggestedScore = {
  readonly criterionId: string;
  readonly value: number | string;
  /** Why the model chose that value. Shown beside it; never stored on the reviewer's own score. */
  readonly rationale: string;
};

/**
 * What a reviewer did with a suggestion.
 *
 * `offered` is the only state the provider can produce. Both others require a reviewer action and
 * carry who took it, which is enforced in storage (`1310`) rather than only here.
 */
export type SuggestionState = "offered" | "accepted" | "rejected";

/**
 * A suggestion offered to one reviewer for one assignment.
 *
 * Scoped to `(assignmentId, reviewerId)` rather than to the proposal, because blind review means
 * the suggestion is drafted from the *masked* projection: two reviewers of the same abstract are
 * each offered their own, and neither sees the other's. `round` rides along because an abstract
 * reviewed again in round 2 is a different judgement from the same abstract in round 1, and a
 * suggestion that silently spanned both would attach round 1's reasoning to round 2's score.
 */
export type ReviewSuggestion = {
  readonly id: string;
  readonly eventId: string;
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly proposalId: string;
  readonly round: number;
  /** A short prose summary of the abstract. Never becomes the reviewer's notes on its own. */
  readonly summary: string;
  readonly scores: readonly SuggestedScore[];
  readonly state: SuggestionState;
  readonly provenance: SuggestionProvenance;
  /** The reviewer who accepted or rejected it. Null exactly while the state is `offered`. */
  readonly respondedBy: string | null;
  readonly respondedAt: string | null;
  readonly createdAt: string;
};

/**
 * How a reviewer's own evaluation came to hold the values it holds.
 *
 * `manual` is every evaluation written by hand and every one that existed before this feature —
 * migration `1310` backfills it, so the column has no null and no "unknown" to interpret.
 * `suggested` means the reviewer accepted a suggestion into this record; the suggestion's id is
 * stored beside it and storage refuses the combination without one.
 *
 * The distinction is the acceptance criterion "accepting produces the reviewer's own record and
 * is distinguishable from a hand-written one". It is *not* a claim about the current values: a
 * reviewer who accepts and then edits every number still has `suggested` on the row, because what
 * the field records is where the draft started, which is the honest thing to be able to say.
 */
export type EvaluationSource = "manual" | "suggested";

/**
 * A digest of the proposal text a suggestion was drafted against.
 *
 * Deliberately not a cryptographic hash: this detects an edit, it does not defend against one.
 * FNV-1a over the fields a reviewer actually reads, so it is stable across runs and processes —
 * which is what makes the deterministic fake deterministic — and cheap enough to recompute on
 * every queue read.
 */
export function proposalRevisionOf(parts: {
  readonly title: string;
  readonly abstract: string;
  readonly answers: readonly { readonly fieldId: string; readonly value: string }[];
}): string {
  const text = [
    parts.title,
    parts.abstract,
    ...[...parts.answers]
      .sort((left, right) => left.fieldId.localeCompare(right.fieldId))
      .map(({ fieldId, value }) => `${fieldId}=${value}`),
  ].join("");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `rev-${hash.toString(16).padStart(8, "0")}`;
}
