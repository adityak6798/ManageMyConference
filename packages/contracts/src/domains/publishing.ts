import { z } from "zod";

// @spec PRD-PUB-001
export const routeSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
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
  // Composed from the speaker profile's `organization`. It was published as `headline`,
  // which promised a job title and delivered an employer.
  organization: z.string(),
  photoUrl: z.string().optional(),
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
export type PublicEventProjectionDto = z.infer<typeof publicEventProjectionSchema>;
export const publicEventResponseSchema = z.object({ projection: publicEventProjectionSchema });
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
export const publicationPreviewResponseSchema = z.object({
  publication: z.object({
    eventId: z.string().uuid(),
    slug: routeSlugSchema,
    state: z.enum(["draft", "published", "unpublished"]),
    draft: publicEventProjectionSchema,
    published: publicEventProjectionSchema.nullable(),
    publishedAt: z.string().datetime().nullable(),
  }),
});
