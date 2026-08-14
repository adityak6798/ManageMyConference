export interface SubmittedProposalReference {
  readonly proposalId: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly submittedAt: string;
}
export type {
  CfpNotificationPort,
  SubmitterProposalState,
  SubmitterProposalView,
} from "./cfp-service";
export {
  CfpClosedError,
  CfpRoutingConfigurationError,
  CfpDraftConflictError,
  CfpProposalNotFoundError,
  CfpService,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "./cfp-service";
export { cfpTemplateSlice } from "./template-slice";
