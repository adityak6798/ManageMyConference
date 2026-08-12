import { z } from "zod";

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export const contentSessionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  proposalId: z.string(),
  title: z.string(),
  abstract: z.string(),
  format: z.string(),
  speakerProfileIds: z.array(z.string().uuid()),
  tags: z.array(z.string()),
  tracks: z.array(z.string()),
  publicationState: z.enum(["draft", "ready", "published"]),
  /*
   * Where the event's published agenda places this session — never a stored property of the
   * session. It is resolved from the agenda publication in force on every read, and is absent
   * while that publication does not place this session (including before any schedule is
   * published at all).
   *
   * It follows the **agenda** publication, which is not the same clock as
   * `/api/public/events/{slug}/schedule`: that serves the **site** publication, frozen when the
   * organizer last published the event page. Publishing the agenda alone moves this field and
   * leaves the public page where it was, so the two disagree until the site is republished.
   * That window is the rule (`PRD-PUB-001`), not a defect — but they are not interchangeable,
   * and an earlier version of this comment claimed they always agree.
   */
  schedule: z
    .object({
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      location: z.string(),
    })
    .optional(),
});
export const speakerProfileSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  userId: z.string(),
  sourcePersonId: z.string(),
  name: z.string(),
  email: z.string().email(),
  bio: z.string(),
  pronouns: z.string(),
  organization: z.string(),
  photoAssetId: z.string().uuid().optional(),
  workflowStatus: z.enum(["invited", "onboarding", "ready", "blocked"]).optional(),
  logistics: z.record(z.string()).optional(),
  customFields: z.record(z.string()).optional(),
});
export const speakerTaskSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  speakerProfileId: z.string().uuid(),
  title: z.string(),
  dueAt: z.string().datetime(),
  status: z.enum(["open", "complete"]),
  completedAt: z.string().datetime().optional(),
  type: z.enum(["general", "file-request"]).optional(),
  instructions: z.string().optional(),
  sessionId: z.string().uuid().optional(),
});
export const speakerAssetSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  speakerProfileId: z.string().uuid(),
  name: z.string(),
  contentType: z.string(),
  storageKey: z.string(),
  visibility: z.enum(["private", "publishable"]),
  uploadedAt: z.string().datetime(),
  taskId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  versionGroupId: z.string().uuid().optional(),
  versionNumber: z.number().int().positive().optional(),
  isLatest: z.boolean().optional(),
});
export const speakerMessageSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  speakerProfileId: z.string().uuid(),
  subject: z.string(),
  sentAt: z.string().datetime(),
});
export const speakerResourceSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  title: z.string(),
  slug: z.string(),
  bodyHtml: z.string(),
  embedHtml: z.string(),
  visibility: z.enum(["hidden", "visible"]),
  sortOrder: z.number().int(),
});
export const contentCommentSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  assetId: z.string().uuid(),
  authorId: z.string(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
});
export const contentRevisionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  entityType: z.enum(["profile", "session"]),
  entityId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  snapshotJson: z.string(),
  actorId: z.string(),
  createdAt: z.string().datetime(),
  restoredFromRevisionId: z.string().uuid().optional(),
});
export const contentWorkspaceSchema = z.object({
  sessions: z.array(contentSessionSchema),
  speakers: z.array(speakerProfileSchema),
  tasks: z.array(speakerTaskSchema),
  assets: z.array(speakerAssetSchema),
  messages: z.array(speakerMessageSchema),
  resources: z.array(speakerResourceSchema).optional(),
  comments: z.array(contentCommentSchema).optional(),
  revisions: z.array(contentRevisionSchema).optional(),
});
export type ContentWorkspaceDto = z.infer<typeof contentWorkspaceSchema>;
/**
 * Acceptance names a proposal and nothing else.
 *
 * Title, abstract, format and speaker identity are resolved server-side through the review
 * domain's public application interface (`ARC-FLOW-001`); a client that could supply them could
 * also invent them, which is how a fabricated proposal id used to create a session with a speaker
 * who had never applied. Organizers refine the session afterwards with
 * `PATCH /api/content-sessions/{sessionId}`.
 */
export const acceptContentInputSchema = z.object({ proposalId: z.string().uuid() });
export type AcceptContentInput = z.infer<typeof acceptContentInputSchema>;
export const updateSpeakerProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bio: z.string().trim().max(2000),
  pronouns: z.string().trim().max(50),
  organization: z.string().trim().max(120),
});
export type UpdateSpeakerProfileInput = z.infer<typeof updateSpeakerProfileInputSchema>;
/**
 * Which uploaded file is this speaker's headshot.
 *
 * A request of its own rather than a field on `updateSpeakerProfileInputSchema`, because the
 * two carry different authority: the profile text is the speaker's to write, while a headshot
 * may also be set — or removed — by an organizer of the event whose programme it appears on.
 * Naming a photo is a *choice*, never an exposure: the asset's visibility is untouched, so a
 * private upload stays private and the public projection emits a `photoUrl` only for an asset
 * an organizer separately marked publishable. `DELETE` on the same address removes the choice.
 */
export const setSpeakerPhotoInputSchema = z.object({ assetId: z.string().uuid() });
export type SetSpeakerPhotoInput = z.infer<typeof setSpeakerPhotoInputSchema>;
export const uploadSpeakerAssetInputSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
  contentBase64: z
    .string()
    .min(1)
    .max(8_000_000)
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      "Asset content must be valid base64",
    ),
  taskId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  versionGroupId: z.string().uuid().optional(),
});
export type UploadSpeakerAssetInput = z.infer<typeof uploadSpeakerAssetInputSchema>;
export const eventContentParamsSchema = z.object({ eventId: z.string().uuid() });
export const profileParamsSchema = z.object({ profileId: z.string().uuid() });
export const taskParamsSchema = z.object({ taskId: z.string().uuid() });
export const contentSessionParamsSchema = z.object({ sessionId: z.string().uuid() });
export const speakerAssetParamsSchema = z.object({ assetId: z.string().uuid() });
export const updateContentSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  abstract: z.string().trim().min(1),
  format: z.string().trim().min(1),
  speakerProfileIds: z.array(z.string().uuid()).min(1),
  tags: z.array(z.string().trim().min(1)),
  tracks: z.array(z.string().trim().min(1)),
  publicationState: z.enum(["draft", "ready", "published"]),
});
export type UpdateContentSessionInput = z.infer<typeof updateContentSessionInputSchema>;
export const requestSpeakerTaskInputSchema = z.object({
  profileId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  dueAt: z.string().datetime(),
});
export const bulkRequestSpeakerTaskInputSchema = z.object({
  profileIds: z.array(z.string().uuid()).min(1).max(500),
  title: z.string().trim().min(1).max(160),
  dueAt: z.string().datetime(),
  type: z.enum(["general", "file-request"]),
  instructions: z.string().trim().max(4000).default(""),
  sessionId: z.string().uuid().optional(),
});
export const speakerCsvImportInputSchema = z.object({
  eventId: z.string().uuid(),
  csv: z.string().min(1).max(2_000_000),
  commit: z.boolean().default(false),
});
export const speakerCsvImportResultSchema = z.object({
  preview: z.boolean(),
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      row: z.number().int().positive(),
      name: z.string(),
      email: z.string(),
      duplicate: z.boolean(),
      errors: z.array(z.string()),
    }),
  ),
});
export const updateSpeakerWorkflowInputSchema = z.object({
  workflowStatus: z.enum(["invited", "onboarding", "ready", "blocked"]),
  logistics: z.record(z.string().max(1000)),
  customFields: z.record(z.string().max(1000)),
});
export const addContentCommentInputSchema = z.object({
  assetId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});
export const restoreContentRevisionInputSchema = z.object({ revisionId: z.string().uuid() });
export const bulkDownloadDeliverablesInputSchema = z.object({
  eventId: z.string().uuid(),
  assetIds: z.array(z.string().uuid()).min(1).max(100),
});
export const recordSpeakerMessageInputSchema = z.object({
  profileId: z.string().uuid(),
  subject: z.string().trim().min(1).max(200),
});

export const createSpeakerResourceInputSchema = z.object({
  eventId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(120),
  bodyHtml: z.string().max(100_000),
  embedHtml: z.string().max(20_000).default(""),
  embedAllowedHosts: z.array(z.string().trim().min(1).max(253)).max(20).default([]),
  visibility: z.enum(["hidden", "visible"]),
  sortOrder: z.number().int().min(0).max(10_000),
});
export const updateSpeakerResourceInputSchema = createSpeakerResourceInputSchema.omit({
  eventId: true,
});
export const speakerResourceParamsSchema = z.object({ resourceId: z.string().uuid() });

/**
 * What sending an event's calendar invitations did.
 *
 * `unreachable` names the sessions and the reason rather than counting them: a send that quietly
 * reaches fewer speakers than the organizer believes is the failure worth designing against, and
 * a number gives them nothing to chase.
 */
export const speakerCalendarInviteResultSchema = z.object({
  sent: z.number().int().nonnegative(),
  alreadySent: z.number().int().nonnegative(),
  unreachable: z.array(z.object({ session: z.string(), reason: z.string() })),
});
export type SpeakerCalendarInviteResultDto = z.infer<typeof speakerCalendarInviteResultSchema>;
