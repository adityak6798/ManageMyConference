/**
 * `GenerationRepository` against D1, plus the board revision a generated draft is measured
 * against.
 *
 * The criteria library and the availability windows are both **whole-set replacements**, and for
 * the same reason: each is one arrangement the organizer confirmed, and an upsert would leave
 * behind whatever they removed. D1 applies a batch atomically, so there is no moment at which an
 * event has half a library — which matters, because a library missing a criterion is a priority
 * the generator would have to invent.
 *
 * `boardRevision` reads `agenda_drafts.revision`, the counter the board's own optimistic writes
 * already advance. Reusing it rather than adding a second is what keeps "has the board moved
 * since this draft was generated" answerable at all: a number this file maintained separately
 * would need to be advanced by every writer, including the ones that know nothing about
 * generation.
 *
 * @spec PRD-AGD-001 ARC-003
 */
import type {
  AvailabilityWindow,
  Criterion,
  CriterionKey,
  UnplacedExplanation,
} from "../../domain/agenda/draft-generation";
import type { Placement } from "../../domain/agenda/agenda";
import type {
  GeneratedDraft,
  GenerationRepository,
} from "../../application/agenda/generation-service";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface GenerationDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface DraftRow {
  id: string;
  event_id: string;
  name: string;
  board_revision: number;
  criteria_json: string;
  placements_json: string;
  unplaced_json: string;
  generated_by: string;
  generated_at: string;
  status: GeneratedDraft["status"];
  accepted_at: string | null;
}

const DRAFT_COLUMNS =
  "id, event_id, name, board_revision, criteria_json, placements_json, unplaced_json, generated_by, generated_at, status, accepted_at";

const toDraft = (row: DraftRow): GeneratedDraft => ({
  id: row.id,
  eventId: row.event_id,
  name: row.name,
  boardRevision: row.board_revision,
  criteria: JSON.parse(row.criteria_json) as Criterion[],
  placements: JSON.parse(row.placements_json) as Placement[],
  unplaced: JSON.parse(row.unplaced_json) as UnplacedExplanation[],
  generatedBy: row.generated_by,
  generatedAt: row.generated_at,
  status: row.status,
  acceptedAt: row.accepted_at,
});

export class D1AgendaGenerationRepository implements GenerationRepository {
  constructor(private readonly database: GenerationDatabasePort) {}

  private async rows<T>(query: string, ...values: unknown[]): Promise<T[]> {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .all<T>();
    if (!result.success)
      throw new Error(`D1 failed to read agenda generation: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }

  /** The board's own optimistic counter. Zero for an event with no board row yet. */
  async boardRevision(eventId: string): Promise<number> {
    const row = (
      await this.rows<{ revision: number }>(
        "SELECT revision FROM agenda_drafts WHERE event_id = ? LIMIT 1",
        eventId,
      )
    )[0];
    return row?.revision ?? 0;
  }

  async listDrafts(eventId: string): Promise<readonly GeneratedDraft[]> {
    return (
      await this.rows<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM agenda_generated_drafts WHERE event_id = ? ORDER BY generated_at DESC, id`,
        eventId,
      )
    ).map(toDraft);
  }

  async findDraft(eventId: string, draftId: string): Promise<GeneratedDraft | null> {
    const row = (
      await this.rows<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM agenda_generated_drafts WHERE event_id = ? AND id = ? LIMIT 1`,
        eventId,
        draftId,
      )
    )[0];
    return row ? toDraft(row) : null;
  }

  async createDraft(draft: GeneratedDraft): Promise<void> {
    const result = await this.database
      .prepare(
        `INSERT INTO agenda_generated_drafts (${DRAFT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        draft.id,
        draft.eventId,
        draft.name,
        draft.boardRevision,
        JSON.stringify(draft.criteria),
        JSON.stringify(draft.placements),
        JSON.stringify(draft.unplaced),
        draft.generatedBy,
        draft.generatedAt,
        draft.status,
        draft.acceptedAt,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to store a generated draft: ${result.error ?? "unknown error"}`);
  }

  async setDraftStatus(
    eventId: string,
    draftId: string,
    status: "accepted" | "discarded",
    at: string | null,
  ): Promise<number> {
    const result = await this.database
      .prepare(
        "UPDATE agenda_generated_drafts SET status = ?, accepted_at = ? WHERE id = ? AND event_id = ?",
      )
      .bind(status, status === "accepted" ? at : null, draftId, eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to update a generated draft: ${result.error ?? "unknown error"}`);
    return changedRows(result, "update a generated draft");
  }

  /** Null rather than an empty list: "never configured" and "configured as empty" differ. */
  async listCriteria(eventId: string): Promise<readonly Criterion[] | null> {
    const rows = await this.rows<{ criterion: CriterionKey; position: number; enabled: number }>(
      "SELECT criterion, position, enabled FROM agenda_generation_criteria WHERE event_id = ? ORDER BY position, criterion",
      eventId,
    );
    if (rows.length === 0) return null;
    return rows.map((row) => ({
      criterion: row.criterion,
      position: row.position,
      enabled: row.enabled === 1,
    }));
  }

  async replaceCriteria(eventId: string, criteria: readonly Criterion[]): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare("DELETE FROM agenda_generation_criteria WHERE event_id = ?")
        .bind(eventId),
      ...criteria.map((entry) =>
        this.database
          .prepare(
            "INSERT INTO agenda_generation_criteria (event_id, criterion, position, enabled) VALUES (?,?,?,?)",
          )
          .bind(eventId, entry.criterion, entry.position, entry.enabled ? 1 : 0),
      ),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(`D1 failed to replace criteria: ${failed.error ?? "unknown error"}`);
  }

  async listAvailability(eventId: string): Promise<readonly AvailabilityWindow[]> {
    return (
      await this.rows<{
        speaker_id: string;
        starts_at: string;
        ends_at: string;
        kind: AvailabilityWindow["kind"];
      }>(
        "SELECT speaker_id, starts_at, ends_at, kind FROM agenda_speaker_availability WHERE event_id = ? ORDER BY speaker_id, starts_at",
        eventId,
      )
    ).map((row) => ({
      speakerId: row.speaker_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      kind: row.kind,
    }));
  }

  async replaceAvailability(
    eventId: string,
    windows: readonly AvailabilityWindow[],
  ): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare("DELETE FROM agenda_speaker_availability WHERE event_id = ?")
        .bind(eventId),
      ...windows.map((window) =>
        this.database
          .prepare(
            "INSERT OR IGNORE INTO agenda_speaker_availability (event_id, speaker_id, starts_at, ends_at, kind, note) VALUES (?,?,?,?,?,'')",
          )
          .bind(eventId, window.speakerId, window.startsAt, window.endsAt, window.kind),
      ),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(`D1 failed to replace availability: ${failed.error ?? "unknown error"}`);
  }
}
