import type { Publication, PublicEventProjection } from "../../domain/publishing/publication";

// @spec PRD-PUB-001
export interface PublicationRepository {
  findPublicBySlug(slug: string): Promise<Publication | null>;
  findByEventId(eventId: string): Promise<Publication | null>;
  publish(
    eventId: string,
    publishedAt: string,
    projection: PublicEventProjection,
  ): Promise<Publication | null>;
  unpublish(eventId: string): Promise<Publication | null>;
}
