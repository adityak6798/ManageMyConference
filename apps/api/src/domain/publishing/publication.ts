// @spec PRD-PUB-001
export interface PublicSpeaker {
  readonly slug: string;
  readonly name: string;
  readonly bio: string;
  readonly headline: string;
  readonly photoUrl?: string;
}

export interface PublicSession {
  readonly slug: string;
  readonly title: string;
  readonly abstract: string;
  readonly format: string;
  readonly track: string;
  readonly speakerSlugs: readonly string[];
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly room?: string;
}

export interface PublicEventProjection {
  readonly event: {
    readonly eventId: string;
    readonly slug: string;
    readonly name: string;
    readonly summary: string;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly timezone: string;
    readonly venue: string;
  };
  readonly cfp: {
    readonly title: string;
    readonly description: string;
    readonly status: "open" | "closed";
    readonly publishedAt: string | null;
    readonly submissionUrl: string;
  };
  readonly sessions: readonly PublicSession[];
  readonly speakers: readonly PublicSpeaker[];
}

export interface Publication {
  readonly eventId: string;
  readonly slug: string;
  readonly state: "draft" | "published" | "unpublished";
  readonly draft: PublicEventProjection;
  readonly published: PublicEventProjection | null;
  readonly publishedAt: string | null;
}

// Publication snapshots deliberately copy only public contract fields. This is the privacy
// boundary between upstream draft material and publishing-owned storage.
export const allowlistPublicProjection = (
  projection: PublicEventProjection,
): PublicEventProjection => ({
  event: {
    eventId: projection.event.eventId,
    slug: projection.event.slug,
    name: projection.event.name,
    summary: projection.event.summary,
    startsOn: projection.event.startsOn,
    endsOn: projection.event.endsOn,
    timezone: projection.event.timezone,
    venue: projection.event.venue,
  },
  cfp: {
    title: projection.cfp.title,
    description: projection.cfp.description,
    status: projection.cfp.status,
    publishedAt: projection.cfp.publishedAt,
    submissionUrl: projection.cfp.submissionUrl,
  },
  sessions: projection.sessions.map((session) => ({
    slug: session.slug,
    title: session.title,
    abstract: session.abstract,
    format: session.format,
    track: session.track,
    speakerSlugs: [...session.speakerSlugs],
    ...(session.startsAt ? { startsAt: session.startsAt } : {}),
    ...(session.endsAt ? { endsAt: session.endsAt } : {}),
    ...(session.room ? { room: session.room } : {}),
  })),
  speakers: projection.speakers.map((speaker) => ({
    slug: speaker.slug,
    name: speaker.name,
    bio: speaker.bio,
    headline: speaker.headline,
    ...(speaker.photoUrl ? { photoUrl: speaker.photoUrl } : {}),
  })),
});
