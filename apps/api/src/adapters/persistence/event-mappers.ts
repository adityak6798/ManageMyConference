import type { Event } from "../../domain/events/event";

export interface EventRow {
  id: string;
  name: string;
  timezone: string;
  created_at: string;
}

export const eventToRow = (event: Event): EventRow => ({
  id: event.id,
  name: event.name,
  timezone: event.timezone,
  created_at: event.createdAt,
});

export const rowToEvent = (row: EventRow): Event => ({
  id: row.id,
  name: row.name,
  timezone: row.timezone,
  createdAt: row.created_at,
});
