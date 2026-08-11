import type { PublicationRepository } from "./publication-repository";
import { allowlistPublicProjection } from "../../domain/publishing/publication";
import { type Actor, AuthenticationRequiredError, CapabilityDeniedError } from "../identity/actor";
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
    const access = actor.eventAccess.find((candidate) => candidate.eventId === eventId);
    if (!access) return false;
    if (access.role !== "organizer" || !access.capabilities.has(capability))
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
    const slugBase = event.name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 76);
    const slug = `${slugBase || "event"}-${eventId}`;
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
            slug: session.id,
            title: session.title,
            abstract: session.abstract,
            format: session.format,
            track: placement ? (tracks.get(placement.trackId) ?? "") : (session.tracks[0] ?? ""),
            speakerSlugs: session.speakerProfileIds.filter((id) => speakers.has(id)),
            ...(slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt } : {}),
            ...(room ? { room } : {}),
          };
        }),
        speakers: content.speakers.map((speaker) => ({
          slug: speaker.id,
          name: speaker.name,
          bio: speaker.bio,
          headline: speaker.organization,
          ...(speaker.photoAssetId
            ? { photoUrl: `/api/public/assets/${speaker.photoAssetId}` }
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
