import { z } from "zod";

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export const contentSessionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  proposalId: z.string(),
  title: z.string(),
  abstract: z.string().optional(),
  format: z.string().optional(),
  speakerProfileIds: z.array(z.string().uuid()),
  tags: z.array(z.string()).optional(),
  tracks: z.array(z.string()).optional(),
  publicationState: z.enum(["draft", "ready", "published"]).optional(),
  /*
   * Where the event's published agenda places this session — never a stored property of the
   * session. It is resolved from the agenda publication in force on every read, and is absent
   * while that publication does not place this session (including before any schedule is
   * published at all).
   *
   * It follows the **agenda** publication. For a live site, `EVT-SCHEDULE-PUBLISHED` activates a
   * new publishing projection in the same transaction, so this field and the public programme
   * move together. An unpublished site's content projection may still carry this organizer-only
   * field, but no public schedule exists there (`PRD-PUB-001`).
   */
  schedule: z
    .object({
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      location: z.string(),
    })
    .optional(),
});
/**
 * The platforms a speaker profile can carry a link for, and the rule each link obeys.
 *
 * Closed, so that the portal, the organizer view and the public programme can all name the
 * platform and label the link rather than rendering a bare URL and hoping. `website` is the
 * escape hatch.
 *
 * Only `http` and `https` are accepted. A profile field is speaker-supplied text that the public
 * programme renders into an `href`, so `javascript:` — which `z.string().url()` accepts, because
 * it is a valid URL — would be stored script that every visitor's browser is invited to run.
 * `mailto:` is refused for a milder reason: the profile already carries an address, and a second
 * one nobody verified is a worse answer to "how do I contact this speaker".
 */
export const SPEAKER_SOCIAL_PLATFORMS = [
  "website",
  "mastodon",
  "bluesky",
  "linkedin",
  "github",
  "x",
  "youtube",
] as const;

export const SOCIAL_LINK_REJECTED = "Enter a full http:// or https:// address, or leave it blank.";

const socialLinkSchema = z
  .string()
  .trim()
  .max(300)
  .refine((value) => {
    if (!value) return true;
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      // ERROR-INTENT: `new URL` reports an unparseable address by throwing, and "not a link" is
      // the answer this refinement exists to produce. The caller sees a field error.
      return false;
    }
  }, SOCIAL_LINK_REJECTED);

/*
 * Written out rather than generated from the list above, so the OpenAPI document names every
 * platform an organizer's API client may send. Blank is "no link", so an emptied box removes
 * the entry rather than storing an empty string that every surface would then have to skip.
 */
export const speakerSocialLinksSchema = z
  .object({
    website: socialLinkSchema.optional(),
    mastodon: socialLinkSchema.optional(),
    bluesky: socialLinkSchema.optional(),
    linkedin: socialLinkSchema.optional(),
    github: socialLinkSchema.optional(),
    x: socialLinkSchema.optional(),
    youtube: socialLinkSchema.optional(),
  })
  .transform((links) =>
    Object.fromEntries(Object.entries(links).filter(([, value]) => Boolean(value))),
  );
export type SpeakerSocialLinksDto = z.infer<typeof speakerSocialLinksSchema>;

export const speakerProfileSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  userId: z.string(),
  sourcePersonId: z.string(),
  name: z.string(),
  email: z.string().email().optional(),
  bio: z.string().optional(),
  pronouns: z.string().optional(),
  jobTitle: z.string(),
  organization: z.string().optional(),
  /** Optimistic version of the canonical profile, derived from its attributed revisions. */
  version: z.number().int().nonnegative(),
  photoAssetId: z.string().uuid().optional(),
  workflowStatus: z.string().trim().min(1).max(60).optional(),
  logistics: z.record(z.string()).optional(),
  customFields: z.record(z.string()).optional(),
  socialLinks: z.record(z.string()).optional(),
  /**
   * How many portal invitations an organizer has deliberately sent this speaker.
   *
   * The visible half of the delivery history: the console shows it beside the roster so "have we
   * actually written to this person, and how often?" is answerable without opening the outbox.
   * It does not count the welcome acceptance sends, so 0 does not mean "never contacted".
   */
  invitationsSent: z.number().int().nonnegative().optional(),
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
/**
 * A person an audit row may name, with the name to print for them.
 *
 * Addressing only, exactly as `AssignableOwner` is on the server: appearing here says a revision
 * may carry this id, never that the holder has any capability on the event. It mirrors review's
 * `reviewerDirectory`, which exists for the same reason — the console was printing the stored id
 * `seed-organizer` where a name belonged (#154).
 */
export const contentActorSchema = z.object({
  id: z.string(),
  name: z.string(),
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
  /** Optional because the speaker-scoped projection carries no revisions to attribute. */
  actorDirectory: z.array(contentActorSchema).optional(),
  workflowStatuses: z
    .array(
      z.object({
        id: z.string(),
        eventId: z.string().uuid(),
        key: z.string().trim().min(1).max(60),
        label: z.string().trim().min(1).max(80),
        category: z.enum(["open", "ready", "blocked"]),
        sortOrder: z.number().int(),
        createdAt: z.string().datetime(),
      }),
    )
    .optional(),
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
export const updateSpeakerProfileInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    bio: z.string().trim().max(2000).optional(),
    pronouns: z.string().trim().max(50).optional(),
    jobTitle: z.string().trim().max(120).optional(),
    organization: z.string().trim().max(120).optional(),
    /*
     * Optional so an older client's save is a text edit rather than a silent wipe of every link.
     * Sending it replaces the whole set, which is what an edit form submits — a blank box is a
     * removal, and there is no way to express "leave this one alone" that a form could produce.
     */
    socialLinks: speakerSocialLinksSchema.optional(),
  })
  .refine(({ expectedVersion: _expectedVersion, ...changes }) => Object.keys(changes).length > 0, {
    message: "Change at least one profile field.",
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
export const setSpeakerPhotoInputSchema = z.object({
  assetId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type SetSpeakerPhotoInput = z.infer<typeof setSpeakerPhotoInputSchema>;
export const clearSpeakerPhotoInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type ClearSpeakerPhotoInput = z.infer<typeof clearSpeakerPhotoInputSchema>;
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
export const updateContentSessionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    abstract: z.string().trim().min(1).optional(),
    format: z.string().trim().min(1).optional(),
    speakerProfileIds: z.array(z.string().uuid()).min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    tracks: z.array(z.string().trim().min(1)).optional(),
    publicationState: z.enum(["draft", "ready", "published"]).optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "Change at least one session field.",
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
  /**
   * Which session this request is about, when it is about one.
   *
   * Optional because most requested work — a bio, a headshot, a travel form — belongs to the
   * person rather than to a talk. When it is present the upload answering the task records it
   * too, which is what lets an organizer ask "what is still missing for this session?" rather
   * than reading it off file names. The server refuses a session from another event.
   */
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
  workflowStatus: z.string().trim().min(1).max(60),
  logistics: z.record(z.string().max(1000)),
  customFields: z.record(z.string().max(1000)),
});
export const configureContentWorkflowStatusesInputSchema = z.object({
  statuses: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        label: z.string().trim().min(1).max(80),
        category: z.enum(["open", "ready", "blocked"]),
      }),
    )
    .min(1)
    .max(30),
});
export const setSpeakerCollaboratorsInputSchema = z.object({
  collaborators: z
    .array(z.object({ userId: z.string().trim().min(1), access: z.enum(["view", "edit"]) }))
    .max(50),
});
export const speakerCollaboratorsResponseSchema = z.object({
  collaborators: z.array(z.object({ userId: z.string(), access: z.enum(["view", "edit"]) })),
});
export const contentShareInputSchema = z.object({
  lifetimeHours: z.number().int().min(1).max(720),
  viewLimit: z.number().int().min(1).max(1000).optional(),
  password: z.string().min(8).max(200).optional(),
});
export const contentShareSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["speaker-profile", "speaker-asset"]),
  resourceRef: z.string().uuid(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  viewLimit: z.number().int().positive().nullable(),
  views: z.number().int().nonnegative(),
  revokedAt: z.string().datetime().nullable(),
  hasPassword: z.boolean(),
  scope: z.object({ privateSet: z.literal(true) }),
});
export const contentShareListResponseSchema = z.object({ shares: z.array(contentShareSchema) });
export const contentShareParamsSchema = z.object({ shareId: z.string().uuid() });
export const contentShareTokenParamsSchema = z.object({ token: z.string().min(20).max(200) });
export const contentSharePasswordQuerySchema = z.object({
  password: z.string().max(200).optional(),
});
export const contentRemixInputSchema = z.object({
  instruction: z.string().trim().max(1000).default(""),
});
export const contentRemixResponseSchema = z.object({
  draft: z.object({
    state: z.literal("draft"),
    field: z.enum(["bio", "abstract"]),
    text: z.string(),
    model: z.string(),
  }),
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

/**
 * Remind the speakers behind a chosen set of open tasks.
 *
 * Bounded for the same reason the download is: this is one request an organizer presses, and an
 * unbounded selection would meet a Worker's subrequest budget rather than a refusal.
 */
export const remindSpeakerTasksInputSchema = z.object({
  eventId: z.string().uuid(),
  taskIds: z.array(z.string().uuid()).min(1).max(100),
});
export type RemindSpeakerTasksInput = z.infer<typeof remindSpeakerTasksInputSchema>;

/**
 * What happened for each task, including the ones nothing was sent for.
 *
 * `alreadySent` is not a failure: reminders converge on one delivery per (task, deadline), so an
 * organizer pressing this on work the automatic sweep already covered must be told the speaker
 * has been reminded rather than that a second message was queued.
 */
export const speakerReminderOutcomeSchema = z.object({
  taskId: z.string().uuid(),
  speakerName: z.string(),
  title: z.string(),
  dueAt: z.string().datetime(),
  outcome: z.enum(["queued", "already-sent", "unreachable", "refused"]),
  reason: z.string(),
});
export type SpeakerReminderOutcomeDto = z.infer<typeof speakerReminderOutcomeSchema>;
export const remindSpeakerTasksResponseSchema = z.object({
  reminders: z.array(speakerReminderOutcomeSchema),
});

/**
 * Invite a chosen set of speakers into the portal, deliberately and again if need be.
 *
 * Bounded for the same reason the reminder selection is: this is one request an organizer
 * presses, and an unbounded roster would meet a Worker's subrequest budget rather than a refusal.
 *
 * The speakers are named one by one rather than implied by the event. An invitation is mail to a
 * real person, so "everybody currently on this roster" is not something a request should mean by
 * omission — the same rule `assignSpeakerChecklistInputSchema` states for dated work.
 */
export const inviteSpeakersInputSchema = z.object({
  eventId: z.string().uuid(),
  profileIds: z.array(z.string().uuid()).min(1).max(100),
});
export type InviteSpeakersInput = z.infer<typeof inviteSpeakersInputSchema>;

/**
 * What happened for each speaker, including the ones nothing was sent for.
 *
 * `occurrence` is which invitation this was for that speaker: 1 is the first an organizer asked
 * for, and it is what makes a re-invitation a *new* delivery rather than one deduplicated into
 * the welcome acceptance sent months earlier. It is 0 when nothing was claimed, which is the
 * honest answer for a speaker who has no address to write to.
 *
 * `alreadySent` is not a failure here either: an enqueue retried at the same occurrence converges
 * on one message, so an organizer must be told the speaker has been invited rather than that a
 * second message was queued that was not.
 */
export const speakerInvitationOutcomeSchema = z.object({
  profileId: z.string().uuid(),
  speakerName: z.string(),
  email: z.string(),
  occurrence: z.number().int().nonnegative(),
  outcome: z.enum(["queued", "already-sent", "unreachable", "refused"]),
  reason: z.string(),
});
export type SpeakerInvitationOutcomeDto = z.infer<typeof speakerInvitationOutcomeSchema>;
export const inviteSpeakersResponseSchema = z.object({
  invitations: z.array(speakerInvitationOutcomeSchema),
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
 * One line of the event's reusable speaker checklist: what is asked of every speaker, and when.
 *
 * Not a `speakerTaskSchema` with nobody attached. A task is a named person's work — the portal,
 * the reminders and every completion badge read it that way — while a line is the event's, and
 * stays the event's until an organizer instantiates it against real speakers.
 *
 * `dueOffsetDays` is a distance rather than a date because an event carries no date range of its
 * own (`PRD-EVT-001`): the due date is derived at instantiation from the anchor that request
 * names, and negative counts backwards from it, which is what "two weeks before the event" is.
 */
export const speakerTaskTemplateSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  sortOrder: z.number().int(),
  dueOffsetDays: z.number().int(),
  createdAt: z.string().datetime(),
});
export type SpeakerTaskTemplateDto = z.infer<typeof speakerTaskTemplateSchema>;
/**
 * The checklist lines an organizer is declaring.
 *
 * Each is written at its `(event_id, title)` identity, so sending the same checklist twice
 * converges instead of appending a second copy of every line. Two lines under one title are
 * therefore one line the store cannot tell apart, and are refused rather than silently merged.
 * Lines this request does not name are left alone: declaring is not deleting.
 */
export const saveSpeakerTaskTemplatesInputSchema = z.object({
  templates: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().max(4000).default(""),
        sortOrder: z.number().int().min(0).max(10_000),
        // Ten years either side of the anchor, and whole days: a fractional offset would derive
        // a due date at an hour nobody chose, and the column stores an INTEGER.
        dueOffsetDays: z.number().int().min(-3650).max(3650),
      }),
    )
    // Empty is refused rather than accepted as a no-op, because it cannot mean what a caller
    // sending it would mean by it: nothing here removes a line.
    .min(1)
    .max(100)
    .refine(
      (templates) => new Set(templates.map(({ title }) => title)).size === templates.length,
      "Each checklist line needs a title of its own",
    ),
});
export type SaveSpeakerTaskTemplatesInput = z.infer<typeof saveSpeakerTaskTemplatesInputSchema>;
/**
 * One line, authored or edited from the console (issue #176).
 *
 * Separate from the bulk declaration above because it addresses the row rather than the title.
 * That is what lets an organizer *rename* a line: through the `(event_id, title)` path a
 * corrected title would create a second line and leave the mistyped one in the checklist for
 * ever, since nothing there removes anything.
 *
 * The bounds are the same as the bulk schema's, deliberately — one command must not accept a
 * line the other would refuse, or the two ways into the same table disagree about what a line
 * may be.
 */
export const speakerTaskTemplateInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).default(""),
  sortOrder: z.number().int().min(0).max(10_000),
  dueOffsetDays: z.number().int().min(-3650).max(3650),
});
export type SpeakerTaskTemplateInput = z.infer<typeof speakerTaskTemplateInputSchema>;
export const speakerTaskTemplateIdParamsSchema = z.object({
  templateId: z.string().uuid(),
});
/**
 * The whole checklist, which is what every write here answers with.
 *
 * A write answers with the list rather than with the row it touched, so the console never has to
 * reconstruct the order a reorder produced from a response describing one line.
 */
export const speakerTaskTemplateListResponseSchema = z.object({
  templates: z.array(speakerTaskTemplateSchema),
});
/**
 * The tasks an assignment created, and only those.
 *
 * An empty list is the honest answer to "everybody already has every line", which is what
 * running this a second time means — not a failure, and not nothing having happened before.
 */
export const speakerChecklistAssignmentResponseSchema = z.object({
  tasks: z.array(speakerTaskSchema),
});
/**
 * Turn the event's checklist into real work for named speakers.
 *
 * The speakers are named one by one rather than implied. Instantiating a checklist puts dated
 * work in real people's portals and mails them about it, so "everybody currently in this event"
 * is not a thing a request should mean by omission.
 *
 * `anchorAt` is the instant the offsets count from; omitted, the server counts from now.
 */
export const assignSpeakerChecklistInputSchema = z.object({
  profileIds: z.array(z.string().uuid()).min(1).max(500),
  anchorAt: z.string().datetime().optional(),
});
export type AssignSpeakerChecklistInput = z.infer<typeof assignSpeakerChecklistInputSchema>;

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
