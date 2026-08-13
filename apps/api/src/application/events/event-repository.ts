import type { Event, Organization } from "../../domain/events/event";

// @spec PRD-EVT-001
export interface EventRepository {
  create(event: Event): Promise<void>;
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
