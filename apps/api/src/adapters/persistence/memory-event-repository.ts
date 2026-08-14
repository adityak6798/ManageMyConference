import type {
  CreateEventOptions,
  CreateEventOutcome,
  EventRepository,
} from "../../application/events/event-repository";
import type { Event, Organization } from "../../domain/events/event";

export class MemoryEventRepository implements EventRepository {
  private readonly events = new Map<string, Event>();
  readonly organizations = new Map<string, Organization>();
  /** `organizationId provisioningKey` to event id, mirroring the partial unique index. */
  private readonly provisioned = new Map<string, string>();
  /** The organizer grants the real adapter would have committed with the event row. */
  readonly organizerGrants: { eventId: string; userId: string }[] = [];

  private static key(organizationId: string, provisioningKey: string) {
    return `${organizationId} ${provisioningKey}`;
  }

  async create(event: Event, options: CreateEventOptions = {}): Promise<CreateEventOutcome> {
    const key =
      options.provisioningKey === undefined
        ? null
        : MemoryEventRepository.key(event.organizationId, options.provisioningKey);
    if (key !== null && this.provisioned.has(key)) return "provisioning-key-taken";
    this.events.set(event.id, event);
    if (key !== null) this.provisioned.set(key, event.id);
    // One write, as in the adapter: the grant lands only if the event did.
    if (options.organizerUserId !== undefined)
      this.organizerGrants.push({ eventId: event.id, userId: options.organizerUserId });
    return "created";
  }

  async findByProvisioningKey(
    organizationId: string,
    provisioningKey: string,
  ): Promise<Event | null> {
    const id = this.provisioned.get(MemoryEventRepository.key(organizationId, provisioningKey));
    return (id === undefined ? null : this.events.get(id)) ?? null;
  }

  /**
   * The D1 statement also refuses when an event *template* references the organization; this
   * fixture holds none, so the predicate has nothing to model. Named rather than left implicit,
   * because a fixture quietly more permissive than the adapter is how a guard stops being tested.
   */
  async discardUnusedOrganization(organizationId: string): Promise<boolean> {
    const used = [...this.events.values()].some((event) => event.organizationId === organizationId);
    if (used || !this.organizations.has(organizationId)) return false;
    this.organizations.delete(organizationId);
    return true;
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

  async listAllIdsInOrganization(organizationId: string) {
    return [...this.events.values()]
      .filter((event) => event.organizationId === organizationId)
      .map((event) => event.id)
      .sort();
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
    this.provisioned.clear();
    this.organizerGrants.length = 0;
  }
}
