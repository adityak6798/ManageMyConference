import {
  ProposalStatusConfigurationError,
  type ProposalStatusAudit,
  type SubmittedProposal,
  type SubmittedProposalInterface,
} from "../../application/cfp/submitted-proposal-interface";

export class MemorySubmittedProposalAdapter implements SubmittedProposalInterface {
  private proposals = new Map<string, SubmittedProposal>();
  private audit: ProposalStatusAudit[] = [];
  private statuses = new Map<
    string,
    readonly { key: string; label: string; sortOrder: number }[]
  >();
  constructor(seed: readonly SubmittedProposal[] = []) {
    for (const proposal of seed) this.proposals.set(proposal.id, proposal);
  }
  async list(eventId: string, status?: SubmittedProposal["status"]) {
    return [...this.proposals.values()].filter(
      (proposal) => proposal.eventId === eventId && (!status || proposal.status === status),
    );
  }
  async find(eventId: string, proposalId: string) {
    const proposal = this.proposals.get(proposalId);
    return proposal?.eventId === eventId ? proposal : null;
  }
  async listStatuses(eventId: string) {
    return (
      this.statuses.get(eventId) ?? [
        { key: "submitted", label: "Submitted", sortOrder: 0 },
        { key: "under_review", label: "Under review", sortOrder: 1 },
        { key: "reviewed", label: "Reviewed", sortOrder: 2 },
        { key: "withdrawn", label: "Withdrawn", sortOrder: 3 },
      ]
    );
  }
  async saveStatuses(
    eventId: string,
    statuses: readonly { key: string; label: string; sortOrder: number }[],
  ) {
    this.statuses.set(eventId, statuses);
  }
  async transitionAtomically(
    input: Parameters<SubmittedProposalInterface["transitionAtomically"]>[0],
  ) {
    if (!(await this.listStatuses(input.eventId)).some(({ key }) => key === input.toStatus))
      throw new ProposalStatusConfigurationError("Choose a configured proposal status");
    const proposals = input.proposalIds.map((id) => this.proposals.get(id));
    if (proposals.some((proposal) => !proposal || proposal.eventId !== input.eventId))
      throw new Error("Atomic proposal transition failed");
    return (proposals as SubmittedProposal[]).map((proposal, index) => {
      const updated = { ...proposal, status: input.toStatus };
      this.proposals.set(proposal.id, updated);
      this.audit.push({
        id: input.auditIds[index] as string,
        eventId: input.eventId,
        proposalId: proposal.id,
        fromStatus: proposal.status,
        toStatus: input.toStatus,
        actorId: input.actorId,
        occurredAt: input.occurredAt,
      });
      return updated;
    });
  }
  async listAudit(eventId: string) {
    return this.audit.filter((entry) => entry.eventId === eventId);
  }
}
