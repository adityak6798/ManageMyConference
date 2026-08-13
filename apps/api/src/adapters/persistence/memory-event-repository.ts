import type { EventRepository } from "../../application/events/event-repository";
import type { Event, Organization } from "../../domain/events/event";

export class MemoryEventRepository implements EventRepository {
  private readonly events = new Map<string, Event>();
  readonly organizations = new Map<string, Organization>();

  async create(event: Event): Promise<void> {
    this.events.set(event.id, event);
  }

  async createOrganization(organization: Organization): Promise<void> {
    this.organizations.set(organization.id, { id: organization.id, name: organization.name });
  }

  async update(eventId: string, name: string, timezone: string): Promise<Event | null> {
    const event = this.events.get(eventId);
    if (!event) return null;
    const updated = { ...event, name, timezone };
    this.events.set(eventId, updated);
    return updated;
  }

  async list(scope: {
    organizationIds: readonly string[];
    eventIds: readonly string[];
  }): Promise<readonly Event[]> {
    return [...this.events.values()]
      .filter(
        (event) =>
          scope.organizationIds.includes(event.organizationId) || scope.eventIds.includes(event.id),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async findById(
    eventId: string,
    scope: { organizationIds: readonly string[]; eventIds: readonly string[] },
  ): Promise<Event | null> {
    const event = this.events.get(eventId);
    if (!event) return null;
    return scope.organizationIds.includes(event.organizationId) || scope.eventIds.includes(event.id)
      ? event
      : null;
  }

  async listIdsInOrganization(organizationId: string, candidateEventIds: readonly string[]) {
    const candidates = new Set(candidateEventIds);
    return [...this.events.values()]
      .filter((event) => event.organizationId === organizationId && candidates.has(event.id))
      .map(({ id }) => id)
      .sort((left, right) => left.localeCompare(right));
  }

  reset(): void {
    this.events.clear();
    this.organizations.clear();
  }
}
