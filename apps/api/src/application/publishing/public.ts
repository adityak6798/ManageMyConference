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
 * The seam platform's audit timeline observes publishing through (#99, `PRD-OPS-003`).
 *
 * Appended here rather than woven in, so a lane rebasing around this line moves nothing above it.
 */
export type { PublicationNotificationPort } from "./publication-service";
