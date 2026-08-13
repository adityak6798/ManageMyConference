/**
 * The platform domain's public application interface.
 *
 * Declared even though nothing outside platform imports it today, following the precedent
 * recorded for `application/events/public.ts`: a domain's export surface exists so that a later
 * consumer has something to target instead of deep-importing a service, and declaring it while
 * it blocks nothing is cheaper than discovering the need mid-lane.
 *
 * What platform composes is other domains' reads, so the traffic points the other way: this
 * module exports the operational service the transport constructs, the ports its adapters
 * implement, and the vocabulary its answers are written in.
 *
 * @spec PRD-OPS-001 ARC-DOM-001
 */
export type {
  AuditPage,
  AuditRecord,
  AuditRecordInput,
  AuditRecorderDependencies,
  AuditRecordStore,
  AuditSource,
  PreparedAuditRecord,
  PreparedAuditWriter,
  RequestIdentity,
} from "./audit-service";
export {
  AUDIT_PAGE_LIMIT_MAX,
  AuditRecorder,
  createRequestIdentity,
  lifecycleAuditKey,
} from "./audit-service";
export type {
  InboxCategoryKey,
  InboxDismissal,
  InboxDismissalStore,
  InboxItem,
  InboxPriority,
  InboxSection,
  PlatformInboxAnswer,
  PlatformInboxDependencies,
} from "./inbox-service";
export {
  INBOX_CATEGORY_KEYS,
  InboxItemNotFoundError,
  PlatformInboxService,
} from "./inbox-service";
export type { PlatformOperationsDependencies } from "./operations-service";
export { PlatformOperationsService } from "./operations-service";
export type {
  PlatformSearchAnswer,
  SearchResult,
  SearchResultKind,
  SearchSection,
  SearchSectionKey,
} from "./search-service";
export {
  PlatformSearchService,
  SEARCH_QUERY_MIN_LENGTH,
  SEARCH_SECTION_KEYS,
  SearchQueryTooShortError,
} from "./search-service";
export { PlatformSourceUnavailableError } from "./section";
export type {
  AgendaSource,
  CommunicationsSource,
  ContentSource,
  CrmSource,
  EventOrganizationSource,
  PlatformSources,
  PublishingSource,
  ReviewSource,
} from "./sources";
