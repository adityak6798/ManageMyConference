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
}

export class D1EventRepository implements EventRepository {
  constructor(private readonly database: D1DatabasePort) {}

  async create(event: Event): Promise<void> {
    const row = eventToRow(event);
    const result = await this.database
      .prepare("INSERT INTO events (id, name, timezone, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, row.name, row.timezone, row.created_at)
      .run();
    if (!result.success) {
      throw new Error(`D1 failed to create event: ${result.error ?? "unknown error"}`);
    }
  }

  async list(): Promise<readonly Event[]> {
    const result = await this.database
      .prepare("SELECT id, name, timezone, created_at FROM events ORDER BY created_at")
      .all<EventRow>();
    if (!result.success) {
      throw new Error(`D1 failed to list events: ${result.error ?? "unknown error"}`);
    }
    return (result.results ?? []).map(rowToEvent);
  }
}
