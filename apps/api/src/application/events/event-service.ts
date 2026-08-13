import type { Event, Organization } from "../../domain/events/event";
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
    const organizationIds = actor.organizationAccess
      ? actor.organizationAccess
          .filter(({ capabilities }) => capabilities.has("events:read"))
          .map(({ id }) => id)
      : actor.organizations.map(({ id }) => id);
    return {
      organizationIds,
      eventIds: actor.eventAccess
        .filter(({ capabilities }) => capabilities.has("events:read"))
        .map(({ eventId }) => eventId),
    };
  }

  async create(actor: Actor | null, command: CreateEventCommand): Promise<Event> {
    const authorized = requireCapability(actor, "events:create");
    const canCreateInOrganization = authorized.organizationAccess
      ? authorized.organizationAccess.some(
          ({ id, capabilities }) =>
            id === command.organizationId && capabilities.has("events:create"),
        )
      : authorized.organizations.some(({ id }) => id === command.organizationId);
    if (!canCreateInOrganization) {
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
    const roleGrantSubjectId = authorized.roleGrantSubjectId ?? authorized.id;
    if (roleGrantSubjectId) await this.dependencies.grantOrganizer?.(event.id, roleGrantSubjectId);
    return event;
  }

  /**
   * Create the organization a first-time signup will own. **No actor, deliberately.**
   *
   * This is the one write in this domain that cannot be authorized against an actor's
   * memberships, because at the moment it runs the caller has no memberships at all — the
   * organization being created is what they are about to become a member of. The system-trust
   * sibling of `organizationOf`, and it carries the same obligation: the *caller* has already
   * established who is asking. Identity-access reaches it exactly once, immediately after
   * verifying a Google `id_token`, and nothing else in the repository calls it.
   *
   * The `organizations` table is the events domain's (`table-ownership.json`), which is why this
   * lives here rather than in identity-access even though the signup workflow it serves is
   * identity's. The workflow crosses the boundary as this call.
   */
  async provisionOrganization(command: { readonly name: string }): Promise<Organization> {
    const organization: Organization = { id: this.dependencies.newId(), name: command.name };
    await this.dependencies.repository.createOrganization({
      ...organization,
      createdAt: this.dependencies.now().toISOString(),
    });
    return organization;
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

  /**
   * Every event of an organization, for a domain scoping its own tables by them.
   *
   * Identity-access uses it to list and remove event roles without reading `events`, which
   * `table-ownership.json` says belongs here. Addressing facts rather than grants, like
   * `organizationOf`: knowing which events an organization owns confers nothing, and the caller
   * has already authorized the action that led here.
   */
  listEventIdsForOrganization(organizationId: string): Promise<readonly string[]> {
    return this.dependencies.repository.listAllIdsInOrganization(organizationId);
  }

  /** Public application query for domains that must validate several event candidates at once. */
  listEventIdsInOrganization(
    organizationId: string,
    candidateEventIds: readonly string[],
  ): Promise<readonly string[]> {
    return this.dependencies.repository.listIdsInOrganization(organizationId, candidateEventIds);
  }
}
