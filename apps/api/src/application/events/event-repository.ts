import type { Event } from "../../domain/events/event";

// @spec PRD-EVT-001
export interface EventRepository {
  create(event: Event): Promise<void>;
  list(scope: {
    organizationIds: readonly string[];
    eventIds: readonly string[];
  }): Promise<readonly Event[]>;
  findById(
    eventId: string,
    scope: { organizationIds: readonly string[]; eventIds: readonly string[] },
  ): Promise<Event | null>;
  /** Return only candidate events owned by the named organization, in one repository read. */
  listIdsInOrganization(
    organizationId: string,
    candidateEventIds: readonly string[],
  ): Promise<readonly string[]>;
}
