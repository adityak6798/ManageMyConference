import { z } from "zod";

// @spec PRD-EVT-001
export const createEventInputSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1, "Event name is required").max(120),
  timezone: z.string().trim().min(1).default("America/Los_Angeles"),
});

export type CreateEventInput = z.infer<typeof createEventInputSchema>;

export const eventSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  createdAt: z.string().datetime(),
});

export type EventDto = z.infer<typeof eventSchema>;
export const eventIdParamsSchema = z.object({ eventId: z.string().uuid() });

export const eventListResponseSchema = z.object({ events: z.array(eventSchema) });
export const createEventResponseSchema = z.object({ event: eventSchema });
export const demoPersonaSchema = z.enum(["organizer", "reviewer", "speaker", "public"]);
export const demoSessionInputSchema = z.object({ persona: demoPersonaSchema });
export const demoSessionResponseSchema = z.object({ persona: demoPersonaSchema });
export const capabilitySchema = z.enum([
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
]);
export const sessionEventAccessSchema = z.object({
  eventId: z.string().uuid(),
  role: demoPersonaSchema,
  capabilities: z.array(capabilitySchema),
});
export const sessionResponseSchema = z.object({
  actor: z.object({ id: z.string(), name: z.string(), persona: demoPersonaSchema }),
  organizations: z.array(z.object({ id: z.string().uuid() })),
  eventAccess: z.array(sessionEventAccessSchema),
  capabilities: z.array(capabilitySchema),
});
export type SessionDto = z.infer<typeof sessionResponseSchema>;
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  checks: z.object({
    database: z.literal("configured"),
    sessionSigning: z.enum(["configured", "disabled"]),
  }),
  providerMode: z.literal("deterministic-fakes"),
  logFormat: z.literal("structured-json"),
});

export const apiErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL_ERROR",
]);

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    correlationId: z.string(),
    fieldErrors: z.record(z.array(z.string())).optional(),
  }),
});

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

// @spec PRD-CFP-001 PRD-CFP-002
export const cfpFieldTypeSchema = z.enum(["short_text", "long_text", "email", "select"]);
export const cfpFieldSchema = z.object({
  id: z.string().min(1).max(80),
  type: cfpFieldTypeSchema,
  label: z.string().trim().min(1).max(120),
  guidance: z.string().trim().max(500).default(""),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
});
export const cfpStatusSchema = z.enum(["draft", "open", "closed"]);
const cfpFieldsSchema = z
  .array(cfpFieldSchema)
  .min(1)
  .max(40)
  .superRefine((fields, context) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.id))
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Field IDs must be unique",
        });
      seen.add(field.id);
      if (field.type === "select" && field.options.length === 0)
        context.addIssue({
          code: "custom",
          path: [index, "options"],
          message: "Select fields need at least one option",
        });
    });
  });
export const saveCfpInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  fields: cfpFieldsSchema,
});
export const cfpFormSchema = saveCfpInputSchema.extend({
  eventId: z.string().uuid(),
  status: cfpStatusSchema,
  version: z.number().int().positive(),
  publishedAt: z.string().datetime().nullable(),
});
export const cfpResponseSchema = z.object({ cfp: cfpFormSchema });
export const cfpStateInputSchema = z.object({ state: z.enum(["publish", "close", "reopen"]) });
export const submitProposalInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  answers: z.record(z.string()),
});
export const proposalConfirmationSchema = z.object({
  confirmationId: z.string().uuid(),
  submittedAt: z.string().datetime(),
});
export const proposalConfirmationResponseSchema = z.object({
  submission: proposalConfirmationSchema,
});
export type CfpField = z.infer<typeof cfpFieldSchema>;
export type CfpFormDto = z.infer<typeof cfpFormSchema>;
export type SaveCfpInput = z.infer<typeof saveCfpInputSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalInputSchema>;
