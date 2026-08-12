import type { CreateEventInput, EventDto, UpdateEventInput } from "@greenroom/contracts";
import type {
  CreateEventCommand,
  UpdateEventCommand,
} from "../../application/events/event-service";
import type { EventView } from "../../application/events/public";

export const createEventInputToCommand = (input: CreateEventInput): CreateEventCommand => ({
  organizationId: input.organizationId,
  name: input.name,
  timezone: input.timezone,
});
export const updateEventInputToCommand = (input: UpdateEventInput): UpdateEventCommand => input;

export const eventToDto = (event: EventView): EventDto => ({ ...event });
