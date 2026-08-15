// @spec PRD-EVT-001 PRD-EVT-002
export type { Event as EventView } from "../../domain/events/event";
export type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";
export { EventIdempotencyConflictError, EventService } from "./event-service";
export type { EventTemplateRepository } from "./event-template-repository";
export type {
  EventTemplateApplicationDetail,
  EventTemplateCapture,
  EventTemplateDetail,
  EventTemplateVersionView,
  SaveTemplateCommand,
  TemplateActorNamePort,
  TemplateApplicationCommand,
} from "./event-template-service";
export {
  EventTemplateNameTakenError,
  EventTemplateNotFoundError,
  EventTemplateRangeError,
  EventTemplateSelectionError,
  EventTemplateService,
  EventTemplateStateError,
} from "./event-template-service";
/**
 * The port each domain implements to contribute its own configuration to a template, and the
 * report vocabulary the orchestrator speaks. A slice implementation lives in its own domain's
 * application directory and imports only this surface (`ARC-DOM-001`).
 */
export {
  type DateRemap,
  type DeclaredExclusion,
  declaredExclusions,
  type EventConfigurationSlice,
  type SliceCaptureReport,
  type SliceContext,
  type SliceEntry,
  type SliceFault,
  type SliceOutcome,
  type SlicePreview,
  type SlicePreviewOutcome,
  type SlicePreviewReport,
  type SliceProvision,
  SliceRefusalError,
  type SliceResult,
  type SliceResultReport,
  type TemplateApplicationPlan,
  type TemplateApplicationResult,
} from "./template-ports";
