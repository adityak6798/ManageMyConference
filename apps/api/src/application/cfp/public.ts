export interface SubmittedProposalReference {
  readonly proposalId: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly submittedAt: string;
}

/**
 * One call whose deadline is near enough — either side — to be worth a message (issue #210).
 *
 * `draftHolders` is the accounts holding at least one **unsubmitted** proposal on this call, by
 * account id and never by address: whoever sends the reminder resolves the address through
 * identity, so a form answer cannot become a recipient here. A guest submission has no account
 * and therefore no entry, which is the same boundary `#132` draws everywhere else.
 */
export interface CfpDeadlineNotice {
  readonly eventId: string;
  readonly closesAt: string;
  readonly draftHolders: readonly { readonly userId: string; readonly draftCount: number }[];
}

/**
 * How communications asks this domain which calls are about to close, or have.
 *
 * The sibling of `CommunicationsContentQuery`, declared here for the same reason: `cfp_forms` and
 * `cfp_submissions` are this domain's tables (`table-ownership.json`), and communications sends
 * the message. The scheduled reminder crosses the boundary as this call and never as a join.
 */
export interface CommunicationsCfpQuery {
  /**
   * Published calls whose `closes_at` falls in `[from, to)`, with their draft holders.
   *
   * The window spans the deadline in both directions on purpose — the caller sends a reminder to
   * draft holders before it and a closing notice to organizers after it — so one read answers
   * both, and a call with neither audience is simply a row with no work in it.
   *
   * Only **published** calls: an unpublished one has no applicants and no deadline anybody has
   * seen, so a message about it would be the product announcing something nobody was told.
   */
  listDeadlineNotices(
    window: { readonly from: string; readonly to: string },
    limit: number,
  ): Promise<readonly CfpDeadlineNotice[]>;
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
  CfpProposalStateConflictError,
  CfpService,
  CfpStateError,
  CfpUnavailableError,
  CfpValidationError,
} from "./cfp-service";
export { cfpTemplateSlice } from "./template-slice";
