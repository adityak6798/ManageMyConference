export interface SubmittedProposalReference {
  readonly proposalId: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly submittedAt: string;
}
export {
  CfpRoutingConfigurationError,
  CfpDraftConflictError,
  CfpService,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "./cfp-service";
