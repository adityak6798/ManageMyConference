export type ProposalStatus = "submitted" | "under_review" | "reviewed" | "withdrawn";

export interface SubmittedProposal {
  readonly id: string;
  readonly organizationId: string;
  readonly eventId: string;
  readonly title: string;
  readonly abstract: string;
  readonly submitterName: string;
  readonly status: ProposalStatus;
}

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
}

export type SubmittedProposalInterface = SubmittedProposalQuery & SubmittedProposalCommands;
