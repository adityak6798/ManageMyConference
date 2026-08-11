import type { PublicationRepository } from "./publication-repository";
import {
  allowlistPublicProjection,
  publicEventSlug,
  publicSlugs,
} from "../../domain/publishing/publication";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  hasEventRoleCapability,
} from "../identity/actor";
import type { PublishingContentQuery } from "../content/public";
import type { PublicSchedule } from "../agenda/public";

export interface PublicationSources {
  event(actor: Actor, eventId: string): Promise<{ name: string; timezone: string } | null>;
  cfp(eventId: string): Promise<{
    title: string;
    description: string;
    status: "open" | "closed";
    publishedAt: string | null;
  } | null>;
  content: PublishingContentQuery;
  schedule(eventId: string): Promise<PublicSchedule | null>;
}

// @spec PRD-PUB-001
export class PublicationService {
  private readonly sources: PublicationSources | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly repository: PublicationRepository,
    sourcesOrNow?: PublicationSources | (() => Date),
    now: () => Date = () => new Date(),
  ) {
    this.sources = typeof sourcesOrNow === "function" ? undefined : sourcesOrNow;
    this.now = typeof sourcesOrNow === "function" ? sourcesOrNow : now;
  }

  async publicBySlug(slug: string) {
    const publication = await this.repository.findPublicBySlug(slug);
    return publication?.published ?? null;
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

  async preview(actor: Actor | null, eventId: string) {
    const organizer = this.requireOrganizer(actor, eventId, "events:settings:read");
    if (!organizer) return null;
    const stored = await this.repository.findByEventId(eventId);
    if (!this.sources) return stored;
    const event = await this.sources.event(organizer, eventId);
    if (!event) return null;
    const slug = publicEventSlug(event.name, eventId);
    const publication =
      stored ??
      ({
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
      } satisfies import("../../domain/publishing/publication").Publication);
    const [cfp, content, schedule] = await Promise.all([
      this.sources.cfp(eventId),
      this.sources.content.publishedEventContent(eventId),
      this.sources.schedule(eventId),
    ]);
    if (!event) return null;
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
    return {
      ...publication,
      draft: allowlistPublicProjection({
        event: {
          ...publication.draft.event,
          name: event.name,
          timezone: event.timezone,
          startsOn: sortedDates[0] ?? publication.draft.event.startsOn,
          endsOn: sortedDates.at(-1) ?? publication.draft.event.endsOn,
        },
        cfp: cfp
          ? {
              title: cfp.title,
              description: cfp.description,
              status: cfp.status,
              publishedAt: cfp.publishedAt,
              submissionUrl: `/events/${publication.slug}/cfp`,
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
        })),
      }),
    };
  }

  async publish(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:update")) return null;
    const publication = await this.preview(actor, eventId);
    if (!publication) return null;
    return this.repository.publish(
      eventId,
      this.now().toISOString(),
      allowlistPublicProjection(publication.draft),
    );
  }

  unpublish(actor: Actor | null, eventId: string) {
    if (!this.requireOrganizer(actor, eventId, "events:settings:update")) return null;
    return this.repository.unpublish(eventId);
  }
}
