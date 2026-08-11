/**
 * Publishing's public application interface.
 *
 * Callers outside the publishing domain — the HTTP transport, other domains — use this
 * module rather than reaching into the service or the projection types directly.
 */
export { PublicationService } from "./publication-service";
export type { PublicationSources } from "./publication-service";
export { composePublicSchedule } from "../../domain/publishing/publication";
export type {
  PublicEventProjection,
  PublicScheduleProjection,
  PublicScheduleSession,
} from "../../domain/publishing/publication";
