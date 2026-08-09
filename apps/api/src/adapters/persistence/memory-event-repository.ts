import type { EventRepository } from "../../application/events/event-repository";
import type { Event } from "../../domain/events/event";

export class MemoryEventRepository implements EventRepository {
  private readonly events = new Map<string, Event>();

  async create(event: Event): Promise<void> {
    this.events.set(event.id, event);
  }

  async list(): Promise<readonly Event[]> {
    return [...this.events.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  reset(): void {
    this.events.clear();
  }
}
