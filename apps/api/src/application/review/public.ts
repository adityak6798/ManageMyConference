/**
 * The review domain's public application interface.
 *
 * `ARC-FLOW-001` runs evaluation outcome -> acceptance command -> content and linked speaker.
 * The content domain never reads `cfp_submissions`; it asks this interface whether a proposal
 * carries a recorded acceptance decision and, if so, what it says.
 *
 * `ReviewService` implements `AcceptedProposalQuery`. Everything the content domain takes from
 * here is a type or an error, and it takes them with `import type`, so that import pulls none of
 * review's implementation with it; the transport layer keeps importing `review-service.ts`
 * directly for the service itself.
 *
 * The `reviewTemplateSlice` re-export at the foot of this file is a value export, and it closes a
 * real cycle: `public.ts` -> `template-slice.ts` -> `review-service.ts` -> `public.ts`, whose last
 * edge imports this module's error classes as values. It is harmless as those three modules
 * stand, because none of them touches a circular binding while it is being evaluated — every use
 * is inside a function that runs long afterwards. A top-level `extends`, constant or call reading
 * across the cycle would not be, so add one only after breaking the cycle.
 */

/** Everything the content domain needs to turn an accepted proposal into a session. */
export interface AcceptedProposal {
  readonly eventId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly abstract: string;
  readonly format: string;
  readonly formatId?: string;
  /** CFP-originating track, preserved into content on acceptance when configured. */
  readonly track?: string;
  readonly trackId?: string;
  readonly participants?: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: "co_speaker" | "moderator";
  }[];
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
export { reviewTemplateSlice } from "./template-slice";
