import { z } from "zod";

// @spec PRD-COM-001 PRD-INT-001
export const deliveryChannelSchema = z.enum(["email", "airtable", "accelevents"]);
export const deliveryStateSchema = z.enum(["queued", "retrying", "succeeded", "terminal"]);
export const triggerTypeSchema = z.enum([
  "speaker.invited",
  "reviewer.assigned",
  "organizer.digest",
  "projection.requested",
]);
export const createTemplateInputSchema = z.object({
  organizationId: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  version: z.number().int().positive(),
  channel: deliveryChannelSchema,
  subject: z.string().max(200).nullable(),
  body: z.string().min(1).max(100_000),
});
export const triggerDeliveryInputSchema = z
  .object({
    organizationId: z.string().uuid(),
    eventId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    triggerType: triggerTypeSchema,
    channel: deliveryChannelSchema,
    recipientRef: z.string().trim().min(1).max(500),
    payload: z.record(z.unknown()),
    templateKey: z.string().trim().min(1).max(80).optional(),
    templateVersion: z.number().int().positive().optional(),
    projectionVersion: z.number().int().positive().optional(),
  })
  .superRefine((input, context) => {
    if (input.channel === "email" && !input.templateKey)
      context.addIssue({
        code: "custom",
        path: ["templateKey"],
        message: "Email delivery requires a template",
      });
    if (input.channel === "email" && input.triggerType === "projection.requested")
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message: "Projection triggers require a projection provider",
      });
    if (input.channel !== "email" && input.triggerType !== "projection.requested")
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message: "Projection providers require a projection trigger",
      });
    if (input.channel !== "email" && input.projectionVersion === undefined)
      context.addIssue({
        code: "custom",
        path: ["projectionVersion"],
        message: "Projection delivery requires a version",
      });
  });
export const communicationsHistoryParamsSchema = z.object({
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(500).optional(),
});
export const retryDeliveryInputSchema = z.object({ organizationId: z.string().uuid() });
export const deliveryIdParamsSchema = z.object({ deliveryId: z.string().min(1) });
export const messageTemplateSchema = createTemplateInputSchema.extend({
  id: z.string(),
  createdAt: z.string().datetime(),
});
export const deliverySchema = z.object({
  id: z.string(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  idempotencyKey: z.string(),
  triggerType: triggerTypeSchema,
  channel: deliveryChannelSchema,
  templateId: z.string().nullable(),
  templateVersion: z.number().int().positive().nullable(),
  recipientRef: z.string(),
  payload: z.record(z.unknown()),
  projectionVersion: z.number().int().positive().nullable(),
  state: deliveryStateSchema,
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime(),
  leaseToken: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const deliveryAttemptSchema = z.object({
  id: z.string(),
  deliveryId: z.string(),
  sequence: z.number().int().positive(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  outcome: z.enum(["succeeded", "retryable_failure", "terminal_failure"]),
  providerReference: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export const templateResponseSchema = z.object({ template: messageTemplateSchema });
export const deliveryResponseSchema = z.object({ delivery: deliverySchema });
export const communicationsHistoryResponseSchema = z.object({
  history: z.array(
    z.object({ delivery: deliverySchema, attempts: z.array(deliveryAttemptSchema) }),
  ),
  nextCursor: z.string().nullable(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;
export type TriggerDeliveryInput = z.infer<typeof triggerDeliveryInputSchema>;
export type DeliveryDto = z.infer<typeof deliverySchema>;
export type CommunicationsHistoryDto = z.infer<typeof communicationsHistoryResponseSchema>;
