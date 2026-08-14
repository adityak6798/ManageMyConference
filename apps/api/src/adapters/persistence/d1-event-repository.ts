import type {
  CreateEventOptions,
  CreateEventOutcome,
  EventRepository,
} from "../../application/events/event-repository";
import type { Event, Organization } from "../../domain/events/event";
import { type EventRow, eventToRow, rowToEvent } from "./event-mappers";
import { changedRows, type D1WriteResult } from "./d1-write-result";

export interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<D1Result<T>>;
}

export interface D1DatabasePort {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

/**
 * This organization already has an event provisioned under this key, rather than anything else.
 *
 * Named by column and not merely by table, following `d1-agenda-repository.ts`: `events` carries
 * a primary key too, and reading "the id collided" as "somebody else provisioned first" would
 * make a caller adopt a stranger's event. SQLite words the two forms of the failure differently,
 * so both are matched.
 */
function isProvisioningKeyTaken(error: unknown): boolean {
  // D1 puts the SQLite message on the error itself, and Miniflare sometimes only on its cause.
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error ?? "");
  if (!text.includes("UNIQUE constraint failed") && !text.includes("PRIMARY KEY must be unique"))
    return false;
  return text.includes("events.provisioning_key");
}

/**
 * The organizer role that has to commit with the event row, rendered by whoever owns that table.
 *
 * `event_roles` belongs to identity-access (`table-ownership.json`), and an event whose creator
 * never got the role is an event nobody can open — the two writes were unbatched, so a failure
 * between them left exactly that (issue #164). The composition root binds this to identity's own
 * `preparedOrganizerGrant`, and the statements come back opaque to be appended to the batch this
 * insert was going to run anyway. Same shape as `PublicationEventWriter` in the agenda adapter,
 * and for the same reason: the SQL and the column names stay in the domain that owns them.
 *
 * Optional, because the in-memory compositions and the cron's read-only `EventService` bind
 * nothing. A create that asks for a grant with no writer bound is refused rather than written
 * without one — a silently role-less event is the defect, not the recovery.
 */
export type OrganizerGrantWriter = (
  database: D1DatabasePort,
  grant: { readonly eventId: string; readonly userId: string },
) => readonly D1PreparedStatement[];

export class D1EventRepository implements EventRepository {
  constructor(
    private readonly database: D1DatabasePort,
    private readonly writeOrganizerGrant?: OrganizerGrantWriter,
  ) {}

  /**
   * The event row and, when one is asked for, the organizer role on it — in one batch.
   *
   * A `provisioningKey` that is already taken in this organization is reported rather than
   * thrown: the caller adopts the event that won. The uniqueness failure is matched by column,
   * following `d1-agenda-repository.ts`, so a foreign-key failure or a future constraint is not
   * quietly read as "somebody else got here first".
   */
  async create(event: Event, options: CreateEventOptions = {}): Promise<CreateEventOutcome> {
    const row = eventToRow(event);
    if (options.organizerUserId !== undefined && !this.writeOrganizerGrant)
      throw new Error(
        "D1 cannot create an event with an organizer grant: no organizer grant writer is bound",
      );
    const statements = [
      this.database
        .prepare(
          "INSERT INTO events (id, organization_id, name, timezone, created_at, provisioning_key) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          row.id,
          row.organization_id,
          row.name,
          row.timezone,
          row.created_at,
          options.provisioningKey ?? null,
        ),
      ...(options.organizerUserId !== undefined && this.writeOrganizerGrant
        ? this.writeOrganizerGrant(this.database, {
            eventId: event.id,
            userId: options.organizerUserId,
          })
        : []),
    ];
    let results: Array<D1WriteResult & { results?: unknown[] }>;
    try {
      results = await this.database.batch(statements);
    } catch (error) {
      if (options.provisioningKey !== undefined && isProvisioningKeyTaken(error))
        return "provisioning-key-taken";
      throw error;
    }
    const failed = results.find((result) => !result.success);
    if (failed) {
      // A batch that reports failure without throwing: the whole transaction rolled back, so the
      // key was not consumed either and the caller learns the same thing it would from a throw.
      if (options.provisioningKey !== undefined && isProvisioningKeyTaken(failed.error))
        return "provisioning-key-taken";
      throw new Error(`D1 failed to create event: ${failed.error ?? "unknown error"}`);
    }
    return "created";
  }

  async findByProvisioningKey(
    organizationId: string,
    provisioningKey: string,
  ): Promise<Event | null> {
    const result = await this.database
      .prepare(
        "SELECT id, organization_id, name, timezone, created_at FROM events WHERE organization_id = ? AND provisioning_key = ? LIMIT 1",
      )
      .bind(organizationId, provisioningKey)
      .all<EventRow>();
    if (!result.success)
      throw new Error(`D1 failed to find provisioned event: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? rowToEvent(row) : null;
  }

  /**
   * Delete an organization that holds nothing of this domain's, and report whether one went.
   *
   * The count is load-bearing — the whole point is to distinguish "the orphan is gone" from "it
   * was not an orphan" — so a driver that omits `meta.changes` is refused rather than read as
   * either, following the rule `d1-content-repository.ts` sets.
   */
  async discardUnusedOrganization(organizationId: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        "DELETE FROM organizations WHERE id = ? AND NOT EXISTS (SELECT 1 FROM events WHERE organization_id = ?) AND NOT EXISTS (SELECT 1 FROM event_templates WHERE organization_id = ?)",
      )
      .bind(organizationId, organizationId, organizationId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to discard organization: ${result.error ?? "unknown error"}`);
    return changedRows(result, "discard an unused organization") > 0;
  }

  async createOrganization(organization: Organization & { createdAt: string }): Promise<void> {
    const result = await this.database
      .prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
      .bind(organization.id, organization.name, organization.createdAt)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create organization: ${result.error ?? "unknown error"}`);
  }

  async update(eventId: string, name: string, timezone: string): Promise<Event | null> {
    const result = await this.database
      .prepare("UPDATE events SET name = ?, timezone = ? WHERE id = ?")
      .bind(name, timezone, eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to update event: ${result.error ?? "unknown error"}`);
    const loaded = await this.database
      .prepare(
        "SELECT id, organization_id, name, timezone, created_at FROM events WHERE id = ? LIMIT 1",
      )
      .bind(eventId)
      .all<EventRow>();
    if (!loaded.success)
      throw new Error(`D1 failed to reload updated event: ${loaded.error ?? "unknown error"}`);
    return loaded.results?.[0] ? rowToEvent(loaded.results[0]) : null;
  }

  async list(scope: {
    organizationIds: readonly string[];
    eventIds: readonly string[];
  }): Promise<readonly Event[]> {
    const organizationIds = [...new Set(scope.organizationIds)];
    const eventIds = [...new Set(scope.eventIds)];
    if (organizationIds.length === 0 && eventIds.length === 0) return [];
    const organizationPlaceholders = organizationIds.map(() => "?").join(", ");
    const eventPlaceholders = eventIds.map(() => "?").join(", ");
    const clauses = [
      ...(organizationIds.length ? [`organization_id IN (${organizationPlaceholders})`] : []),
      ...(eventIds.length ? [`id IN (${eventPlaceholders})`] : []),
    ];
    const result = await this.database
      .prepare(
        `SELECT id, organization_id, name, timezone, created_at FROM events WHERE ${clauses.join(" OR ")} ORDER BY created_at`,
      )
      .bind(...organizationIds, ...eventIds)
      .all<EventRow>();
    if (!result.success) {
      throw new Error(`D1 failed to list events: ${result.error ?? "unknown error"}`);
    }
    return (result.results ?? []).map(rowToEvent);
  }

  async findById(
    eventId: string,
    scope: { organizationIds: readonly string[]; eventIds: readonly string[] },
  ): Promise<Event | null> {
    const organizationIds = [...new Set(scope.organizationIds)];
    const eventIds = [...new Set(scope.eventIds)];
    if (organizationIds.length === 0 && eventIds.length === 0) return null;
    const clauses = [
      ...(organizationIds.length
        ? [`organization_id IN (${organizationIds.map(() => "?").join(", ")})`]
        : []),
      ...(eventIds.length ? [`id IN (${eventIds.map(() => "?").join(", ")})`] : []),
    ];
    const result = await this.database
      .prepare(
        `SELECT id, organization_id, name, timezone, created_at FROM events WHERE id = ? AND (${clauses.join(" OR ")}) LIMIT 1`,
      )
      .bind(eventId, ...organizationIds, ...eventIds)
      .all<EventRow>();
    if (!result.success)
      throw new Error(`D1 failed to find event: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? rowToEvent(row) : null;
  }

  async listAllIdsInOrganization(organizationId: string) {
    const result = await this.database
      .prepare("SELECT id FROM events WHERE organization_id = ? ORDER BY id")
      .bind(organizationId)
      .all<{ id: string }>();
    if (!result.success)
      throw new Error(
        `D1 failed to list the events of an organization: ${result.error ?? "unknown error"}`,
      );
    return (result.results ?? []).map(({ id }) => id);
  }

  async listIdsInOrganization(organizationId: string, candidateEventIds: readonly string[]) {
    const eventIds = [...new Set(candidateEventIds)];
    if (eventIds.length === 0) return [];
    const result = await this.database
      .prepare(
        "SELECT id FROM events WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY id",
      )
      .bind(organizationId, JSON.stringify(eventIds))
      .all<{ id: string }>();
    if (!result.success)
      throw new Error(
        `D1 failed to list event ids in organization: ${result.error ?? "unknown error"}`,
      );
    return (result.results ?? []).map(({ id }) => id);
  }
}
