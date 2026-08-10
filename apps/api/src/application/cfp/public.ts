export interface SubmittedProposalReference {
  readonly proposalId: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly submittedAt: string;
}
export { CfpService, CfpUnavailableError, CfpValidationError } from "./cfp-service";
