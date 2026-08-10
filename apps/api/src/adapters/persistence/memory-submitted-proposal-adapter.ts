import type {
  ProposalStatusAudit,
  SubmittedProposal,
  SubmittedProposalInterface,
} from "../../application/cfp/submitted-proposal-interface";

export class MemorySubmittedProposalAdapter implements SubmittedProposalInterface {
  private proposals = new Map<string, SubmittedProposal>();
  private audit: ProposalStatusAudit[] = [];
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
  async transitionAtomically(
    input: Parameters<SubmittedProposalInterface["transitionAtomically"]>[0],
  ) {
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
