export type Capability =
  | "events:read"
  | "events:create"
  | "events:settings:read"
  | "events:settings:update"
  | "communications:manage"
  | "agenda:manage"
  | "crm:manage"
  | "content:read"
  | "content:manage"
  | "review:manage"
  | "review:evaluate"
  /**
   * Administer who belongs to an organization and who is staffed on its events.
   *
   * Event-earned like every other capability here, and deliberately *not* a global administrator
   * role: an organization-addressed route requires this capability, membership of the named
   * organization, and that the capability was earned on an event belonging to it. See
   * `MembershipService.requireOrganization` and `docs/architecture/authorization.md`.
   */
  | "identity:manage";

export interface EventAccess {
  readonly eventId: string;
  readonly role: "organizer" | "reviewer" | "speaker" | "public";
  readonly capabilities: ReadonlySet<Capability>;
}

export interface Actor {
  readonly id: string;
  readonly name: string;
  readonly persona: "organizer" | "reviewer" | "speaker" | "public";
  readonly organizations: readonly { id: string }[];
  readonly eventAccess: readonly EventAccess[];
  readonly capabilities: ReadonlySet<Capability>;
  /** Explicit organization-level grants for delegated machine identities. Humans omit this. */
  readonly organizationAccess?: readonly {
    id: string;
    capabilities: ReadonlySet<Capability>;
  }[];
  /** User eligible to receive a role created by this actor; machines delegate to their creator. */
  readonly roleGrantSubjectId?: string;
}

export class AuthenticationRequiredError extends Error {}
export class CapabilityDeniedError extends Error {}

export function requireCapability(actor: Actor | null, capability: Capability): Actor {
  if (!actor) throw new AuthenticationRequiredError("Authentication is required");
  if (!actor.capabilities.has(capability)) {
    throw new CapabilityDeniedError(`Actor lacks ${capability}`);
  }
  return actor;
}

/**
 * Does the actor hold `capability` through a grant of `role` on this exact event?
 *
 * An actor may hold several roles on one event — the seeded organizer is also a reviewer of
 * the demo event. Every access entry has to be considered, so this is `some`, never `find`:
 * matching only the first entry made authorization depend on the order the identity directory
 * happened to return roles in, which `ORDER BY role` was silently supplying (`ARC-AUTH-001`).
 */
export function hasEventRoleCapability(
  actor: Actor,
  eventId: string,
  role: EventAccess["role"],
  capability: Capability,
): boolean {
  return actor.eventAccess.some(
    (candidate) =>
      candidate.eventId === eventId &&
      candidate.role === role &&
      candidate.capabilities.has(capability),
  );
}

export function requireEventCapability(
  actor: Actor | null,
  eventId: string,
  capability: Capability,
): Actor {
  if (!actor) throw new AuthenticationRequiredError("Authentication is required");
  const authorized = actor.eventAccess.some(
    (candidate) => candidate.eventId === eventId && candidate.capabilities.has(capability),
  );
  if (!authorized) {
    throw new CapabilityDeniedError(`Actor lacks ${capability} for event`);
  }
  return actor;
}
