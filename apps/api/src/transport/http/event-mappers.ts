import type {
  CreateEventInput,
  EventDto,
  EventTemplateApplicationDto,
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
  EventTemplateApplicationDetail,
  EventTemplateVersionView,
  EventView,
} from "../../application/events/public";

export const createEventInputToCommand = (input: CreateEventInput): CreateEventCommand => ({
  organizationId: input.organizationId,
  idempotencyKey: input.idempotencyKey,
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
  version: EventTemplateVersionView,
): EventTemplateVersionDto => ({
  id: version.id,
  version: version.version,
  sourceEventId: version.sourceEventId,
  sourceEventName: version.payload.source.eventName,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  createdByName: version.createdByName,
  slices: Object.entries(version.payload.slices)
    .filter(([, payload]) => payload != null)
    .map(([key]) => key)
    .sort(),
});

/**
 * One past application, as the console reads it back.
 *
 * Mapped field by field rather than spread, so a field added to the stored outcome for one
 * domain's benefit does not become part of an API payload by accident — which is the same rule
 * `eventTemplateVersionToDto` follows about the slice payloads themselves.
 */
export const eventTemplateApplicationToDto = (
  application: EventTemplateApplicationDetail,
): EventTemplateApplicationDto => ({
  templateId: application.templateId,
  templateName: application.templateName,
  templateState: application.templateState,
  templateVersionId: application.templateVersionId,
  version: application.version,
  appliedAt: application.appliedAt,
  appliedBy: application.appliedBy,
  appliedByName: application.appliedByName,
  outcome: application.outcome,
  destination: application.destination,
  ...(application.selection === undefined ? {} : { selection: [...application.selection] }),
  slices: application.slices.map((slice) => ({
    key: slice.key,
    label: slice.label,
    outcome: slice.outcome,
    reason: slice.reason,
    applied: slice.applied.map(({ id, label }) => ({ id, label })),
    incompatible: slice.incompatible.map(({ id, label }) => ({ id, label })),
  })),
});
