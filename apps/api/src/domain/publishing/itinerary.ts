/*
 * An attendee's chosen sessions.
 *
 * The first attendee-scoped data in the product, and deliberately the least of it: an
 * itinerary names published session slugs and nothing else — no name, no email, no device
 * identifier. What makes it *someone's* is a capability token held by the browser, so the
 * record stays anonymous even to whoever holds the database.
 *
 * @spec PRD-PUB-001
 */

/** Enough for a week-long conference and small enough that the row cannot become a payload. */
export const MAX_ITINERARY_SESSIONS = 200;

export interface AttendeeItinerary {
  readonly eventSlug: string;
  readonly sessionSlugs: readonly string[];
  readonly updatedAt: string;
}

/**
 * Reduce what the browser asked to save to what the published projection can justify.
 *
 * Three things at once, and each has a reason beyond tidiness:
 *
 * - **Unknown slugs are dropped**, not rejected. The projection is a snapshot, so a session
 *   the organizer withdrew between two visits is a normal event rather than a caller
 *   mistake; refusing the whole save would leave the attendee unable to change anything.
 *   It is also what stops this table storing arbitrary caller-supplied strings.
 * - **Duplicates collapse**, so a double-tapped star cannot inflate the row.
 * - **Programme order, not click order.** The itinerary is read as a day plan, and ordering
 *   it by when the attendee happened to star each session would make it useless as one.
 */
export const reconcileItinerary = (
  requested: readonly string[],
  publishedSlugs: readonly string[],
): string[] => {
  const chosen = new Set(requested);
  return publishedSlugs.filter((slug) => chosen.has(slug)).slice(0, MAX_ITINERARY_SESSIONS);
};
