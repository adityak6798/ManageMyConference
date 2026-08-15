import { z } from "zod";
import { cursorPage, cursorPageParams } from "./platform";

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
  "reviewer.reminder",
  "organizer.digest",
  "projection.requested",
  "schedule.published",
  "speaker.scheduled",
  "speaker.task_assigned",
  "speaker.task_reminder",
  "speaker.calendar_invite",
  "decision.recorded",
  "proposal.submitted",
  "cfp.deadline_approaching",
  "cfp.call_closed",
]);
/**
 * What an organizer's `POST /api/communications/deliveries` may name — everything except the
 * domain-event pair, `proposal.submitted`, and the two scheduled CFP deadline messages.
 *
 * A submission confirmation is absent for a narrower reason than the domain events: it is not
 * something an organizer authors. Its recipient is resolved from the session that submitted the
 * proposal, which is the entire property that made it shippable (`#132`, decision `D5`), and a
 * request naming an arbitrary address would hand back exactly the primitive that binding removed.
 * The refusal is a 400 naming the field rather than a coherence check deeper in, and it is visible
 * in the published OpenAPI.
 *
 * `cfp.deadline_approaching` and `cfp.call_closed` are absent on the same grounds (issue #210).
 * The scheduler decides who is reminded — the accounts holding an unsubmitted draft, and the
 * organizers of the event — and resolves every address through identity from an account id.
 * Letting a request name one with an arbitrary `recipientRef` would be organizer-authored mail to
 * any address, wearing the label of a message the product sends on its own.
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
  "reviewer.reminder",
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
  "reviewer.reminder": ["email"],
  "organizer.digest": ["email"],
  "speaker.scheduled": ["email"],
  "speaker.task_assigned": ["email"],
  "speaker.task_reminder": ["email"],
  "speaker.calendar_invite": ["email"],
  "decision.recorded": ["email"],
  "proposal.submitted": ["email"],
  "cfp.deadline_approaching": ["email"],
  "cfp.call_closed": ["email"],
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
export const communicationsHistoryParamsSchema = cursorPageParams({ max: 50, default: 25 }).extend({
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
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
  /**
   * Who to send to. Omitted means every reachable speaker on the event.
   *
   * An id the event no longer has a speaker for, or one with no address, is a `400` and nothing
   * is sent — an organizer ticked a person, and quietly reaching fewer people than were ticked
   * is the failure this surface already refuses to make.
   */
  recipientIds: z.array(z.string().min(1)).min(1).max(500).optional(),
});

/**
 * What each chosen recipient would receive, rendered by the same call the send uses.
 *
 * A separate request rather than a field on the recipients read, because it needs the template
 * and the selection — and because a preview that renders client-side could disagree with the
 * message that is actually stored on the delivery, which is worse than no preview since it is
 * believed (#189).
 */
export const previewBroadcastInputSchema = broadcastInputSchema.pick({
  organizationId: true,
  eventId: true,
  templateKey: true,
  templateVersion: true,
  /**
   * Picked because rendering without it is the same preview/send disagreement in the other
   * direction: a template with a `payload` placeholder previewed as `400 ... has no value`,
   * telling the author their template cannot be sent, while the identical send with the same
   * payload went out fine. Anything the send renders against, the preview renders against.
   */
  payload: true,
  recipientIds: true,
});
export type PreviewBroadcastInput = z.infer<typeof previewBroadcastInputSchema>;

export const broadcastPreviewEntrySchema = z.object({
  userId: z.string(),
  name: z.string(),
  address: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
});
export const broadcastPreviewResponseSchema = z.object({
  entries: z.array(broadcastPreviewEntrySchema),
  /** The same change detector the recipients read returns, so a preview can be confirmed. */
  audienceVersion: z.string(),
});
export type BroadcastPreviewEntryDto = z.infer<typeof broadcastPreviewEntrySchema>;

/**
 * The merge-field vocabulary a speaker template may use.
 *
 * Published on the wire so the console prints the same list the server resolves, rather than
 * hard-coding a copy that drifts. The renderer refuses a placeholder with no value — a half
 * sentence reaching a speaker is worse than a refused send — so an author who cannot see this
 * list writes a template that cannot be sent.
 */
export const speakerMergeFieldSchema = z.object({
  token: z.string(),
  describes: z.string(),
});
export const speakerMergeFieldsResponseSchema = z.object({
  fields: z.array(speakerMergeFieldSchema),
});
export type SpeakerMergeFieldDto = z.infer<typeof speakerMergeFieldSchema>;
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
export const communicationsHistoryResponseSchema = cursorPage(
  z.object({ delivery: deliverySchema, attempts: z.array(deliveryAttemptSchema) }),
  "history",
);
export type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;
export type MessageTemplateDto = z.infer<typeof messageTemplateSchema>;
export type BroadcastInput = z.infer<typeof broadcastInputSchema>;
export type BroadcastRecipientDto = z.infer<typeof broadcastRecipientSchema>;
export type BroadcastResultDto = z.infer<typeof broadcastResponseSchema>;
export type TriggerDeliveryInput = z.infer<typeof triggerDeliveryInputSchema>;
export type DeliveryDto = z.infer<typeof deliverySchema>;
export type CommunicationsHistoryDto = z.infer<typeof communicationsHistoryResponseSchema>;

/**
 * The inbound Accelevents registration sync (`PRD-INT-001`, brief feature 7).
 *
 * `disposition` is a prediction in a dry run and an outcome in an apply, and the two use the same
 * words on purpose: an organizer who previewed three creates should recognise the three creates
 * they get.
 */
export const accelEventsSyncRowSchema = z.object({
  sourceRef: z.string(),
  name: z.string(),
  email: z.string(),
  disposition: z.enum(["create", "skip", "invalid"]),
  errors: z.array(z.string()),
});
export const accelEventsSyncReportSchema = z.object({
  preview: z.boolean(),
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  rows: z.array(accelEventsSyncRowSchema),
});
export const accelEventsSyncRunSchema = z.object({
  eventId: z.string().uuid(),
  startedAt: z.string(),
  completedAt: z.string(),
  outcome: z.enum(["succeeded", "failed"]),
  total: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
});
/** The organizer surface's whole state: what the integration is, and what it last did. */
export const accelEventsIntegrationSchema = z.object({
  /** `fixture` answers from an in-repository roster; `live` reads the real platform. */
  mode: z.enum(["fixture", "live"]),
  direction: z.literal("inbound"),
  lastRun: accelEventsSyncRunSchema.nullable(),
});
export const accelEventsSyncInputSchema = z.object({ commit: z.boolean() });
export type AccelEventsSyncReportDto = z.infer<typeof accelEventsSyncReportSchema>;
export type AccelEventsIntegrationDto = z.infer<typeof accelEventsIntegrationSchema>;

// Versioned outbound webhook contracts. Payloads intentionally carry identifiers and the fact,
// never speaker, proposal, reviewer, or CFP content.
export const webhookEventTypeSchema = z.enum(["schedule.published"]);
export const webhookIdempotencyHeaderSchema = z.object({
  "idempotency-key": z.string().trim().min(1).max(200),
});
export const webhookPayloadSchema = z.object({
  id: z.string(),
  type: webhookEventTypeSchema,
  version: z.literal(1),
  occurredAt: z.string().datetime(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid(),
  data: z.record(z.unknown()),
});
export const schedulePublishedWebhookPayloadSchema = webhookPayloadSchema.extend({
  type: z.literal("schedule.published"),
  data: z.object({ publicationVersion: z.number().int().positive() }),
});
export const organizationWebhookParamsSchema = z.object({ organizationId: z.string().uuid() });
export const webhookParamsSchema = organizationWebhookParamsSchema.extend({
  subscriptionId: z.string().min(1),
});
export const webhookDeliveryParamsSchema = organizationWebhookParamsSchema.extend({
  deliveryId: z.string().min(1),
});
export const createWebhookInputSchema = z.object({
  eventId: z.string().uuid().nullable().optional(),
  url: z.string().url().max(2_000),
  eventTypes: z
    .array(webhookEventTypeSchema)
    .min(1)
    .max(10)
    .refine((values) => new Set(values).size === values.length, "Event types must be unique"),
});
export const updateWebhookInputSchema = z
  .object({
    eventId: z.string().uuid().nullable().optional(),
    url: z.string().url().max(2_000).optional(),
    eventTypes: z
      .array(webhookEventTypeSchema)
      .min(1)
      .max(10)
      .refine((values) => new Set(values).size === values.length, "Event types must be unique")
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const webhookSubscriptionSchema = z.object({
  id: z.string(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  url: z.string().url(),
  eventTypes: z.array(webhookEventTypeSchema),
  state: z.enum(["active", "disabled"]),
  createdAt: z.string().datetime(),
  disabledAt: z.string().datetime().nullable(),
  disabledReason: z.string().nullable(),
});
export const createWebhookResponseSchema = z.object({
  subscription: webhookSubscriptionSchema,
  secret: z.string().min(32),
});
export const webhooksResponseSchema = z.object({
  subscriptions: z.array(webhookSubscriptionSchema),
});
export const webhookResponseSchema = z.object({ subscription: webhookSubscriptionSchema });
export const rotateWebhookResponseSchema = z.object({
  secret: z.string().min(32),
  overlapExpiresAt: z.string().datetime(),
});
export const webhookDeliverySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  organizationId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  eventRecordId: z.string(),
  eventType: webhookEventTypeSchema,
  idempotencyKey: z.string(),
  payload: webhookPayloadSchema,
  state: z.enum(["queued", "retrying", "succeeded", "terminal"]),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime(),
  leaseToken: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const webhookDeliveryAttemptSchema = z.object({
  id: z.string(),
  deliveryId: z.string(),
  sequence: z.number().int().positive(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  outcome: z.enum(["succeeded", "retryable_failure", "terminal_failure"]),
  errorCode: z.string().nullable(),
  requestedBy: z.string().nullable(),
});
export const webhookHistoryParamsSchema = webhookParamsSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(500).optional(),
});
export const webhookHistoryResponseSchema = z.object({
  history: z.array(
    z.object({ delivery: webhookDeliverySchema, attempts: z.array(webhookDeliveryAttemptSchema) }),
  ),
  nextCursor: z.string().nullable(),
});
export const webhookDeliveryResponseSchema = z.object({ delivery: webhookDeliverySchema });
