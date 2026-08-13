/**
 * Organization membership and event-role administration.
 *
 * This is the largest piece of product issue #12 was still missing. Until it existed, no route
 * anywhere in the repository wrote `organization_memberships` or `event_roles`: the only writers
 * were `grantOrganizer`, called by signup and by event creation, and `provisionSpeaker`, called by
 * CRM speaker conversion. A self-serve organizer could create an event and then had no way to add
 * a reviewer, a co-organizer, or anybody else to it.
 *
 * Three rules from `docs/architecture/authorization.md` are enforced here rather than at the
 * route, because they are properties of the operation and not of the transport:
 *
 * 1. **An invitation is accepted by the accepting session's own identity, never by address
 *    lookup.** `accept` takes the acting actor and grants to *that* user id. The invitation's
 *    `email` addresses the offer and authorizes nothing.
 * 2. **A demo persona id is never a valid grant target.** Every write whose subject is one is
 *    refused, and the refusal is audited. The seeded grants come from seed SQL, so refusing them
 *    here costs nothing real and removes the crossing entirely.
 * 3. Actor resolution is not this service's business. It receives an `Actor` and never resolves
 *    one.
 *
 * @spec PRD-IAM-001 PRD-IAM-002 ARC-AUTH-001
 */
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  requireCapability,
} from "./actor";
import type { AuditAction, AuditContext } from "./audit";
import { isDemoPersonaId } from "./demo-session";

/** A role somebody can be invited into. `public` is not invitable: everybody already has it. */
export type InvitableRole = "organizer" | "reviewer" | "speaker";

export class MembershipRefusedError extends Error {}
export class InvitationInvalidError extends Error {}
export class EventOutsideOrganizationError extends Error {}

export interface OrganizationMember {
  userId: string;
  name: string;
  email: string | null;
  /** Roles this member holds on events belonging to *this* organization. */
  eventRoles: readonly { eventId: string; role: string }[];
}

export interface Invitation {
  id: string;
  organizationId: string;
  eventId: string | null;
  email: string;
  role: InvitableRole;
  invitedByUserId: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  acceptedByUserId: string | null;
  revokedAt: number | null;
}

export interface AuditEventRow {
  id: string;
  occurredAt: number;
  action: string;
  outcome: string;
  source: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  eventId: string | null;
  correlationId: string;
  detail: string | null;
}

/** What acceptance found and did, or null when the token named nothing acceptable. */
export interface AcceptedInvitation {
  organizationId: string;
  eventId: string | null;
  role: InvitableRole;
}

export interface MembershipRepository {
  /**
   * `eventIds` are the organization's events, supplied by the events domain.
   *
   * Passed in rather than looked up, because `events` is that domain's table and identity-access
   * reads none of it (`table-ownership.json`). The same reason applies to `removeMember`.
   */
  listMembers(
    organizationId: string,
    eventIds: readonly string[],
  ): Promise<readonly OrganizationMember[]>;
  listInvitations(organizationId: string): Promise<readonly Invitation[]>;
  createInvitation(
    invitation: Invitation & { tokenHash: string },
    context: AuditContext,
  ): Promise<void>;
  revokeInvitation(
    organizationId: string,
    invitationId: string,
    now: number,
    context: AuditContext,
  ): Promise<number>;
  /**
   * Spend the invitation named by `tokenHash` and grant what it offers to `userId`, as one D1
   * batch with the audit row. Null when the token matched no live invitation — unknown, expired,
   * revoked, or already accepted, deliberately indistinguishable.
   */
  acceptInvitation(input: {
    tokenHash: string;
    userId: string;
    now: number;
    context: AuditContext;
  }): Promise<AcceptedInvitation | null>;
  removeMember(
    organizationId: string,
    userId: string,
    eventIds: readonly string[],
    now: number,
    context: AuditContext,
  ): Promise<number>;
  setEventRole(
    eventId: string,
    userId: string,
    role: InvitableRole,
    now: number,
    context: AuditContext,
  ): Promise<number>;
  revokeEventRole(
    eventId: string,
    userId: string,
    role: InvitableRole,
    now: number,
    context: AuditContext,
  ): Promise<number>;
  listAuditEvents(
    organizationId: string,
    limit: number,
    before: number | null,
  ): Promise<readonly AuditEventRow[]>;
  /**
   * A standalone audit row for an action this service refused before it wrote anything.
   *
   * The one audit write in this domain that is not batched with a state change, because there is
   * no state change to batch it with — and unlike the Google callback's refusals, this one is
   * worth the round trip: it records a caller who *was* authorized reaching for something across
   * the demo/real boundary, which is precisely what an operator would go looking for.
   */
  recordRefusal(
    entry: {
      action: AuditAction;
      organizationId: string;
      subjectUserId?: string;
      eventId?: string;
      detail?: Record<string, unknown>;
    },
    context: AuditContext,
  ): Promise<void>;
  /** Is this user a member of this organization? Used to scope event-role administration. */
  isMember(organizationId: string, userId: string): Promise<boolean>;
}

export interface MembershipDependencies {
  repository: MembershipRepository;
  events: {
    belongsToOrganization(eventId: string, organizationId: string): Promise<boolean>;
    listEventIdsInOrganization(
      organizationId: string,
      candidateEventIds: readonly string[],
    ): Promise<readonly string[]>;
    listEventIdsForOrganization(organizationId: string): Promise<readonly string[]>;
  };
  newId(): string;
  now(): number;
  /** 32 random bytes as an opaque token, and the digest that is all the database ever sees. */
  mintToken(): Promise<{ token: string; tokenHash: string }>;
  invitationLifetimeMs?: number;
}

const DEFAULT_INVITATION_LIFETIME_MS = 604_800_000; // seven days

export class MembershipService {
  constructor(private readonly dependencies: MembershipDependencies) {}

  /**
   * Who may administer this organization's membership.
   *
   * The same three conditions the CRM directory uses for organization-addressed routes, and each
   * rules out a different escalation:
   *
   * 1. `identity:manage` at all — a reviewer or speaker never holds it, so being staffed on an
   *    event grants no administrative reach.
   * 2. Membership of *this* organization — an organizer elsewhere holds a perfectly good
   *    actor-wide capability and it must not reach this organization.
   * 3. That the capability was earned inside this organization. Conditions 1 and 2 can be met by
   *    two different organizations at once: somebody who organizes an event in A and merely
   *    belongs to B would otherwise administer B on the strength of a grant A gave them.
   *
   * There is deliberately no global administrator. The effect is only ever narrower than event
   * access, never wider.
   */
  private async requireOrganization(actor: Actor | null, organizationId: string): Promise<Actor> {
    const authorized = requireCapability(actor, "identity:manage");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    const candidateEventIds = authorized.eventAccess
      .filter(({ capabilities }) => capabilities.has("identity:manage"))
      .map(({ eventId }) => eventId);
    if (
      (await this.dependencies.events.listEventIdsInOrganization(organizationId, candidateEventIds))
        .length > 0
    )
      return authorized;
    throw new CapabilityDeniedError("Actor lacks identity:manage inside this organization");
  }

  /**
   * Every write here additionally requires a *real* session, not merely a capability.
   *
   * A demo persona resolves as `demo` and holds the seeded organizer's capabilities, so without
   * this a persona could mint real invitations and real grants in the demo organization — state
   * that outlives the persona and is handed to whoever presses "Continue as organizer" next. The
   * refusal is audited, because an attempt to cross the two populations is exactly what an
   * operator would want to find later.
   */
  private async requireRealSession(
    actor: Actor,
    organizationId: string,
    action: AuditAction,
    context: AuditContext,
  ): Promise<void> {
    if (context.source === "human" && isDemoPersonaId(actor.id)) {
      await this.dependencies.repository.recordRefusal(
        {
          action,
          organizationId,
          subjectUserId: actor.id,
          detail: { reason: "demo-persona-actor" },
        },
        context,
      );
      throw new MembershipRefusedError("A demo persona cannot administer membership");
    }
  }

  /** Rule 2: a seeded persona is never a valid grant target. Refusal is recorded. */
  private async refuseDemoSubject(
    subjectUserId: string,
    organizationId: string,
    action: AuditAction,
    context: AuditContext,
    eventId?: string,
  ): Promise<void> {
    if (!isDemoPersonaId(subjectUserId)) return;
    await this.dependencies.repository.recordRefusal(
      {
        action,
        organizationId,
        subjectUserId,
        ...(eventId ? { eventId } : {}),
        detail: { reason: "demo-persona-subject" },
      },
      context,
    );
    throw new MembershipRefusedError("A demo persona cannot be granted membership or a role");
  }

  private async requireOrganizationEvent(organizationId: string, eventId: string): Promise<void> {
    if (!(await this.dependencies.events.belongsToOrganization(eventId, organizationId)))
      throw new EventOutsideOrganizationError("Event is not part of this organization");
  }

  async listMembers(actor: Actor | null, organizationId: string) {
    await this.requireOrganization(actor, organizationId);
    return this.dependencies.repository.listMembers(
      organizationId,
      await this.dependencies.events.listEventIdsForOrganization(organizationId),
    );
  }

  async listInvitations(actor: Actor | null, organizationId: string) {
    await this.requireOrganization(actor, organizationId);
    return this.dependencies.repository.listInvitations(organizationId);
  }

  /**
   * Offer somebody a place. Answers the token, which is the only time it exists in the clear —
   * the database stores its digest, so this return value is what an invitation link is built
   * from and nothing can reissue it afterwards.
   */
  async invite(
    actor: Actor | null,
    organizationId: string,
    command: { email: string; role: InvitableRole; eventId?: string | undefined },
    context: AuditContext,
  ): Promise<{ invitation: Invitation; token: string }> {
    const authorized = await this.requireOrganization(actor, organizationId);
    await this.requireRealSession(authorized, organizationId, "membership.invited", context);
    if (command.eventId) await this.requireOrganizationEvent(organizationId, command.eventId);
    else if (command.role !== "organizer")
      throw new InvitationInvalidError("An organization invitation grants the organizer role");
    const now = this.dependencies.now();
    const { token, tokenHash } = await this.dependencies.mintToken();
    const invitation: Invitation = {
      id: this.dependencies.newId(),
      organizationId,
      eventId: command.eventId ?? null,
      email: command.email.trim().toLowerCase(),
      role: command.role,
      invitedByUserId: authorized.id,
      createdAt: now,
      expiresAt: now + (this.dependencies.invitationLifetimeMs ?? DEFAULT_INVITATION_LIFETIME_MS),
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
    };
    await this.dependencies.repository.createInvitation({ ...invitation, tokenHash }, context);
    return { invitation, token };
  }

  async revokeInvitation(
    actor: Actor | null,
    organizationId: string,
    invitationId: string,
    context: AuditContext,
  ): Promise<number> {
    const authorized = await this.requireOrganization(actor, organizationId);
    await this.requireRealSession(
      authorized,
      organizationId,
      "membership.invitation_revoked",
      context,
    );
    return this.dependencies.repository.revokeInvitation(
      organizationId,
      invitationId,
      this.dependencies.now(),
      context,
    );
  }

  /**
   * Accept an invitation as the caller.
   *
   * **The token says which invitation; the session says who.** Nothing here reads the
   * invitation's address, which is rule 1 and the reason a real organizer cannot invite
   * `organizer@greenroom.test` and thereby hand a demo persona a real membership.
   *
   * The caller must hold a real session — a persona resolves as `demo` and the route refuses it
   * before this is reached — and cannot be a seeded persona, which is checked here too because a
   * service is not entitled to assume its transport.
   */
  async accept(
    actor: Actor | null,
    token: string,
    context: AuditContext,
  ): Promise<AcceptedInvitation> {
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    if (isDemoPersonaId(actor.id))
      throw new MembershipRefusedError("A demo persona cannot accept an invitation");
    const { tokenHash } = await hashToken(token);
    const accepted = await this.dependencies.repository.acceptInvitation({
      tokenHash,
      userId: actor.id,
      now: this.dependencies.now(),
      context,
    });
    // Unknown, expired, revoked and already-accepted are one answer. Telling them apart would
    // say whether a guessed token named a real invitation.
    if (!accepted) throw new InvitationInvalidError("That invitation is not valid");
    return accepted;
  }

  async removeMember(
    actor: Actor | null,
    organizationId: string,
    userId: string,
    context: AuditContext,
  ): Promise<number> {
    const authorized = await this.requireOrganization(actor, organizationId);
    await this.requireRealSession(authorized, organizationId, "membership.removed", context);
    await this.refuseDemoSubject(userId, organizationId, "membership.removed", context);
    return this.dependencies.repository.removeMember(
      organizationId,
      userId,
      await this.dependencies.events.listEventIdsForOrganization(organizationId),
      this.dependencies.now(),
      context,
    );
  }

  /**
   * Grant or revoke one role on one event.
   *
   * The subject must already be a member of the owning organization: an event role is how a
   * member is staffed, and granting one to a stranger would be an invitation by another name,
   * without the acceptance step that makes invitations safe.
   *
   * Removal takes effect on the very next request without touching any session, because
   * `resolveUserSession` re-derives the actor from D1 every time. That is asserted rather than
   * engineered — see `d1-identity-membership.integration.test.ts` — and it is why removing a
   * role does not revoke sessions: the person may hold memberships elsewhere that are none of
   * this organization's business.
   */
  async setEventRole(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    userId: string,
    role: InvitableRole,
    context: AuditContext,
  ): Promise<number> {
    const authorized = await this.requireOrganization(actor, organizationId);
    await this.requireRealSession(authorized, organizationId, "event_role.granted", context);
    await this.refuseDemoSubject(userId, organizationId, "event_role.granted", context, eventId);
    await this.requireOrganizationEvent(organizationId, eventId);
    if (!(await this.dependencies.repository.isMember(organizationId, userId)))
      throw new MembershipRefusedError("That person is not a member of this organization");
    return this.dependencies.repository.setEventRole(
      eventId,
      userId,
      role,
      this.dependencies.now(),
      context,
    );
  }

  async revokeEventRole(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    userId: string,
    role: InvitableRole,
    context: AuditContext,
  ): Promise<number> {
    const authorized = await this.requireOrganization(actor, organizationId);
    await this.requireRealSession(authorized, organizationId, "event_role.revoked", context);
    await this.refuseDemoSubject(userId, organizationId, "event_role.revoked", context, eventId);
    await this.requireOrganizationEvent(organizationId, eventId);
    return this.dependencies.repository.revokeEventRole(
      eventId,
      userId,
      role,
      this.dependencies.now(),
      context,
    );
  }

  /** The organizer-visible audit log, scoped to this organization and paginated by time. */
  async listAuditEvents(
    actor: Actor | null,
    organizationId: string,
    page: { limit?: number; before?: number },
  ) {
    await this.requireOrganization(actor, organizationId);
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 200);
    return this.dependencies.repository.listAuditEvents(organizationId, limit, page.before ?? null);
  }
}

/** SHA-256 of the invitation token, which is the only form the database ever holds. */
export async function hashToken(token: string): Promise<{ tokenHash: string }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return {
    tokenHash: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}

/** 32 random bytes, base64url, and the digest the database stores instead of them. */
export async function mintInvitationToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return { token, ...(await hashToken(token)) };
}
