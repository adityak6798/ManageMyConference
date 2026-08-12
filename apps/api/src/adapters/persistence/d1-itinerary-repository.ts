import type {
  ItineraryRepository,
  StoredItinerary,
} from "../../application/publishing/itinerary-repository";

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ success: boolean; error?: string }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
interface D1DatabasePort {
  prepare(query: string): D1PreparedStatement;
}

interface ItineraryRow {
  event_id: string;
  session_slugs: string;
  updated_at: string;
}

const fromRow = (row: ItineraryRow): StoredItinerary => ({
  eventId: row.event_id,
  // Stored as JSON and read back defensively: a row that is not an array of strings is
  // treated as an empty itinerary rather than being handed to the projection filter.
  sessionSlugs: (() => {
    const parsed: unknown = JSON.parse(row.session_slugs);
    return Array.isArray(parsed) ? parsed.filter((slug) => typeof slug === "string") : [];
  })(),
  updatedAt: row.updated_at,
});

// @spec PRD-PUB-001
export class D1ItineraryRepository implements ItineraryRepository {
  constructor(private readonly database: D1DatabasePort) {}

  async create(
    tokenHash: string,
    eventId: string,
    sessionSlugs: readonly string[],
    now: string,
  ): Promise<StoredItinerary | null> {
    const result = await this.database
      .prepare(
        `INSERT INTO attendee_itineraries (token_hash, event_id, session_slugs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(tokenHash, eventId, JSON.stringify([...sessionSlugs]), now, now)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to create itinerary: ${result.error ?? "unknown error"}`);
    return { eventId, sessionSlugs: [...sessionSlugs], updatedAt: now };
  }

  async findByTokenHash(tokenHash: string): Promise<StoredItinerary | null> {
    const result = await this.database
      .prepare(
        "SELECT event_id, session_slugs, updated_at FROM attendee_itineraries WHERE token_hash = ? LIMIT 1",
      )
      .bind(tokenHash)
      .all<ItineraryRow>();
    if (!result.success)
      throw new Error(`D1 failed to load itinerary: ${result.error ?? "unknown error"}`);
    return result.results?.[0] ? fromRow(result.results[0]) : null;
  }

  async save(
    tokenHash: string,
    sessionSlugs: readonly string[],
    now: string,
  ): Promise<StoredItinerary | null> {
    const result = await this.database
      .prepare(
        "UPDATE attendee_itineraries SET session_slugs = ?, updated_at = ? WHERE token_hash = ?",
      )
      .bind(JSON.stringify([...sessionSlugs]), now, tokenHash)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save itinerary: ${result.error ?? "unknown error"}`);
    return this.findByTokenHash(tokenHash);
  }

  async prune(emptyBefore: string, endedBefore: string): Promise<void> {
    const result = await this.database
      .prepare(
        `DELETE FROM attendee_itineraries
         WHERE (session_slugs = '[]' AND updated_at < ?)
            OR event_id IN (
              SELECT event_id
              FROM public_event_projections
              WHERE COALESCE(
                json_extract(published_json, '$.event.endsOn'),
                json_extract(draft_json, '$.event.endsOn')
              ) <> ''
                AND COALESCE(
                  json_extract(published_json, '$.event.endsOn'),
                  json_extract(draft_json, '$.event.endsOn')
                ) < ?
            )`,
      )
      .bind(emptyBefore, endedBefore)
      .run();
    if (!result.success)
      throw new Error(`D1 failed to prune itineraries: ${result.error ?? "unknown error"}`);
  }
}
