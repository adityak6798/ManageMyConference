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
}

/**
 * The key a self-serve workspace's first event is provisioned under, per person.
 *
 * Unique per `(organization_id, provisioning_key)` by a partial index, which is what makes two
 * concurrent first sign-ins converge on one event instead of creating two (issue #164): both
 * callbacks are the same person, so both compute the same key and the second one loses and adopts.
 *
 * **It names the person, not just the intent**, so the idempotence belongs to the caller: a repeat
 * of *this* person's provisioning converges, and two different people provisioning in one
 * organization would not silently collide on each other's key.
 *
 * It is not what stops a member taking somebody else's event. `SignupService.completeWorkspace`
 * does that, by provisioning only into an organization with no events and no other member and
 * never adopting an event that already exists — so no caller can reach here with another person's
 * key in play. The subject is defence in depth against a future caller, and today no test can
 * observe the difference; that is stated rather than dressed up as a guard.
 */
export const firstEventProvisioningKey = (userId: string) => `self-serve-first-event:${userId}`;

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

  /** Who may create an event in this organization, and who the role belongs to when they do. */
  private authorizeCreate(actor: Actor | null, organizationId: string): Actor {
    const authorized = requireCapability(actor, "events:create");
    const canCreateInOrganization = authorized.organizationAccess
      ? authorized.organizationAccess.some(
          ({ id, capabilities }) => id === organizationId && capabilities.has("events:create"),
        )
      : authorized.organizations.some(({ id }) => id === organizationId);
    if (!canCreateInOrganization) {
      throw new CapabilityDeniedError("Organization access denied");
    }
    return authorized;
  }

  async create(actor: Actor | null, command: CreateEventCommand): Promise<Event> {
    const authorized = this.authorizeCreate(actor, command.organizationId);
    const created = await this.write(command, authorized.roleGrantSubjectId ?? authorized.id, {});
    if (created === null)
      // Unreachable: only a provisioning key can be taken, and `create` passes none.
      throw new Error("Creating an event without a provisioning key cannot be refused as taken");
    return created;
  }

  /**
   * The event row and its organizer role, as one durable write.
   *
   * They used to be two — the insert, then a separate `grantOrganizer` — so a failure between
   * them left an event whose creator held no role on it, and therefore an event nobody could
   * open or delete (issue #164). The role belongs to identity-access, so the repository is
   * handed the subject and the adapter commits both in one batch through a writer that domain
   * supplies.
   *
   * `null` means the provisioning key was already taken; the caller adopts the winner.
   */
  private async write(
    command: CreateEventCommand,
    organizerUserId: string | undefined,
    options: { readonly provisioningKey?: string },
  ): Promise<Event | null> {
    const event: Event = {
      id: this.dependencies.newId(),
      organizationId: command.organizationId,
      name: command.name,
      timezone: command.timezone,
      createdAt: this.dependencies.now().toISOString(),
    };
    const outcome = await this.dependencies.repository.create(event, {
      ...(organizerUserId ? { organizerUserId } : {}),
      ...options,
    });
    return outcome === "created" ? event : null;
  }

  /**
   * The one event a brand-new self-serve workspace starts with.
   *
   * Authorized exactly as `create` is — the caller has just been made a member of the
   * organization it names — and different from it in one way: it is **idempotent per caller per
   * organization**. Two concurrent first sign-ins for one account both reach here, and the
   * uniqueness the provisioning key declares is what makes the second one adopt the first's
   * event rather than create a second "Your first event" that no route can delete. A *different*
   * person provisioning in the same organization would not collide with it — which is why the
   * caller that decides to provision at all (`completeWorkspace`) requires an organization with
   * no events and no other member.
   *
   * On adoption the caller holds no role yet — its own grant rolled back with its refused
   * insert — so the caller grants it, exactly as it does for an event it finds by reading. That
   * grant is `INSERT OR IGNORE` on identity's side, so it is free when the role is already held.
   */
  async provisionFirstEvent(actor: Actor | null, command: CreateEventCommand): Promise<Event> {
    const authorized = this.authorizeCreate(actor, command.organizationId);
    const subject = authorized.roleGrantSubjectId ?? authorized.id;
    const created = await this.write(command, subject, {
      provisioningKey: firstEventProvisioningKey(subject),
    });
    if (created) return created;
    const adopted = await this.dependencies.repository.findByProvisioningKey(
      command.organizationId,
      firstEventProvisioningKey(subject),
    );
    if (!adopted)
      // The key was reported taken and then named no row: two answers that cannot both be true,
      // and a state no retry here can resolve. Reported rather than papered over with a second
      // create, which is exactly the duplicate this method exists to prevent.
      throw new Error(
        `Event provisioning for organization ${command.organizationId} was refused as already provisioned, but no provisioned event exists`,
      );
    return adopted;
  }

  /**
   * Remove an organization a signup abandoned, and report whether one went.
   *
   * The system-trust sibling of `provisionOrganization` and its counterweight: that call writes
   * the organization before the identity batch that would reference it, so a failed signup left
   * an unreferenced row that nothing swept (issue #164) — and, once the demo reset reads the
   * data (`GAP-019`), one that would make a reset refuse forever. No actor, for the same reason
   * `provisionOrganization` has none: at the moment it runs nobody is a member. The refusal is
   * in the repository's statement, so an organization that became somebody's workspace between
   * the failure and this call is kept rather than deleted.
   */
  async discardUnusedOrganization(organizationId: string): Promise<boolean> {
    return this.dependencies.repository.discardUnusedOrganization(organizationId);
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

  /**
   * What this event is called, for a caller that has no actor to scope by.
   *
   * The same system-trust shape as `organizationOf` above, and it carries the same obligation:
   * the caller has already authorized the action that led here. It exists because a message to
   * a speaker reads better naming their conference than not, and a consumer that had to fetch
   * the whole event through `get` would need an actor it does not have.
   *
   * A portal's program list is the second caller (issue #196), and it needs the same defence
   * stated once: a Site lists the programs an organizer *attached to it*, the attaching was
   * authorized, and a visitor reading that list needs a name rather than a uuid. What this
   * confers is a name for an event whose id the caller already holds — exactly what the public
   * event hub gives away to anybody at all — so it adds no reach, and withholding it would only
   * mean a portal that prints identifiers.
   *
   * Null when no such event exists. A caller must treat that as "no name" rather than as an
   * empty string — a message saying "You are speaking at " is worse than one that does not
   * mention the event, and a portal is better off leaving the entry out.
   */
  async nameOf(eventId: string): Promise<string | null> {
    const event = await this.dependencies.repository.findById(eventId, {
      organizationIds: [],
      eventIds: [eventId],
    });
    return event?.name ?? null;
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
