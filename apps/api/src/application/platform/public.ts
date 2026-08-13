/**
 * The platform domain's public application interface.
 *
 * Declared even though nothing outside platform imports it today, following the precedent
 * recorded for `application/events/public.ts`: a domain's export surface exists so that a later
 * consumer has something to target instead of deep-importing a service, and declaring it while
 * it blocks nothing is cheaper than discovering the need mid-lane.
 *
 * What platform composes is other domains' reads, so the traffic points the other way: this
 * module exports the operational service the transport constructs and the vocabulary its
 * answers are written in.
 *
 * @spec PRD-OPS-001 ARC-DOM-001
 */
export type { PlatformOperationsDependencies } from "./operations-service";
export { PlatformOperationsService } from "./operations-service";
export type {
  AgendaSearchSource,
  CommunicationsSearchSource,
  ContentSearchSource,
  CrmSearchSource,
  EventOrganizationSource,
  PlatformSearchAnswer,
  PlatformSearchDependencies,
  ReviewSearchSource,
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
  SearchSourceUnavailableError,
} from "./search-service";
