import type { Event } from "../../domain/events/event";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { EventRepository } from "./event-repository";

export interface CreateEventCommand {
  readonly organizationId: string;
  readonly name: string;
  readonly timezone: string;
}

export interface UpdateEventCommand {
  readonly name: string;
  readonly timezone: string;
}

export interface EventServiceDependencies {
  repository: EventRepository;
  newId: () => string;
  now: () => Date;
  grantOrganizer?: (eventId: string, userId: string) => Promise<void>;
}

// @spec PRD-EVT-001
export class EventService {
  constructor(private readonly dependencies: EventServiceDependencies) {}

  private scope(actor: Actor) {
    return {
      organizationIds: actor.organizations.map(({ id }) => id),
      eventIds: actor.eventAccess
        .filter(({ capabilities }) => capabilities.has("events:read"))
        .map(({ eventId }) => eventId),
    };
  }

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
    await this.dependencies.grantOrganizer?.(event.id, authorized.id);
    return event;
  }

  async update(
    actor: Actor | null,
    eventId: string,
    command: UpdateEventCommand,
  ): Promise<Event | null> {
    requireEventCapability(actor, eventId, "events:settings:update");
    return this.dependencies.repository.update(eventId, command.name, command.timezone);
  }
  listAssigned(actor: Actor | null): Promise<readonly Event[]> {
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    return this.dependencies.repository.list({
      organizationIds: [],
      eventIds: actor.eventAccess.map(({ eventId }) => eventId),
    });
  }

  list(actor: Actor | null): Promise<readonly Event[]> {
    const authorized = requireCapability(actor, "events:read");
    return this.dependencies.repository.list(this.scope(authorized));
  }

  async get(actor: Actor | null, eventId: string): Promise<Event | null> {
    const authorized = requireCapability(actor, "events:read");
    return this.dependencies.repository.findById(eventId, this.scope(authorized));
  }

  /**
   * Which organization owns this event, for a caller that has no actor to scope by.
   *
   * The system-trust sibling of `belongsToOrganization`, and it exists for the same reason: a
   * lifecycle consequence — a speaker welcomed after acceptance, a schedule confirmation drained
   * from the outbox on a cron tick — happens without a request, so there is no actor whose
   * organizations could scope the lookup. Both are addressing facts rather than grants: knowing
   * which organization owns an event confers nothing, and every caller here has already
   * authorized the action that led to it.
   *
   * Null when no such event exists, which a caller must treat as "do not act" rather than as an
   * empty string.
   */
  async organizationOf(eventId: string): Promise<string | null> {
    const event = await this.dependencies.repository.findById(eventId, {
      organizationIds: [],
      eventIds: [eventId],
    });
    return event?.organizationId ?? null;
  }

  async belongsToOrganization(eventId: string, organizationId: string): Promise<boolean> {
    return (
      (await this.dependencies.repository.findById(eventId, {
        organizationIds: [organizationId],
        eventIds: [],
      })) !== null
    );
  }

  /** Public application query for domains that must validate several event candidates at once. */
  listEventIdsInOrganization(
    organizationId: string,
    candidateEventIds: readonly string[],
  ): Promise<readonly string[]> {
    return this.dependencies.repository.listIdsInOrganization(organizationId, candidateEventIds);
  }
}
