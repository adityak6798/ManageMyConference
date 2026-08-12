import type {
  AgendaRepository,
  PublishedSchedule,
} from "../../application/agenda/agenda-repository";
import {
  schedulePublishedEvent,
  type AgendaDraft,
  type Placement,
  type SchedulePublishedEvent,
} from "../../domain/agenda/agenda";
interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: { changes?: number };
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T>(): Promise<D1Result<T>>;
}
interface AgendaDatabase {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<D1Result<T>[]>;
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
 * only the announcement is missing. See `docs/exec-plans/tech-debt.md` (`DEBT-006`).
 */
export type PublicationEventWriter = (
  database: AgendaDatabase,
  event: SchedulePublishedEvent,
) => readonly D1Statement[];

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
 * Named by column, not merely by table, because this table has two uniqueness constraints and
 * they call for opposite responses: a taken version is retried with the next one, a taken
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
      ? { draft: JSON.parse(row.draft_json) as AgendaDraft, revision: row.revision }
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
  async saveResources(eventId: string, resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">) {
    if (!(await this.getDraftRow(eventId))) {
      await this.saveDraft({ eventId, ...resources, sessions: [], placements: [] });
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
      if ((result.meta?.changes ?? 0) === 1) return updated;
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
   */
  async publish(schedule: PublishedSchedule) {
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
      ...(this.writePublicationEvent?.(this.database, schedulePublishedEvent(schedule)) ?? []),
    ];
    let results: D1Result<unknown>[];
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
