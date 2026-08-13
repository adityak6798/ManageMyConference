/**
 * Publishing's public application interface.
 *
 * Callers outside the publishing domain — the HTTP transport, other domains — use this
 * module rather than reaching into the service or the projection types directly.
 */

export type { AttendeeItinerary } from "../../domain/publishing/itinerary";
export type {
  PublicationSettings,
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
