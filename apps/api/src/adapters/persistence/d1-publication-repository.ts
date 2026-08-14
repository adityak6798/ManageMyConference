import type { PublicationRepository } from "../../application/publishing/publication-repository";
import { PublicationSlugTakenError } from "../../application/publishing/publication-service";
import type {
  ProjectionRefresh,
  Publication,
  PublicationProvenance,
  PublicEventProjection,
} from "../../domain/publishing/publication";
import { changedRows, type D1WriteResult } from "./d1-write-result";

export interface PublicationD1Statement {
  bind(...values: unknown[]): PublicationD1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
interface D1DatabasePort {
  prepare(query: string): PublicationD1Statement;
  batch<T = unknown>(
    statements: PublicationD1Statement[],
  ): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface PublicationRow {
  event_id: string;
  slug: string;
  state: Publication["state"];
  draft_json: string;
  published_json: string | null;
  published_at: string | null;
  projection_version: number;
  agenda_version: number | null;
  agenda_published_at: string | null;
  cfp_version: number | null;
  cfp_published_at: string | null;
  content_digest: string | null;
  activation_cause: PublicationProvenance["cause"] | null;
}

const PUBLICATION_COLUMNS =
  "event_id, slug, state, draft_json, published_json, published_at, projection_version, agenda_version, agenda_published_at, cfp_version, cfp_published_at, content_digest, activation_cause";

const fromRow = (row: PublicationRow): Publication => ({
  eventId: row.event_id,
  slug: row.slug,
  state: row.state,
  draft: JSON.parse(row.draft_json) as PublicEventProjection,
  published: row.published_json ? (JSON.parse(row.published_json) as PublicEventProjection) : null,
  publishedAt: row.published_at,
  projectionVersion: row.projection_version,
  provenance:
    row.activation_cause && row.content_digest
      ? {
          agendaVersion: row.agenda_version,
          agendaPublishedAt: row.agenda_published_at,
          cfpVersion: row.cfp_version,
          cfpPublishedAt: row.cfp_published_at,
          contentDigest: row.content_digest,
          cause: row.activation_cause,
        }
      : null,
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
        `SELECT ${PUBLICATION_COLUMNS} FROM public_event_projections WHERE slug = ? AND state = 'published' LIMIT 1`,
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
        `SELECT ${PUBLICATION_COLUMNS} FROM public_event_projections WHERE event_id = ? LIMIT 1`,
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
    provenance: PublicationProvenance = {
      agendaVersion: null,
      agendaPublishedAt: null,
      cfpVersion: null,
      cfpPublishedAt: null,
      contentDigest: "legacy:unknown",
      cause: "site-published",
    },
  ): Promise<Publication | null> {
    let results: Array<D1WriteResult & { results?: unknown[] }>;
    try {
      results = await this.database.batch([
        this.database
          .prepare(
            `INSERT INTO public_event_projections
          (event_id, slug, state, draft_json, published_json, published_at,
           projection_version, agenda_version, agenda_published_at, cfp_version,
           cfp_published_at, content_digest, activation_cause)
         VALUES (?, ?, 'published', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
          slug = excluded.slug,
          state = 'published',
          draft_json = excluded.draft_json,
          published_json = excluded.published_json,
          published_at = excluded.published_at,
          projection_version = public_event_projections.projection_version + 1,
          agenda_version = excluded.agenda_version,
          agenda_published_at = excluded.agenda_published_at,
          cfp_version = excluded.cfp_version,
          cfp_published_at = excluded.cfp_published_at,
          content_digest = excluded.content_digest,
          activation_cause = excluded.activation_cause`,
          )
          .bind(
            eventId,
            projection.event.slug,
            JSON.stringify(projection),
            JSON.stringify(projection),
            publishedAt,
            provenance.agendaVersion,
            provenance.agendaPublishedAt,
            provenance.cfpVersion,
            provenance.cfpPublishedAt,
            provenance.contentDigest,
            provenance.cause,
          ),
        this.snapshotStatement(eventId),
      ]);
    } catch (error) {
      if (isPublicationSlugConstraint(error))
        throw new PublicationSlugTakenError("That public address is already taken.");
      throw error;
    }
    const constraint = results.find((result) => isPublicationSlugConstraint(result.error));
    if (constraint) throw new PublicationSlugTakenError("That public address is already taken.");
    const failure = results.find((result) => !result.success);
    if (failure)
      throw new Error(`D1 failed to publish projection: ${failure.error ?? "unknown error"}`);
    return this.findByEventId(eventId);
  }

  /** Insert the active row as an immutable history entry after a publish/refresh statement. */
  private snapshotStatement(eventId: string): PublicationD1Statement {
    return this.database
      .prepare(
        `INSERT INTO public_event_projection_versions
          (event_id, version, activated_at, projection_json, agenda_version,
           agenda_published_at, cfp_version, cfp_published_at, content_digest, activation_cause)
         SELECT event_id, projection_version, published_at, published_json, agenda_version,
                agenda_published_at, cfp_version, cfp_published_at, content_digest, activation_cause
         FROM public_event_projections
         WHERE event_id = ? AND state = 'published' AND published_json IS NOT NULL
         ON CONFLICT(event_id, version) DO NOTHING`,
      )
      .bind(eventId);
  }

  /**
   * Statements publishing contributes to the agenda's publication transaction.
   *
   * The first statement is conditional on the event still being live and on the composed bytes
   * or provenance actually changing. The second snapshots exactly the row that first statement
   * activated. Both are publishing-owned SQL returned opaquely through agenda's existing event
   * writer; agenda never names this table or learns the projection shape.
   */
  prepareRefreshStatements(refresh: ProjectionRefresh): readonly PublicationD1Statement[] {
    const projection = JSON.stringify(refresh.projection);
    const source = refresh.provenance;
    return [
      this.database
        .prepare(
          `UPDATE public_event_projections SET
             published_json = ?,
             published_at = ?,
             projection_version = projection_version + 1,
             agenda_version = ?,
             agenda_published_at = ?,
             cfp_version = ?,
             cfp_published_at = ?,
             content_digest = ?,
             activation_cause = ?
           WHERE event_id = ? AND state = 'published'
             AND (
               published_json IS NOT ? OR
               agenda_version IS NOT ? OR agenda_published_at IS NOT ? OR
               cfp_version IS NOT ? OR cfp_published_at IS NOT ? OR
               content_digest IS NOT ?
             )`,
        )
        .bind(
          projection,
          refresh.activatedAt,
          source.agendaVersion,
          source.agendaPublishedAt,
          source.cfpVersion,
          source.cfpPublishedAt,
          source.contentDigest,
          source.cause,
          refresh.eventId,
          projection,
          source.agendaVersion,
          source.agendaPublishedAt,
          source.cfpVersion,
          source.cfpPublishedAt,
          source.contentDigest,
        ),
      this.snapshotStatement(refresh.eventId),
    ];
  }

  async refreshPublished(refresh: ProjectionRefresh): Promise<Publication | null> {
    const results = await this.database.batch([...this.prepareRefreshStatements(refresh)]);
    const failure = results.find((result) => !result.success);
    if (failure)
      throw new Error(
        `D1 failed to refresh public projection: ${failure.error ?? "unknown error"}`,
      );
    const update = results[0];
    if (!update) throw new Error("D1 returned no result for public projection refresh");
    // Missing `meta.changes` is a failure, never an assumed success or no-op.
    changedRows(update, "refresh public projection");
    const publication = await this.findByEventId(refresh.eventId);
    return publication?.state === "published" ? publication : null;
  }

  async unpublish(eventId: string): Promise<Publication | null> {
    const result = await this.database
      .prepare(
        "UPDATE public_event_projections SET state = 'unpublished', published_json = NULL, published_at = NULL WHERE event_id = ? AND state = 'published'",
      )
      .bind(eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to unpublish projection: ${result.error ?? "unknown error"}`);
    if (changedRows(result, "unpublish projection") === 0) return null;
    return this.findByEventId(eventId);
  }
}
