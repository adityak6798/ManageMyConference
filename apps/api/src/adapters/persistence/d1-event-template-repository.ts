import type {
  EventTemplateApplicationOutcome,
  EventTemplateApplicationRecord,
  EventTemplateApplicationView,
  EventTemplateRepository,
  EventTemplateVersionDraft,
} from "../../application/events/event-template-repository";
import { EventTemplateNameTakenError } from "../../application/events/event-template-service";
import type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";
import type { D1DatabasePort, D1PreparedStatement } from "./d1-event-repository";
import { changedRows, type D1WriteResult } from "./d1-write-result";

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
  template_state: string;
  template_version_id: string;
  version: number;
  applied_at: string;
  applied_by: string;
  outcome_json: string;
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

/**
 * A stored application outcome, refused rather than trusted, exactly as `rowToPayload` is.
 *
 * `outcome_json` carries a `json_valid` CHECK and nothing more, so shape is unconstrained. A row
 * this adapter cannot read is a fault here rather than an `undefined.map` in the console, and
 * `slices` is required because it is the whole reason the surface reads this back: an outcome
 * word with no categories under it would render "applied in part" over an empty list.
 */
function rowToOutcome(row: ApplicationRow): EventTemplateApplicationOutcome {
  const parsed: unknown = JSON.parse(row.outcome_json);
  const refuse = () => {
    throw new Error(
      `Event template application for version ${row.template_version_id} has an unreadable outcome`,
    );
  };
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("outcome" in parsed) ||
    // The envelope word, against the set the contract publishes rather than "is a string": an
    // unknown word here reaches the DTO intact and fails the *client's* decode, turning a row
    // this adapter could have refused into a 200 the browser cannot read.
    !APPLICATION_OUTCOMES.has((parsed as { outcome: unknown }).outcome as string) ||
    !("slices" in parsed) ||
    !Array.isArray((parsed as { slices: unknown }).slices) ||
    !("destination" in parsed)
  )
    refuse();
  /*
   * The two fields beside `slices`, to the depth their readers reach.
   *
   * The card renders `destination.startsOn` and `.endsOn`, and the mapper spreads `selection`.
   * Checking that the keys are merely *present* left both a `TypeError` one layer out, which is
   * the failure this function claims to convert into a named fault.
   */
  const shape = parsed as { destination?: unknown; selection?: unknown };
  const destination = shape.destination as { startsOn?: unknown; endsOn?: unknown } | null;
  if (
    typeof destination !== "object" ||
    destination === null ||
    typeof destination.startsOn !== "string" ||
    typeof destination.endsOn !== "string" ||
    // Absent is the honest reading of a row written before the selection was stored; present and
    // not a list of strings is a row nothing in this system wrote.
    (shape.selection !== undefined &&
      (!Array.isArray(shape.selection) || !shape.selection.every((key) => typeof key === "string")))
  )
    refuse();
  const outcome = parsed as EventTemplateApplicationOutcome;
  /*
   * Each category, not just the array around them.
   *
   * The transport maps `applied` and `incompatible` entry by entry, so a row whose `slices` hold
   * `[{}]` — hand-written, or written by a shape this code no longer speaks — would be an
   * `undefined.map` three layers away, which is the exact failure the check above exists to
   * prevent. Refusing here is what makes the promise in this comment true rather than aspirational.
   */
  for (const slice of outcome.slices)
    if (
      typeof slice !== "object" ||
      slice === null ||
      typeof slice.key !== "string" ||
      typeof slice.label !== "string" ||
      // Same closed set, per category, for the same reason.
      !SLICE_OUTCOMES.has(slice.outcome as string) ||
      typeof slice.reason !== "string" ||
      !Array.isArray(slice.applied) ||
      !Array.isArray(slice.incompatible) ||
      // The mapper destructures `{ id, label }` per entry, so the entries are checked too — a
      // stored `applied: [null]` is otherwise the same `undefined.map` one level further in.
      ![...slice.applied, ...slice.incompatible].every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.id === "string" &&
          typeof entry.label === "string",
      )
    )
      refuse();
  return outcome;
}

/**
 * The two closed sets a stored outcome is written from, checked rather than assumed.
 *
 * The contract pins both (`templateApplicationResultSchema`, `sliceResultSchema`), and the client
 * decodes against it — so a word outside them is a 200 whose body the browser refuses, which is a
 * worse failure than the refusal this adapter exists to raise. Kept next to the reader that uses
 * them so a widened vocabulary is a compile-adjacent edit rather than a silent divergence.
 */
const APPLICATION_OUTCOMES = new Set(["applied", "partial", "failed", "skipped"]);
const SLICE_OUTCOMES = new Set(["applied", "skipped", "incompatible", "unauthorized", "failed"]);

const TEMPLATE_COLUMNS = "id, organization_id, name, state, created_at, updated_at";
const VERSION_COLUMNS =
  "id, template_id, version, source_event_id, payload_json, created_at, created_by";

/**
 * The version insert, which allocates its own number and refuses to land without its template.
 *
 * Two properties, both structural rather than conventional:
 *
 * - **The number comes from the same statement**, so two organizers capturing one template at
 *   once cannot both read the same `MAX(version) + 1` and race each other into
 *   `UNIQUE (template_id, version)`. `RETURNING` is what lets the caller learn the allocated
 *   value without a second read another writer could interleave with.
 * - **`WHERE EXISTS` is the compare-and-swap half**: no version row is written unless its
 *   template row is there to be pointed at. Inside `createTemplateWithVersion` that template is
 *   the batch's own first statement, so the guard reads what the transaction has already done;
 *   used on its own it is what turns "the template was archived away under me" into zero rows
 *   changed instead of a foreign-key fault, and zero changed rows is refused by the caller.
 */
const VERSION_INSERT =
  `INSERT INTO event_template_versions (${VERSION_COLUMNS})` +
  " SELECT ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM event_template_versions WHERE template_id = ?), ?, ?, ?, ?" +
  " WHERE EXISTS (SELECT 1 FROM event_templates WHERE id = ?)" +
  " RETURNING version";

// @spec PRD-EVT-002
export class D1EventTemplateRepository implements EventTemplateRepository {
  constructor(private readonly database: D1DatabasePort) {}

  /**
   * The template and its first version, in one `batch` — which D1 runs as one transaction.
   *
   * This is the fix for issue #177, and the shape is the one issue #116 used in content. Before
   * it, `saveFromEvent` wrote the template, then ran six cross-domain slice exports, then wrote
   * the version; a failure anywhere in that window left an active template with no versions —
   * a row the console lists with an empty version select, that duplicating answers 409 for, that
   * every apply answers 404 for, and whose name is still held against the partial unique index.
   * Neither row can now outlive the other: the version insert carries `WHERE EXISTS` on the
   * template, and a template insert the index refuses takes the version down with it.
   *
   * The name-conflict mapping had to be re-established for the batch, and that is the reason
   * this was not a mechanical lift. A batch reports a bad statement two ways — a rejected
   * promise or an unsuccessful result — so both are read, and both answer 409 rather than a 500
   * describing an index by name.
   */
  async createTemplateWithVersion(
    template: EventTemplate,
    version: EventTemplateVersionDraft,
  ): Promise<number> {
    const results = await this.database
      .batch<{ version: number }>([
        this.database
          .prepare(`INSERT INTO event_templates (${TEMPLATE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(
            template.id,
            template.organizationId,
            template.name,
            template.state,
            template.createdAt,
            template.updatedAt,
          ),
        this.versionStatement(version),
      ])
      .catch((error: unknown) => {
        // ERROR-INTENT: The partial unique index over active rows is the name rule; a violation
        // is the organizer's answer, not a fault. Every other driver error is rethrown.
        if (isNameConflict(error)) throw new EventTemplateNameTakenError(NAME_TAKEN);
        throw error;
      });
    const failed = results.find((result) => !result.success);
    if (failed) {
      if (isNameConflict(failed.error)) throw new EventTemplateNameTakenError(NAME_TAKEN);
      throw new Error(`D1 failed to create event template: ${failed.error ?? "unknown error"}`);
    }
    const [created, versioned] = results;
    if (!created || changedRows(created, "create an event template") !== 1)
      throw new Error("D1 reported no inserted row while creating an event template");
    return this.allocated(versioned, "create an event template version");
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

  async createVersion(version: EventTemplateVersionDraft): Promise<number> {
    const result = await this.versionStatement(version).run<{ version: number }>();
    if (!result.success)
      throw new Error(
        `D1 failed to create an event template version: ${result.error ?? "unknown error"}`,
      );
    return this.allocated(result, "create an event template version");
  }

  private versionStatement(version: EventTemplateVersionDraft): D1PreparedStatement {
    return this.database
      .prepare(VERSION_INSERT)
      .bind(
        version.id,
        version.templateId,
        version.templateId,
        version.sourceEventId,
        JSON.stringify(version.payload),
        version.createdAt,
        version.createdBy,
        version.templateId,
      );
  }

  /**
   * The version number storage allocated, or a refusal — never a guess.
   *
   * Zero changed rows is the `WHERE EXISTS` guard refusing: the template is not there, so no
   * version was written and the caller must not be told one was. A driver that wrote the row but
   * cannot say which number it chose is refused for the same reason `d1-write-result.ts` refuses
   * a missing `meta.changes` — reading silence as "1" would report the wrong version back to an
   * organizer and store it in the application record that says what they cloned.
   */
  private allocated(
    result: (D1WriteResult & { results?: { version: number }[] }) | undefined,
    operation: string,
  ): number {
    if (!result) throw new Error(`D1 reported no result while attempting to ${operation}`);
    if (changedRows(result, operation) !== 1)
      throw new Error(`D1 reported no inserted row while attempting to ${operation}`);
    const version = result.results?.[0]?.version;
    if (typeof version !== "number")
      throw new Error(`D1 reported no version number while attempting to ${operation}`);
    return version;
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
          " templates.state AS template_state," +
          " applications.template_version_id AS template_version_id, versions.version AS version," +
          " applications.applied_at AS applied_at, applications.applied_by AS applied_by," +
          " applications.outcome_json AS outcome_json" +
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
      templateState: rowToState(row.template_state, row.template_id),
      templateVersionId: row.template_version_id,
      version: row.version,
      appliedAt: row.applied_at,
      appliedBy: row.applied_by,
      ...rowToOutcome(row),
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
