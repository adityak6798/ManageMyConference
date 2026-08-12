import { z } from "zod";

// @spec PRD-COM-001 PRD-INT-001
/**
 * `event` carries a domain event this system committed rather than a call to an outside one.
 * It appears in responses because a delivery history shows every delivery, and it is absent from
 * `requestChannelSchema` below because no request may create one.
 */
export const deliveryChannelSchema = z.enum(["email", "airtable", "accelevents", "event"]);
export const deliveryStateSchema = z.enum(["queued", "retrying", "succeeded", "terminal"]);
export const triggerTypeSchema = z.enum([
  "speaker.invited",
  "reviewer.assigned",
  "organizer.digest",
  "projection.requested",
  "schedule.published",
  "speaker.scheduled",
  "speaker.task_assigned",
  "speaker.task_reminder",
  "speaker.calendar_invite",
  "decision.recorded",
]);
/**
 * What an organizer's `POST /api/communications/deliveries` may name — everything except the
 * domain-event pair.
 *
 * A domain event records that something already happened inside this system, and downstream
 * consumers trust it precisely because it was committed in the same transaction as the fact it
 * announces. A request that could mint one could announce a schedule publication that never
 * occurred. Narrowing the request schema rather than relying on the service's coherence check
 * means the refusal is a 400 naming the field, and is visible in the published OpenAPI.
 */
export const requestChannelSchema = z.enum(["email", "airtable", "accelevents"]);
export const requestTriggerTypeSchema = z.enum([
  "speaker.invited",
  "reviewer.assigned",
  "organizer.digest",
  "projection.requested",
  "speaker.scheduled",
  "speaker.task_assigned",
  "speaker.task_reminder",
  "speaker.calendar_invite",
  "decision.recorded",
]);
/**
 * Which channels each trigger may use. The API enforces the same table in
 * `apps/api/src/domain/communications/delivery.ts`; this is the contract's statement of it, and
 * `communications-contract.test.ts` asserts the two agree so they cannot drift apart.
 */
export const triggerChannels: Record<
  z.infer<typeof triggerTypeSchema>,
  readonly z.infer<typeof deliveryChannelSchema>[]
> = {
  "speaker.invited": ["email"],
  "reviewer.assigned": ["email"],
  "organizer.digest": ["email"],
  "speaker.scheduled": ["email"],
  "speaker.task_assigned": ["email"],
  "speaker.task_reminder": ["email"],
  "speaker.calendar_invite": ["email"],
  "decision.recorded": ["email"],
  "projection.requested": ["airtable", "accelevents"],
  "schedule.published": ["event"],
};
export const createTemplateInputSchema = z.object({
  organizationId: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  /**
   * Omit to have the server allocate the next version, which is what a console should do.
   *
   * It used to be required, so the caller computed the next number from the list it last read;
   * two organizers publishing the same key at once proposed the same number and the loser got a
   * `500`. Naming one explicitly still works and a taken one is now a `409`.
   */
  version: z.number().int().positive().optional(),
  // Not `deliveryChannelSchema`: there is no such thing as a template for the `event` channel,
  // which carries a payload no human reads. `message_templates`' own CHECK says the same.
  channel: requestChannelSchema,
  subject: z.string().max(200).nullable(),
  body: z.string().min(1).max(100_000),
});
export const triggerDeliveryInputSchema = z
  .object({
    organizationId: z.string().uuid(),
    eventId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    triggerType: requestTriggerTypeSchema,
    channel: requestChannelSchema,
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
    if (!triggerChannels[input.triggerType].includes(input.channel))
      context.addIssue({
        code: "custom",
        path: ["triggerType"],
        message: `A ${input.triggerType} delivery cannot be sent over the ${input.channel} channel`,
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
export const templateListParamsSchema = z.object({ organizationId: z.string().uuid() });
export const broadcastRecipientsParamsSchema = z.object({
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
});
export const broadcastInputSchema = z.object({
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  templateKey: z.string().trim().min(1).max(80),
  /** Omitted sends the newest version; pinning one is how a re-send repeats an older message. */
  templateVersion: z.number().int().positive().optional(),
  /** Values for the template's placeholders. `speakerName` is supplied per recipient. */
  payload: z.record(z.unknown()).optional(),
  /**
   * The `audienceVersion` the organizer confirmed against. A mismatch is `409 CONFLICT` and
   * nothing is sent. Optional so an API caller that never saw a count is not made to invent one.
   */
  audienceVersion: z.string().min(1).max(100).optional(),
});
export const deliveryIdParamsSchema = z.object({ deliveryId: z.string().min(1) });
export const messageTemplateSchema = createTemplateInputSchema.extend({
  id: z.string(),
  // Required on a stored template even though the request may omit it: the server allocated one.
  version: z.number().int().positive(),
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
  /** The message as sent. Null on projection channels, which carry a payload, not a message. */
  renderedSubject: z.string().nullable(),
  renderedBody: z.string().nullable(),
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
export const templateListResponseSchema = z.object({
  templates: z.array(messageTemplateSchema),
});
export const broadcastRecipientSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /** Null when identity holds no address for this speaker. Counted, never guessed at. */
  address: z.string().nullable(),
});
export const broadcastRecipientsResponseSchema = z.object({
  recipients: z.array(broadcastRecipientSchema),
  /**
   * Names this exact audience. Send it back with a broadcast and a send whose audience has since
   * changed is refused rather than reaching a different set of people than the count on screen.
   * A change detector, not a token: it authorizes nothing and is re-resolved server-side.
   */
  audienceVersion: z.string(),
});
export const broadcastResponseSchema = z.object({
  /** Deliveries this send created. Never counts one an earlier send already wrote. */
  enqueued: z.number().int().nonnegative(),
  /** Recipients whose delivery already existed under the same key; nothing new was queued. */
  alreadySent: z.number().int().nonnegative(),
  unreachable: z.array(broadcastRecipientSchema),
  deliveries: z.array(deliverySchema),
});
export const deliveryResponseSchema = z.object({ delivery: deliverySchema });
export const communicationsHistoryResponseSchema = z.object({
  history: z.array(
    z.object({ delivery: deliverySchema, attempts: z.array(deliveryAttemptSchema) }),
  ),
  nextCursor: z.string().nullable(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;
export type MessageTemplateDto = z.infer<typeof messageTemplateSchema>;
export type BroadcastInput = z.infer<typeof broadcastInputSchema>;
export type BroadcastRecipientDto = z.infer<typeof broadcastRecipientSchema>;
export type BroadcastResultDto = z.infer<typeof broadcastResponseSchema>;
export type TriggerDeliveryInput = z.infer<typeof triggerDeliveryInputSchema>;
export type DeliveryDto = z.infer<typeof deliverySchema>;
export type CommunicationsHistoryDto = z.infer<typeof communicationsHistoryResponseSchema>;
