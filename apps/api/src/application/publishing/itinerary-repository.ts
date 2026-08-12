// @spec PRD-PUB-001
export interface StoredItinerary {
  readonly eventId: string;
  readonly sessionSlugs: readonly string[];
  readonly updatedAt: string;
}

/**
 * Itinerary storage, addressed only by the SHA-256 of the capability token.
 *
 * Every method takes the hash rather than the token itself, so the plaintext never reaches
 * the adapter layer and cannot be written to a log, a query plan, or a stored procedure by
 * accident — the same handling an API key gets.
 */
export interface ItineraryRepository {
  create(
    tokenHash: string,
    eventId: string,
    sessionSlugs: readonly string[],
    now: string,
  ): Promise<StoredItinerary | null>;
  findByTokenHash(tokenHash: string): Promise<StoredItinerary | null>;
  save(
    tokenHash: string,
    sessionSlugs: readonly string[],
    now: string,
  ): Promise<StoredItinerary | null>;
  prune(emptyBefore: string, endedBefore: string): Promise<void>;
}
