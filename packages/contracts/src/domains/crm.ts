import { z } from "zod";

// @spec PRD-CRM-001
export const prospectStageSchema = z.enum([
  "identified",
  "contacted",
  "engaged",
  "invited",
  "converted",
]);
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
  contact: z.object({ name: z.string().trim().min(1).max(160), email: z.string().email() }),
});
const editableProspectStageSchema = z.enum(["identified", "contacted", "engaged", "invited"]);
export const updateProspectInputSchema = z
  .object({
    stage: editableProspectStageSchema.optional(),
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
export const prospectListResponseSchema = z.object({ prospects: z.array(prospectSchema) });
/**
 * A user identity-access reports as assignable on this event. Ids are opaque identity strings
 * (`seed-organizer`), not UUIDs, so the CRM never invents an owner the directory does not know.
 */
export const prospectOwnerSchema = z.object({ id: z.string(), name: z.string() });
export const prospectOwnerListResponseSchema = z.object({
  owners: z.array(prospectOwnerSchema),
});
export type ProspectOwnerDto = z.infer<typeof prospectOwnerSchema>;

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
  email: z.string(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  notes: z.string().nullable(),
  source: contactSourceSchema,
  mergedIntoId: z.string().uuid().nullable(),
  tags: z.array(z.string()),
  fields: z.array(contactCustomFieldSchema),
  aliases: z.array(contactAliasSchema),
  events: z.array(contactEventLinkSchema),
  activities: z.array(contactActivitySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrganizationContactDto = z.infer<typeof organizationContactSchema>;

const tagList = z.string().trim().min(1).max(40);
/** The stored definition of a saved view. Every criterion optional: `{}` is "no filters". */
export const contactFiltersSchema = z.object({
  search: z.string().trim().min(1).max(160).optional(),
  company: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  tags: z.array(tagList).max(20).optional(),
  fieldKey: z.string().trim().min(1).max(60).optional(),
  fieldValue: z.string().trim().min(1).max(300).optional(),
  eventId: z.string().uuid().optional(),
});
export type ContactFiltersDto = z.infer<typeof contactFiltersSchema>;
/**
 * The same criteria as query parameters. `tags` arrives comma-separated because a repeated
 * parameter does not survive `context.req.query()`, and `segmentId` is offered instead of the
 * criteria so reopening a saved view sends its identity rather than a client-rebuilt copy.
 */
export const contactListQuerySchema = z.object({
  search: z.string().trim().min(1).max(160).optional(),
  company: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  tags: z.string().trim().min(1).max(400).optional(),
  fieldKey: z.string().trim().min(1).max(60).optional(),
  fieldValue: z.string().trim().min(1).max(300).optional(),
  eventId: z.string().uuid().optional(),
  segmentId: z.string().uuid().optional(),
});

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

export const contactDirectoryParamsSchema = z.object({ organizationId: z.string().uuid() });
export const contactPathSchema = z.object({
  organizationId: z.string().uuid(),
  contactId: z.string().uuid(),
});
export const contactResponseSchema = z.object({ contact: organizationContactSchema });
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
export const duplicateListResponseSchema = z.object({ groups: z.array(duplicateGroupSchema) });
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
export const segmentResponseSchema = z.object({ segment: contactSegmentSchema });
export const segmentListResponseSchema = z.object({ segments: z.array(contactSegmentSchema) });

/**
 * One row as the parser read it. Every field the preview resolves is declared, `notes` and
 * `fields` included: the client decodes non-strictly, so a field missing here is silently
 * dropped on the way to the screen, and an organizer would have approved a preview that did not
 * mention the notes and custom columns the commit was about to write.
 */
export const contactImportRowSchema = z.object({
  line: z.number().int().positive(),
  name: z.string(),
  email: z.string(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  fields: z.array(contactCustomFieldSchema),
  /** What committing this file would do with this row, decided against the live directory. */
  action: z.enum(["create", "update", "skip"]),
  errors: z.array(z.string()),
});
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
  /** Absent on a preview; the communications delivery this recipient's send created. */
  deliveryId: z.string().optional(),
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
