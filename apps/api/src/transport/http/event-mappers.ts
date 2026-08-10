import type { CreateEventInput, EventDto } from "@greenroom/contracts";
import type { CreateEventCommand } from "../../application/events/event-service";
import type { EventView } from "../../application/events/public";

export const createEventInputToCommand = (input: CreateEventInput): CreateEventCommand => ({
  organizationId: input.organizationId,
  name: input.name,
  timezone: input.timezone,
});

export const eventToDto = (event: EventView): EventDto => ({ ...event });
