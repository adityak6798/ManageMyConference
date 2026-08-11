/**
 * The review domain's public application interface.
 *
 * `ARC-FLOW-001` runs evaluation outcome -> acceptance command -> content and linked speaker.
 * The content domain never reads `cfp_submissions`; it asks this interface whether a proposal
 * carries a recorded acceptance decision and, if so, what it says.
 *
 * `ReviewService` implements `AcceptedProposalQuery`. This module deliberately holds only types
 * and errors so it can be imported from the content domain without a module cycle; the transport
 * layer keeps importing `review-service.ts` directly for the service itself.
 */

/** Everything the content domain needs to turn an accepted proposal into a session. */
export interface AcceptedProposal {
  readonly eventId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly abstract: string;
  readonly format: string;
  /** Always present: a proposal with no contact address is never resolvable as accepted. */
  readonly submitter: { readonly name: string; readonly email: string };
  readonly decidedAt: string;
}

/** No proposal with that id was submitted to that event. Callers must not distinguish the two. */
export class ProposalNotFoundError extends Error {}

/** The proposal exists but carries no `accepted` decision. */
export class ProposalNotAcceptedError extends Error {}

/**
 * The proposal is accepted but the published form collected no contact address, so no speaker
 * identity can be provisioned from it. A field-level input problem, never a server fault.
 */
export class ProposalSubmitterUnavailableError extends Error {}

export interface AcceptedProposalQuery {
  /**
   * Resolve an accepted proposal, or throw. Every failure is a typed 4xx: unknown or foreign
   * proposals raise `ProposalNotFoundError`, undecided or declined ones
   * `ProposalNotAcceptedError`, and identity-less ones `ProposalSubmitterUnavailableError`.
   */
  acceptedProposal(eventId: string, proposalId: string): Promise<AcceptedProposal>;
}
