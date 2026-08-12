import type {
  AgendaRepository,
  PublishedSchedule,
} from "../../application/agenda/agenda-repository";
import type { AgendaDraft, Placement } from "../../domain/agenda/agenda";
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
}

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
}

export class D1AgendaRepository implements AgendaRepository {
  constructor(
    private readonly database: AgendaDatabase,
    private readonly now: () => Date,
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
