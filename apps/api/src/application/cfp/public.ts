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
/**
 * The submitter authorization guard, exported so the transport can run it *before* it parses a
 * body. The service calls it too — this is not a substitute for that, and the routes below it do
 * not rely on it having run.
 */
export { submitterFor } from "./cfp-service";
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
