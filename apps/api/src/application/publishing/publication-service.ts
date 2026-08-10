import type { PublicationRepository } from "./publication-repository";
import { allowlistPublicProjection } from "../../domain/publishing/publication";

// @spec PRD-PUB-001
export class PublicationService {
  constructor(
    private readonly repository: PublicationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publicBySlug(slug: string) {
    const publication = await this.repository.findPublicBySlug(slug);
    return publication?.published ?? null;
  }

  preview(eventId: string) {
    return this.repository.findByEventId(eventId);
  }

  async publish(eventId: string) {
    const publication = await this.repository.findByEventId(eventId);
    if (!publication) return null;
    return this.repository.publish(
      eventId,
      this.now().toISOString(),
      allowlistPublicProjection(publication.draft),
    );
  }

  unpublish(eventId: string) {
    return this.repository.unpublish(eventId);
  }
}
