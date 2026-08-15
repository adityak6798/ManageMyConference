/**
 * Who may administer an organization, and the last-administrator rule that keeps one recoverable.
 *
 * Extracted from `MembershipService` when custom roles became a second administrative surface
 * over the same grants (issue #196). Two copies of an authorization rule is how one surface ends
 * up permitting what the other refuses, and this particular rule has three conditions of which
 * the third is the one everybody leaves out — see `requireOrganizationAdministration`.
 *
 * @spec PRD-IAM-002 ARC-AUTH-001
 */
import { type Actor, CapabilityDeniedError, requireCapability } from "./actor";

export interface OrganizationEventDirectory {
  listEventIdsInOrganization(
    organizationId: string,
    candidateEventIds: readonly string[],
  ): Promise<readonly string[]>;
}

/**
 * Refuse unless the actor administers this organization.
 *
 * Three conditions together, each ruling out a different escalation:
 *
 * 1. `identity:manage` at all — a reviewer or speaker never holds it, so being staffed on an
 *    event grants no administrative reach. A **custom role** never holds it either, which is
 *    what stops a composed role from administering the roles that compose it.
 * 2. Membership of *this* organization — an organizer elsewhere holds a perfectly good
 *    actor-wide capability and it must not reach this organization.
 * 3. That the capability was earned inside this organization. Conditions 1 and 2 can be met by
 *    two different organizations at once: somebody who organizes an event in A and merely
 *    belongs to B would otherwise administer B on the strength of a grant A gave them.
 *
 * What this bounds is the *organization*, which is wider than `requireEventCapability` — an
 * organizer of one of its events administers the whole of it. That is intended and is stated in
 * `docs/architecture/authorization.md`, because somebody reading only the capability name would
 * assume otherwise.
 */
export async function requireOrganizationAdministration(
  actor: Actor | null,
  organizationId: string,
  events: OrganizationEventDirectory,
): Promise<Actor> {
  const authorized = requireCapability(actor, "identity:manage");
  if (!authorized.organizations.some(({ id }) => id === organizationId))
    throw new CapabilityDeniedError("Organization access denied");
  const candidateEventIds = authorized.eventAccess
    .filter(({ capabilities }) => capabilities.has("identity:manage"))
    .map(({ eventId }) => eventId);
  if ((await events.listEventIdsInOrganization(organizationId, candidateEventIds)).length > 0)
    return authorized;
  throw new CapabilityDeniedError("Actor lacks identity:manage inside this organization");
}

/**
 * The removal would leave this organization with nobody who can administer it.
 *
 * Separate from `MembershipRefusedError` because it is the one refusal with a *remedy* rather
 * than a reason: the caller is being told to staff a second administrator first, not that they
 * were never allowed.
 */
export class LastAdministratorError extends Error {
  constructor() {
    super(
      "This is the organization's last administrator. Grant somebody else the organizer role on one of its events first.",
    );
  }
}
