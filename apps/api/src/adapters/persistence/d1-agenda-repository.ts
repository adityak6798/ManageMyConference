import type {
  AgendaRepository,
  PublishedSchedule,
  ScheduleReconciliation,
} from "../../application/agenda/agenda-repository";
import {
  advanceBoardOccurrences,
  compareSessionScheduleRevisions,
  EMPTY_BOARD_OCCURRENCES,
  isScheduleInSync,
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
interface MaterializationRow {
  publication_watermark: number;
  materialized_watermark: number | null;
}
interface HistoryRow {
  version: number;
  published_at: string;
  schedule_json: string;
}

const SESSION_SCHEDULE_COLUMNS = "session_id, starts_at, ends_at, location, revision, revised_at";

/**
 * How many publications one replay query carries.
 *
 * Every row holds a complete board, so the page size is a memory bound rather than a round-trip
 * optimization: a repair of an event with a thousand publications must not need a thousand boards
 * resident at once. The fold consumes each page and keeps only its result, which is one entry per
 * session however long the history is.
 */
const REPLAY_PAGE = 25;

/**
 * How many times a repair re-reads and re-replays before giving up.
 *
 * Each attempt loses only to a publication that committed between the replay's first page and its
 * write, and a publication repairs the drift itself on the way past, so losing repeatedly means
 * the event is being published faster than its history can be walked. That is worth surfacing
 * rather than looping in a cron tick.
 */
const REPAIR_ATTEMPTS = 3;

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

/**
 * The rows of one statement of a batched read, or the reason there are none.
 *
 * A batch reports each statement's outcome separately, so a failure on the second of two reads
 * arrives as `success: false` on that entry rather than as a rejected promise. Reading `results`
 * without checking would turn it into an empty answer, which for the watermark below means "this
 * event has never published" — the one wrong answer that would silence drift detection.
 */
function readRows<T>(
  result: { success: boolean; error?: string; results?: unknown } | undefined,
  what: string,
): readonly T[] {
  if (!result?.success)
    throw new Error(`D1 failed to read ${what}: ${result?.error ?? "unknown error"}`);
  return (result.results ?? []) as readonly T[];
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
    if (!row) return null;
    const stored = JSON.parse(row.draft_json) as AgendaDraft;
    return {
      /*
       * Normalized here rather than at each caller, because every row written before the
       * occurrences existed — the seeded board included — lacks the field, and no migration
       * backfilled them. A board this repository hands out without one reaches a caller that
       * has been told every draft carries it: `savePlacements` returns the board it read
       * unchanged when a plan seats nothing, which is an ordinary answer on a full board and
       * was the one path that could serve a draft the response contract then refused.
       */
      draft: { ...stored, occurrences: stored.occurrences ?? EMPTY_BOARD_OCCURRENCES },
      revision: row.revision,
    };
  }
  /**
   * Replace the whole board, occurrences included.
   *
   * This is the create path — a first `saveResources`, or a seed — rather than an edit, so the
   * occurrences start empty: nothing has yet happened to any session on a board that has only
   * just come into existence, and there is no previous board here to fold against.
   */
  async saveDraft(draft: AgendaDraft) {
    const stored: AgendaDraft = {
      ...draft,
      occurrences: draft.occurrences ?? EMPTY_BOARD_OCCURRENCES,
    };
    const result = await this.database
      .prepare(
        "INSERT INTO agenda_drafts (event_id, draft_json, updated_at, revision) VALUES (?, ?, ?, 0) ON CONFLICT(event_id) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at, revision = agenda_drafts.revision + 1",
      )
      .bind(stored.eventId, JSON.stringify(stored), this.now().toISOString())
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
      /*
       * The occurrences advance in the same statement as the board and against the same revision
       * the compare-and-set is defending, so a lost update recomputes them against the board that
       * actually won. Deriving them anywhere else — on read, or in the service before the write —
       * would let a concurrent placement produce numbers describing a board that was never
       * stored (issue #180).
       */
      const revision = current.revision + 1;
      const stored: AgendaDraft = {
        ...updated,
        occurrences: advanceBoardOccurrences(current.draft, updated, revision),
      };
      const result = await this.database
        .prepare(
          "UPDATE agenda_drafts SET draft_json = ?, updated_at = ?, revision = revision + 1 WHERE event_id = ? AND revision = ?",
        )
        .bind(JSON.stringify(stored), this.now().toISOString(), eventId, current.revision)
        .run();
      if (!result.success)
        throw new Error(`D1 failed to update agenda draft: ${result.error ?? "unknown error"}`);
      if (changedRows(result, "update agenda draft") === 1) return stored;
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
   *
   * **The fold is only sound over revisions that were current.** It starts from whatever the
   * previous publication left behind, so a stored answer that had already drifted would be folded
   * straight through and the new publication would inherit it — which is how one missed
   * publication could become permanent (`GAP-024`). The read below is `sessionScheduleRevisions`
   * rather than a raw select precisely because that method re-derives a drifted answer before
   * returning it, so a publication landing after a deploy window heals the event on its way past
   * (issue #169).
   *
   * The watermark that records "these rows describe every publication ever written" is advanced in
   * this same batch. It is an upsert rather than a conditional update, which keeps `meta.changes`
   * out of the correctness argument here exactly as the delete-then-insert above does: the insert
   * trigger on `agenda_publications` has already created the row a moment earlier in this same
   * transaction, and on the branch where it somehow has not, the upsert writes the whole truth
   * rather than silently matching nothing.
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
      ...this.insertSessionSchedules(schedule.eventId, revisions),
      this.markMaterialized(schedule.eventId, schedule.version, schedule.publishedAt),
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
   * The stored revisions, and whether they can still be believed.
   *
   * Two statements in one `batch`, so the check costs a round trip's share of nothing: the rows
   * are a range scan of exactly what they return — `(event_id, session_id)` leads with `event_id`,
   * so no index beyond the primary key is needed — and the watermark is a single primary-key
   * lookup. Issuing them separately would double the round trips on the hottest read in this
   * domain to answer a question whose answer is almost always "yes".
   *
   * `ORDER BY session_id` costs nothing — the primary key already walks in that order — and makes
   * the returned map's iteration order a stated property rather than one that happens to hold.
   * Every caller today reads by key, so nothing depends on it; the point is that nothing later
   * can come to depend on an accident of the engine either.
   */
  private async readMaterialized(eventId: string) {
    const [scheduleResult, watermarkResult] = await this.database.batch<unknown>([
      this.database
        .prepare(
          `SELECT ${SESSION_SCHEDULE_COLUMNS} FROM agenda_session_schedules WHERE event_id = ? ORDER BY session_id`,
        )
        .bind(eventId),
      this.database
        .prepare(
          "SELECT publication_watermark, materialized_watermark FROM agenda_schedule_materializations WHERE event_id = ? LIMIT 1",
        )
        .bind(eventId),
    ]);
    const rows = readRows<SessionScheduleRow>(scheduleResult, "session schedule revisions");
    const watermark = readRows<MaterializationRow>(watermarkResult, "the schedule watermark")[0];
    return {
      revisions: sessionScheduleMap(rows),
      /*
       * No row means no publication has ever been written for this event, so there is nothing the
       * stored answer could be behind. The insert trigger creates the row, so this state and "the
       * event has never published" are the same state — it is not a missing row for an event that
       * has one.
       */
      publicationWatermark: watermark?.publication_watermark ?? null,
      materializedWatermark: watermark?.materialized_watermark ?? null,
    };
  }

  /**
   * Where the schedule in force puts each session — re-derived first if the stored answer has
   * fallen behind the publication history.
   *
   * The check is one indexed row, not a replay: a read that replayed would be the very cost issue
   * #141 removed. What it can detect is therefore exactly "some writer moved `agenda_publications`
   * without maintaining this table", which is both ways `GAP-024` said the answer could go stale —
   * the deploy window, where the old Worker commits publications against a database the migration
   * has already reached, and any other direct writer. The exact, field-by-field comparison lives
   * in `reconcileSessionSchedules` and is reserved for the on-demand surface.
   *
   * **Repairing on a read is deliberate, and it is a write from a read path.** The alternative was
   * to serve the stale answer and wait for the sweep, and the thing being served is not a stale
   * number on a dashboard: it decides whether a speaker is mailed an invitation to a session the
   * programme does not schedule, and whether the invitation that puts a returning talk back on
   * their calendar is suppressed. Both are irreversible in the way a wrong page render is not.
   * The repair is idempotent, guarded by a compare-and-set on the watermark, and reachable from
   * an anonymous read only through the `.ics` download — which is a read of derived state
   * correcting derived state, never a write of anything a caller supplied.
   */
  async sessionScheduleRevisions(
    eventId: string,
  ): Promise<ReadonlyMap<string, SessionScheduleRevision>> {
    const stored = await this.readMaterialized(eventId);
    if (
      stored.publicationWatermark === null ||
      stored.materializedWatermark === stored.publicationWatermark
    )
      return stored.revisions;
    return (await this.reconcile(eventId, true)).revisions;
  }

  async reconcileSessionSchedules(
    eventId: string,
    options: { readonly repair: boolean },
  ): Promise<ScheduleReconciliation> {
    return (await this.reconcile(eventId, options.repair)).reconciliation;
  }

  /**
   * Replay the history, compare it against the stored rows, and optionally make them agree.
   *
   * The order of the two reads is load-bearing. The watermark is read *before* the replay, so a
   * publication that commits while the replay is walking pages either arrives too late to be
   * folded — in which case the stored rows stay behind and the watermark says so — or is folded
   * in, in which case the compare-and-set below finds the watermark moved and the attempt is
   * retried. There is no ordering in which a publication is both folded and marked as caught up.
   *
   * A losing attempt still leaves the rows it wrote. That is not a hole: they were derived from a
   * real prefix of the history, the watermark still reports the event as drifted, and the retry
   * replaces them. The state after a lost race is a drifted event that is flagged as drifted,
   * which is exactly the state before it.
   *
   * `repair: false` writes nothing at all, including the watermark. An operator asking whether an
   * event is sound must be able to ask without changing the answer, and a reconciliation that
   * stamped the watermark on a read-only check would report "in sync" the second time it ran
   * whatever it found the first time.
   */
  private async reconcile(eventId: string, repair: boolean) {
    for (let attempt = 0; attempt < REPAIR_ATTEMPTS; attempt += 1) {
      const stored = await this.readMaterialized(eventId);
      const replayed = await this.replayPublicationHistory(eventId);
      const drift = compareSessionScheduleRevisions(stored.revisions, replayed.revisions);
      const reconciliation = {
        eventId,
        publicationWatermark: stored.publicationWatermark,
        materializedWatermark: stored.materializedWatermark,
        publications: replayed.publications,
        drift,
      };
      /*
       * A sound event is one whose rows agree with the history *and* whose watermark says so.
       * The second half is not redundant: `1602` backfills every already-published event with no
       * materialized watermark at all, because it cannot honestly claim `1601` caught a
       * publication landing between the two migrations. Those events have correct rows and an
       * unclaimed watermark, and the first repair is what turns the correctness into a statement.
       */
      if (isScheduleInSync(drift) && stored.materializedWatermark === stored.publicationWatermark)
        return {
          reconciliation: { ...reconciliation, repaired: false },
          revisions: stored.revisions,
        };
      if (!repair)
        return {
          reconciliation: { ...reconciliation, repaired: false },
          revisions: stored.revisions,
        };
      if (
        await this.rebuildSessionSchedules(eventId, replayed.revisions, stored.publicationWatermark)
      )
        return {
          reconciliation: {
            ...reconciliation,
            materializedWatermark: stored.publicationWatermark,
            repaired: true,
          },
          revisions: replayed.revisions,
        };
    }
    throw new Error(
      `D1 could not reconcile agenda schedules for event ${eventId}: the publication history moved during every attempt`,
    );
  }

  /**
   * Fold `nextSessionScheduleRevisions` over every publication this event has committed.
   *
   * The same rule the write path applies one publication at a time and the same rule `1601`'s
   * backfill expresses as a CTE, run here as the third and last user of that one definition. A
   * second SQL transcription of the fold would have been cheaper to run and impossible to keep
   * honest: a repair that disagreed with the write path would rewrite correct rows into wrong
   * ones, on the surface whose entire purpose is to be trusted.
   *
   * Paged by keyset on `version`, which the primary key already orders. A publication committing
   * mid-replay lands after the cursor and is either folded or missed depending on timing; the
   * caller's compare-and-set is what turns "depending on timing" into a retry rather than a lie.
   */
  private async replayPublicationHistory(eventId: string) {
    let revisions: ReadonlyMap<string, SessionScheduleRevision> = new Map();
    let after = 0;
    let publications = 0;
    for (;;) {
      const result = await this.database
        .prepare(
          "SELECT version, published_at, schedule_json FROM agenda_publications WHERE event_id = ? AND version > ? ORDER BY version LIMIT ?",
        )
        .bind(eventId, after, REPLAY_PAGE)
        .all<HistoryRow>();
      if (!result.success)
        throw new Error(
          `D1 failed to replay agenda publications: ${result.error ?? "unknown error"}`,
        );
      const rows = result.results ?? [];
      for (const row of rows) {
        revisions = nextSessionScheduleRevisions(revisions, {
          version: row.version,
          publishedAt: row.published_at,
          agenda: JSON.parse(row.schedule_json) as AgendaDraft,
        });
        after = row.version;
      }
      publications += rows.length;
      if (rows.length < REPLAY_PAGE) return { revisions, publications };
    }
  }

  /**
   * Write the replayed answer back, and claim the watermark only if it has not moved.
   *
   * The claim is the one statement in this adapter whose affected-row count is load-bearing, and
   * it is load-bearing in the direction the row-count contract exists for: zero means another
   * publication was written while this replay was walking the history, so the rows just written
   * describe a prefix rather than the whole of it, and marking them current would be the false
   * statement this whole mechanism exists to prevent. `changedRows` refuses a driver that omits
   * the count outright, because "no count" would otherwise be indistinguishable from "matched",
   * and guessing wrong here silences the detector permanently.
   *
   * An event with no watermark row has never had a publication written, so there is nothing to
   * claim; the rebuild still runs, because a row standing against an empty history is the phantom
   * case and deleting it is the repair.
   */
  private async rebuildSessionSchedules(
    eventId: string,
    revisions: ReadonlyMap<string, SessionScheduleRevision>,
    watermark: number | null,
  ): Promise<boolean> {
    const claim =
      watermark === null
        ? null
        : this.database
            .prepare(
              "UPDATE agenda_schedule_materializations SET materialized_watermark = ?, materialized_at = ? WHERE event_id = ? AND publication_watermark = ?",
            )
            .bind(watermark, this.now().toISOString(), eventId, watermark);
    const results = await this.database.batch([
      this.database
        .prepare("DELETE FROM agenda_session_schedules WHERE event_id = ?")
        .bind(eventId),
      ...this.insertSessionSchedules(eventId, revisions),
      ...(claim ? [claim] : []),
    ]);
    const failure = results.find((result) => !result.success);
    if (failure)
      throw new Error(
        `D1 failed to rebuild session schedule revisions: ${failure.error ?? "unknown error"}`,
      );
    if (!claim) return true;
    const applied = results[results.length - 1];
    if (!applied)
      throw new Error("D1 returned no result for the agenda schedule materialization claim");
    return changedRows(applied, "claim the agenda schedule watermark") === 1;
  }

  /**
   * Events whose stored revisions are known to lag their publication history.
   *
   * Reads the partial index `1602` declares, whose predicate is this `WHERE` clause, so the scan
   * touches the drifted events rather than every event that has ever published. `ORDER BY
   * event_id` makes a bounded sweep deterministic: without it, a deployment holding more drifted
   * events than one tick repairs could in principle keep returning the same page and starve the
   * rest — with it, each repaired event leaves the index and the next tick starts where this one
   * stopped.
   */
  async driftedEvents(limit: number): Promise<readonly string[]> {
    const result = await this.database
      .prepare(
        "SELECT event_id FROM agenda_schedule_materializations WHERE materialized_watermark IS NOT publication_watermark ORDER BY event_id LIMIT ?",
      )
      .bind(limit)
      .all<{ event_id: string }>();
    if (!result.success)
      throw new Error(
        `D1 failed to list drifted agenda schedules: ${result.error ?? "unknown error"}`,
      );
    return (result.results ?? []).map((row) => row.event_id);
  }

  private insertSessionSchedules(
    eventId: string,
    revisions: ReadonlyMap<string, SessionScheduleRevision>,
  ) {
    return [...revisions].map(([sessionId, revision]) =>
      this.database
        .prepare(
          `INSERT INTO agenda_session_schedules (event_id, ${SESSION_SCHEDULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          eventId,
          sessionId,
          revision.startsAt,
          revision.endsAt,
          revision.location,
          revision.revision,
          revision.revisedAt,
        ),
    );
  }

  /** "These rows describe every publication written for this event up to `watermark`." */
  private markMaterialized(eventId: string, watermark: number, at: string) {
    return this.database
      .prepare(
        "INSERT INTO agenda_schedule_materializations (event_id, publication_watermark, materialized_watermark, materialized_at) VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET materialized_watermark = excluded.materialized_watermark, materialized_at = excluded.materialized_at",
      )
      .bind(eventId, watermark, watermark, at);
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
