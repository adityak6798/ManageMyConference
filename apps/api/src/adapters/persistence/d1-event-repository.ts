import type { EventRepository } from "../../application/events/event-repository";
import type { Event } from "../../domain/events/event";
import { type EventRow, eventToRow, rowToEvent } from "./event-mappers";

export interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T>(): Promise<D1Result<T>>;
}

export interface D1DatabasePort {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export class D1EventRepository implements EventRepository {
  constructor(private readonly database: D1DatabasePort) {}

  async create(event: Event): Promise<void> {
    const row = eventToRow(event);
    const result = await this.database
      .prepare(
        "INSERT INTO events (id, organization_id, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.organization_id, row.name, row.timezone, row.created_at)
      .run();
    if (!result.success) {
      throw new Error(`D1 failed to create event: ${result.error ?? "unknown error"}`);
    }
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
