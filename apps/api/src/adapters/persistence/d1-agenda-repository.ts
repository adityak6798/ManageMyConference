import type {
  AgendaRepository,
  PublishedSchedule,
} from "../../application/agenda/agenda-repository";
import type { AgendaDraft, Placement } from "../../domain/agenda/agenda";
interface D1Result<T> {
  results?: T[];
  success: boolean;
  error?: string;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T>(): Promise<D1Result<T>>;
}
interface AgendaDatabase {
  prepare(query: string): D1Statement;
}

interface DraftRow {
  draft_json: string;
}
interface PublicationRow {
  event_id: string;
  version: number;
  published_at: string;
  published_by: string;
  schedule_json: string;
}

export class D1AgendaRepository implements AgendaRepository {
  constructor(
    private readonly database: AgendaDatabase,
    private readonly now: () => Date,
  ) {}
  async getDraft(eventId: string): Promise<AgendaDraft | null> {
    const result = await this.database
      .prepare("SELECT draft_json FROM agenda_drafts WHERE event_id = ? LIMIT 1")
      .bind(eventId)
      .all<DraftRow>();
    if (!result.success)
      throw new Error(`D1 failed to read agenda draft: ${result.error ?? "unknown error"}`);
    return result.results?.[0] ? (JSON.parse(result.results[0].draft_json) as AgendaDraft) : null;
  }
  async saveDraft(draft: AgendaDraft) {
    const result = await this.database
      .prepare(
        "INSERT INTO agenda_drafts (event_id, draft_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at",
      )
      .bind(draft.eventId, JSON.stringify(draft), this.now().toISOString())
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save agenda draft: ${result.error ?? "unknown error"}`);
  }
  async savePlacement(eventId: string, placement: Placement) {
    const draft = await this.getDraft(eventId);
    if (draft)
      await this.saveDraft({
        ...draft,
        placements: [...draft.placements.filter(({ id }) => id !== placement.id), placement],
      });
  }
  async removePlacement(eventId: string, placementId: string) {
    const draft = await this.getDraft(eventId);
    if (draft)
      await this.saveDraft({
        ...draft,
        placements: draft.placements.filter(({ id }) => id !== placementId),
      });
  }
  async publish(schedule: PublishedSchedule) {
    const result = await this.database
      .prepare(
        "INSERT INTO agenda_publications (event_id, version, published_at, published_by, schedule_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        schedule.eventId,
        schedule.version,
        schedule.publishedAt,
        schedule.publishedBy,
        JSON.stringify(schedule.agenda),
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to publish agenda: ${result.error ?? "unknown error"}`);
  }
  async getPublished(eventId: string): Promise<PublishedSchedule | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, version, published_at, published_by, schedule_json FROM agenda_publications WHERE event_id = ? ORDER BY version DESC LIMIT 1",
      )
      .bind(eventId)
      .all<PublicationRow>();
    if (!result.success)
      throw new Error(`D1 failed to read published agenda: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row
      ? {
          eventId: row.event_id,
          version: row.version,
          publishedAt: row.published_at,
          publishedBy: row.published_by,
          agenda: JSON.parse(row.schedule_json) as AgendaDraft,
        }
      : null;
  }
}
