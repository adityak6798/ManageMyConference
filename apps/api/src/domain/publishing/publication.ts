// @spec PRD-PUB-001
export interface PublicSpeaker {
  readonly slug: string;
  readonly name: string;
  readonly bio: string;
  /**
   * The speaker's employer, copied from their profile. It was called `headline` while it
   * still held the organization, which made the gallery print an employer wherever a job
   * title belonged; the field now says what it actually carries.
   */
  readonly organization: string;
  readonly photoUrl?: string;
  /**
   * The speaker's own links, by platform, frozen into the snapshot like everything else here.
   *
   * Content narrows every value to `http`/`https` before storing it, which is the property the
   * public page relies on to render one into an `href`. Absent for a speaker who recorded none,
   * so an unchanged programme publishes to identical bytes twice.
   */
  readonly socialLinks?: Readonly<Record<string, string>>;
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

/**
 * Which upstream public facts were composed into one immutable projection version.
 *
 * Publishing owns the snapshot, while these values make the inputs it used observable without
 * copying another domain's storage identifiers into the public contract. Content has no single
 * version row, so its public application projection is represented by a deterministic digest.
 */
export interface PublicationProvenance {
  readonly agendaVersion: number | null;
  readonly agendaPublishedAt: string | null;
  readonly cfpVersion: number | null;
  readonly cfpPublishedAt: string | null;
  readonly contentDigest: string;
  readonly cause: "site-published" | "schedule-published" | "source-reconciled";
}

export interface Publication {
  readonly eventId: string;
  readonly slug: string;
  readonly state: "draft" | "published" | "unpublished";
  readonly draft: PublicEventProjection;
  readonly published: PublicEventProjection | null;
  readonly publishedAt: string | null;
  /** Monotonic within one event; zero means the event has never had a live snapshot. */
  readonly projectionVersion?: number;
  readonly provenance?: PublicationProvenance | null;
}

/** A fully composed snapshot ready for the publishing repository to activate. */
export interface ProjectionRefresh {
  readonly eventId: string;
  /** Compare-and-swap guard for the active composition this refresh was derived from. */
  readonly expectedProjectionVersion: number;
  readonly activatedAt: string;
  readonly projection: PublicEventProjection;
  readonly provenance: PublicationProvenance;
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
    organization: speaker.organization,
    ...(speaker.photoUrl ? { photoUrl: speaker.photoUrl } : {}),
    // Copied key by key, like everything else here: the allowlist is what stops a field an
    // older writer left in a stored snapshot from being republished, so spreading the object
    // would defeat the whole function. Omitted entirely when the speaker recorded none.
    ...(speaker.socialLinks && Object.keys(speaker.socialLinks).length > 0
      ? {
          socialLinks: Object.fromEntries(
            Object.entries(speaker.socialLinks).map(([platform, url]) => [platform, url]),
          ),
        }
      : {}),
  })),
});

/**
 * The public-page fields the organizer types rather than the ones publishing composes.
 *
 * `undefined` leaves a field alone; the empty string is a real value that clears it. That
 * distinction is the whole point for the two dates — clearing them hands the field back to
 * the agenda-derived value, and there would otherwise be no way to say so.
 */
export interface PublicationSettings {
  readonly slug?: string | undefined;
  readonly summary?: string | undefined;
  readonly venue?: string | undefined;
  readonly startsOn?: string | undefined;
  readonly endsOn?: string | undefined;
}

/**
 * The dates the public page shows: the organizer's typed ones, with the agenda filling
 * whichever end they left empty.
 *
 * Extracted so composition and validation cannot drift apart. They did: `updateSettings`
 * compared only the *stored* values, so clearing one end while the other stayed pinned
 * passed the check and then composed into an inverted range — an agenda start after a
 * pinned end — which was returned to the organizer and published.
 */
export const resolveEventDates = (
  stored: { startsOn: string; endsOn: string },
  agendaDays: readonly string[],
): { startsOn: string; endsOn: string } => ({
  startsOn: stored.startsOn || (agendaDays[0] ?? ""),
  endsOn: stored.endsOn || (agendaDays.at(-1) ?? ""),
});

/**
 * Merge organizer-typed settings into a stored draft.
 *
 * Applied to the **stored** draft, never to a composed preview. Composition fills empty
 * dates from the agenda, so merging into a composed projection would write that derived
 * date back as though the organizer had typed it — pinning the public page to whatever the
 * agenda happened to say on the day an unrelated field was edited.
 *
 * `submissionUrl` is re-derived here because it embeds the slug; leaving it behind would
 * point the call for proposals at the event's previous address.
 */
export const applyPublicationSettings = (
  projection: PublicEventProjection,
  settings: PublicationSettings,
): PublicEventProjection => {
  const slug = settings.slug ?? projection.event.slug;
  return {
    ...projection,
    event: {
      ...projection.event,
      slug,
      summary: settings.summary ?? projection.event.summary,
      venue: settings.venue ?? projection.event.venue,
      startsOn: settings.startsOn ?? projection.event.startsOn,
      endsOn: settings.endsOn ?? projection.event.endsOn,
    },
    cfp: { ...projection.cfp, submissionUrl: `/events/${slug}/cfp` },
  };
};

/**
 * A session the published snapshot places: everything `PublicSession` carries, with the
 * clock no longer optional. A session without a time is published but not scheduled.
 */
export interface PublicScheduleSession extends PublicSession {
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * The public schedule. `version` and `publishedAt` identify the agenda's numbered
 * immutable snapshot; the sessions are the published projection's own, so the schedule
 * can only ever name content the organizer has published, under the same public slug the
 * event hub uses for it.
 */
export interface PublicScheduleProjection {
  readonly eventSlug: string;
  readonly version: number;
  readonly publishedAt: string;
  readonly sessions: readonly PublicScheduleSession[];
}

const isScheduled = (session: PublicSession): session is PublicScheduleSession =>
  Boolean(session.startsAt && session.endsAt);

/**
 * Compose the public schedule from a published projection and the agenda publication in
 * force.
 *
 * The projection is the only source of session material here. The agenda snapshot is
 * keyed by `content_sessions` and `speaker_profiles` primary keys and covers the whole
 * organizer board — including sessions whose content is still a draft — so nothing but
 * its identity crosses this boundary. Fields are copied one by one for the same reason
 * `allowlistPublicProjection` copies them: a stored snapshot is JSON, and a spread would
 * publish whatever an older writer happened to leave in it.
 */
export const composePublicSchedule = (
  projection: PublicEventProjection,
  publication: { readonly version: number; readonly publishedAt: string },
): PublicScheduleProjection => ({
  eventSlug: projection.event.slug,
  version: publication.version,
  publishedAt: publication.publishedAt,
  sessions: projection.sessions
    .filter(isScheduled)
    .map((session) => ({
      slug: session.slug,
      title: session.title,
      abstract: session.abstract,
      format: session.format,
      track: session.track,
      speakerSlugs: [...session.speakerSlugs],
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      ...(session.room ? { room: session.room } : {}),
    }))
    // Programme order, and the same order on every read: two sessions that start together
    // are separated by room and then by title rather than by storage order.
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        (left.room ?? "").localeCompare(right.room ?? "") ||
        left.title.localeCompare(right.title),
    ),
});

/*
 * Public URLs are part of the product. `/sessions/designing-the-calm-conference` is
 * readable, quotable, and survives being pasted into a programme; the storage UUID this
 * projection used to emit is none of those things. Slugs are therefore derived here, in
 * the publishing domain's projection step, from the title or name the organizer typed —
 * publishing never reaches into content or agenda storage to build one.
 */
const SLUG_MAX_LENGTH = 72;

export const toPublicSlug = (value: string): string =>
  value
    .normalize("NFKD")
    // Strip the combining marks NFKD just split off, so "Renee" survives an accented "Renée".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");

/**
 * A short, stable discriminator derived from the record's own id (FNV-1a, base36).
 * It depends on nothing but that record, so republishing unchanged content reproduces
 * exactly the same URL even as neighbouring records come and go.
 */
const discriminator = (id: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(-6).padStart(4, "0");
};

/**
 * Assign one readable, event-unique slug per record.
 *
 * A title nobody else in the event shares keeps the clean slug; genuine duplicates each
 * take the record-derived suffix so neither one wins the bare name. Records whose label
 * slugs to nothing (emoji-only titles, scripts outside the route charset) fall back to
 * `<fallback>-<discriminator>` rather than to their primary key.
 */
export function publicSlugs<T>(
  records: readonly T[],
  identify: (record: T) => { id: string; label: string },
  fallback: string,
): (id: string) => string {
  const bases = records.map((record) => {
    const { id, label } = identify(record);
    return { id, base: toPublicSlug(label) || `${fallback}-${discriminator(id)}` };
  });
  const shared = new Set(
    bases.map(({ base }) => base).filter((base, index, all) => all.indexOf(base) !== index),
  );
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  for (const { id, base } of bases) {
    let slug = shared.has(base) ? `${base}-${discriminator(id)}` : base;
    // Two distinct records can only land here by hashing alike behind the same base;
    // the counter keeps the guarantee absolute rather than probabilistic.
    for (let attempt = 2; taken.has(slug); attempt += 1)
      slug = `${base}-${discriminator(id)}-${attempt}`;
    taken.add(slug);
    assigned.set(id, slug);
  }
  return (id: string) => assigned.get(id) ?? `${fallback}-${discriminator(id)}`;
}

/**
 * The event's own public address. Slugs are unique across every event, so the name alone
 * cannot be trusted; the discriminator makes it unique without pasting a storage UUID
 * into the one URL an organizer is most likely to share.
 */
export const publicEventSlug = (name: string, eventId: string): string =>
  `${toPublicSlug(name) || "event"}-${discriminator(eventId)}`;
