/**
 * `ReportRepository` against D1.
 *
 * Share links are deliberately **not** here: they live in `d1-capability-links.ts`, because the
 * shape is not reporting's. `DEBT-012`'s conditions hold for every anonymous link in this
 * product, and a per-domain token table is how two of them come to disagree about revocation.
 *
 * **`recordRun` is a claim whose uniqueness is the arbiter.** It happens before delivery, and
 * `UNIQUE(schedule_id, occurrence_key)` is what turns "the same occurrence" into "at most one
 * delivery" across a retried tick or two Workers racing. The schedule's watermark moves in the
 * same batch; `finishRun` replaces the fail-safe failed claim after the external effect returns.
 *
 * @spec PRD-OPS-001 ARC-003
 */
import type { ReportDatasetKey, ReportQuery } from "../../application/platform/report-catalogue";
import {
  type ReportDefinition,
  ReportNameTakenError,
  type ReportRepository,
  type ReportRun,
  type ReportSchedule,
} from "../../application/platform/reporting-service";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface ReportDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface DefinitionRow {
  id: string;
  event_id: string;
  organization_id: string;
  name: string;
  description: string;
  dataset: ReportDatasetKey;
  query_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
}
interface ScheduleRow {
  id: string;
  report_id: string;
  cadence: ReportSchedule["cadence"];
  minute_of_day: number;
  day_of_week: number | null;
  day_of_month: number | null;
  timezone: string;
  recipients: string;
  link_lifetime_hours: number;
  created_by: string;
  created_at: string;
  paused_at: string | null;
  last_fired_key: string | null;
  scope_json: string;
}

const DEFINITION_COLUMNS =
  "id, event_id, organization_id, name, description, dataset, query_json, created_by, created_at, updated_at, revision";
const SCHEDULE_COLUMNS =
  "id, report_id, cadence, minute_of_day, day_of_week, day_of_month, timezone, recipients, link_lifetime_hours, created_by, created_at, paused_at, last_fired_key, scope_json";

const toDefinition = (row: DefinitionRow): ReportDefinition => ({
  id: row.id,
  eventId: row.event_id,
  organizationId: row.organization_id,
  name: row.name,
  description: row.description,
  dataset: row.dataset,
  query: JSON.parse(row.query_json) as ReportQuery,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revision: row.revision,
});

const toSchedule = (row: ScheduleRow): ReportSchedule => ({
  id: row.id,
  reportId: row.report_id,
  cadence: row.cadence,
  minuteOfDay: row.minute_of_day,
  dayOfWeek: row.day_of_week,
  dayOfMonth: row.day_of_month,
  timezone: row.timezone,
  recipients: JSON.parse(row.recipients) as string[],
  linkLifetimeHours: row.link_lifetime_hours,
  createdBy: row.created_by,
  createdAt: row.created_at,
  pausedAt: row.paused_at,
  lastFiredKey: row.last_fired_key,
  scope: JSON.parse(row.scope_json) as Record<string, unknown>,
});

export class D1ReportRepository implements ReportRepository {
  constructor(private readonly database: ReportDatabasePort) {}

  private async rows<T>(query: string, ...values: unknown[]): Promise<T[]> {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .all<T>();
    if (!result.success)
      throw new Error(`D1 failed to read reports: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }

  private async write(statement: D1Statement, operation: string): Promise<number> {
    let result: D1WriteResult;
    try {
      result = await statement.run();
    } catch (error) {
      // ERROR-INTENT: classified and rethrown — a unique-index refusal on the report name is a
      // caller-facing 409, and everything else keeps its message. D1 rejects rather than
      // answering `success: false`, which a fake repository never reproduces.
      if (/unique/i.test(String(error))) throw new ReportNameTakenError();
      throw new Error(`D1 failed to ${operation}: ${String(error)}`);
    }
    if (!result.success) {
      if (/unique/i.test(result.error ?? "")) throw new ReportNameTakenError();
      throw new Error(`D1 failed to ${operation}: ${result.error ?? "unknown error"}`);
    }
    return changedRows(result, operation);
  }

  async list(eventId: string): Promise<readonly ReportDefinition[]> {
    return (
      await this.rows<DefinitionRow>(
        `SELECT ${DEFINITION_COLUMNS} FROM report_definitions WHERE event_id = ? ORDER BY name, id`,
        eventId,
      )
    ).map(toDefinition);
  }

  async find(eventId: string, reportId: string): Promise<ReportDefinition | null> {
    const row = (
      await this.rows<DefinitionRow>(
        `SELECT ${DEFINITION_COLUMNS} FROM report_definitions WHERE event_id = ? AND id = ? LIMIT 1`,
        eventId,
        reportId,
      )
    )[0];
    return row ? toDefinition(row) : null;
  }

  async findById(reportId: string): Promise<ReportDefinition | null> {
    const row = (
      await this.rows<DefinitionRow>(
        `SELECT ${DEFINITION_COLUMNS} FROM report_definitions WHERE id = ? LIMIT 1`,
        reportId,
      )
    )[0];
    return row ? toDefinition(row) : null;
  }

  async create(report: ReportDefinition): Promise<void> {
    await this.write(
      this.database
        .prepare(
          `INSERT INTO report_definitions (${DEFINITION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          report.id,
          report.eventId,
          report.organizationId,
          report.name,
          report.description,
          report.dataset,
          JSON.stringify(report.query),
          report.createdBy,
          report.createdAt,
          report.updatedAt,
          report.revision,
        ),
      "create a report",
    );
  }

  async update(report: ReportDefinition, expectedRevision: number): Promise<number> {
    return this.write(
      this.database
        .prepare(
          "UPDATE report_definitions SET name = ?, description = ?, dataset = ?, query_json = ?, updated_at = ?, revision = ? " +
            "WHERE id = ? AND event_id = ? AND revision = ?",
        )
        .bind(
          report.name,
          report.description,
          report.dataset,
          JSON.stringify(report.query),
          report.updatedAt,
          report.revision,
          report.id,
          report.eventId,
          expectedRevision,
        ),
      "update a report",
    );
  }

  async remove(eventId: string, reportId: string, expectedRevision: number): Promise<number> {
    // `RETURNING id` rather than the affected-row count: shares, schedules and runs cascade, and
    // D1 reports the cascade in `meta.changes` — a number that is true and is not the answer to
    // "did this report go".
    const removed = await this.rows<{ id: string }>(
      "DELETE FROM report_definitions WHERE id = ? AND event_id = ? AND revision = ? RETURNING id",
      reportId,
      eventId,
      expectedRevision,
    );
    return removed.length;
  }

  async createSchedule(schedule: ReportSchedule): Promise<void> {
    await this.write(
      this.database
        .prepare(
          `INSERT INTO report_schedules (${SCHEDULE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          schedule.id,
          schedule.reportId,
          schedule.cadence,
          schedule.minuteOfDay,
          schedule.dayOfWeek,
          schedule.dayOfMonth,
          schedule.timezone,
          JSON.stringify(schedule.recipients),
          schedule.linkLifetimeHours,
          schedule.createdBy,
          schedule.createdAt,
          schedule.pausedAt,
          schedule.lastFiredKey,
          JSON.stringify(schedule.scope),
        ),
      "create a schedule",
    );
  }

  async listSchedules(reportId: string): Promise<readonly ReportSchedule[]> {
    return (
      await this.rows<ScheduleRow>(
        `SELECT ${SCHEDULE_COLUMNS} FROM report_schedules WHERE report_id = ? ORDER BY created_at, id`,
        reportId,
      )
    ).map(toSchedule);
  }

  async removeSchedule(reportId: string, scheduleId: string): Promise<number> {
    const removed = await this.rows<{ id: string }>(
      "DELETE FROM report_schedules WHERE id = ? AND report_id = ? RETURNING id",
      scheduleId,
      reportId,
    );
    return removed.length;
  }

  async listDueSchedules(): Promise<readonly (ReportSchedule & { eventId: string })[]> {
    return (
      await this.rows<ScheduleRow & { event_id: string }>(
        `SELECT s.id, s.report_id, s.cadence, s.minute_of_day, s.day_of_week, s.day_of_month, s.timezone, ` +
          `s.recipients, s.link_lifetime_hours, s.created_by, s.created_at, s.paused_at, s.last_fired_key, s.scope_json, ` +
          `d.event_id FROM report_schedules s JOIN report_definitions d ON d.id = s.report_id ` +
          `WHERE s.paused_at IS NULL ORDER BY s.id`,
      )
    ).map((row) => ({ ...toSchedule(row), eventId: row.event_id }));
  }

  /**
   * Claim one run and move the schedule's watermark, in one batch.
   *
   * `OR IGNORE` plus the unique index is what makes a retried tick converge: the second attempt
   * writes nothing and answers `false`, and the watermark update is guarded on the insert having
   * happened so it cannot claim an occurrence no run recorded.
   */
  async recordRun(run: ReportRun, lastFiredKey: string): Promise<boolean> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "INSERT OR IGNORE INTO report_runs (id, schedule_id, occurrence_key, ran_at, outcome, detail) VALUES (?,?,?,?,?,?)",
        )
        .bind(run.id, run.scheduleId, run.occurrenceKey, run.ranAt, run.outcome, run.detail),
      this.database
        .prepare("UPDATE report_schedules SET last_fired_key = ? WHERE id = ? AND changes() > 0")
        .bind(lastFiredKey, run.scheduleId),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(`D1 failed to record a report run: ${failed.error ?? "unknown error"}`);
    const [inserted] = results;
    if (!inserted) throw new Error("D1 returned no result while recording a report run");
    return changedRows(inserted, "record a report run") > 0;
  }

  async finishRun(runId: string, outcome: ReportRun["outcome"], detail: string): Promise<void> {
    const result = await this.database
      .prepare("UPDATE report_runs SET outcome = ?, detail = ? WHERE id = ?")
      .bind(outcome, detail, runId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to finish a report run: ${result.error ?? "unknown error"}`);
    if (changedRows(result, "finish a report run") !== 1)
      throw new Error("D1 could not find the report run it claimed");
  }

  async listRuns(scheduleId: string, limit: number): Promise<readonly ReportRun[]> {
    return (
      await this.rows<{
        id: string;
        schedule_id: string;
        occurrence_key: string;
        ran_at: string;
        outcome: ReportRun["outcome"];
        detail: string;
      }>(
        "SELECT id, schedule_id, occurrence_key, ran_at, outcome, detail FROM report_runs " +
          "WHERE schedule_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?",
        scheduleId,
        limit,
      )
    ).map((row) => ({
      id: row.id,
      scheduleId: row.schedule_id,
      occurrenceKey: row.occurrence_key,
      ranAt: row.ran_at,
      outcome: row.outcome,
      detail: row.detail,
    }));
  }
}
