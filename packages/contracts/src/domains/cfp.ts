import { z } from "zod";

// @spec PRD-CFP-001 PRD-CFP-002
export const cfpFieldTypeSchema = z.enum(["short_text", "long_text", "email", "select"]);
/**
 * The longest answer each field type accepts when the organizer states no explicit limit.
 *
 * The CFP domain repeats these numbers in `apps/api/src/domain/cfp/cfp.ts` because the
 * application layer may not import this package; the two must stay in agreement. The
 * authoritative value for any published form is the `maxLength` persisted on its fields,
 * which is what both the form builder and `validateAnswers` read.
 */
export const CFP_FIELD_MAX_LENGTHS = {
  short_text: 200,
  long_text: 5_000,
  // RFC 5321 section 4.5.3.1.3 caps a forward path at 256 octets including the angle brackets.
  email: 254,
  select: 120,
} as const satisfies Record<z.infer<typeof cfpFieldTypeSchema>, number>;
/** The longest answer any single field may accept, and the cap on an explicit `maxLength`. */
export const CFP_ANSWER_MAX_LENGTH = 10_000;
/** Answers are keyed by field id, so a submission can never carry more keys than a form has. */
export const CFP_ANSWER_MAX_FIELDS = 40;
export const cfpConditionSchema = z.object({
  fieldId: z.string().min(1).max(80),
  operator: z.enum(["equals", "in", "notEmpty"]),
  values: z.array(z.string().max(120)).max(30).default([]),
});
export const cfpChoiceSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
});
export type CfpCondition = z.infer<typeof cfpConditionSchema>;
export const cfpConditionMatches = (
  condition: CfpCondition | undefined,
  answers: Readonly<Record<string, string>>,
) => {
  if (!condition) return true;
  const value = answers[condition.fieldId]?.trim() ?? "";
  if (condition.operator === "notEmpty") return Boolean(value);
  if (condition.operator === "equals") return value === (condition.values[0] ?? "");
  return condition.values.includes(value);
};
export const cfpFieldSchema = z.object({
  id: z.string().min(1).max(80),
  type: cfpFieldTypeSchema,
  label: z.string().trim().min(1).max(120),
  guidance: z.string().trim().max(500).default(""),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  /** Stable values for reserved `track` and `format` selectors; labels may change independently. */
  choices: z.array(cfpChoiceSchema).max(30).optional(),
  /**
   * The longest answer this field accepts. Optional so forms saved before limits existed
   * still parse; `cfpFieldMaxLength` supplies the type default for those.
   */
  maxLength: z.number().int().min(1).max(CFP_ANSWER_MAX_LENGTH).optional(),
  visibleWhen: cfpConditionSchema.optional(),
});
export const cfpRoutingRuleSchema = z.object({
  id: z.string().min(1).max(80),
  when: cfpConditionSchema,
  routeTo: z.object({ status: z.string().trim().min(1).max(80) }),
});
/** The limit the form builder must advertise and the validator must enforce, for one field. */
export const cfpFieldMaxLength = (field: {
  type: z.infer<typeof cfpFieldTypeSchema>;
  maxLength?: number | undefined;
}): number => field.maxLength ?? CFP_FIELD_MAX_LENGTHS[field.type];
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
      if (field.type === "select" && field.options.length === 0 && !field.choices?.length)
        context.addIssue({
          code: "custom",
          path: [index, "options"],
          message: "Select fields need at least one option",
        });
      if (field.visibleWhen) {
        const sourceIndex = fields.findIndex(({ id }) => id === field.visibleWhen?.fieldId);
        if (sourceIndex < 0 || sourceIndex >= index)
          context.addIssue({
            code: "custom",
            path: [index, "visibleWhen", "fieldId"],
            message: "A condition must reference an earlier question",
          });
      }
    });
  });
const saveCfpBaseSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  fields: cfpFieldsSchema,
  routing: z.array(cfpRoutingRuleSchema).max(20).default([]),
  expectedVersion: z.number().int().nonnegative(),
});
export const saveCfpInputSchema = saveCfpBaseSchema.superRefine((form, context) => {
  const ids = new Set(form.fields.map(({ id }) => id));
  const ruleIds = new Set<string>();
  form.routing.forEach((rule, index) => {
    if (!ids.has(rule.when.fieldId))
      context.addIssue({
        code: "custom",
        path: ["routing", index, "when", "fieldId"],
        message: "A routing rule must reference a question in this form",
      });
    if (ruleIds.has(rule.id))
      context.addIssue({
        code: "custom",
        path: ["routing", index, "id"],
        message: "Routing rule IDs must be unique",
      });
    ruleIds.add(rule.id);
  });
});
/**
 * The state applicants are actually in, which only the server can answer.
 *
 * `scheduled` and `closed` are separate members because they are opposite messages — "come back
 * on the 3rd" against "you have missed it" — and a client that folded them together would have to
 * guess which. `unpublished` never reaches the public route, which 404s instead; it exists for the
 * organizer's composer, where a draft that has never been published is a real state to show.
 */
export const cfpEffectiveStatusSchema = z.enum(["unpublished", "scheduled", "open", "closed"]);
/**
 * The scheduled submission window: two UTC instants, either of which may be absent.
 *
 * Absent means unbounded in that direction, which is the state every call shipped in before this
 * existed. Instants rather than wall-clock times in the event's zone, so a deadline that has been
 * announced cannot move because somebody corrected the event's timezone afterwards; both surfaces
 * render and collect them *in* that zone.
 */
export const cfpWindowSchema = z.object({
  opensAt: z.string().datetime().nullable(),
  closesAt: z.string().datetime().nullable(),
});
export const cfpWindowInputSchema = cfpWindowSchema.superRefine((window, context) => {
  if (
    window.opensAt &&
    window.closesAt &&
    Date.parse(window.closesAt) <= Date.parse(window.opensAt)
  )
    context.addIssue({
      code: "custom",
      path: ["closesAt"],
      message: "The call has to close after it opens",
    });
});
export const cfpFormSchema = saveCfpBaseSchema
  .omit({ expectedVersion: true })
  .merge(cfpWindowSchema)
  .extend({
    eventId: z.string().uuid(),
    status: cfpStatusSchema,
    version: z.number().int().positive(),
    publishedAt: z.string().datetime().nullable(),
    publishedStatus: z.enum(["open", "closed"]).nullable(),
    /**
     * Carried by every CFP response, organizer and public alike.
     *
     * Required rather than derived in the browser: deriving it there would put a visitor's own
     * clock in charge of whether a deadline has passed, so a skewed laptop would render an open
     * form over a call the server refuses and the applicant would find out by losing a
     * submission.
     */
    effectiveStatus: cfpEffectiveStatusSchema,
  });
export const cfpResponseSchema = z.object({ cfp: cfpFormSchema });
export const cfpRoutingStatusesResponseSchema = z.object({
  statuses: z.array(z.object({ key: z.string(), label: z.string() })),
});
export const cfpStateInputSchema = z.object({ state: z.enum(["publish", "close", "reopen"]) });
/**
 * The only unauthenticated write in the API, so its body is bounded before it reaches a domain.
 *
 * A key is a field id (`cfpFieldSchema.id`), a value is one answer, and a submission can carry
 * no more keys than a form has fields (`cfpFieldsSchema.max(40)`). The per-value ceiling here is
 * the absolute maximum any field may declare; `validateAnswers` then enforces the narrower,
 * per-field `maxLength` the published form advertises.
 */
export const proposalParticipantRoleSchema = z.enum(["co_speaker", "moderator"]);
export const proposalParticipantStateSchema = z.enum(["pending", "accepted", "declined"]);
export const proposalParticipantInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  role: proposalParticipantRoleSchema,
});
export const proposalParticipantSchema = proposalParticipantInputSchema.extend({
  state: proposalParticipantStateSchema,
});
export const submitProposalInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  answers: z
    .record(z.string().min(1).max(80), z.string().max(CFP_ANSWER_MAX_LENGTH))
    .refine((answers) => Object.keys(answers).length <= CFP_ANSWER_MAX_FIELDS, {
      message: `A proposal carries at most ${CFP_ANSWER_MAX_FIELDS} answers`,
    }),
  participants: z.array(proposalParticipantInputSchema).max(8).default([]),
});
export const proposalConfirmationSchema = z.object({
  confirmationId: z.string().uuid(),
  submittedAt: z.string().datetime(),
});
export const proposalConfirmationResponseSchema = z.object({
  submission: proposalConfirmationSchema,
});

/**
 * The account-bound half of the applicant surface.
 *
 * These routes take a session, which is what separates them from the anonymous submission above:
 * a proposal they write has an owner, so it can be listed, resumed, revised, and told its
 * decision. They deliberately live under `/api/events/...` rather than under `/api/public/...` —
 * that namespace is anonymous by construction, answers `Access-Control-Allow-Origin: *`, and is
 * cacheable, none of which may be true of one person's proposals.
 */
export const cfpProposalParamsSchema = z.object({
  eventId: z.string().uuid(),
  proposalId: z.string().uuid(),
});
export const cfpParticipantParamsSchema = cfpProposalParamsSchema.extend({
  participantId: z.string().uuid(),
});
export const respondProposalParticipantInputSchema = z.object({
  state: z.enum(["accepted", "declined"]),
  expectedRevision: z.number().int().positive(),
});
export const proposalParticipantResponseSchema = z.object({
  participant: z.object({ id: z.string().uuid(), state: proposalParticipantStateSchema }),
  revision: z.number().int().positive(),
});
/**
 * What a submitter is told about their own proposal.
 *
 * `state` is deliberately not the organizer's triage status. Triage keys are organizer vocabulary
 * — an event may configure "shortlist_maybe" — and forwarding them would publish the inside of a
 * review process. Only the two decisions that are communicated anyway pass through.
 */
export const submitterProposalStateSchema = z.enum([
  "draft",
  "under_consideration",
  "accepted",
  "declined",
]);
export const submitterProposalSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  lifecycle: z.enum(["draft", "submitted"]),
  state: submitterProposalStateSchema,
  /** Null when nothing answered yet names the proposal. */
  title: z.string().nullable(),
  answers: z.record(z.string().min(1).max(80), z.string().max(CFP_ANSWER_MAX_LENGTH)),
  participants: z.array(proposalParticipantSchema).optional(),
  /** The optimistic-concurrency token every write has to name back. */
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  /** Null while it is a draft: nothing has been submitted, so nothing is confirmed. */
  submittedAt: z.string().datetime().nullable(),
});
export const submitterProposalsResponseSchema = z.object({
  proposals: z.array(submitterProposalSchema),
});
export const submitterProposalResponseSchema = z.object({ proposal: submitterProposalSchema });
/**
 * Answers, bounded exactly as the anonymous submission's are — same ceilings, same field count.
 *
 * A draft is held to the same *shape* as a submission and not to its completeness, so this schema
 * is shared by all three writes and the required-field rule lives in the service, which is the
 * only place that knows whether this call is a save or a submit.
 */
const proposalAnswersSchema = z
  .record(z.string().min(1).max(80), z.string().max(CFP_ANSWER_MAX_LENGTH))
  .refine((answers) => Object.keys(answers).length <= CFP_ANSWER_MAX_FIELDS, {
    message: `A proposal carries at most ${CFP_ANSWER_MAX_FIELDS} answers`,
  });
export const createProposalDraftInputSchema = z.object({
  /**
   * The CFP command's existing deterministic key, reused rather than joined by a second one: a
   * retried create converges on the draft the first attempt made instead of leaving two
   * half-written proposals on the dashboard.
   */
  idempotencyKey: z.string().trim().min(8).max(120),
  answers: proposalAnswersSchema,
  participants: z.array(proposalParticipantInputSchema).max(8).default([]),
});
export const saveProposalInputSchema = z.object({
  answers: proposalAnswersSchema,
  participants: z.array(proposalParticipantInputSchema).max(8).default([]),
  expectedRevision: z.number().int().positive(),
});
export type CfpField = z.infer<typeof cfpFieldSchema>;
export type CfpChoice = z.infer<typeof cfpChoiceSchema>;
export type ProposalParticipant = z.infer<typeof proposalParticipantSchema>;
export type ProposalParticipantInput = z.infer<typeof proposalParticipantInputSchema>;
export type CfpRoutingRule = z.infer<typeof cfpRoutingRuleSchema>;
export type CfpFormDto = z.infer<typeof cfpFormSchema>;
export type CfpEffectiveStatus = z.infer<typeof cfpEffectiveStatusSchema>;
export type CfpWindowInput = z.infer<typeof cfpWindowSchema>;
export type SaveCfpInput = z.infer<typeof saveCfpInputSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalInputSchema>;
export type SubmitterProposalDto = z.infer<typeof submitterProposalSchema>;
export type SubmitterProposalState = z.infer<typeof submitterProposalStateSchema>;
