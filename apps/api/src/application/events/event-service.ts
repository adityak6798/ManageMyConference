import type { Event } from "../../domain/events/event";
import { type Actor, requireCapability } from "../identity/actor";
import type { EventRepository } from "./event-repository";

export interface CreateEventCommand {
  readonly name: string;
  readonly timezone: string;
}

export interface EventServiceDependencies {
  repository: EventRepository;
  newId: () => string;
  now: () => Date;
}

// @spec PRD-EVT-001
export class EventService {
  constructor(private readonly dependencies: EventServiceDependencies) {}

  async create(actor: Actor | null, command: CreateEventCommand): Promise<Event> {
    requireCapability(actor, "events:create");
    const event: Event = {
      id: this.dependencies.newId(),
      name: command.name,
      timezone: command.timezone,
      createdAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.repository.create(event);
    return event;
  }

  list(actor: Actor | null): Promise<readonly Event[]> {
    requireCapability(actor, "events:read");
    return this.dependencies.repository.list();
  }
}
