import type { PublicationRepository } from "../../application/publishing/publication-repository";
import type { Publication, PublicEventProjection } from "../../domain/publishing/publication";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ success: boolean; error?: string }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
interface D1DatabasePort {
  prepare(query: string): D1PreparedStatement;
}

interface PublicationRow {
  event_id: string;
  slug: string;
  state: Publication["state"];
  draft_json: string;
  published_json: string | null;
  published_at: string | null;
}

const fromRow = (row: PublicationRow): Publication => ({
  eventId: row.event_id,
  slug: row.slug,
  state: row.state,
  draft: JSON.parse(row.draft_json) as PublicEventProjection,
  published: row.published_json ? (JSON.parse(row.published_json) as PublicEventProjection) : null,
  publishedAt: row.published_at,
});

// @spec PRD-PUB-001
export class D1PublicationRepository implements PublicationRepository {
  constructor(private readonly database: D1DatabasePort) {}

  async findPublicBySlug(slug: string): Promise<Publication | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, slug, state, draft_json, published_json, published_at FROM public_event_projections WHERE slug = ? AND state = 'published' LIMIT 1",
      )
      .bind(slug)
      .all<PublicationRow>();
    if (!result.success)
      throw new Error(`D1 failed to load public projection: ${result.error ?? "unknown error"}`);
    return result.results?.[0] ? fromRow(result.results[0]) : null;
  }

  async findByEventId(eventId: string): Promise<Publication | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, slug, state, draft_json, published_json, published_at FROM public_event_projections WHERE event_id = ? LIMIT 1",
      )
      .bind(eventId)
      .all<PublicationRow>();
    if (!result.success)
      throw new Error(`D1 failed to load publication preview: ${result.error ?? "unknown error"}`);
    return result.results?.[0] ? fromRow(result.results[0]) : null;
  }

  async publish(eventId: string, publishedAt: string): Promise<Publication | null> {
    const result = await this.database
      .prepare(
        "UPDATE public_event_projections SET state = 'published', published_json = draft_json, published_at = ? WHERE event_id = ?",
      )
      .bind(publishedAt, eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to publish projection: ${result.error ?? "unknown error"}`);
    return this.findByEventId(eventId);
  }

  async unpublish(eventId: string): Promise<Publication | null> {
    const result = await this.database
      .prepare(
        "UPDATE public_event_projections SET state = 'unpublished', published_json = NULL, published_at = NULL WHERE event_id = ?",
      )
      .bind(eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to unpublish projection: ${result.error ?? "unknown error"}`);
    return this.findByEventId(eventId);
  }
}
