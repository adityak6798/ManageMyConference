import type {
  AgendaRepository,
  PublishedSchedule,
} from "../../application/agenda/agenda-repository";
import {
  nextSessionScheduleRevisions,
  schedulePublishedEvent,
  type AgendaDraft,
  type Placement,
  type SchedulePublishedEvent,
  type SessionScheduleRevision,
} from "../../domain/agenda/agenda";
import { changedRows, type D1WriteResult } from "./d1-write-result";
interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<D1Result<T>>;
}
interface AgendaDatabase {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

/**
 * Renders the publication event into statements committed with the publication itself.
 *
 * The agenda does not own the outbox and never names one of its columns: this is the seam a
 * composition root binds to whichever domain durably records events, and the statements come
 * back opaque to be appended to the batch the publication was going to run anyway. That is what
 * makes the snapshot and its announcement one durable operation rather than two writes with a
 * window between them.
 *
 * Optional because an agenda still publishes with nothing bound — the schedule commits, and
 * only the announcement is missing.
 *
 * It may return its statements asynchronously, and the binding that closed `DEBT-006` needs
 * that: a `communication_deliveries` row is organization-scoped, the publication carries only an
 * event id, and resolving one from the other is a read. The alternative was a statement that
 * joined `events` to find the organization, which would have put a read of another domain's
 * table inside this one's insert. The read happens before the batch either way, so the
 * publication and its event still commit or fail together.
 */
export type PublicationEventWriter = (
  database: AgendaDatabase,
  event: SchedulePublishedEvent,
) => readonly D1Statement[] | Promise<readonly D1Statement[]>;

interface DraftRow {
  draft_json: string;
  revision: number;
}
interface PublicationRow {
  event_id: string;
  version: number;
  published_at: string;
  published_by: string;
  schedule_json: string;
  command_key: string | null;
}
interface SessionScheduleRow {
  session_id: string;
  starts_at: string;
  ends_at: string;
  location: string;
  revision: number;
  revised_at: string;
}

const SESSION_SCHEDULE_COLUMNS = "session_id, starts_at, ends_at, location, revision, revised_at";

const sessionScheduleMap = (rows: readonly SessionScheduleRow[]) =>
  new Map<string, SessionScheduleRevision>(
    rows.map((row) => [
      row.session_id,
      {
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        location: row.location,
        revision: row.revision,
        revisedAt: row.revised_at,
      },
    ]),
  );

const publicationFromRow = (row: PublicationRow | undefined): PublishedSchedule | null =>
  row
    ? {
        eventId: row.event_id,
        version: row.version,
        publishedAt: row.published_at,
        publishedBy: row.published_by,
        agenda: JSON.parse(row.schedule_json) as AgendaDraft,
        ...(row.command_key === null ? {} : { commandKey: row.command_key }),
      }
    : null;

/**
 * Whether a failure is "that version already exists" rather than anything else.
 *
 * Deliberately narrow. It matches only a uniqueness failure that names
 * `agenda_publications.version`, because the caller's response to `true` is to retry with the
 * next version — and retrying is the wrong answer to every other constraint in the batch. A
 * broader test would turn a foreign-key failure on `published_by`, or a future constraint on
 * the event record, into an infinite allocation loop that never explains itself.
 *
 * SQLite words the two ways this can surface differently ("UNIQUE constraint failed" for the
 * unique index, "PRIMARY KEY must be unique" for the rowid form), so both are named here.
 */
function uniquenessFailureOn(error: unknown, column: string): boolean {
  // D1 puts the SQLite message on the error itself, and Miniflare sometimes only on its cause.
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error ?? "");
  if (!text.includes("UNIQUE constraint failed") && !text.includes("PRIMARY KEY must be unique"))
    return false;
  return text.includes(`agenda_publications.${column}`);
}

/**
 * The version was taken, rather than anything else.
 *
 * Named by column, not merely by table, because this table now has two uniqueness constraints
 * and they call for opposite responses: a taken version is retried with the next one, a taken
 * command key must never be. Matching the table alone would make a replayed command retry
 * until it exhausted its attempts and then report contention that does not exist.
 */
const isVersionTaken = (error: unknown) => uniquenessFailureOn(error, "version");
/** This exact command already committed a publication. */
const isCommandReplayed = (error: unknown) => uniquenessFailureOn(error, "command_key");

export class D1AgendaRepository implements AgendaRepository {
  constructor(
    private readonly database: AgendaDatabase,
    private readonly now: () => Date,
    private readonly writePublicationEvent?: PublicationEventWriter,
  ) {}
  async getDraft(eventId: string): Promise<AgendaDraft | null> {
    return (await this.getDraftRow(eventId))?.draft ?? null;
  }
  private async getDraftRow(eventId: string) {
    const result = await this.database
      .prepare("SELECT draft_json, revision FROM agenda_drafts WHERE event_id = ? LIMIT 1")
      .bind(eventId)
      .all<DraftRow>();
    if (!result.success)
      throw new Error(`D1 failed to read agenda draft: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row
      ? {
          draft: JSON.parse(row.draft_json) as AgendaDraft,
          revision: row.revision,
        }
      : null;
  }
  async saveDraft(draft: AgendaDraft) {
    const result = await this.database
      .prepare(
        "INSERT INTO agenda_drafts (event_id, draft_json, updated_at, revision) VALUES (?, ?, ?, 0) ON CONFLICT(event_id) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at, revision = agenda_drafts.revision + 1",
      )
      .bind(draft.eventId, JSON.stringify(draft), this.now().toISOString())
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save agenda draft: ${result.error ?? "unknown error"}`);
  }
  async savePlacement(eventId: string, placement: Placement) {
    return this.updateDraft(eventId, (draft) => ({
      ...draft,
      placements: [...draft.placements.filter(({ id }) => id !== placement.id), placement],
    }));
  }
  async savePlacements(eventId: string, plan: (draft: AgendaDraft) => readonly Placement[]) {
    // Kept so a plan that seats nothing can answer with the board the retry loop already read,
    // rather than refusing (which would read as "no agenda") or costing a second read.
    let seen: AgendaDraft | null = null;
    const updated = await this.updateDraft(eventId, (draft) => {
      seen = draft;
      const placements = plan(draft);
      if (!placements.length) return null;
      const replaced = new Set(placements.map(({ id }) => id));
      return {
        ...draft,
        placements: [...draft.placements.filter(({ id }) => !replaced.has(id)), ...placements],
      };
    });
    return updated ?? seen;
  }
  async saveResources(eventId: string, resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">) {
    if (!(await this.getDraftRow(eventId))) {
      await this.saveDraft({
        eventId,
        ...resources,
        sessions: [],
        placements: [],
      });
      return true;
    }
    return (
      (await this.updateDraft(eventId, (draft) =>
        draft.placements.some(
          (placement) =>
            !resources.rooms.some(({ id }) => id === placement.roomId) ||
            !resources.tracks.some(({ id }) => id === placement.trackId) ||
            !resources.slots.some(({ id }) => id === placement.slotId),
        )
          ? null
          : { ...draft, ...resources },
      )) !== null
    );
  }
  async removePlacement(eventId: string, placementId: string) {
    await this.updateDraft(eventId, (draft) => ({
      ...draft,
      placements: draft.placements.filter(({ id }) => id !== placementId),
    }));
  }
  private async updateDraft(
    eventId: string,
    update: (draft: AgendaDraft) => AgendaDraft | null,
  ): Promise<AgendaDraft | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.getDraftRow(eventId);
      if (!current) return null;
      const updated = update(current.draft);
      if (!updated) return null;
      const result = await this.database
        .prepare(
          "UPDATE agenda_drafts SET draft_json = ?, updated_at = ?, revision = revision + 1 WHERE event_id = ? AND revision = ?",
        )
        .bind(JSON.stringify(updated), this.now().toISOString(), eventId, current.revision)
        .run();
      if (!result.success)
        throw new Error(`D1 failed to update agenda draft: ${result.error ?? "unknown error"}`);
      if (changedRows(result, "update agenda draft") === 1) return updated;
    }
    throw new Error("D1 failed to update agenda draft after concurrent changes");
  }
  /**
   * Commit the snapshot and its event together, or commit neither.
   *
   * `batch` is one D1 transaction, so the publication row and whatever the event writer
   * produces share a fate. That is the whole point: a crash between two separate writes leaves
   * either a published schedule nobody was told about or an announcement of a snapshot that
   * does not exist, and both are states a downstream consumer cannot recover from.
   *
   * The version is allocated by the caller and defended here by the primary key. A concurrent
   * publication that reached this version first makes the insert fail on that constraint, which
   * is reported as `false` rather than thrown — the caller's retry is the allocation loop. Any
   * other failure is a real one and propagates, because silently returning `false` for it would
   * put the caller into a retry that can never succeed.
   *
   * The per-session revisions advance in this same batch, so they share the snapshot's fate: a
   * publication that rolls back cannot leave a revision behind, and one that commits cannot
   * fail to advance them. That is what lets the read be a single indexed lookup instead of a
   * replay of every board this event has ever published (issue #141).
   *
   * **Why the read-then-write below needs no extra locking.** `AgendaService.publish` allocates
   * `version = previous.version + 1`, and `(event_id, version)` is the primary key. Any
   * publication that commits between this method's read of the revisions and its batch
   * necessarily takes the version being inserted here, so this whole batch — materialization
   * included — rolls back on that constraint and the service's allocation loop retries with a
   * fresh read. A batch that commits is therefore proof that the revisions it read were current.
   * The read lives here rather than in the service precisely so each retry attempt re-reads it.
   *
   * The materialization is a delete-then-insert over this event's rows rather than targeted
   * per-session upserts, which keeps `meta.changes` out of the correctness argument: a first
   * publication legitimately deletes nothing, so no count here is load-bearing and none needs
   * `changedRows`. Targeted statements would make every count load-bearing and each would have
   * to be refused when the driver omitted it.
   *
   * One insert statement per placed session, rather than one multi-row insert. That looks like
   * the obvious saving and is not available: D1 caps a query at **100 bound parameters**, this
   * table has seven columns, so a multi-row insert holds fourteen sessions and fails on the
   * fifteenth — on every board large enough for the saving to matter. Chunking to fourteen would
   * work, but D1 documents no limit on statements per batch, so it would trade a plain loop for
   * an arithmetic one to relieve a limit that does not exist. `d1-content-repository.ts` writes
   * its speakers, tasks and messages the same way for the same reason.
   */
  async publish(schedule: PublishedSchedule) {
    const revisions = nextSessionScheduleRevisions(
      await this.sessionScheduleRevisions(schedule.eventId),
      schedule,
    );
    const statements = [
      this.database
        .prepare(
          "INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json, command_key) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          schedule.eventId,
          schedule.version,
          schedule.publishedAt,
          schedule.publishedBy,
          JSON.stringify(schedule.agenda),
          schedule.commandKey ?? null,
        ),
      this.database
        .prepare("DELETE FROM agenda_session_schedules WHERE event_id = ?")
        .bind(schedule.eventId),
      ...[...revisions].map(([sessionId, revision]) =>
        this.database
          .prepare(
            `INSERT INTO agenda_session_schedules (event_id, ${SESSION_SCHEDULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            schedule.eventId,
            sessionId,
            revision.startsAt,
            revision.endsAt,
            revision.location,
            revision.revision,
            revision.revisedAt,
          ),
      ),
      ...((await this.writePublicationEvent?.(this.database, schedulePublishedEvent(schedule))) ??
        []),
    ];
    let results: Array<D1WriteResult & { results?: unknown[] }>;
    try {
      results = await this.database.batch(statements);
    } catch (error) {
      if (isCommandReplayed(error)) return "command-replayed";
      if (isVersionTaken(error)) return "version-taken";
      throw error;
    }
    if (results.some((result) => isCommandReplayed(result.error))) return "command-replayed";
    if (results.some((result) => isVersionTaken(result.error))) return "version-taken";
    const failure = results.find((result) => !result.success);
    if (failure)
      throw new Error(`D1 failed to publish agenda: ${failure.error ?? "unknown error"}`);
    return "committed";
  }
  async getPublished(eventId: string): Promise<PublishedSchedule | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, version, published_at, published_by, schedule_json, command_key FROM agenda_publications WHERE event_id = ? ORDER BY version DESC LIMIT 1",
      )
      .bind(eventId)
      .all<PublicationRow>();
    if (!result.success)
      throw new Error(`D1 failed to read published agenda: ${result.error ?? "unknown error"}`);
    return publicationFromRow(result.results?.[0]);
  }
  /**
   * One statement, at most one row per session, whatever the length of the history.
   *
   * No index beyond the primary key: `(event_id, session_id)` already leads with `event_id`, so
   * this is a range scan of exactly the rows it returns.
   *
   * `ORDER BY session_id` costs nothing — the primary key already walks in that order — and makes
   * the returned map's iteration order a stated property rather than one that happens to hold.
   * Every caller today reads by key, so nothing depends on it; the point is that nothing later
   * can come to depend on an accident of the engine either.
   */
  async sessionScheduleRevisions(
    eventId: string,
  ): Promise<ReadonlyMap<string, SessionScheduleRevision>> {
    const result = await this.database
      .prepare(
        `SELECT ${SESSION_SCHEDULE_COLUMNS} FROM agenda_session_schedules WHERE event_id = ? ORDER BY session_id`,
      )
      .bind(eventId)
      .all<SessionScheduleRow>();
    if (!result.success)
      throw new Error(
        `D1 failed to read session schedule revisions: ${result.error ?? "unknown error"}`,
      );
    return sessionScheduleMap(result.results ?? []);
  }

  /**
   * The publication an earlier attempt of this command committed.
   *
   * Read after a refused insert as well as before one: losing the unique index on the command
   * key means a concurrent retry of the same command committed first, and the caller wants that
   * publication rather than an error.
   */
  async findByCommandKey(eventId: string, commandKey: string): Promise<PublishedSchedule | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, version, published_at, published_by, schedule_json, command_key FROM agenda_publications WHERE event_id = ? AND command_key = ? LIMIT 1",
      )
      .bind(eventId, commandKey)
      .all<PublicationRow>();
    if (!result.success)
      throw new Error(`D1 failed to read published agenda: ${result.error ?? "unknown error"}`);
    return publicationFromRow(result.results?.[0]);
  }
}
