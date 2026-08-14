import type {
  CfpField,
  CfpForm,
  CfpResolvedRoute,
  CfpSubmissionWindow,
  ProposalLifecycle,
  ProposalSubmission,
} from "../../domain/cfp/cfp";

/**
 * A write to one proposal an account owns.
 *
 * Every field of the identity is part of the WHERE clause rather than of the SET clause. That is
 * the isolation contract in storage: a write naming another account's proposal, another event's
 * proposal, or a revision somebody else has already advanced matches no row and reports `false`.
 * The service then re-reads to say which of those it was, because "you are not allowed" and "you
 * are looking at a stale copy" are different sentences to show a person.
 *
 * `at` is the instant the write is judged against. The window guard compares `cfp_forms.opens_at`
 * and `closes_at` to it as text, which is exactly why migration `1201` insists both columns hold
 * the canonical `toISOString()` shape.
 */
export interface ProposalOwnerWrite {
  readonly eventId: string;
  readonly proposalId: string;
  readonly submitterUserId: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly expectedRevision: number;
  readonly updatedAt: string;
  readonly at: string;
  /**
   * The form these answers were validated against, stored beside them.
   *
   * Answers and their form travel together on **every** write, not only on the submit. A revision
   * is validated against the form as published *now*, so writing the answers without the fields
   * leaves a row whose keys no longer match its snapshot — and every organizer and reviewer
   * projection reads answers by looking each stored field up in that snapshot. A renamed question
   * between submission and revision therefore emptied the proposal in triage, in every reviewer's
   * queue and on the submitter's own dashboard, and blanked the contact address the decision
   * notification is resolved from. `submitProposal` already carried both; this is the same
   * invariant on the sibling write (`GAP-025`'s lesson about siblings).
   */
  readonly cfpVersion: number;
  readonly fields: readonly CfpField[];
  /**
   * The lifecycle this write's snapshot was chosen for, asserted in the statement's own `WHERE`.
   *
   * A submitted proposal stores the form it was validated against; a draft stores none, so it is
   * named from the live form. Which of those is right is decided from a row read *before* the
   * write, and the caller supplies the expected revision — so without this predicate a revision
   * naming a number the row has not reached yet could land the draft branch on a row a concurrent
   * submit had already moved to `submitted`, blanking its snapshot and with it every organizer
   * and reviewer projection of that proposal. Naming the lifecycle makes the mismatch match no
   * row, which is a refusal the caller already knows how to explain.
   */
  readonly lifecycle: ProposalLifecycle;
}

/**
 * A `ProposalOwnerWrite` that also moves the proposal out of draft, so it records the decision.
 *
 * `lifecycle` is **omitted** rather than inherited. The other write chooses between two snapshots
 * from a row it read earlier, so it has to say which it assumed; this one has a single fixed
 * precondition — submitting is one-way, so the row must still be a draft — and that belongs in the
 * statement rather than in a value a caller supplies. Binding it here made a hard invariant into
 * an argument: a caller passing `submitted` would re-submit an already-submitted proposal, giving
 * it a new `submitted_at`, a re-resolved route and a second confirmation, and migration `1201`'s
 * no-regression trigger does not fire on `submitted` → `submitted`.
 */
export interface ProposalSubmitWrite extends Omit<ProposalOwnerWrite, "lifecycle"> {
  readonly resolvedRoute: CfpResolvedRoute | null;
  readonly status: string;
  readonly submittedAt: string;
}

/** A draft this account is creating, with the instant the open-window guard is judged against. */
export interface ProposalDraftCreate extends ProposalSubmission {
  readonly submitterUserId: string;
  readonly at: string;
}

export interface CfpRepository {
  findForm(eventId: string): Promise<CfpForm | null>;
  findPublished(eventId: string): Promise<CfpForm | null>;
  saveForm(form: CfpForm, expectedVersion: number): Promise<boolean>;
  savePublished(form: CfpForm, updateEditable: boolean, expectedVersion: number): Promise<boolean>;
  /**
   * Replace the scheduled window. Live state, so it takes effect without a republish and carries
   * no optimistic-concurrency token of its own — two organizers setting a deadline are choosing a
   * date, not editing a document, and last write wins is the honest answer for that.
   */
  saveWindow(eventId: string, window: CfpSubmissionWindow): Promise<boolean>;
  /**
   * An **anonymous, submitted** proposal by its idempotency key.
   *
   * Scoped to `submitter_user_id IS NULL` and to `lifecycle = 'submitted'`, and both halves are
   * load-bearing. `UNIQUE (event_id, idempotency_key)` is not owner-scoped and the key is supplied
   * by the caller, so an unscoped read is how an anonymous retry ends up answered with somebody
   * else's draft — a confirmation identifier for a proposal that was never submitted, belonging to
   * an account the caller has no relationship with. Two reviewers reproduced exactly that.
   */
  findAnonymousSubmission(
    eventId: string,
    idempotencyKey: string,
  ): Promise<ProposalSubmission | null>;
  /** A proposal **this account** owns, by its idempotency key. Any lifecycle. */
  findOwnedProposalByKey(
    eventId: string,
    idempotencyKey: string,
    submitterUserId: string,
  ): Promise<ProposalSubmission | null>;
  /** A **submitted** proposal by id. A draft is not one, and is invisible here. */
  findSubmissionById(eventId: string, proposalId: string): Promise<ProposalSubmission | null>;
  createSubmission(submission: ProposalSubmission): Promise<ProposalSubmission | null>;
  /** One proposal of any lifecycle, scoped to the account that owns it. */
  findProposalForOwner(
    eventId: string,
    proposalId: string,
    submitterUserId: string,
  ): Promise<ProposalSubmission | null>;
  /** Every proposal this account owns for this event, drafts included, oldest first. */
  listProposalsForOwner(
    eventId: string,
    submitterUserId: string,
  ): Promise<readonly ProposalSubmission[]>;
  createDraft(draft: ProposalDraftCreate): Promise<ProposalSubmission | null>;
  saveProposalAnswers(write: ProposalOwnerWrite): Promise<boolean>;
  submitProposal(write: ProposalSubmitWrite): Promise<boolean>;
}
