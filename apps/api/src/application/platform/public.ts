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
  RequestIdentityDependencies,
  RequestIdentityScope,
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
/**
 * The capability-URL convention (issue #196), which every anonymous share link in this product
 * addresses a resource through — and which issue #189's `GAP-028` residual is meant to consume
 * rather than reinvent. `DEBT-012` states what a capability URL costs; this is what pays it.
 */
export type {
  CapabilityLink,
  CapabilityLinkKind,
  CapabilityLinkStore,
} from "./capability-link";
export {
  CAPABILITY_LINK_KINDS,
  CapabilityLinkUnavailableError,
  hashCapabilityToken,
  MAX_CAPABILITY_LINK_HOURS,
  mintCapabilityToken,
  spendCapabilityLink,
} from "./capability-link";
/**
 * Reporting (issue #196): the catalogue a report may be written against, the pure engine that
 * answers one, and the service that saves, shares and schedules them.
 */
export type {
  ReportDataset,
  ReportDatasetKey,
  ReportField,
  ReportFilter,
  ReportQuery,
  ReportResult,
  ReportRow,
} from "./report-catalogue";
export {
  MAX_REPORT_SCAN,
  maskValue,
  REPORT_CATALOGUE,
  REPORT_DATASETS,
  REPORT_OPERATORS,
  ReportQueryInvalidError,
  ReportTooExpensiveError,
  runQuery,
  validateQuery,
} from "./report-catalogue";
export { readReportRows } from "./report-rows";
export type {
  ReportDefinition,
  ReportDeliveryPort,
  ReportingDependencies,
  ReportRepository,
  ReportRun,
  ReportSchedule,
  ReportShare,
} from "./reporting-service";
export {
  isKnownTimezone,
  occurrenceKey,
  ReportConflictError,
  ReportingService,
  ReportInvalidError,
  ReportNameTakenError,
  ReportNotFoundError,
  ReportPiiDeniedError,
  ReportShareUnavailableError,
} from "./reporting-service";
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
