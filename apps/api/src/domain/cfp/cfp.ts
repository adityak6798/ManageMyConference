export type CfpFieldType = "short_text" | "long_text" | "email" | "select";
export interface CfpCondition {
  readonly fieldId: string;
  readonly operator: "equals" | "in" | "notEmpty";
  readonly values: readonly string[];
}
export interface CfpField {
  readonly id: string;
  readonly type: CfpFieldType;
  readonly label: string;
  readonly guidance: string;
  readonly required: boolean;
  readonly options: readonly string[];
  /**
   * The longest answer this field accepts. Optional because forms published before limits
   * existed carry no value; `cfpFieldMaxLength` supplies the type default for those.
   */
  readonly maxLength?: number | undefined;
  readonly visibleWhen?: CfpCondition | undefined;
}
export interface CfpRoutingRule {
  readonly id: string;
  readonly when: CfpCondition;
  readonly routeTo: { readonly status: string };
}
export interface CfpResolvedRoute {
  readonly ruleId: string;
  readonly status: string;
}
/**
 * Default answer ceilings per field type.
 *
 * `packages/contracts/src/index.ts` repeats these numbers for the form builder because the
 * application layer may not import that package. The two must stay in agreement.
 */
export const CFP_FIELD_MAX_LENGTHS: Readonly<Record<CfpFieldType, number>> = {
  short_text: 200,
  long_text: 5_000,
  // RFC 5321 section 4.5.3.1.3 caps a forward path at 256 octets including the angle brackets.
  email: 254,
  select: 120,
};
/**
 * One rule for "how long may this answer be", read by the validator and advertised by the form.
 */
export const cfpFieldMaxLength = (field: Pick<CfpField, "type" | "maxLength">): number =>
  field.maxLength ?? CFP_FIELD_MAX_LENGTHS[field.type];
export interface CfpForm {
  readonly eventId: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly CfpField[];
  readonly routing?: readonly CfpRoutingRule[] | undefined;
  readonly status: "draft" | "open" | "closed";
  readonly version: number;
  readonly publishedAt: string | null;
  readonly publishedStatus: "open" | "closed" | null;
}
export interface ProposalSubmission {
  readonly id: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly idempotencyKey: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly fields: readonly CfpField[];
  readonly resolvedRoute?: CfpResolvedRoute | null | undefined;
  readonly submittedAt: string;
}
