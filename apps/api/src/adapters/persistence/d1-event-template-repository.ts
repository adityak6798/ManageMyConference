import type {
  EventTemplateApplicationRecord,
  EventTemplateApplicationView,
  EventTemplateRepository,
  EventTemplateVersionRecord,
} from "../../application/events/event-template-repository";
import { EventTemplateNameTakenError } from "../../application/events/event-template-service";
import type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";
import type { D1DatabasePort } from "./d1-event-repository";
import { changedRows } from "./d1-write-result";

interface TemplateRow {
  id: string;
  organization_id: string;
  name: string;
  state: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  template_id: string;
  version: number;
  source_event_id: string;
  payload_json: string;
  created_at: string;
  created_by: string;
}

interface ApplicationRow {
  template_id: string;
  template_name: string;
  template_version_id: string;
  version: number;
  applied_at: string;
}

/** The state column is a CHECK-constrained pair; anything else means the row was written by hand. */
function rowToState(value: string, id: string): EventTemplateState {
  if (value === "active" || value === "archived") return value;
  throw new Error(`Event template ${id} has unknown state '${value}'`);
}

function rowToTemplate(row: TemplateRow): EventTemplate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    state: rowToState(row.state, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A stored payload is untrusted input by the time it is read back.
 *
 * `payload_json` carries a database CHECK for `json_valid`, so malformed text cannot land, but
 * *shape* is not constrained by anything. Parsing here and refusing a payload that is not an
 * object with the fields the orchestrator reads keeps a corrupt row from surfacing as
 * `undefined is not an object` three layers away.
 */
function rowToPayload(row: VersionRow): EventTemplatePayload {
  const parsed: unknown = JSON.parse(row.payload_json);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("source" in parsed) ||
    !("slices" in parsed)
  )
    throw new Error(`Event template version ${row.id} has an unreadable payload`);
  return parsed as EventTemplatePayload;
}

function rowToVersion(row: VersionRow): EventTemplateVersion {
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    sourceEventId: row.source_event_id,
    payload: rowToPayload(row),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const TEMPLATE_COLUMNS = "id, organization_id, name, state, created_at, updated_at";
const VERSION_COLUMNS =
  "id, template_id, version, source_event_id, payload_json, created_at, created_by";

// @spec PRD-EVT-002
export class D1EventTemplateRepository implements EventTemplateRepository {
  constructor(private readonly database: D1DatabasePort) {}

  async createTemplate(template: EventTemplate): Promise<void> {
    const result = await this.database
      .prepare(`INSERT INTO event_templates (${TEMPLATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        template.id,
        template.organizationId,
        template.name,
        template.state,
        template.createdAt,
        template.updatedAt,
      )
      .run()
      .catch((error: unknown) => {
        // ERROR-INTENT: The partial unique index over active rows is the name rule; a violation
        // is the organizer's answer, not a fault. Every other driver error is rethrown below.
        if (isNameConflict(error)) throw new EventTemplateNameTakenError(NAME_TAKEN);
        throw error;
      });
    if (!result.success) {
      if (isNameConflict(result.error)) throw new EventTemplateNameTakenError(NAME_TAKEN);
      throw new Error(`D1 failed to create event template: ${result.error ?? "unknown error"}`);
    }
    if (changedRows(result, "create an event template") !== 1)
      throw new Error("D1 reported no inserted row while creating an event template");
  }

  async findTemplate(templateId: string): Promise<EventTemplate | null> {
    const result = await this.database
      .prepare(`SELECT ${TEMPLATE_COLUMNS} FROM event_templates WHERE id = ? LIMIT 1`)
      .bind(templateId)
      .all<TemplateRow>();
    if (!result.success)
      throw new Error(`D1 failed to read event template: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? rowToTemplate(row) : null;
  }

  async listTemplates(organizationId: string): Promise<readonly EventTemplate[]> {
    const result = await this.database
      .prepare(
        `SELECT ${TEMPLATE_COLUMNS} FROM event_templates WHERE organization_id = ? ORDER BY state, name`,
      )
      .bind(organizationId)
      .all<TemplateRow>();
    if (!result.success)
      throw new Error(`D1 failed to list event templates: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(rowToTemplate);
  }

  async updateTemplate(
    templateId: string,
    changes: { readonly name?: string; readonly state?: EventTemplateState },
    updatedAt: string,
  ): Promise<boolean> {
    const assignments = [
      ...(changes.name === undefined ? [] : ["name = ?"]),
      ...(changes.state === undefined ? [] : ["state = ?"]),
      "updated_at = ?",
    ];
    const bindings = [
      ...(changes.name === undefined ? [] : [changes.name]),
      ...(changes.state === undefined ? [] : [changes.state]),
      updatedAt,
      templateId,
    ];
    const result = await this.database
      .prepare(`UPDATE event_templates SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...bindings)
      .run()
      .catch((error: unknown) => {
        // ERROR-INTENT: as in `createTemplate` — a renamed template colliding with a live name
        // is the organizer's answer. Anything else keeps travelling.
        if (isNameConflict(error)) throw new EventTemplateNameTakenError(NAME_TAKEN);
        throw error;
      });
    if (!result.success) {
      if (isNameConflict(result.error)) throw new EventTemplateNameTakenError(NAME_TAKEN);
      throw new Error(`D1 failed to update event template: ${result.error ?? "unknown error"}`);
    }
    // A missing count is a failure rather than "no such template": reporting a write whose fate
    // the driver would not state as a clean 404 is the disagreement issue #133 removed.
    return changedRows(result, "update an event template") > 0;
  }

  async nextVersion(templateId: string): Promise<number> {
    const result = await this.database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM event_template_versions WHERE template_id = ?",
      )
      .bind(templateId)
      .all<{ next: number }>();
    if (!result.success)
      throw new Error(
        `D1 failed to read the next template version: ${result.error ?? "unknown error"}`,
      );
    return result.results?.[0]?.next ?? 1;
  }

  async createVersion(version: EventTemplateVersionRecord): Promise<void> {
    const result = await this.database
      .prepare(
        `INSERT INTO event_template_versions (${VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        version.id,
        version.templateId,
        version.version,
        version.sourceEventId,
        JSON.stringify(version.payload),
        version.createdAt,
        version.createdBy,
      )
      .run();
    if (!result.success)
      throw new Error(
        `D1 failed to create an event template version: ${result.error ?? "unknown error"}`,
      );
    if (changedRows(result, "create an event template version") !== 1)
      throw new Error("D1 reported no inserted row while creating an event template version");
  }

  async findVersion(templateId: string, version: number): Promise<EventTemplateVersion | null> {
    const result = await this.database
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM event_template_versions WHERE template_id = ? AND version = ? LIMIT 1`,
      )
      .bind(templateId, version)
      .all<VersionRow>();
    if (!result.success)
      throw new Error(
        `D1 failed to read an event template version: ${result.error ?? "unknown error"}`,
      );
    const row = result.results?.[0];
    return row ? rowToVersion(row) : null;
  }

  async listVersions(templateId: string): Promise<readonly EventTemplateVersion[]> {
    const result = await this.database
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM event_template_versions WHERE template_id = ? ORDER BY version DESC`,
      )
      .bind(templateId)
      .all<VersionRow>();
    if (!result.success)
      throw new Error(
        `D1 failed to list event template versions: ${result.error ?? "unknown error"}`,
      );
    return (result.results ?? []).map(rowToVersion);
  }

  async recordApplication(application: EventTemplateApplicationRecord): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO event_template_applications (id, event_id, template_version_id, applied_at, applied_by, outcome_json)" +
          " VALUES (?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(event_id, template_version_id) DO UPDATE SET" +
          " applied_at = excluded.applied_at, applied_by = excluded.applied_by, outcome_json = excluded.outcome_json",
      )
      .bind(
        application.id,
        application.eventId,
        application.templateVersionId,
        application.appliedAt,
        application.appliedBy,
        JSON.stringify(application.outcome),
      )
      .run();
    if (!result.success)
      throw new Error(
        `D1 failed to record a template application: ${result.error ?? "unknown error"}`,
      );
    if (changedRows(result, "record a template application") !== 1)
      throw new Error("D1 reported no written row while recording a template application");
  }

  async listApplications(eventId: string): Promise<readonly EventTemplateApplicationView[]> {
    const result = await this.database
      .prepare(
        "SELECT versions.template_id AS template_id, templates.name AS template_name," +
          " applications.template_version_id AS template_version_id, versions.version AS version," +
          " applications.applied_at AS applied_at" +
          " FROM event_template_applications AS applications" +
          " JOIN event_template_versions AS versions ON versions.id = applications.template_version_id" +
          " JOIN event_templates AS templates ON templates.id = versions.template_id" +
          " WHERE applications.event_id = ? ORDER BY applications.applied_at DESC",
      )
      .bind(eventId)
      .all<ApplicationRow>();
    if (!result.success)
      throw new Error(
        `D1 failed to list template applications: ${result.error ?? "unknown error"}`,
      );
    return (result.results ?? []).map((row) => ({
      templateId: row.template_id,
      templateName: row.template_name,
      templateVersionId: row.template_version_id,
      version: row.version,
      appliedAt: row.applied_at,
    }));
  }
}

const NAME_TAKEN = "Another active template in this organization already uses that name";

/**
 * SQLite words a partial-unique-index violation by naming the index, not the columns, so the
 * name is matched as well as the generic phrase. `event_templates.name` appears when a future
 * migration promotes the index to a table constraint.
 */
function isNameConflict(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return (
    /UNIQUE constraint failed/i.test(text) &&
    /event_templates_active_name_idx|event_templates\.name/i.test(text)
  );
}
