import type { Event } from "../../domain/events/event";
import { type Actor, CapabilityDeniedError, requireCapability } from "../identity/actor";
import type { EventRepository } from "./event-repository";

export interface CreateEventCommand {
  readonly organizationId: string;
  readonly name: string;
  readonly timezone: string;
}

export interface EventServiceDependencies {
  repository: EventRepository;
  newId: () => string;
  now: () => Date;
}

// @spec PRD-EVT-001
export class EventService {
  constructor(private readonly dependencies: EventServiceDependencies) {}

  async create(actor: Actor | null, command: CreateEventCommand): Promise<Event> {
    const authorized = requireCapability(actor, "events:create");
    if (!authorized.organizations.some(({ id }) => id === command.organizationId)) {
      throw new CapabilityDeniedError("Organization access denied");
    }
    const event: Event = {
      id: this.dependencies.newId(),
      organizationId: command.organizationId,
      name: command.name,
      timezone: command.timezone,
      createdAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.repository.create(event);
    return event;
  }

  list(actor: Actor | null): Promise<readonly Event[]> {
    const authorized = requireCapability(actor, "events:read");
    return this.dependencies.repository.list({
      organizationIds: authorized.organizations.map(({ id }) => id),
      eventIds: authorized.eventAccess
        .filter(({ capabilities }) => capabilities.has("events:read"))
        .map(({ eventId }) => eventId),
    });
  }

  async get(actor: Actor | null, eventId: string): Promise<Event | null> {
    const visible = await this.list(actor);
    return visible.find(({ id }) => id === eventId) ?? null;
  }
}
