export type ProposalStatus = string;
export class ProposalStatusConfigurationError extends Error {}
export interface ProposalStatusDefinition {
  readonly key: string;
  readonly label: string;
  readonly sortOrder: number;
}

/**
 * The person who submitted a proposal, derived from the answers the published form collected.
 *
 * Contact details are organizer-only: the reviewer projection replaces this with `null` and
 * `submitterName` with a mask (see `ReviewService.reviewerQueue`). It is `null` when the
 * published form asked for no email-typed field, which is also the reason a proposal cannot be
 * turned into program content — there is no identity to provision a speaker from.
 */
export interface ProposalSubmitter {
  readonly name: string;
  readonly email: string;
}

export interface SubmittedProposal {
  readonly id: string;
  readonly eventId: string;
  readonly title: string;
  readonly abstract: string;
  /**
   * The proposal's CFP-originating programme track.
   *
   * `track` is a reserved published CFP select-field id. It is optional for proposals captured
   * before that convention existed and is not inferred from arbitrary prose. Review uses this
   * immutable submitted value for bulk selection; content carries it forward on acceptance.
   */
  readonly track?: string;
  readonly trackId?: string | null;
  readonly formatId?: string | null;
  readonly formatLabel?: string | null;
  readonly participants?: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: "co_speaker" | "moderator";
    readonly state: "pending" | "accepted" | "declined";
  }[];
  /** Display name only. Reviewer projections replace it with a mask. */
  readonly submitterName: string;
  /** Organizer-only contact details, or `null` when the form collected no email. */
  readonly submitter: ProposalSubmitter | null;
  /**
   * The account that owns this proposal, or `null` for a guest submission.
   *
   * It is here so that a message *about* a decision can be addressed to the person who proved
   * control of a mailbox rather than to whatever `submitter.email` a form collected — the
   * unverified-recipient exposure issue #132 describes. It is an identity reference and never a
   * contact detail, so the reviewer projection drops it with the rest of the submitter.
   */
  readonly submitterUserId: string | null;
  /** Never contains an `email`-typed answer; those surface only through `submitter`. */
  readonly answers: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly type: "short_text" | "long_text" | "select";
    readonly value: string;
  }[];
  readonly status: ProposalStatus;
}

/** The name shown wherever the submitter must stay anonymous. */
export const MASKED_SUBMITTER_NAME = "Applicant";

export interface ProposalStatusAudit {
  readonly id: string;
  readonly eventId: string;
  readonly proposalId: string;
  readonly fromStatus: ProposalStatus;
  readonly toStatus: ProposalStatus;
  readonly actorId: string;
  readonly occurredAt: string;
}

export interface SubmittedProposalQuery {
  list(eventId: string, status?: ProposalStatus): Promise<readonly SubmittedProposal[]>;
  find(eventId: string, proposalId: string): Promise<SubmittedProposal | null>;
  findMany(eventId: string, proposalIds: readonly string[]): Promise<readonly SubmittedProposal[]>;
  listStatuses(eventId: string): Promise<readonly ProposalStatusDefinition[]>;
}

export interface SubmittedProposalCommands {
  transitionAtomically(input: {
    eventId: string;
    proposalIds: readonly string[];
    toStatus: ProposalStatus;
    actorId: string;
    occurredAt: string;
    auditIds: readonly string[];
  }): Promise<readonly SubmittedProposal[]>;
  listAudit(eventId: string): Promise<readonly ProposalStatusAudit[]>;
  saveStatuses(eventId: string, statuses: readonly ProposalStatusDefinition[]): Promise<void>;
}

export type SubmittedProposalInterface = SubmittedProposalQuery & SubmittedProposalCommands;
