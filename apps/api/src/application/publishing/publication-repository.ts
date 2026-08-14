import type {
  ProjectionRefresh,
  Publication,
  PublicationProvenance,
  PublicEventProjection,
} from "../../domain/publishing/publication";

// @spec PRD-PUB-001
export interface PublicationRepository {
  findPublicBySlug(slug: string): Promise<Publication | null>;
  findByEventId(eventId: string): Promise<Publication | null>;
  /**
   * Which event holds a slug, in any state.
   *
   * `findPublicBySlug` cannot answer this: it filters to `state = 'published'`, so it would
   * report a draft's reserved address as free and the unique index would refuse the write
   * afterwards.
   */
  findEventIdBySlug(slug: string): Promise<string | null>;
  /**
   * Persist organizer-edited draft settings without touching the published snapshot.
   *
   * Creates the row when the event has never been published, which is the normal case:
   * `publish` is what inserts today, so an organizer editing their public details before
   * publishing has no row to update.
   */
  saveSettings(
    eventId: string,
    slug: string,
    draft: PublicEventProjection,
  ): Promise<Publication | null>;
  publish(
    eventId: string,
    publishedAt: string,
    projection: PublicEventProjection,
    provenance?: PublicationProvenance,
  ): Promise<Publication | null>;
  /**
   * Activate a newly composed source-driven snapshot only while the event is already live.
   *
   * Optional for small in-memory compositions that exercise only explicit site publication.
   * Production storage implements it, and public reads refuse to serve a known-stale source
   * projection when no implementation is available.
   */
  refreshPublished?(refresh: ProjectionRefresh): Promise<Publication | null>;
  unpublish(eventId: string): Promise<Publication | null>;
}
