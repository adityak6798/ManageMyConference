import type { PublicationRepository } from "./publication-repository";

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

  publish(eventId: string) {
    return this.repository.publish(eventId, this.now().toISOString());
  }

  unpublish(eventId: string) {
    return this.repository.unpublish(eventId);
  }
}
