/**
 * `EmbedRepository` against D1.
 *
 * `findLiveByTokenHash` filters on `revoked_at IS NULL` in the statement rather than reading the
 * row and testing it afterwards, and that is the difference between "withdrawn" and "forbidden":
 * a revoked embed matches nothing, so the resolver cannot tell it from an address that never
 * existed. The partial index `publication_embeds_live_idx` covers exactly that predicate.
 *
 * The update deliberately does **not** write `output` or `token_hash`. Migration `1805` guards
 * both with triggers, so this is the second of two defences rather than the only one — but
 * leaving them out of the statement is what makes the intent legible here: an embed's address and
 * its output are what its consumers depend on, and neither is this service's to move.
 *
 * @spec PRD-PUB-001 ARC-003
 */
import type { EmbedRepository } from "../../application/publishing/embed-service";
import type {
  EmbedFilters,
  EmbedOutput,
  EmbedTheme,
  EmbedView,
  PublicationEmbed,
} from "../../domain/publishing/embed";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface EmbedDatabasePort {
  prepare(query: string): D1Statement;
}

interface EmbedRow {
  id: string;
  event_id: string;
  name: string;
  view: EmbedView;
  output: EmbedOutput;
  accent: string;
  theme: EmbedTheme;
  filters_json: string;
  fields_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
  revoked_at: string | null;
}

const COLUMNS =
  "id, event_id, name, view, output, accent, theme, filters_json, fields_json, created_by, created_at, updated_at, revision, revoked_at";

const toEmbed = (row: EmbedRow): PublicationEmbed => ({
  id: row.id,
  eventId: row.event_id,
  name: row.name,
  view: row.view,
  output: row.output,
  accent: row.accent,
  theme: row.theme,
  filters: JSON.parse(row.filters_json) as EmbedFilters,
  fields: JSON.parse(row.fields_json) as string[],
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revision: row.revision,
  revokedAt: row.revoked_at,
});

export class D1EmbedRepository implements EmbedRepository {
  constructor(private readonly database: EmbedDatabasePort) {}

  private async rows<T>(query: string, ...values: unknown[]): Promise<T[]> {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .all<T>();
    if (!result.success)
      throw new Error(`D1 failed to read embeds: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }

  async list(eventId: string): Promise<readonly PublicationEmbed[]> {
    return (
      await this.rows<EmbedRow>(
        `SELECT ${COLUMNS} FROM publication_embeds WHERE event_id = ? ORDER BY created_at DESC, id`,
        eventId,
      )
    ).map(toEmbed);
  }

  async find(eventId: string, embedId: string): Promise<PublicationEmbed | null> {
    const row = (
      await this.rows<EmbedRow>(
        `SELECT ${COLUMNS} FROM publication_embeds WHERE event_id = ? AND id = ? LIMIT 1`,
        eventId,
        embedId,
      )
    )[0];
    return row ? toEmbed(row) : null;
  }

  async findLiveByTokenHash(tokenHash: string): Promise<PublicationEmbed | null> {
    const row = (
      await this.rows<EmbedRow>(
        `SELECT ${COLUMNS} FROM publication_embeds WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
        tokenHash,
      )
    )[0];
    return row ? toEmbed(row) : null;
  }

  async create(embed: PublicationEmbed, tokenHash: string): Promise<void> {
    const result = await this.database
      .prepare(
        "INSERT INTO publication_embeds (id, event_id, name, view, output, accent, theme, filters_json, fields_json, token_hash, created_by, created_at, updated_at, revision, revoked_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        embed.id,
        embed.eventId,
        embed.name,
        embed.view,
        embed.output,
        embed.accent,
        embed.theme,
        JSON.stringify(embed.filters),
        JSON.stringify(embed.fields),
        tokenHash,
        embed.createdBy,
        embed.createdAt,
        embed.updatedAt,
        embed.revision,
        embed.revokedAt,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create an embed: ${result.error ?? "unknown error"}`);
  }

  async update(embed: PublicationEmbed, expectedRevision: number): Promise<number> {
    const result = await this.database
      .prepare(
        "UPDATE publication_embeds SET name = ?, view = ?, accent = ?, theme = ?, filters_json = ?, fields_json = ?, updated_at = ?, revision = ? " +
          "WHERE id = ? AND event_id = ? AND revision = ? AND revoked_at IS NULL",
      )
      .bind(
        embed.name,
        embed.view,
        embed.accent,
        embed.theme,
        JSON.stringify(embed.filters),
        JSON.stringify(embed.fields),
        embed.updatedAt,
        embed.revision,
        embed.id,
        embed.eventId,
        expectedRevision,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to update an embed: ${result.error ?? "unknown error"}`);
    return changedRows(result, "update an embed");
  }

  async revoke(eventId: string, embedId: string, at: string): Promise<number> {
    const result = await this.database
      .prepare(
        "UPDATE publication_embeds SET revoked_at = ? WHERE id = ? AND event_id = ? AND revoked_at IS NULL",
      )
      .bind(at, embedId, eventId)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to revoke an embed: ${result.error ?? "unknown error"}`);
    return changedRows(result, "revoke an embed");
  }
}
