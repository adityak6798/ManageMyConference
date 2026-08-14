/**
 * Publishing's public application interface.
 *
 * Callers outside the publishing domain — the HTTP transport, other domains — use this
 * module rather than reaching into the service or the projection types directly.
 */

export type { AttendeeItinerary } from "../../domain/publishing/itinerary";
export type {
  ProjectionRefresh,
  PublicationSettings,
  PublicationProvenance,
  PublicEventProjection,
  PublicScheduleProjection,
  PublicScheduleSession,
} from "../../domain/publishing/publication";
export { composePublicSchedule } from "../../domain/publishing/publication";
export { ItineraryNotFoundError, ItineraryService } from "./itinerary-service";
export type { PublicationSources } from "./publication-service";
export {
  PublicationService,
  PublicationSettingsError,
  PublicationSlugTakenError,
} from "./publication-service";
export { publishingTemplateSlice } from "./template-slice";
/**
 * Sites and portals (issue #196).
 *
 * A Site composes *pointers* to programs other domains own; `SiteProgramResolver` is the seam the
 * composition root binds to those domains' own public application interfaces, so publishing never
 * learns another domain's tables.
 */
export type {
  PublicSite,
  Site,
  SiteFieldKind,
  SitePage,
  SiteProgram,
  SiteProgramKind,
  SiteState,
  SiteTheme,
} from "../../domain/publishing/site";
export {
  composePublicSite,
  programHref,
  REQUIRED_REGISTRATION_FIELDS,
} from "../../domain/publishing/site";
export type { SiteDraft, SiteProgramResolver, SiteRepository } from "./site-service";
export {
  SiteAlreadyRegisteredError,
  SiteConflictError,
  SiteConsentUnavailableError,
  SiteInvalidError,
  SiteNotFoundError,
  SiteService,
  SiteSlugTakenError,
} from "./site-service";
/**
 * The seam platform's audit timeline observes publishing through (#99, `PRD-OPS-003`).
 *
 * Appended here rather than woven in, so a lane rebasing around this line moves nothing above it.
 */
export type { PublicationNotificationPort } from "./publication-service";

/**
 * Named, revocable embeds (issue #192's residual lifecycle epic).
 *
 * The lifecycle rather than the view: PR #214 shipped the views, and what was missing was that an
 * embed had no identity — it could not be revisited, changed, or withdrawn.
 */
export type {
  EmbedFilters,
  EmbedOutput,
  EmbedTheme,
  EmbedView,
  PublicationEmbed,
  RenderedEmbed,
} from "../../domain/publishing/embed";
export {
  EMBED_FIELDS,
  EMBED_OUTPUTS,
  EMBED_VIEWS,
  renderEmbed,
  selectSessions,
} from "../../domain/publishing/embed";
export type { EmbedDraft, EmbedRepository } from "./embed-service";
export {
  EmbedConflictError,
  EmbedInvalidError,
  EmbedNotFoundError,
  EmbedService,
} from "./embed-service";
