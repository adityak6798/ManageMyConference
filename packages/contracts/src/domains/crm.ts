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
