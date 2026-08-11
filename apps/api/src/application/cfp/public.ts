export interface SubmittedProposalReference {
  readonly proposalId: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly submittedAt: string;
}
export { CfpService, CfpStateError, CfpUnavailableError, CfpValidationError } from "./cfp-service";
