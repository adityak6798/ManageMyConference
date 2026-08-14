import type { Event, Organization } from "../../domain/events/event";

/**
 * What else the write that creates an event has to carry.
 *
 * Both fields exist because an event and the things that make it usable have to commit
 * together. `organizerUserId` is the role its creator needs to open it at all — two unbatched
 * writes left an event nobody could reach (issue #164) — and `provisioningKey` is what makes a
 * second concurrent provisioner lose instead of creating a duplicate.
 */
export interface CreateEventOptions {
  /**
   * The organizer role to grant in the same durable write. The `event_roles` row belongs to
   * identity-access, so the adapter is handed a writer that renders it; this names the subject
   * and never the table.
   */
  readonly organizerUserId?: string;
  /**
   * Unique per organization, so a repeat of the same provisioning intent is refused rather than
   * duplicated. Absent for every event a person creates deliberately.
   */
  readonly provisioningKey?: string;
}

/**
 * Whether the row was written, or whether this organization already has an event provisioned
 * under the same key — in which case the caller adopts that one rather than trying again.
 */
export type CreateEventOutcome = "created" | "provisioning-key-taken";

// @spec PRD-EVT-001
export interface EventRepository {
  create(event: Event, options?: CreateEventOptions): Promise<CreateEventOutcome>;
  /** The event this organization was provisioned under `provisioningKey`, if it has one. */
  findByProvisioningKey(organizationId: string, provisioningKey: string): Promise<Event | null>;
  /**
   * Remove an organization that never became anybody's workspace, and refuse if it did.
   *
   * Self-serve signup writes the organization before the identity batch that would reference it,
   * so a failed signup leaves an unreferenced row and nothing sweeps it (issue #164). The guard
   * is part of the statement rather than a read before it: `true` means a row with no events was
   * deleted, `false` means there was nothing to delete or the organization has since been used.
   *
   * The guard covers this domain's own references — events and event templates — and no other
   * domain's, because it cannot read another domain's tables and must not pretend to. That is
   * sound for the one caller it has: the id is minted inside `provisionOrganization` and given
   * to exactly one signup, which discards it only when the batch that would have referenced it
   * failed whole. Any future caller owes that same argument.
   *
   * One case the guard does **not** cover on its own, and the reason it is still safe: a batch
   * that commits and whose response is lost surfaces to the caller as a failure with
   * `organization_memberships` already written. What refuses the delete then is that table's
   * `REFERENCES organizations(id)` (migration `0002`), which turns this statement into an error
   * rather than into a member of a deleted organization. That is storage doing the work, not
   * this predicate — worth knowing before anyone drops the constraint.
   */
  discardUnusedOrganization(organizationId: string): Promise<boolean>;
  /**
   * Write one organization row. Distinct from `create` because an organization is the container
   * an event needs before it can exist, and self-serve signup is the only caller.
   */
  createOrganization(organization: Organization & { readonly createdAt: string }): Promise<void>;
  update(eventId: string, name: string, timezone: string): Promise<Event | null>;
  list(scope: {
    organizationIds: readonly string[];
    eventIds: readonly string[];
  }): Promise<readonly Event[]>;
  findById(
    eventId: string,
    scope: { organizationIds: readonly string[]; eventIds: readonly string[] },
  ): Promise<Event | null>;
  /** Return only candidate events owned by the named organization, in one repository read. */
  /**
   * Every event this organization owns.
   *
   * Distinct from `listIdsInOrganization`, which filters a caller's candidates: this answers the
   * whole set, for a domain that has to scope its own tables by "the events of this
   * organization" and must not read `events` to find out which those are.
   */
  listAllIdsInOrganization(organizationId: string): Promise<readonly string[]>;
  listIdsInOrganization(
    organizationId: string,
    candidateEventIds: readonly string[],
  ): Promise<readonly string[]>;
}
