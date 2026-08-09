import type { Event } from "../../domain/events/event";

// @spec PRD-EVT-001
export interface EventRepository {
  create(event: Event): Promise<void>;
  list(): Promise<readonly Event[]>;
}
