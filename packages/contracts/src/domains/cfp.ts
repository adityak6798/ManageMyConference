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
      if (field.type === "select" && field.options.length === 0)
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
export const cfpFormSchema = saveCfpBaseSchema.omit({ expectedVersion: true }).extend({
  eventId: z.string().uuid(),
  status: cfpStatusSchema,
  version: z.number().int().positive(),
  publishedAt: z.string().datetime().nullable(),
  publishedStatus: z.enum(["open", "closed"]).nullable(),
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
export const submitProposalInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  answers: z
    .record(z.string().min(1).max(80), z.string().max(CFP_ANSWER_MAX_LENGTH))
    .refine((answers) => Object.keys(answers).length <= CFP_ANSWER_MAX_FIELDS, {
      message: `A proposal carries at most ${CFP_ANSWER_MAX_FIELDS} answers`,
    }),
});
export const proposalConfirmationSchema = z.object({
  confirmationId: z.string().uuid(),
  submittedAt: z.string().datetime(),
});
export const proposalConfirmationResponseSchema = z.object({
  submission: proposalConfirmationSchema,
});
export type CfpField = z.infer<typeof cfpFieldSchema>;
export type CfpRoutingRule = z.infer<typeof cfpRoutingRuleSchema>;
export type CfpFormDto = z.infer<typeof cfpFormSchema>;
export type SaveCfpInput = z.infer<typeof saveCfpInputSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalInputSchema>;
