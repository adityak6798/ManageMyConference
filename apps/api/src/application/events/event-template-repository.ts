import type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";
import type { SliceResultReport, TemplateApplicationResult } from "./template-ports";

/**
 * A version as its author states it, with the one field the author does not choose left out.
 *
 * The number is allocated by storage *inside* the insert rather than read first and written
 * second. Two organizers capturing the same template at the same moment would otherwise both
 * read the same next number and the loser's insert would trip `UNIQUE (template_id, version)` —
 * a 500 naming a constraint, for a request with nothing wrong with it.
 */
export interface EventTemplateVersionDraft {
  readonly id: string;
  readonly templateId: string;
  readonly sourceEventId: string;
  readonly payload: EventTemplatePayload;
  readonly createdAt: string;
  readonly createdBy: string;
}

/**
 * What an application concluded, per category, as it is stored and read back.
 *
 * Typed rather than `unknown`, because this is now read as well as written (issue #175). It
 * carries the destination range on purpose: the range is a *parameter* of the clone rather than
 * a property of the event, so it is the one thing a repair could not otherwise reconstruct, and
 * without it "apply this again" would have to ask the organizer to retype two dates they
 * confirmed once already.
 */
export interface EventTemplateApplicationOutcome {
  readonly outcome: TemplateApplicationResult["outcome"];
  readonly destination: { readonly startsOn: string; readonly endsOn: string };
  /**
   * The category keys the command named, absent when it named none — which means every category
   * the version carries. Stored so a repair re-applies *what was asked for*: without it, an
   * application of two selected categories would be repaired by applying all six, which is a
   * different act than the one being repeated.
   *
   * Absent on rows written before issue #175 as well, and there it reads as the same "no
   * selection was recorded". That is the honest reading of a row that never stored one.
   */
  readonly selection?: readonly string[] | undefined;
  readonly slices: readonly SliceResultReport[];
}

export interface EventTemplateApplicationRecord {
  readonly id: string;
  readonly eventId: string;
  readonly templateVersionId: string;
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly outcome: EventTemplateApplicationOutcome;
}

/**
 * One application of one template version to this event, as a surface reads it back.
 *
 * `templateState` is carried because the repair depends on it: applying an archived template is
 * refused, so a console that offered "apply this again" without knowing would walk an organizer
 * into a 409 the page could have predicted.
 */
export interface EventTemplateApplicationView extends EventTemplateApplicationOutcome {
  readonly templateId: string;
  readonly templateName: string;
  readonly templateState: EventTemplateState;
  readonly templateVersionId: string;
  readonly version: number;
  readonly appliedAt: string;
  readonly appliedBy: string;
}

// @spec PRD-EVT-002
export interface EventTemplateRepository {
  /**
   * Write a template **and its first version as one transaction**, and answer the number
   * storage allocated for that version.
   *
   * There is deliberately no way to write a bare template. A template with no version is not a
   * lesser template, it is a husk: `GET /api/event-templates/{id}` answers 200 with an empty
   * version select, duplicating it answers 409, applying any version answers 404, and the name
   * is held against the partial unique index so saving again under the same name is refused
   * until somebody archives it. The pairing is the invariant, so the port offers no shape that
   * can break it (issue #177).
   *
   * Raises `EventTemplateNameTakenError` when an active template in the same organization
   * already holds the name. The uniqueness is the database's — a partial unique index over
   * active rows — so two concurrent saves cannot both win a read-then-write race, and the
   * mapping has to survive the batch: a name conflict answers 409, never 500.
   */
  createTemplateWithVersion(
    template: EventTemplate,
    version: EventTemplateVersionDraft,
  ): Promise<number>;
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
  /**
   * Append a version to a template that already exists, and answer the number it was given.
   *
   * Refuses rather than writes when the template is gone, so a version cannot outlive the row
   * it belongs to in the other direction either.
   */
  createVersion(version: EventTemplateVersionDraft): Promise<number>;
  findVersion(templateId: string, version: number): Promise<EventTemplateVersion | null>;
  listVersions(templateId: string): Promise<readonly EventTemplateVersion[]>;
  /**
   * Record which template version an event was configured from, and the per-slice outcome of
   * the most recent application. Converges on `(event_id, template_version_id)` so a retried
   * or repeated apply updates one row instead of accumulating them.
   */
  recordApplication(application: EventTemplateApplicationRecord): Promise<void>;
  /**
   * Every template version applied to this event, newest first, with the stored per-category
   * outcome. Nothing wrote `outcome_json` and then read it back before issue #175: a category
   * that did not land was reported once, in the response, and never mentioned again.
   */
  listApplications(eventId: string): Promise<readonly EventTemplateApplicationView[]>;
}
