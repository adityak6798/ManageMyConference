import type {
  CreateEventInput,
  EventDto,
  EventTemplateDto,
  EventTemplateVersionDto,
  UpdateEventInput,
} from "@greenroom/contracts";
import type {
  CreateEventCommand,
  UpdateEventCommand,
} from "../../application/events/event-service";
import type {
  EventTemplate,
  EventTemplateVersion,
  EventView,
} from "../../application/events/public";

export const createEventInputToCommand = (input: CreateEventInput): CreateEventCommand => ({
  organizationId: input.organizationId,
  name: input.name,
  timezone: input.timezone,
});
export const updateEventInputToCommand = (input: UpdateEventInput): UpdateEventCommand => input;

export const eventToDto = (event: EventView): EventDto => ({ ...event });

export const eventTemplateToDto = (template: EventTemplate): EventTemplateDto => ({ ...template });

/**
 * A version, described rather than dumped.
 *
 * The stored slice payloads never cross this boundary: they are the private shape of the
 * domain that wrote them, and a console that renders them would be reading CFP's or agenda's
 * internals through the events surface. What a caller needs is which categories the version
 * holds and where it came from, so that is what it gets.
 */
export const eventTemplateVersionToDto = (
  version: EventTemplateVersion,
): EventTemplateVersionDto => ({
  id: version.id,
  version: version.version,
  sourceEventId: version.sourceEventId,
  sourceEventName: version.payload.source.eventName,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  slices: Object.entries(version.payload.slices)
    .filter(([, payload]) => payload != null)
    .map(([key]) => key)
    .sort(),
});
