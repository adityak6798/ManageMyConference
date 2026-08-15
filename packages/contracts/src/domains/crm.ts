import { z } from "zod";

/**
 * A stage key on this event's board.
 *
 * Not an enum any more. Which keys exist is data — `crm_pipeline_stages`, one row per stage an
 * organizer configured — and an enum here would refuse every stage they added while also being
 * a second copy of a list that lives in the database (#197, migration `1502`).
 *
 * The *shape* is still constrained, because a key is an identifier rather than a sentence and
 * the console builds URLs and CSS class names from it.
 */
// @spec PRD-CRM-001
export const prospectStageSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens");
export const prospectContactSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  isPrimary: z.boolean(),
});
/*
 * Two vocabularies, deliberately different sizes. `stage-change` and `conversion` are
 * written by the CRM service as the transition they describe is applied, so they are part
 * of what a timeline returns but not of what a client may submit: a caller who could post
 * one could tell the timeline a prospect moved when it never did.
 */
export const prospectActivityKindSchema = z.enum([
  "note",
  "email",
  "call",
  "meeting",
  "engagement",
  "stage-change",
  "conversion",
]);
export const recordableProspectActivityKindSchema = z.enum(["note", "email", "call", "meeting"]);
export const prospectActivitySchema = z.object({
  id: z.string().uuid(),
  kind: prospectActivityKindSchema,
  summary: z.string(),
  private: z.boolean(),
  occurredAt: z.string().datetime(),
  actorId: z.string(),
});
export const prospectSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  name: z.string(),
  stage: prospectStageSchema,
  ownerId: z.string(),
  nextAction: z.string().nullable(),
  nextActionAt: z.string().datetime().nullable(),
  contacts: z.array(prospectContactSchema),
  activities: z.array(prospectActivitySchema),
  speakerId: z.string().uuid().nullable(),
  convertedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProspectDto = z.infer<typeof prospectSchema>;
export const createProspectInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  ownerId: z.string().trim().min(1),
  nextAction: z.string().trim().min(1).max(300).optional(),
  nextActionAt: z.string().datetime().optional(),
  contact: z.object({
    name: z.string().trim().min(1).max(160),
    email: z.string().email(),
  }),
});
/*
 * Any key this event configured, refused by the *server* against the board rather than by a
 * fixed list here. The five-key enum this replaces was the wire-level twin of the CHECK `1502`
 * removed, and it would have refused every stage an organizer added.
 */
const editableProspectStageSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens");
export const updateProspectInputSchema = z
  .object({
    stage: editableProspectStageSchema.optional(),
    /** What moved it: a drag on the board and an edit in the panel are different acts. */
    source: z.enum(["board", "detail"]).optional(),
    ownerId: z.string().trim().min(1).optional(),
    nextAction: z.string().trim().min(1).max(300).nullable().optional(),
    nextActionAt: z.string().datetime().nullable().optional(),
    activity: z
      .object({
        kind: recordableProspectActivityKindSchema,
        summary: z.string().trim().min(1).max(1000),
        private: z.boolean().default(true),
      })
      .optional(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(160),
        email: z.string().email(),
        isPrimary: z.boolean().default(false),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one change is required");
export const prospectPathSchema = z.object({
  eventId: z.string().uuid(),
  prospectId: z.string().uuid(),
});
export const prospectListQuerySchema = z.object({
  stage: prospectStageSchema.optional(),
  ownerId: z.string().optional(),
  overdue: z.enum(["true"]).optional(),
});
export const prospectResponseSchema = z.object({ prospect: prospectSchema });
export const prospectListResponseSchema = z.object({
  prospects: z.array(prospectSchema),
});
/** Public, year-round interest form. `website` is a honeypot and must remain blank. */
export const submitSpeakerInterestInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  website: z.literal("").optional().default(""),
});
export const submitSpeakerInterestResponseSchema = z.object({
  interest: z.object({
    confirmationId: z.string().uuid(),
    submittedAt: z.string().datetime(),
  }),
});
/**
 * A user identity-access reports as assignable on this event. Ids are opaque identity strings
 * (`seed-organizer`), not UUIDs, so the CRM never invents an owner the directory does not know.
 */
export const prospectOwnerSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export const prospectOwnerListResponseSchema = z.object({
  owners: z.array(prospectOwnerSchema),
});
export type ProspectOwnerDto = z.infer<typeof prospectOwnerSchema>;

/* ------------------------------------------------------------------------------------------
 * The configurable sourcing board (#197).
 *
 * A stage's `key` is stable and is what a prospect row stores; `label` is the organizer's to
 * rename; `category` is closed so a filter or a report keyed on "won" survives the rename.
 * ---------------------------------------------------------------------------------------- */

export const stageCategorySchema = z.enum(["open", "won", "nurture", "lost"]);
export type StageCategoryDto = z.infer<typeof stageCategorySchema>;

/**
 * Lowercase, hyphen-separated, and never generated from the label by the client.
 *
 * The key outlives every rename, so deriving it from the current name would produce a *new*
 * key the moment somebody edited the label — stranding every prospect standing in that stage.
 */
const stageKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens");

export const pipelineStageSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  key: stageKeySchema,
  label: z.string(),
  category: stageCategorySchema,
  sortOrder: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type PipelineStageDto = z.infer<typeof pipelineStageSchema>;

/**
 * The whole list, every time.
 *
 * Adding, renaming and reordering are one act on a board — a reorder moves every column — so
 * a diff would have to be reassembled into this anyway, with a window in which two columns
 * claim the same position.
 */
export const savePipelineStagesInputSchema = z.object({
  stages: z
    .array(
      z.object({
        key: stageKeySchema,
        label: z.string().trim().min(1).max(80),
        category: stageCategorySchema,
      }),
    )
    .min(1, "A pipeline needs at least one stage")
    .max(24, "A board with more than two dozen columns is a list, not a board"),
});
export type SavePipelineStagesInput = z.infer<typeof savePipelineStagesInputSchema>;

/**
 * Deleting a stage names where its prospects go.
 *
 * Required rather than defaulted: a default would silently decide where somebody's shortlist
 * went, and the reason a bare delete is refused at all is that losing track of a prospect is
 * worse than one more question.
 */
export const deletePipelineStageInputSchema = z.object({
  migrateTo: stageKeySchema,
});
export type DeletePipelineStageInput = z.infer<typeof deletePipelineStageInputSchema>;

export const prospectTransitionSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  prospectId: z.string().uuid(),
  /** Null for the transition that created the prospect: it came from nowhere. */
  fromStage: z.string().nullable(),
  toStage: z.string(),
  actorId: z.string(),
  source: z.enum(["board", "detail", "created", "conversion", "migration"]),
  occurredAt: z.string().datetime(),
});
export type ProspectTransitionDto = z.infer<typeof prospectTransitionSchema>;

export const pipelineStageListResponseSchema = z.object({
  stages: z.array(pipelineStageSchema),
});
export const pipelineHistoryResponseSchema = z.object({
  transitions: z.array(prospectTransitionSchema),
});
export const pipelineStagePathSchema = z.object({
  eventId: z.string().uuid(),
  stageKey: stageKeySchema,
});

/* ------------------------------------------------------------------------------------------
 * The organization-wide speaker directory.
 *
 * Everything below is addressed by `organizationId`, never by `eventId`. That is the wire-level
 * expression of the boundary: an event-scoped path could not carry a cross-event answer, and a
 * caller cannot reach the directory by naming an event it happens to organize.
 * ---------------------------------------------------------------------------------------- */

export const contactSourceSchema = z.enum(["manual", "import", "prospect"]);
/** Read vocabulary and write vocabulary, sized differently for the same reason prospects are. */
export const contactActivityKindSchema = z.enum([
  "note",
  "email",
  "call",
  "meeting",
  "import",
  "merge",
  "outreach",
  "conversion",
]);
export const recordableContactActivityKindSchema = z.enum(["note", "email", "call", "meeting"]);

export const contactCustomFieldSchema = z.object({
  key: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(300),
});
export const contactAliasSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  mergedFromId: z.string().uuid(),
  mergedAt: z.string().datetime(),
});
export const contactEventLinkSchema = z.object({
  eventId: z.string().uuid(),
  prospectId: z.string().uuid(),
  stage: prospectStageSchema,
  speakerId: z.string().uuid().nullable(),
  convertedAt: z.string().datetime().nullable(),
  linkedAt: z.string().datetime(),
});
export const contactActivitySchema = z.object({
  id: z.string().uuid(),
  kind: contactActivityKindSchema,
  summary: z.string(),
  private: z.boolean(),
  occurredAt: z.string().datetime(),
  actorId: z.string(),
});
export const organizationContactSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  /*
   * Governed by per-field access (`PRD-IAM-002`). Optional because a custom role may Hide it,
   * and a hidden field is *absent* rather than null: `null` means no company was recorded, and
   * absent means this reader does not see the one that was. Collapsing the two would tell a
   * sponsor liaison that every contact works nowhere. `name` stays required — a record with no
   * identifying field is unjoinable.
   */
  email: z.string().optional(),
  company: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  source: contactSourceSchema,
  mergedIntoId: z.string().uuid().nullable(),
  tags: z.array(z.string()).optional(),
  fields: z.array(contactCustomFieldSchema).optional(),
  aliases: z.array(contactAliasSchema),
  events: z.array(contactEventLinkSchema),
  activities: z.array(contactActivitySchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrganizationContactDto = z.infer<typeof organizationContactSchema>;

const tagList = z.string().trim().min(1).max(40);
/** The stored definition of a saved view. Every criterion optional: `{}` is "no filters". */
export const contactFiltersSchema = z
  .object({
    search: z.string().trim().min(1).max(160).optional(),
    company: z.string().trim().min(1).max(160).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    tags: z.array(tagList).max(20).optional(),
    fieldKey: z.string().trim().min(1).max(60).optional(),
    fieldValue: z.string().trim().min(1).max(300).optional(),
    eventId: z.string().uuid().optional(),
  })
  // A value with no key names nothing. Both repositories read `fieldValue` only inside the
  // `fieldKey` branch, so one on its own was echoed back as an active criterion while matching
  // every contact — a filter that appears to be doing something and is not.
  .refine(
    (value) => value.fieldValue === undefined || value.fieldKey !== undefined,
    "Filtering by a custom field value also needs the field it belongs to",
  );
export type ContactFiltersDto = z.infer<typeof contactFiltersSchema>;
/**
 * The same criteria as query parameters. `tags` arrives comma-separated because a repeated
 * parameter does not survive `context.req.query()`, and `segmentId` is offered instead of the
 * criteria so reopening a saved view sends its identity rather than a client-rebuilt copy.
 */
export const contactListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(160).optional(),
    company: z.string().trim().min(1).max(160).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    tags: z.string().trim().min(1).max(400).optional(),
    fieldKey: z.string().trim().min(1).max(60).optional(),
    fieldValue: z.string().trim().min(1).max(300).optional(),
    eventId: z.string().uuid().optional(),
    segmentId: z.string().uuid().optional(),
  })
  .refine(
    (value) => value.fieldValue === undefined || value.fieldKey !== undefined,
    "Filtering by a custom field value also needs the field it belongs to",
  );

export const createContactInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().email(),
  company: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  notes: z.string().trim().min(1).max(4000).optional(),
  tags: z.array(tagList).max(20).optional(),
  fields: z.array(contactCustomFieldSchema).max(30).optional(),
});
/**
 * `null` clears, absent leaves alone — the same convention the prospect update uses, so an
 * organizer can empty a note without the client having to send every other field back.
 */
export const updateContactInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    company: z.string().trim().min(1).max(160).nullable().optional(),
    title: z.string().trim().min(1).max(160).nullable().optional(),
    notes: z.string().trim().min(1).max(4000).nullable().optional(),
    tags: z.array(tagList).max(20).optional(),
    fields: z.array(contactCustomFieldSchema).max(30).optional(),
    activity: z
      .object({
        kind: recordableContactActivityKindSchema,
        summary: z.string().trim().min(1).max(1000),
        private: z.boolean().default(true),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one change is required");

export const contactDirectoryParamsSchema = z.object({
  organizationId: z.string().uuid(),
});
export const contactPathSchema = z.object({
  organizationId: z.string().uuid(),
  contactId: z.string().uuid(),
});
export const contactResponseSchema = z.object({
  contact: organizationContactSchema,
});
export const contactListResponseSchema = z.object({
  contacts: z.array(organizationContactSchema),
  /** Echoed back so a cleared filter and a filter that matched nothing look different. */
  filters: contactFiltersSchema,
});

export const duplicateGroupSchema = z.object({
  reason: z.enum(["name-company", "name"]),
  key: z.string(),
  contactIds: z.array(z.string().uuid()).min(2),
  suggestedPrimaryId: z.string().uuid(),
});
export const duplicateListResponseSchema = z.object({
  groups: z.array(duplicateGroupSchema),
});
/** The primary is named explicitly rather than inferred, because a merge cannot be undone. */
export const mergeContactsInputSchema = z.object({
  primaryId: z.string().uuid(),
  duplicateIds: z.array(z.string().uuid()).min(1).max(20),
});

export const contactSegmentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  filters: contactFiltersSchema,
  createdAt: z.string().datetime(),
  createdBy: z.string(),
});
export type ContactSegmentDto = z.infer<typeof contactSegmentSchema>;
export const createSegmentInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: contactFiltersSchema,
});
export const segmentResponseSchema = z.object({
  segment: contactSegmentSchema,
});
export const segmentListResponseSchema = z.object({
  segments: z.array(contactSegmentSchema),
});

/**
 * One row as the parser read it. Every field the preview resolves is declared, `notes` and
 * `fields` included: the client decodes non-strictly, so a field missing here is silently
 * dropped on the way to the screen, and an organizer would have approved a preview that did not
 * mention the notes and custom columns the commit was about to write.
 *
 * Deliberately unbounded, and `fields` deliberately *not* `contactCustomFieldSchema`. This is a
 * report of what a file contained, not a contact: the rows most worth describing are exactly
 * the ones that broke a bound, and validating the echo against the bounds they broke made the
 * message explaining the refusal undecodable — so a file with one over-long cell showed a
 * decode failure instead of naming the cell. What may be *stored* is bounded by
 * `createContactInputSchema` and by the parser, which is where the limit belongs.
 */
export const contactImportRowSchema = z.object({
  line: z.number().int().positive(),
  name: z.string(),
  email: z.string(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  fields: z.array(z.object({ key: z.string(), value: z.string() })),
  /** What committing this file would do with this row, decided against the live directory. */
  action: z.enum(["create", "update", "skip"]),
  errors: z.array(z.string()),
});
/**
 * The byte cap bounds the request. It does not bound the *work*: the CRM domain additionally
 * refuses a file past `MAX_IMPORT_ROWS`, because a megabyte of valid rows costs a database read
 * and a statement each and would exhaust a Worker's budget partway through.
 */
export const importContactsInputSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(1_000_000),
});
export const importPreviewResponseSchema = z.object({
  filename: z.string(),
  rows: z.array(contactImportRowSchema),
  notices: z.array(z.string()),
  summary: z.object({
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
  }),
});
export const contactImportSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  filename: z.string(),
  rowCount: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  importedAt: z.string().datetime(),
  importedBy: z.string(),
});
export const importContactsResponseSchema = z.object({
  import: contactImportSchema,
  contacts: z.array(organizationContactSchema),
  /** Rows the commit refused, so a partially usable file reports what it dropped. */
  rejected: z.array(contactImportRowSchema),
});

/**
 * Bulk outreach names an event as well as an organization. Delivery is event-scoped in
 * communications, and asking the caller to name the event is what lets the CRM check that they
 * may write to it — a directory-wide grant must not become a send into an event they do not run.
 */
export const outreachInputSchema = z
  .object({
    eventId: z.string().uuid(),
    templateKey: z.string().trim().min(1).max(80),
    templateVersion: z.number().int().positive().optional(),
    contactIds: z.array(z.string().uuid()).min(1).max(200).optional(),
    segmentId: z.string().uuid().optional(),
  })
  .refine(
    (value) => Boolean(value.contactIds?.length) !== Boolean(value.segmentId),
    "Name either a segment or an explicit contact list, not both",
  );
export const outreachRecipientSchema = z.object({
  contactId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  /** Absent on a preview; the communications delivery this recipient's send resolved to. */
  deliveryId: z.string().optional(),
  /**
   * Absent on a preview. False when the send converged on a delivery that already existed —
   * a repeat of the same campaign to the same contact, which is deduplicated by design and must
   * not be reported as a message newly on its way.
   */
  created: z.boolean().optional(),
});
export const outreachPreviewResponseSchema = z.object({
  eventId: z.string().uuid(),
  templateKey: z.string(),
  recipients: z.array(outreachRecipientSchema),
});
export const outreachResponseSchema = z.object({
  eventId: z.string().uuid(),
  templateKey: z.string(),
  sent: z.array(outreachRecipientSchema),
});

export const crmCampaignStateSchema = z.enum([
  "draft",
  "scheduled",
  "running",
  "completed",
  "cancelled",
]);
export const crmCampaignSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  name: z.string(),
  templateKey: z.string(),
  templateVersion: z.number().int().positive().nullable(),
  contactIds: z.array(z.string().uuid()),
  segmentId: z.string().uuid().nullable(),
  state: crmCampaignStateSchema,
  scheduledAt: z.string().datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CrmCampaignDto = z.infer<typeof crmCampaignSchema>;
export const createCrmCampaignInputSchema = z.intersection(
  outreachInputSchema,
  z.object({
    name: z.string().trim().min(1).max(160),
    scheduledAt: z.string().datetime().optional(),
  }),
);
export const crmCampaignPathSchema = contactDirectoryParamsSchema.extend({
  campaignId: z.string().uuid(),
});
export const crmCampaignListResponseSchema = z.object({
  campaigns: z.array(crmCampaignSchema).default([]),
});
export const crmEngagementInputSchema = z.object({
  eventId: z.string().uuid(),
  campaignId: z.string().uuid().optional(),
  contactId: z.string().uuid(),
  kind: z.enum(["delivered", "opened", "clicked", "replied", "bounced", "unsubscribed"]),
  providerRef: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime(),
  metadata: z.record(z.string(), z.string().max(1000)).default({}),
});

/**
 * Organization-level analytics. Every number is a count over stored rows; none is a constant,
 * which is the property `PRD-CRM-001` asks the dashboard to hold.
 */
export const contactDashboardResponseSchema = z.object({
  contacts: z.number().int().nonnegative(),
  contactsInMultipleEvents: z.number().int().nonnegative(),
  convertedContacts: z.number().int().nonnegative(),
  duplicateGroups: z.number().int().nonnegative(),
  segments: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  byStage: z.array(z.object({ stage: prospectStageSchema, contacts: z.number().int() })),
  topCompanies: z.array(z.object({ company: z.string(), contacts: z.number().int() })),
  pipelineTransitions: z.number().int().nonnegative().default(0),
  averageDaysToConversion: z.number().nonnegative().nullable().default(null),
  transitionFunnel: z
    .array(
      z.object({
        fromStage: prospectStageSchema.nullable(),
        toStage: prospectStageSchema,
        prospects: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});
export type ContactDashboardDto = z.infer<typeof contactDashboardResponseSchema>;

/** Push a directory contact into one event's pipeline, then through the conversion boundary. */
export const pushContactToEventInputSchema = z.object({
  eventId: z.string().uuid(),
  ownerId: z.string().trim().min(1),
  convert: z.boolean().default(false),
});
export const pushContactToEventResponseSchema = z.object({
  contact: organizationContactSchema,
  prospect: prospectSchema,
});
