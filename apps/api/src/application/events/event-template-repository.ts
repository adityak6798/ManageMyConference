import type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";

export interface EventTemplateVersionRecord {
  readonly id: string;
  readonly templateId: string;
  readonly version: number;
  readonly sourceEventId: string;
  readonly payload: EventTemplatePayload;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface EventTemplateApplicationRecord {
  readonly id: string;
  readonly eventId: string;
  readonly templateVersionId: string;
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly outcome: unknown;
}

export interface EventTemplateApplicationView {
  readonly templateId: string;
  readonly templateName: string;
  readonly templateVersionId: string;
  readonly version: number;
  readonly appliedAt: string;
}

// @spec PRD-EVT-002
export interface EventTemplateRepository {
  /**
   * Write one template row.
   *
   * Raises `EventTemplateNameTakenError` when an active template in the same organization
   * already holds the name. The uniqueness is the database's — a partial unique index over
   * active rows — so two concurrent saves cannot both win a read-then-write race.
   */
  createTemplate(template: EventTemplate): Promise<void>;
  findTemplate(templateId: string): Promise<EventTemplate | null>;
  listTemplates(organizationId: string): Promise<readonly EventTemplate[]>;
  /**
   * Apply a name and/or state change. `false` when no such template exists, which the caller
   * turns into a not-found refusal rather than a silent success.
   */
  updateTemplate(
    templateId: string,
    changes: { readonly name?: string; readonly state?: EventTemplateState },
    updatedAt: string,
  ): Promise<boolean>;
  /** The next unused version number for this template; 1 when it has none. */
  nextVersion(templateId: string): Promise<number>;
  createVersion(version: EventTemplateVersionRecord): Promise<void>;
  findVersion(templateId: string, version: number): Promise<EventTemplateVersion | null>;
  listVersions(templateId: string): Promise<readonly EventTemplateVersion[]>;
  /**
   * Record which template version an event was configured from, and the per-slice outcome of
   * the most recent application. Converges on `(event_id, template_version_id)` so a retried
   * or repeated apply updates one row instead of accumulating them.
   */
  recordApplication(application: EventTemplateApplicationRecord): Promise<void>;
  /** Every template version applied to this event, newest first. */
  listApplications(eventId: string): Promise<readonly EventTemplateApplicationView[]>;
}
