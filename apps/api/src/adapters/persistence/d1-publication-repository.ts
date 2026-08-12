import type { PublicationRepository } from "../../application/publishing/publication-repository";
import { PublicationSlugTakenError } from "../../application/publishing/publication-service";
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

const isPublicationSlugConstraint = (error: unknown) =>
  /(UNIQUE constraint failed:.*public_event_projections(?:\.slug|_draft_slug_idx)|publication slug taken)/i.test(
    error instanceof Error ? error.message : String(error),
  );

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

  async findEventIdBySlug(slug: string): Promise<string | null> {
    /*
     * Both the served address and the one a draft has reserved.
     *
     * The `slug` column holds what is being served right now, and a slug an organizer has
     * edited but not yet published lives only in `draft_json`. Checking the column alone let
     * two events draft the same address: the second save succeeded, and the conflict only
     * surfaced as a unique-index failure at publish time — a 500 on the wrong action, long
     * after the point where the organizer could have chosen a different name.
     */
    const result = await this.database
      .prepare(
        `SELECT event_id FROM public_event_projections
         WHERE slug = ? OR json_extract(draft_json, '$.event.slug') = ?
         LIMIT 1`,
      )
      .bind(slug, slug)
      .all<{ event_id: string }>();
    if (!result.success)
      throw new Error(`D1 failed to resolve publication slug: ${result.error ?? "unknown error"}`);
    return result.results?.[0]?.event_id ?? null;
  }

  async saveSettings(
    eventId: string,
    slug: string,
    draft: PublicEventProjection,
  ): Promise<Publication | null> {
    let result: { success: boolean; error?: string };
    try {
      result = await this.database
        .prepare(
          `INSERT INTO public_event_projections
          (event_id, slug, state, draft_json, published_json, published_at)
         VALUES (?, ?, 'draft', ?, NULL, NULL)
         ON CONFLICT(event_id) DO UPDATE SET
          draft_json = excluded.draft_json,
          -- The row's own \`slug\` is the address currently being *served*, so a draft edit
          -- may only move it while nothing is published; publishing promotes the draft's
          -- slug in its own statement. Otherwise renaming the draft would silently redirect
          -- the live page away from the URL people have already been given, and leave the
          -- frozen snapshot's \`event.slug\` disagreeing with the row that serves it.
          slug = CASE
            WHEN public_event_projections.state = 'published' THEN public_event_projections.slug
            ELSE excluded.slug
          END`,
        )
        .bind(eventId, slug, JSON.stringify(draft))
        .run();
    } catch (error) {
      if (isPublicationSlugConstraint(error))
        throw new PublicationSlugTakenError("That public address is already taken.");
      throw error;
    }
    if (!result.success && isPublicationSlugConstraint(result.error))
      throw new PublicationSlugTakenError("That public address is already taken.");
    if (!result.success)
      throw new Error(`D1 failed to save publication settings: ${result.error ?? "unknown error"}`);
    return this.findByEventId(eventId);
  }

  async publish(
    eventId: string,
    publishedAt: string,
    projection: PublicEventProjection,
  ): Promise<Publication | null> {
    let result: { success: boolean; error?: string };
    try {
      result = await this.database
        .prepare(
          `INSERT INTO public_event_projections
          (event_id, slug, state, draft_json, published_json, published_at)
         VALUES (?, ?, 'published', ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
          slug = excluded.slug,
          state = 'published',
          draft_json = excluded.draft_json,
          published_json = excluded.published_json,
          published_at = excluded.published_at`,
        )
        .bind(
          eventId,
          projection.event.slug,
          JSON.stringify(projection),
          JSON.stringify(projection),
          publishedAt,
        )
        .run();
    } catch (error) {
      if (isPublicationSlugConstraint(error))
        throw new PublicationSlugTakenError("That public address is already taken.");
      throw error;
    }
    if (!result.success && isPublicationSlugConstraint(result.error))
      throw new PublicationSlugTakenError("That public address is already taken.");
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
