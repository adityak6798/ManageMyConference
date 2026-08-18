import { z } from "zod";

// @spec PRD-PUB-001
export const routeSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * Event addresses the console owns, so no event may be published at one.
 *
 * `/events/…` is shared between the public event hub and the console: `/events/new` is where an
 * organizer creates an event. Nothing used to stop another organizer typing `new` into Public
 * address — the slug contract checks shape, and the publication service checks the address
 * against other events rather than against a vocabulary — so the event was accepted end to end
 * and then published everywhere except its own front door: `/events/new/cfp` and
 * `/events/new/schedule` kept serving it while `/events/new` resolved to the console's create
 * form. A derived address can never collide, because the generator appends a per-event
 * discriminator; only a typed one can, which is why this is refused where the address is
 * assigned: `publicationSettingsInputSchema` below refuses it, so the transport answers with a
 * field error on `slug` and the organizer is told on the Public address input.
 *
 * The contract is where this belongs rather than the publication service, and not only because
 * the API's application layer may import no package: it is a rule about the address space, not a
 * fact about other events, so no uniqueness query could ever find it taken. It is also the one
 * place both sides can read — the web entry builds its console-owned path set from this same
 * constant, so the routing claim and the refused vocabulary cannot drift apart. @spec PRD-PUB-001
 */
export const RESERVED_EVENT_SLUGS: readonly string[] = ["new"];
export const ianaTimezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    // ERROR-INTENT: Intl reports unsupported IANA zones by throwing.
    return false;
  }
}, "Timezone must be a valid IANA time zone");
export const publicSpeakerSchema = z.object({
  slug: routeSlugSchema,
  name: z.string(),
  bio: z.string(),
  // Optional only for immutable snapshots published before canonical job titles existed.
  jobTitle: z.string().optional(),
  // Composed from the speaker profile's `organization`. It was published as `headline`,
  // which promised a job title and delivered an employer.
  organization: z.string(),
  photoUrl: z.string().optional(),
  /*
   * The links the speaker entered, by platform. Frozen into the snapshot like everything else
   * here: a speaker editing their profile does not change a published page until the organizer
   * publishes again.
   *
   * Absent rather than empty for a speaker with no links, so two publishes of an unchanged
   * programme are identical bytes. Content narrows every value to `http`/`https` before storing
   * it, which is the property that lets the page render one into an `href`.
   */
  socialLinks: z.record(z.string()).optional(),
});
export const publicSessionSchema = z.object({
  slug: routeSlugSchema,
  title: z.string(),
  abstract: z.string(),
  format: z.string(),
  track: z.string(),
  speakerSlugs: z.array(routeSlugSchema),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  room: z.string().optional(),
});
export const publicEventProjectionSchema = z.object({
  event: z.object({
    eventId: z.string().uuid(),
    slug: routeSlugSchema,
    name: z.string(),
    summary: z.string(),
    startsOn: z.string(),
    endsOn: z.string(),
    timezone: ianaTimezoneSchema,
    venue: z.string(),
  }),
  cfp: z.object({
    title: z.string(),
    description: z.string(),
    status: z.enum(["open", "closed"]),
    publishedAt: z.string().datetime().nullable(),
    submissionUrl: z.string(),
  }),
  sessions: z.array(publicSessionSchema),
  speakers: z.array(publicSpeakerSchema),
});
export const publicationProvenanceSchema = z.object({
  agendaVersion: z.number().int().positive().nullable(),
  agendaPublishedAt: z.string().datetime().nullable(),
  cfpVersion: z.number().int().positive().nullable(),
  cfpPublishedAt: z.string().datetime().nullable(),
  contentDigest: z.string().min(1),
  cause: z.enum(["site-published", "schedule-published", "source-reconciled"]),
});
export type PublicEventProjectionDto = z.infer<typeof publicEventProjectionSchema>;
export const publicEventResponseSchema = z.object({
  projection: publicEventProjectionSchema,
  publication: z
    .object({
      version: z.number().int().nonnegative(),
      publishedAt: z.string().datetime().nullable(),
      provenance: publicationProvenanceSchema.nullable(),
    })
    .optional(),
});
export const publicEventSlugParamsSchema = z.object({ slug: routeSlugSchema });
/*
 * The public schedule is a view of the published projection, not of the agenda draft.
 *
 * It used to be the agenda publication verbatim — every session on the organizer's board,
 * including ones whose content is still a draft, keyed by `content_sessions` and
 * `speaker_profiles` primary keys. A session appears here only if the event's published
 * snapshot publishes it, and it is named by the same slug that snapshot assigned, so the
 * schedule and the event hub address one session by one public identifier and no storage
 * id crosses the boundary. `version` and `publishedAt` stay: they are the agenda's own
 * statement of which numbered immutable snapshot is in force (`PRD-AGD-001`).
 */
// @spec PRD-AGD-001 PRD-PUB-001
export const publicScheduleSessionSchema = publicSessionSchema.required({
  startsAt: true,
  endsAt: true,
});
export const publicScheduleSchema = z.object({
  eventSlug: routeSlugSchema,
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
  sessions: z.array(publicScheduleSessionSchema),
});
export type PublicScheduleDto = z.infer<typeof publicScheduleSchema>;
/*
 * The public-page fields an organizer types, as opposed to the ones publishing composes.
 *
 * These five are publishing's own data and live nowhere else. `summary` and `venue` have no
 * upstream source at all — `preview` passes them through from the stored draft, which is why
 * they read as empty on every event the seed did not write. `startsOn`/`endsOn` do have an
 * upstream source (agenda slot dates) but it cannot express "the conference runs Monday to
 * Wednesday" before an agenda exists. `slug` is the event's public address.
 *
 * `name` and `timezone` are deliberately absent: those are events-domain data, copied into
 * the projection at compose time, and editing them is renaming an event rather than editing
 * its public page. That needs an events-domain command that does not exist yet.
 *
 * Every field is optional so the form can send one changed field; an empty string is a
 * meaningful value that clears the field, and `undefined` means "leave it alone".
 */
// @spec PRD-PUB-001
/*
 * A real calendar day, not merely a well-shaped one.
 *
 * The shape alone accepts `2026-02-31` and `2026-99-99`, and neither is harmless here: the
 * public page formats these values with `Intl.DateTimeFormat`, which throws a `RangeError`
 * on an invalid `Date` and would take the whole client-rendered page down, while a merely
 * overflowing day silently normalises and publishes a date nobody typed. The round-trip is
 * the check — `Date` normalises out of range, so a value that does not come back identical
 * was never a day.
 */
export const publicEventDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date, as YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    // Checked before `toISOString`, which throws `RangeError` on an invalid date rather
    // than returning something comparable — a refinement that throws fails the request
    // with an unhandled error instead of a validation message.
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.toISOString().startsWith(value);
  }, "That date does not exist");
/** A day, or the empty string that clears it back to the agenda-derived value. */
const editableDaySchema = z.union([publicEventDaySchema, z.literal("")]);
export const publicationSettingsInputSchema = z
  .object({
    // Bounded by the `public_event_projections_slug_length` check constraint on the column
    // it is stored in, so an over-long slug is refused by the contract rather than by SQLite.
    // Refined rather than merely shaped, because `new` is a well-formed slug that the console
    // already answers on — see `RESERVED_EVENT_SLUGS`.
    slug: routeSlugSchema
      .max(120)
      .refine(
        (slug) => !RESERVED_EVENT_SLUGS.includes(slug),
        "That address is reserved for Greenroom's own pages. Choose another one.",
      )
      .optional(),
    summary: z.string().max(2000).optional(),
    venue: z.string().max(200).optional(),
    startsOn: editableDaySchema.optional(),
    endsOn: editableDaySchema.optional(),
  })
  // Ordering is only checked here when the caller sends both. A request that moves one end
  // past a stored other end is caught after the merge, in the domain, where the stored value
  // is known — see `applyPublicationSettings`.
  .refine(
    ({ startsOn, endsOn }) => !startsOn || !endsOn || startsOn <= endsOn,
    "The end date cannot fall before the start date",
  );
export type PublicationSettingsInput = z.infer<typeof publicationSettingsInputSchema>;
/*
 * Attendee itineraries.
 *
 * Anonymous by construction, like everything else under `/api/public/*`. The token in the
 * path *is* the identity — there is no user id here to leak, and none to attribute an
 * itinerary to later, which is a constraint worth knowing before anything tries to.
 */
// @spec PRD-PUB-001
export const itineraryTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const itineraryTokenParamsSchema = z.object({ token: itineraryTokenSchema });
export const itinerarySchema = z.object({
  eventSlug: routeSlugSchema,
  sessionSlugs: z.array(routeSlugSchema),
  updatedAt: z.string().datetime(),
});
export type ItineraryDto = z.infer<typeof itinerarySchema>;
/** The saved list replaces the stored one outright; there is no add/remove verb. */
export const itineraryInputSchema = z.object({ sessionSlugs: z.array(routeSlugSchema).max(200) });
export const itineraryResponseSchema = z.object({ itinerary: itinerarySchema });
/** The mint response, and the only time the token is ever returned. */
export const itineraryCreatedResponseSchema = z.object({
  token: itineraryTokenSchema,
  itinerary: itinerarySchema,
});
export const publicationPreviewResponseSchema = z.object({
  publication: z.object({
    eventId: z.string().uuid(),
    slug: routeSlugSchema,
    state: z.enum(["draft", "published", "unpublished"]),
    draft: publicEventProjectionSchema,
    published: publicEventProjectionSchema.nullable(),
    publishedAt: z.string().datetime().nullable(),
    projectionVersion: z.number().int().nonnegative().optional(),
    provenance: publicationProvenanceSchema.nullable().optional(),
  }),
});

/*
 * ---- Sites and portals (issue #196) ----------------------------------------
 *
 * A Site is one organization's branded portal over several programs. It is deliberately *not* a
 * second public-event projection: it composes pointers to programs other domains own, resolved at
 * read time, and it is addressed under its own public prefix so its slugs cannot collide with an
 * event's.
 *
 * @spec PRD-PUB-002
 */
export const siteThemeSchema = z.enum(["light", "dark", "auto"]);
export const siteProgramKindSchema = z.enum(["event-cfp", "interest-form", "speaker-portal"]);
export const siteFieldKindSchema = z.enum(["text", "longtext", "select", "checkbox"]);
export const sitePrimaryColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const siteSlugParamsSchema = z.object({ slug: routeSlugSchema.max(120) });
export const sitePageParamsSchema = siteSlugParamsSchema.extend({
  pageSlug: routeSlugSchema.max(120),
});
export const siteOrganizationParamsSchema = z.object({ organizationId: z.string().uuid() });
export const siteParamsSchema = siteOrganizationParamsSchema.extend({
  siteId: z.string().uuid(),
});
export const siteProgramInputSchema = z.object({
  kind: siteProgramKindSchema,
  /** Another domain's identifier. Opaque to publishing, which is why it is not a uuid() here. */
  ref: z.string().min(1).max(120),
  label: z.string().max(120).optional(),
});
export const sitePageInputSchema = z.object({
  slug: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  /** Sanitized server-side before it is stored; what a client sends is never what is served. */
  bodyHtml: z.string().max(40_000),
  visibility: z.enum(["visible", "hidden"]).optional(),
});
export const siteRegistrationFieldInputSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,60}$/),
  label: z.string().min(1).max(120),
  kind: siteFieldKindSchema,
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(120)).max(20).optional(),
});
export const siteDraftSchema = z.object({
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  tagline: z.string().max(200).optional(),
  landingHeading: z.string().max(160).optional(),
  landingBody: z.string().max(2000).optional(),
  loginHeading: z.string().max(160).optional(),
  loginBody: z.string().max(2000).optional(),
  theme: siteThemeSchema.optional(),
  primaryColor: sitePrimaryColorSchema.optional(),
  programs: z.array(siteProgramInputSchema).max(30).optional(),
  pages: z.array(sitePageInputSchema).max(20).optional(),
  registrationFields: z.array(siteRegistrationFieldInputSchema).max(12).optional(),
});
export const siteUpdateSchema = siteDraftSchema.extend({
  expectedRevision: z.number().int().min(1),
});
export const siteRevisionInputSchema = z.object({ expectedRevision: z.number().int().min(1) });
export const sitePrivacyNoticeInputSchema = z.object({ bodyHtml: z.string().min(1).max(40_000) });
export const sitePrivacyNoticeSchema = z.object({
  version: z.number().int().min(1),
  bodyHtml: z.string(),
  effectiveAt: z.string().datetime(),
});
export const siteRegistrationFieldSchema = siteRegistrationFieldInputSchema.extend({
  required: z.boolean(),
  options: z.array(z.string()),
  position: z.number().int().nonnegative(),
});
export const siteSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  slug: routeSlugSchema.max(120),
  name: z.string(),
  tagline: z.string(),
  landingHeading: z.string(),
  landingBody: z.string(),
  loginHeading: z.string(),
  loginBody: z.string(),
  theme: siteThemeSchema,
  primaryColor: sitePrimaryColorSchema,
  state: z.enum(["draft", "published", "unpublished"]),
  publishedAt: z.string().datetime().nullable(),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  programs: z.array(
    siteProgramInputSchema.extend({
      label: z.string(),
      position: z.number().int().nonnegative(),
    }),
  ),
  pages: z.array(
    sitePageInputSchema.extend({
      id: z.string().uuid(),
      visibility: z.enum(["visible", "hidden"]),
      position: z.number().int().nonnegative(),
    }),
  ),
  registrationFields: z.array(siteRegistrationFieldSchema),
  privacyNotice: sitePrivacyNoticeSchema.nullable(),
});
export const sitesResponseSchema = z.object({ sites: z.array(siteSchema) });
export const siteResponseSchema = z.object({ site: siteSchema });
/**
 * The organizer's view. `unresolvedPrograms` is named rather than left to be inferred from an
 * absence: a program whose source has gone keeps its place in the order, and a portal that
 * quietly shortened itself would say nothing about why.
 */
export const siteDetailResponseSchema = z.object({
  site: siteSchema,
  unresolvedPrograms: z.array(z.object({ kind: siteProgramKindSchema, ref: z.string() })),
  publications: z.array(
    z.object({ version: z.number().int().min(1), publishedAt: z.string().datetime() }),
  ),
});
export const sitePrivacyNoticeResponseSchema = z.object({
  version: z.number().int().min(1),
  effectiveAt: z.string().datetime(),
});
export const siteConsentsResponseSchema = z.object({
  consents: z.array(
    z.object({
      id: z.string().uuid(),
      noticeVersion: z.number().int().min(1),
      /** The registrant's address. Organizer-only, and never on a public route. */
      actorRef: z.string(),
      acceptedAt: z.string().datetime(),
    }),
  ),
});
/** What a visitor is served. Nothing here is draft copy, and nothing is another domain's data. */
export const publicSiteSchema = z.object({
  slug: routeSlugSchema.max(120),
  name: z.string(),
  tagline: z.string(),
  landing: z.object({ heading: z.string(), body: z.string() }),
  login: z.object({ heading: z.string(), body: z.string() }),
  theme: siteThemeSchema,
  primaryColor: sitePrimaryColorSchema,
  programs: z.array(
    z.object({
      kind: siteProgramKindSchema,
      ref: z.string(),
      label: z.string(),
      href: z.string(),
      title: z.string().optional(),
      state: z.string().optional(),
    }),
  ),
  pages: z.array(z.object({ slug: routeSlugSchema.max(120), title: z.string() })),
  privacyNotice: sitePrivacyNoticeSchema.nullable(),
  registrationFields: z.array(siteRegistrationFieldSchema),
  publishedAt: z.string().datetime(),
});
export const publicSiteResponseSchema = z.object({ site: publicSiteSchema });
export const publicSitePageResponseSchema = z.object({
  site: z.object({ slug: routeSlugSchema.max(120), name: z.string() }),
  page: z.object({
    id: z.string().uuid(),
    slug: routeSlugSchema.max(120),
    title: z.string(),
    bodyHtml: z.string(),
    position: z.number().int().nonnegative(),
    visibility: z.enum(["visible", "hidden"]),
  }),
});
/**
 * A registration. `accepted` is the consent itself, and the notice *version* is deliberately not
 * a field: a client that could supply it could claim consent to a version the visitor never saw,
 * so the server stamps the version in force at that instant.
 */
export const siteRegistrationInputSchema = z.object({
  name: z.string().min(1).max(160),
  email: z.string().email().max(254),
  accepted: z.boolean(),
  answers: z.record(z.string().max(2000)).optional(),
});
export const siteRegistrationResponseSchema = z.object({
  registered: z.literal(true),
  noticeVersion: z.number().int().min(1),
  acceptedAt: z.string().datetime(),
});
export type SiteDto = z.infer<typeof siteSchema>;
export type PublicSiteDto = z.infer<typeof publicSiteSchema>;
export type SiteDetailDto = z.infer<typeof siteDetailResponseSchema>;

/*
 * ---- named, revocable embeds (issue #192's residual lifecycle epic) ---------
 *
 * PR #214 shipped the embed views; what was missing was that an embed had no identity — it could
 * not be revisited, changed, or withdrawn, so a URL pasted into somebody else's site answered for
 * ever. `output` is immutable after creation because a host page parsing JSON does not survive
 * being handed HTML; changing it is `duplicate`, which mints a new address.
 *
 * @spec PRD-PUB-001
 */
export const embedViewSchema = z.enum(["schedule", "speakers", "gallery", "itinerary"]);
export const embedOutputSchema = z.enum(["styled-html", "basic-html", "json", "xml", "ical"]);
export const embedFieldSchema = z.enum(["time", "room", "track", "format", "abstract", "speakers"]);
export const embedFiltersSchema = z.object({
  track: z.string().max(120).optional(),
  format: z.string().max(120).optional(),
  /** A calendar date; the embed shows only sessions starting on it. */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export const embedDraftSchema = z.object({
  name: z.string().min(1).max(120),
  view: embedViewSchema,
  output: embedOutputSchema,
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  filters: embedFiltersSchema.optional(),
  /** Empty selects every field, which is what a snippet issued before selection existed asks for. */
  fields: z.array(embedFieldSchema).max(6).optional(),
});
export const embedUpdateSchema = embedDraftSchema.extend({
  expectedRevision: z.number().int().min(1),
});
export const embedDuplicateSchema = z.object({
  name: z.string().min(1).max(120),
  /** The one way to change an output type: the old address keeps working until it is revoked. */
  output: embedOutputSchema.optional(),
});
export const embedSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  name: z.string(),
  view: embedViewSchema,
  output: embedOutputSchema,
  accent: z.string(),
  theme: z.enum(["light", "dark", "auto"]),
  filters: embedFiltersSchema,
  fields: z.array(embedFieldSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().min(1),
  /** Set means withdrawn: the address answers as an unknown one from that moment. */
  revokedAt: z.string().datetime().nullable(),
});
export const embedsResponseSchema = z.object({ embeds: z.array(embedSchema) });
export const embedResponseSchema = z.object({ embed: embedSchema });
/** The URL is returned once, because only the token's digest is stored. */
export const embedCreatedResponseSchema = z.object({ embed: embedSchema, url: z.string() });
export const embedParamsSchema = z.object({
  eventId: z.string().uuid(),
  embedId: z.string().uuid(),
});
export const embedTokenParamsSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
export type EmbedDto = z.infer<typeof embedSchema>;
