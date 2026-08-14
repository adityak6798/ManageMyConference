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
/**
 * The scheduled half of "may a proposal be submitted right now".
 *
 * Two UTC instants, either of which may be absent — an unbounded call is the state every CFP
 * shipped in before this existed, and it stays the default. Both are live state rather than form
 * content: see `apps/api/migrations/1201_cfp_submission_window_and_account_binding.sql` for why
 * extending a deadline must not republish a form.
 */
export interface CfpSubmissionWindow {
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}
export interface CfpForm extends CfpSubmissionWindow {
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
/**
 * Whether a call is taking submissions, and why not when it is not.
 *
 * `scheduled` is a distinct answer rather than a flavour of `closed` because the two say opposite
 * things to an applicant: one is "come back on the 3rd", the other is "you have missed it".
 */
export type CfpEffectiveState = "unpublished" | "scheduled" | "open" | "closed";

/**
 * The precedence between the schedule and the organizer's own close/reopen control, in one place.
 *
 * **Both gates must permit.** The schedule cannot open a call an organizer has closed, and the
 * organizer's Reopen cannot open one whose deadline has passed — to take submissions again after a
 * deadline, the deadline has to move, which is the only act that changes what applicants were
 * told. `CfpService.changeState` refuses a reopen that would have no effect rather than answering
 * 200 to a request that changed nothing.
 *
 * A closed deadline outranks a future opening: a window whose two ends have both gone by reads as
 * `closed`, never as "about to open".
 *
 * Publishing decides what the form asks and never what state the call is in — that rule predates
 * the window (`PRD-CFP-001`) and the window does not weaken it: publishing a form whose event has
 * a future `opensAt` leaves the call `scheduled`.
 */
export function cfpEffectiveState(
  live: {
    readonly status: CfpForm["status"];
  } & CfpSubmissionWindow,
  now: Date,
): CfpEffectiveState {
  if (live.status === "draft") return "unpublished";
  if (live.status === "closed") return "closed";
  const at = now.getTime();
  if (live.closesAt && Date.parse(live.closesAt) <= at) return "closed";
  if (live.opensAt && at < Date.parse(live.opensAt)) return "scheduled";
  return "open";
}

/** Where a proposal is in the submitter's own lifecycle, as opposed to the organizer's triage. */
export type ProposalLifecycle = "draft" | "submitted";

/**
 * The `status` a draft row carries, which no event may configure as a triage destination.
 *
 * Defence in depth rather than a second lifecycle marker: `lifecycle` is what every reader
 * filters on, and this is what keeps a draft out of a status-keyed triage read that forgot to.
 */
export const CFP_DRAFT_STATUS = "draft";

export interface ProposalSubmission {
  readonly id: string;
  readonly eventId: string;
  readonly cfpVersion: number;
  readonly idempotencyKey: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly fields: readonly CfpField[];
  readonly resolvedRoute?: CfpResolvedRoute | null | undefined;
  readonly submittedAt: string;
  /** The account this proposal belongs to, or `null` for an anonymous submission. */
  readonly submitterUserId?: string | null | undefined;
  readonly lifecycle?: ProposalLifecycle | undefined;
  /** Optimistic-concurrency token: every write names the revision it read. */
  readonly revision?: number | undefined;
  readonly updatedAt?: string | undefined;
  /** The organizer's triage status, which the submitter view narrows before showing. */
  readonly status?: string | undefined;
}

/**
 * The proposal's own name, for the one message its submitter reads back.
 *
 * Deliberately narrower than the organizer projection's title rule in
 * `d1-submitted-proposal-adapter.ts`, which also masks person-name fields and falls back through
 * a stored snapshot. This one answers a different question — what to call the thing in a
 * confirmation addressed to the person who wrote it — and answering it here keeps the CFP domain
 * from depending on a projection built for organizers.
 */
export function proposalTitleOf(
  fields: readonly CfpField[],
  answers: Readonly<Record<string, string>>,
): string | null {
  const titled = answers.title?.trim();
  if (titled) return titled;
  for (const field of fields) {
    if (field.type !== "short_text") continue;
    const value = answers[field.id]?.trim();
    if (value) return value;
  }
  return null;
}
