import type {
  CfpField,
  CfpForm,
  CfpResolvedRoute,
  CfpSubmissionWindow,
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
}

/** A `ProposalOwnerWrite` that also moves the proposal out of draft, so it needs the form it met. */
export interface ProposalSubmitWrite extends ProposalOwnerWrite {
  readonly cfpVersion: number;
  readonly fields: readonly CfpField[];
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
  findSubmission(eventId: string, idempotencyKey: string): Promise<ProposalSubmission | null>;
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
