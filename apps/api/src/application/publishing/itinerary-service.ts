import {
  type AttendeeItinerary,
  MAX_ITINERARY_SESSIONS,
  reconcileItinerary,
} from "../../domain/publishing/itinerary";
import type { ItineraryRepository } from "./itinerary-repository";
import type { PublicationRepository } from "./publication-repository";

/** The event is not published, or the token names nothing. One answer, deliberately. */
export class ItineraryNotFoundError extends Error {}

/** 32 bytes. Guessing one is not a threat model anybody needs to reason about further. */
const TOKEN_BYTES = 32;
/** An empty mint has no attendee value; one day is enough to survive an interrupted first visit. */
export const EMPTY_ITINERARY_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Keep ended-event plans for at least one full UTC day so timezone edges cannot prune mid-event. */
export const ENDED_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/**
 * The stored address of a token: its SHA-256, as 64 lowercase hex characters.
 *
 * Presented tokens are hashed and looked up by hash, so the table holds no value that can
 * be replayed against the API. Plain SHA-256 rather than a slow KDF is the right trade
 * here and it is worth saying why: this is a 256-bit random string, not a password, so
 * there is no dictionary to stretch against.
 */
export async function hashItineraryToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Attendee itineraries on the anonymous public surface.
 *
 * Identity is a capability token and nothing else. That choice is forced rather than
 * preferred: `/api/public/*` answers every origin with `Access-Control-Allow-Origin: *`,
 * browsers refuse to send credentials to a wildcard origin, and the namespace's ETag and
 * `no-cache` policy means a shared cache may store these responses — so a per-attendee body
 * on a URL that is the same for everyone would be a cross-attendee leak. Giving each
 * itinerary its own unguessable URL makes the cache key correct by construction, and makes
 * "share my plan" the same act as sharing the link.
 *
 * @spec PRD-PUB-001
 */
export class ItineraryService {
  constructor(
    private readonly itineraries: ItineraryRepository,
    private readonly publications: PublicationRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly randomBytes: (length: number) => Uint8Array = (length) =>
      crypto.getRandomValues(new Uint8Array(length)),
  ) {}

  /** Apply the bounded anonymous-data policy from PRD-PUB-001. Called by the Worker cron. */
  prune(): Promise<void> {
    const now = this.now();
    return this.itineraries.prune(
      new Date(now.getTime() - EMPTY_ITINERARY_RETENTION_MS).toISOString(),
      new Date(now.getTime() - ENDED_EVENT_RETENTION_MS).toISOString().slice(0, 10),
    );
  }

  /** The published projection's session slugs, or null when the event is not public. */
  private async publishedSlugs(eventSlug: string): Promise<{ eventId: string; slugs: string[] }> {
    const publication = await this.publications.findPublicBySlug(eventSlug);
    if (!publication?.published) throw new ItineraryNotFoundError("This event is not published.");
    return {
      eventId: publication.eventId,
      slugs: publication.published.sessions.map((session) => session.slug),
    };
  }

  /**
   * Mint an itinerary for a published event.
   *
   * The token is returned exactly once, here. Nothing else can recover it — the table
   * holds only its hash — which is the property that makes the URL a capability.
   */
  async create(
    eventSlug: string,
    requested: readonly string[] = [],
  ): Promise<{ token: string; itinerary: AttendeeItinerary }> {
    const { eventId, slugs } = await this.publishedSlugs(eventSlug);
    const token = base64url(this.randomBytes(TOKEN_BYTES));
    const timestamp = this.now().toISOString();
    const stored = await this.itineraries.create(
      await hashItineraryToken(token),
      eventId,
      reconcileItinerary(requested, slugs),
      timestamp,
    );
    if (!stored) throw new ItineraryNotFoundError("The itinerary could not be created.");
    return {
      token,
      itinerary: { eventSlug, sessionSlugs: stored.sessionSlugs, updatedAt: stored.updatedAt },
    };
  }

  async read(token: string): Promise<AttendeeItinerary> {
    const stored = await this.itineraries.findByTokenHash(await hashItineraryToken(token));
    if (!stored) throw new ItineraryNotFoundError("This itinerary was not found.");
    const publication = await this.publications.findByEventId(stored.eventId);
    // An event taken down takes its itineraries with it, exactly as it takes its public
    // page: an unpublished snapshot must not stay readable through a side door.
    if (!publication?.published || publication.state !== "published")
      throw new ItineraryNotFoundError("This itinerary was not found.");
    return {
      eventSlug: publication.slug,
      // Re-filtered on read as well as on write, so a session withdrawn after the last save
      // stops appearing without needing anyone to have saved since.
      sessionSlugs: reconcileItinerary(
        stored.sessionSlugs,
        publication.published.sessions.map((session) => session.slug),
      ),
      updatedAt: stored.updatedAt,
    };
  }

  async save(token: string, requested: readonly string[]): Promise<AttendeeItinerary> {
    const tokenHash = await hashItineraryToken(token);
    const stored = await this.itineraries.findByTokenHash(tokenHash);
    if (!stored) throw new ItineraryNotFoundError("This itinerary was not found.");
    const publication = await this.publications.findByEventId(stored.eventId);
    if (!publication?.published || publication.state !== "published")
      throw new ItineraryNotFoundError("This itinerary was not found.");
    const reconciled = reconcileItinerary(
      requested.slice(0, MAX_ITINERARY_SESSIONS),
      publication.published.sessions.map((session) => session.slug),
    );
    const saved = await this.itineraries.save(tokenHash, reconciled, this.now().toISOString());
    if (!saved) throw new ItineraryNotFoundError("This itinerary was not found.");
    return {
      eventSlug: publication.slug,
      sessionSlugs: saved.sessionSlugs,
      updatedAt: saved.updatedAt,
    };
  }
}
