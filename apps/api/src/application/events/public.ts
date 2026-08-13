// @spec PRD-EVT-001 PRD-EVT-002
export type { Event as EventView } from "../../domain/events/event";
export type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";
export { EventService } from "./event-service";
export {
  EventTemplateNameTakenError,
  EventTemplateNotFoundError,
  EventTemplateRangeError,
  EventTemplateService,
  EventTemplateStateError,
} from "./event-template-service";
export type {
  EventTemplateCapture,
  EventTemplateDetail,
  SaveTemplateCommand,
  TemplateApplicationCommand,
} from "./event-template-service";
export type { EventTemplateRepository } from "./event-template-repository";
/**
 * The port each domain implements to contribute its own configuration to a template, and the
 * report vocabulary the orchestrator speaks. A slice implementation lives in its own domain's
 * application directory and imports only this surface (`ARC-DOM-001`).
 */
export {
  declaredExclusions,
  type DateRemap,
  type DeclaredExclusion,
  type EventConfigurationSlice,
  type SliceCaptureReport,
  type SliceEntry,
  type SliceOutcome,
  type SlicePreview,
  type SlicePreviewOutcome,
  type SlicePreviewReport,
  type SliceResult,
  type SliceResultReport,
  type TemplateApplicationPlan,
  type TemplateApplicationResult,
} from "./template-ports";
