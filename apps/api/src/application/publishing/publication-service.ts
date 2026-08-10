import type { PublicationRepository } from "./publication-repository";
import { allowlistPublicProjection } from "../../domain/publishing/publication";
import { type Actor, AuthenticationRequiredError, CapabilityDeniedError } from "../identity/actor";

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

  private requireOrganizer(
    actor: Actor | null,
    eventId: string,
    capability: "events:settings:read" | "events:settings:update",
  ) {
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    const access = actor.eventAccess.find((candidate) => candidate.eventId === eventId);
    if (!access) return false;
    if (access.role !== "organizer" || !access.capabilities.has(capability))
      throw new CapabilityDeniedError(`Actor lacks ${capability} for event`);
    return true;
  }

  preview(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:read")) return null;
    return this.repository.findByEventId(eventId);
  }

  async publish(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:update")) return null;
    const publication = await this.repository.findByEventId(eventId);
    if (!publication) return null;
    return this.repository.publish(
      eventId,
      this.now().toISOString(),
      allowlistPublicProjection(publication.draft),
    );
  }

  unpublish(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:update")) return null;
    return this.repository.unpublish(eventId);
  }
}
