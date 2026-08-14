import {
  allowlistPublicProjection,
  applyPublicationSettings,
  type ProjectionRefresh,
  type Publication,
  type PublicationProvenance,
  type PublicationSettings,
  publicEventSlug,
  publicSlugs,
  resolveEventDates,
} from "../../domain/publishing/publication";
import type { PublicSchedule, SchedulePublishedEvent } from "../agenda/public";
import type { PublishingContentQuery } from "../content/public";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  hasEventRoleCapability,
} from "../identity/actor";
import type { PublicationRepository } from "./publication-repository";

/** The organizer sent a coherent field that contradicts the stored one — a caller mistake. */
export class PublicationSettingsError extends Error {}
/** The requested public address already belongs to another event. */
export class PublicationSlugTakenError extends Error {}
/** A source/site publication advanced after composition; callers recompose instead of overwrite. */
export class PublicationProjectionConflictError extends Error {}

/**
 * Publishing's two lifecycle facts, for whoever wants to observe them.
 *
 * **Who asks, and why the shape is what it is.** The platform domain's unified audit timeline
 * (`PRD-OPS-003`) records every mutation worth remembering on an event, and every other domain
 * already had a seam it could be observed through — content's `SpeakerNotificationPort`, review's
 * `ReviewNotificationPort`, the agenda's publication batch. Publishing had none, so a site going
 * live or being taken down was the one change nothing could account for. This is that seam, and
 * it is the same inversion the other two use: publishing states what happened and holds no idea
 * of auditing, notification, or anything else the composition root chooses to bind.
 *
 * The facts carry only what an observer cannot look up for itself — which event, which public
 * address, and when — because the address is publishing's own answer and the instant is the one
 * this service committed rather than the one an observer's clock reads afterwards. Nothing about
 * the projection's contents crosses: what is on a public page is publishing's business, and an
 * observer that needed it would be reading the page rather than the fact that it moved.
 *
 * **Implementations must not throw.** Both are called after the change is already durable, so
 * failing here would report a failure for work that succeeded and undo nothing — the same
 * obligation `SpeakerNotificationPort` documents, and for the same reason.
 */
export interface PublicationNotificationPort {
  /** The public page went live under this address, replacing whatever was served before. */
  eventPublished(fact: {
    readonly eventId: string;
    readonly slug: string;
    readonly publishedAt: string;
  }): Promise<void>;
  /** The public page was withdrawn. Its address serves the not-published answer from now on. */
  eventUnpublished(fact: {
    readonly eventId: string;
    readonly slug: string;
    readonly unpublishedAt: string;
  }): Promise<void>;
}

export interface PublicationSources {
  event(actor: Actor, eventId: string): Promise<{ name: string; timezone: string } | null>;
  cfp(eventId: string): Promise<{
    version: number;
    title: string;
    description: string;
    status: "open" | "closed";
    publishedAt: string | null;
  } | null>;
  content: PublishingContentQuery;
  schedule(eventId: string): Promise<PublicSchedule | null>;
}

/** Stable, non-security change detector for a source that has no aggregate version row. */
const publicSourceDigest = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
};

/** Cause describes why a version activated, not whether its source inputs are identical. */
const sameSources = (left: PublicationProvenance, right: PublicationProvenance): boolean =>
  left.agendaVersion === right.agendaVersion &&
  left.agendaPublishedAt === right.agendaPublishedAt &&
  left.cfpVersion === right.cfpVersion &&
  left.cfpPublishedAt === right.cfpPublishedAt &&
  left.contentDigest === right.contentDigest;

// @spec PRD-PUB-001
export class PublicationService {
  private readonly sources: PublicationSources | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly repository: PublicationRepository,
    sourcesOrNow?: PublicationSources | (() => Date),
    now: () => Date = () => new Date(),
    /**
     * Optional, so a composition exercising only the projection has nobody to tell and behaves
     * exactly as it did before this port existed.
     */
    private readonly notifications?: PublicationNotificationPort,
  ) {
    this.sources = typeof sourcesOrNow === "function" ? undefined : sourcesOrNow;
    this.now = typeof sourcesOrNow === "function" ? sourcesOrNow : now;
  }

  /** Reconcile and return one row so callers cannot pair bytes from N with metadata from N+1. */
  async currentPublicBySlug(slug: string): Promise<Publication | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publication = await this.repository.findPublicBySlug(slug);
      if (!publication?.published) return null;
      if (!this.sources) return publication;

      /*
       * This is the repair path for a source writer whose notification never reached publishing.
       * The ordinary agenda path is stronger — its projection update commits in the schedule's own
       * batch — but CFP and content predate a durable event seam. Re-reading their narrow public
       * projections here means a successful public read never knowingly serves the old composition.
       * A changed input appends a new immutable publishing version; an unchanged read writes nothing.
       */
      const composed = await this.compose(
        { ...publication, draft: publication.published },
        publication.published.event,
        undefined,
        "source-reconciled",
      );
      if (
        publication.provenance &&
        sameSources(publication.provenance, composed.provenance) &&
        JSON.stringify(publication.published) === JSON.stringify(composed.draft)
      )
        return publication;
      // Small in-memory/legacy compositions have no versioned refresh writer. Production storage
      // always does; retaining the frozen answer here keeps those deliberately narrow doubles useful.
      if (!this.repository.refreshPublished) return publication;
      try {
        return await this.repository.refreshPublished({
          eventId: publication.eventId,
          expectedProjectionVersion: publication.projectionVersion ?? 0,
          activatedAt: this.now().toISOString(),
          projection: allowlistPublicProjection(composed.draft),
          provenance: composed.provenance,
        });
      } catch (error) {
        if (!(error instanceof PublicationProjectionConflictError)) throw error;
      }
    }
    throw new PublicationProjectionConflictError(
      "The public programme kept changing while it was being reconciled.",
    );
  }

  async publicBySlug(slug: string) {
    return (await this.currentPublicBySlug(slug))?.published ?? null;
  }

  /** Reconciled publication lookup for same-domain consumers that start from an event id. */
  async currentPublicByEventId(eventId: string): Promise<Publication | null> {
    const publication = await this.repository.findByEventId(eventId);
    if (publication?.state !== "published" || !publication.published) return null;
    return this.currentPublicBySlug(publication.slug);
  }

  /** The active projection together with the publishing-owned version that all surfaces share. */
  async publicSnapshotBySlug(slug: string) {
    const publication = await this.currentPublicBySlug(slug);
    if (!publication?.published) return null;
    return {
      projection: publication.published,
      version: publication.projectionVersion ?? 0,
      publishedAt: publication.publishedAt,
      provenance: publication.provenance ?? null,
    };
  }

  private requireOrganizer(
    actor: Actor | null,
    eventId: string,
    capability: "events:settings:read" | "events:settings:update",
  ) {
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    if (!actor.eventAccess.some((candidate) => candidate.eventId === eventId)) return false;
    // Every grant on the event counts, not just the first one the directory returned: an
    // organizer who also reviews for the event used to be authorized only because
    // `ORDER BY role` put "organizer" before "reviewer" (`ARC-AUTH-001`).
    if (!hasEventRoleCapability(actor, eventId, "organizer", capability))
      throw new CapabilityDeniedError(`Actor lacks ${capability} for event`);
    return actor;
  }

  /**
   * The publication an event has before anything has been stored for it.
   *
   * Shared with `updateSettings`, which needs the same starting point: an organizer may
   * edit their public details before they ever publish, and `publish` is what inserts the
   * row, so until then there is nothing to merge into.
   */
  private emptyPublication(
    eventId: string,
    event: { name: string; timezone: string },
  ): Publication {
    const slug = publicEventSlug(event.name, eventId);
    return {
      eventId,
      slug,
      state: "draft",
      draft: {
        event: {
          eventId,
          slug,
          name: event.name,
          summary: "",
          startsOn: "",
          endsOn: "",
          timezone: event.timezone,
          venue: "",
        },
        cfp: {
          title: "Call for proposals",
          description: "",
          status: "closed",
          publishedAt: null,
          submissionUrl: `/events/${slug}/cfp`,
        },
        sessions: [],
        speakers: [],
      },
      published: null,
      publishedAt: null,
    };
  }

  private async compose(
    publication: Publication,
    event: { name: string; timezone: string },
    suppliedSchedule: PublicSchedule | undefined,
    cause: PublicationProvenance["cause"],
  ): Promise<Publication & { readonly provenance: PublicationProvenance }> {
    if (!this.sources) throw new Error("Publication sources are not configured");
    const [cfp, content, schedule] = await Promise.all([
      this.sources.cfp(publication.eventId),
      this.sources.content.publishedEventContent(publication.eventId),
      suppliedSchedule
        ? Promise.resolve(suppliedSchedule)
        : this.sources.schedule(publication.eventId),
    ]);
    const agenda = schedule?.agenda;
    const placements = new Map(agenda?.placements.map((item) => [item.sessionId, item]) ?? []);
    const slots = new Map(agenda?.slots.map((item) => [item.id, item]) ?? []);
    const rooms = new Map(agenda?.rooms.map((item) => [item.id, item.name]) ?? []);
    const tracks = new Map(agenda?.tracks.map((item) => [item.id, item.name]) ?? []);
    const dates =
      agenda?.slots.flatMap(({ startsAt, endsAt }) => [
        startsAt.slice(0, 10),
        endsAt.slice(0, 10),
      ]) ?? [];
    const sortedDates = dates.toSorted();
    const speakers = new Map(content.speakers.map((speaker) => [speaker.id, speaker]));
    // Readable public URLs are derived here, from the titles and names the organizer
    // typed, and never from storage keys. `publishedEventContent` already withholds
    // private assets, so an unpublished headshot cannot be linked from the gallery.
    const sessionSlug = publicSlugs(
      content.sessions,
      ({ id, title }) => ({ id, label: title }),
      "session",
    );
    const speakerSlug = publicSlugs(
      content.speakers,
      ({ id, name }) => ({ id, label: name }),
      "speaker",
    );
    const publishableAssets = new Set(content.assets.map(({ id }) => id));
    /*
     * The draft's own address, which is not always the row's. The row's `slug` column is the
     * one being served right now; a slug the organizer has edited but not yet published
     * lives in the draft and only becomes the served address at publish time.
     */
    const draftSlug = publication.draft.event.slug || publication.slug;
    const draft = allowlistPublicProjection({
      event: {
        ...publication.draft.event,
        slug: draftSlug,
        name: event.name,
        timezone: event.timezone,
        /*
         * The organizer's typed dates win, and the agenda fills the gap when they have
         * typed none. It used to be the other way round — the agenda's first and last slot
         * dates overwrote whatever was stored, and the stored value showed only when no
         * agenda existed at all — which left an organizer unable to say "the conference
         * runs Monday to Wednesday" while a single rehearsal slot sat on the Sunday.
         */
        ...resolveEventDates(publication.draft.event, sortedDates),
      },
      cfp: cfp
        ? {
            title: cfp.title,
            description: cfp.description,
            status: cfp.status,
            publishedAt: cfp.publishedAt,
            submissionUrl: `/events/${draftSlug}/cfp`,
          }
        : publication.draft.cfp,
      sessions: content.sessions.map((session) => {
        const placement = placements.get(session.id);
        const slot = placement ? slots.get(placement.slotId) : undefined;
        const room = placement ? rooms.get(placement.roomId) : undefined;
        return {
          slug: sessionSlug(session.id),
          title: session.title,
          abstract: session.abstract,
          format: session.format,
          track: placement ? (tracks.get(placement.trackId) ?? "") : (session.tracks[0] ?? ""),
          speakerSlugs: session.speakerProfileIds
            .filter((id) => speakers.has(id))
            .map((id) => speakerSlug(id)),
          ...(slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt } : {}),
          ...(room ? { room } : {}),
        };
      }),
      speakers: content.speakers.map((speaker) => ({
        slug: speakerSlug(speaker.id),
        name: speaker.name,
        bio: speaker.bio,
        organization: speaker.organization,
        // The gallery links the asset route the content domain actually serves; the
        // `/api/public/assets/:id` path this used to emit was never routed at all.
        ...(speaker.photoAssetId && publishableAssets.has(speaker.photoAssetId)
          ? { photoUrl: `/api/speaker-assets/${speaker.photoAssetId}` }
          : {}),
        // Absent for a speaker with no links, so an unchanged programme publishes to the
        // same bytes twice.
        ...(speaker.socialLinks && Object.keys(speaker.socialLinks).length > 0
          ? { socialLinks: speaker.socialLinks }
          : {}),
      })),
    });
    return {
      ...publication,
      draft,
      provenance: {
        agendaVersion: schedule?.version ?? null,
        agendaPublishedAt: schedule?.publishedAt ?? null,
        cfpVersion: cfp?.version ?? null,
        cfpPublishedAt: cfp?.publishedAt ?? null,
        contentDigest: publicSourceDigest(content),
        cause,
      },
    };
  }

  async preview(actor: Actor | null, eventId: string) {
    const organizer = this.requireOrganizer(actor, eventId, "events:settings:read");
    if (!organizer) return null;
    const stored = await this.repository.findByEventId(eventId);
    if (!this.sources) return stored;
    const event = await this.sources.event(organizer, eventId);
    if (!event) return null;
    return this.compose(
      stored ?? this.emptyPublication(eventId, event),
      event,
      undefined,
      "source-reconciled",
    );
  }

  /**
   * Publishing's consumer of `EVT-SCHEDULE-PUBLISHED`.
   *
   * The caller hands over the public agenda snapshot that produced the event. This method never
   * reads agenda storage, and it preserves the live page's own event fields rather than pulling
   * in unrelated draft edits. The D1 adapter turns the returned value into statements appended
   * to the agenda publication batch, so the new schedule and the public projection become active
   * together. No live publication means no refresh: publishing an agenda cannot create a site.
   */
  async prepareScheduleRefresh(
    event: SchedulePublishedEvent,
    schedule: PublicSchedule,
  ): Promise<ProjectionRefresh | null> {
    const publication = await this.repository.findByEventId(event.eventId);
    if (publication?.state !== "published" || !publication.published || !this.sources) return null;
    if ((publication.provenance?.agendaVersion ?? 0) >= event.publicationVersion) return null;
    const composed = await this.compose(
      { ...publication, draft: publication.published },
      publication.published.event,
      schedule,
      "schedule-published",
    );
    if (!composed.provenance) return null;
    return {
      eventId: event.eventId,
      expectedProjectionVersion: publication.projectionVersion ?? 0,
      activatedAt: event.publishedAt,
      projection: allowlistPublicProjection(composed.draft),
      provenance: composed.provenance,
    };
  }

  /**
   * Edit the public-page fields publishing owns outright.
   *
   * Writes the **draft** and nothing else: visitors keep receiving the frozen snapshot until
   * the organizer publishes again, which is the same promise every other draft edit makes.
   *
   * The merge target is the stored draft rather than the composed preview, so that editing
   * the venue cannot quietly pin the agenda-derived dates — see `applyPublicationSettings`.
   */
  async updateSettings(actor: Actor | null, eventId: string, settings: PublicationSettings) {
    const organizer = this.requireOrganizer(actor, eventId, "events:settings:update");
    if (!organizer) return null;
    if (!this.sources) return null;
    const event = await this.sources.event(organizer, eventId);
    if (!event) return null;
    const stored = await this.repository.findByEventId(eventId);
    const base = stored ?? this.emptyPublication(eventId, event);
    const merged = applyPublicationSettings(base.draft, settings);
    /*
     * Checked after the merge, not in the contract: a request that sends only `endsOn` has
     * to be compared against the stored `startsOn`, which the contract cannot see.
     *
     * And checked against the *composed* range rather than the stored one, because an empty
     * end is not "no constraint" — it is deferred to the agenda, and the agenda's answer can
     * itself invert the range. Clearing `startsOn` while `endsOn` stays pinned to a day
     * before the first scheduled session used to pass this check and then publish backwards.
     * The stored value stays empty either way; only the validation looks through it.
     */
    const schedule = await this.sources.schedule(eventId);
    const agendaDays = (schedule?.agenda?.slots ?? [])
      .flatMap(({ startsAt, endsAt }) => [startsAt.slice(0, 10), endsAt.slice(0, 10)])
      .toSorted();
    const composed = resolveEventDates(merged.event, agendaDays);
    if (composed.startsOn && composed.endsOn && composed.startsOn > composed.endsOn)
      throw new PublicationSettingsError(
        merged.event.startsOn && merged.event.endsOn
          ? "The end date cannot fall before the start date."
          : "Those dates end before the schedule starts. Set both days rather than leaving one to the agenda.",
      );
    if (merged.event.slug !== base.draft.event.slug) {
      const owner = await this.repository.findEventIdBySlug(merged.event.slug);
      if (owner && owner !== eventId)
        throw new PublicationSlugTakenError("That public address is already taken.");
    }
    await this.repository.saveSettings(
      eventId,
      merged.event.slug,
      allowlistPublicProjection(merged),
    );
    return this.preview(actor, eventId);
  }

  async publish(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:update")) return null;
    let published: Publication | null = null;
    let publishedAt = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const publication = await this.preview(actor, eventId);
      if (!publication) return null;
      publishedAt = this.now().toISOString();
      try {
        published = await this.repository.publish(
          eventId,
          publishedAt,
          allowlistPublicProjection(publication.draft),
          publication.provenance
            ? { ...publication.provenance, cause: "site-published" }
            : undefined,
          publication.projectionVersion ?? 0,
        );
        break;
      } catch (error) {
        if (!(error instanceof PublicationProjectionConflictError)) throw error;
      }
    }
    if (!published)
      throw new PublicationProjectionConflictError(
        "The public programme kept changing while it was being published.",
      );
    // Reported after the write, never before: the fact is that a page *is* live, and announcing
    // one that then failed to commit would put a change on an audit timeline that never happened.
    if (published)
      await this.notifications?.eventPublished({
        eventId,
        slug: published.slug,
        publishedAt,
      });
    return published;
  }

  /**
   * Take the public page down.
   *
   * The fact reported is that a **live** page was withdrawn, so the instant is read before the
   * write and the repository's update is conditional on the page still being published. A second
   * unpublish changes no row and therefore reports nothing: without both halves, a double-click
   * announced a take-down that did not happen, and an append-only observer recorded it forever.
   */
  async unpublish(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:update")) return null;
    const unpublishedAt = this.now().toISOString();
    const unpublished = await this.repository.unpublish(eventId);
    if (unpublished)
      await this.notifications?.eventUnpublished({
        eventId,
        slug: unpublished.slug,
        unpublishedAt,
      });
    return unpublished;
  }
}
