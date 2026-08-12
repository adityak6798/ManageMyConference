/*
 * Last-sync state for the Accelevents registration import.
 *
 * One row per event, replaced by each apply — see migration 1751 for why nothing more is kept.
 *
 * @spec PRD-INT-001 PORT-ACCELEVENTS
 */
import type {
  AccelEventsSyncRun,
  AccelEventsSyncRunStore,
} from "../../application/communications/accelevents-sync";

interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<{ success: boolean; error?: string }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
type Database = { prepare(query: string): Statement };

interface RunRow {
  event_id: string;
  started_at: string;
  completed_at: string;
  outcome: AccelEventsSyncRun["outcome"];
  total: number;
  created: number;
  skipped: number;
  invalid: number;
  error_code: string | null;
}

export class D1AccelEventsSyncRuns implements AccelEventsSyncRunStore {
  constructor(private readonly database: Database) {}

  private ensure(result: { success: boolean; error?: string }, operation: string) {
    if (!result.success) throw new Error(`Failed to ${operation}`);
  }

  async record(run: AccelEventsSyncRun): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO accelevents_sync_runs (event_id, started_at, completed_at, outcome, total, created, skipped, invalid, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET started_at = excluded.started_at, completed_at = excluded.completed_at, outcome = excluded.outcome, total = excluded.total, created = excluded.created, skipped = excluded.skipped, invalid = excluded.invalid, error_code = excluded.error_code",
      )
      .bind(
        run.eventId,
        run.startedAt,
        run.completedAt,
        run.outcome,
        run.total,
        run.created,
        run.skipped,
        run.invalid,
        run.errorCode,
      )
      .run();
    this.ensure(result, "record Accelevents sync run");
  }

  async find(eventId: string): Promise<AccelEventsSyncRun | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, started_at, completed_at, outcome, total, created, skipped, invalid, error_code FROM accelevents_sync_runs WHERE event_id = ? LIMIT 1",
      )
      .bind(eventId)
      .all<RunRow>();
    this.ensure(result, "load Accelevents sync run");
    const row = result.results?.[0];
    return row
      ? {
          eventId: row.event_id,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          outcome: row.outcome,
          total: row.total,
          created: row.created,
          skipped: row.skipped,
          invalid: row.invalid,
          errorCode: row.error_code,
        }
      : null;
  }
}

/** The in-memory equivalent, for suites that compose the sync without a database. */
export class MemoryAccelEventsSyncRuns implements AccelEventsSyncRunStore {
  private readonly runs = new Map<string, AccelEventsSyncRun>();
  async record(run: AccelEventsSyncRun): Promise<void> {
    this.runs.set(run.eventId, run);
  }
  async find(eventId: string): Promise<AccelEventsSyncRun | null> {
    return this.runs.get(eventId) ?? null;
  }
}
