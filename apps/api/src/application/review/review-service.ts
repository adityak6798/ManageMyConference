import {
  ACCEPTED_PROPOSAL_STATUS,
  type DecisionOutcome,
  type Evaluation,
  type EvaluationPlan,
  type EvaluationScore,
  type ProposalDecision,
  RESERVED_PROPOSAL_STATUSES,
  type ReviewAssignment,
  type ReviewCompletedEvent,
  type ReviewCriterion,
} from "../../domain/review/review";
import {
  roundAdmits,
  type ReviewRound,
  type ReviewRoundPoolMode,
  type ReviewRoundState,
  roundClosedReason,
  roundCriteria,
} from "../../domain/review/round";
import type {
  EvaluationSource,
  ReviewSuggestion,
  SuggestedScore,
} from "../../domain/review/suggestion";
import { proposalRevisionOf } from "../../domain/review/suggestion";
import type { ProposalStatus, ProposalStatusDefinition } from "../cfp/submitted-proposal-interface";
import {
  MASKED_SUBMITTER_NAME,
  ProposalStatusConfigurationError,
  type SubmittedProposal,
  type SubmittedProposalInterface,
} from "../cfp/submitted-proposal-interface";
import type { EventService } from "../events/event-service";
import { type Actor, CapabilityDeniedError, requireEventCapability } from "../identity/actor";
import type { IdentityDirectory } from "../identity/identity-directory";
import {
  type AcceptedProposal,
  type AcceptedProposalQuery,
  ProposalNotAcceptedError,
  ProposalNotFoundError,
  ProposalSubmitterUnavailableError,
} from "./public";
import { type ReviewRepository, ReviewStateConflictError } from "./review-repository";
import type { ReviewSuggestionPort } from "./suggestion-port";
import { SuggestionUnavailableError } from "./suggestion-port";

export class ReviewValidationError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("Review data is invalid");
  }
}

export class ReviewConflictError extends Error {}
export class ReviewNotFoundError extends Error {}

/**
 * The suggestion port is switched off in this deployment.
 *
 * Distinct from a provider failure, because the two are different facts about the world and a
 * reviewer acts on them differently: a failure is worth pressing again, an absent assistant is
 * not. It is also the state that proves the acceptance criterion "the full review journey passes
 * with the port disabled" — the queue offers no Draft control at all, and a request that arrives
 * anyway is refused rather than quietly answered.
 */
export class SuggestionsDisabledError extends Error {}

/**
 * How review asks for somebody to be told the outcome of a review action.
 *
 * Declared here and bound in the composition root, so this domain imports nothing of whoever
 * delivers the message. Review states what happened; the template, trigger and deduplication
 * belong to the delivering domain.
 *
 * **Implementations must not throw.** Both facts are reported after the change is durable, and a
 * decision that has already transitioned a proposal's status must not report failure because a
 * message could not be queued. See the binding in `apps/api/src/index.ts`.
 *
 * @spec PRD-REV-001 PRD-COM-001 ARC-DOM-001
 */
/**
 * What became of one reviewer's reminder.
 *
 * - `queued`: a delivery was written and the outbox will send it.
 * - `already_sent`: this reviewer had already been reminded about this round, so nothing new was
 *   written. Not a failure — it is the idempotency working, and the organizer needs to see the
 *   difference or they will press again.
 * - `unaddressable`: the reviewer has no linked email. A real state and one this domain reports
 *   rather than hides, because the organizer's repair is to fix the address, and a silent skip
 *   would leave them believing somebody was told.
 *
 * Review states the outcome; it does not carry a delivery id, a template or a channel, because
 * none of those is review's to know.
 */
export type ReviewReminderResult = "queued" | "already_sent" | "unaddressable";

export interface ReviewNotificationPort {
  /**
   * A reviewer was given abstracts to evaluate in this round.
   *
   * Reported once per reviewer per round however many passes the organizer distributes in, so
   * the delivering domain can key on `(eventId, reviewerId, round)` and tell them once.
   */
  reviewerAssigned(fact: {
    readonly eventId: string;
    readonly reviewerId: string;
    readonly round: number;
    readonly assignmentIds: readonly string[];
    readonly proposalCount: number;
  }): Promise<void>;
  /**
   * A reviewer still has outstanding work in a round, and an organizer asked for them to be told.
   *
   * Unlike the other two, this one **answers**: the organizer pressed a button and has to be told
   * what happened to each person, so the delivering domain reports whether this reminder was
   * newly queued or had already been sent. That is the send state the console renders, and it is
   * why the return type is not `void`.
   *
   * Reported once per reviewer per round however many times the organizer presses. The
   * idempotency key is the delivering domain's to construct, but the fact carries everything that
   * key needs, so pressing twice queues one message rather than two.
   */
  remindOutstanding(fact: {
    readonly eventId: string;
    readonly reviewerId: string;
    readonly round: number;
    readonly roundName: string;
    readonly outstanding: number;
  }): Promise<ReviewReminderResult>;
  /**
   * A submitter's proposal was accepted or declined.
   *
   * `submitterEmail` is null when the published form collected no contact address — a real
   * state, and one this domain reports rather than guesses at.
   *
   * `submitterUserId` is the account that owns the proposal, or null for a guest submission. Both
   * are reported because this domain does not decide *which* to write to: that is a delivery
   * question, and the composition root answers it by preferring the address identity holds for
   * the owner over the one a form collected (issue #132).
   */
  decisionRecorded(fact: {
    readonly eventId: string;
    readonly proposalId: string;
    readonly outcome: DecisionOutcome;
    readonly submitterName: string;
    readonly submitterEmail: string | null;
    readonly submitterUserId: string | null;
    readonly proposalTitle: string;
    /**
     * How many times this proposal has been decided, storage-allocated.
     *
     * Reported because an observer cannot otherwise tell a retry from a reinstatement: every
     * other field, `decidedAt` included, moves on both. Re-deciding the same way holds this
     * value, so an observer keyed on it converges on a retry; accept → decline → accept
     * advances it, so the third decision is a third thing that happened. See migration 1311.
     */
    readonly revision: number;
  }): Promise<void>;
}

export interface ReviewServiceDependencies {
  repository: ReviewRepository;
  proposals: SubmittedProposalInterface;
  identities: Pick<IdentityDirectory, "isReviewerForEvent" | "listReviewersForEvent">;
  events: Pick<EventService, "get">;
  /** Tells reviewers and submitters what happened. Optional; review works unchanged without it. */
  notifications?: ReviewNotificationPort;
  /**
   * Drafts AI suggestions. Optional, and absent is a supported configuration rather than a
   * degraded one: with no port bound, the reviewer's queue offers no Draft control and every
   * other review behaviour is byte-for-byte what it was before this feature existed.
   */
  suggestions?: ReviewSuggestionPort;
  /** Ceiling on one provider call. Defaults to `SUGGESTION_TIMEOUT_MS`. */
  suggestionTimeoutMs?: number;
  newId: () => string;
  now: () => Date;
}

/**
 * Field ids and labels that name the session format. Formats are organizer vocabulary rather than
 * a CFP field type, so an unmatched proposal accepts the neutral default and the organizer edits
 * the session afterwards.
 */
const FORMAT_FIELD_IDS = ["format", "session_format", "session_type", "type"];
const FORMAT_LABEL = /\b(format|session type)\b/i;
const DEFAULT_SESSION_FORMAT = "Session";
const formatOf = (proposal: SubmittedProposal) =>
  proposal.answers.find(
    ({ fieldId, label }) =>
      FORMAT_FIELD_IDS.includes(fieldId.toLowerCase()) || FORMAT_LABEL.test(label),
  )?.value || DEFAULT_SESSION_FORMAT;

/**
 * Blind review is a projection concern, not a storage one: the same stored proposal is shown with
 * its submitter to organizers and without to reviewers. This is the mask.
 */
const withoutSubmitter = (proposal: SubmittedProposal): PublishedProposal => ({
  // The owning account goes with the name and the address, and is *dropped* rather than nulled:
  // it is a stable identifier for one person across every event, so a blind queue that kept it
  // would let a reviewer join two masked proposals to the same applicant — and a key set to null
  // is still a key `proposalSchema` does not declare, on a response nothing parses.
  ...withoutOwner(proposal),
  submitterName: MASKED_SUBMITTER_NAME,
  submitter: null,
});

/**
 * A proposal without its owning account id.
 *
 * `submitterUserId` is internal: it exists so a decision message can be addressed to the account
 * rather than to a form answer, and no organizer surface needs it. It is dropped on the way out of
 * **every** read that answers a request, because these responses are serialized without a schema
 * parse that would strip an undeclared field, and `proposalSchema` in the contracts package does
 * not declare it. A stable identifier for one person across every event is not something to put on
 * the wire by accident.
 *
 * Applied at each return rather than inside the adapter, because `decide` needs the id to address
 * its notification and only then stops needing it.
 */
export type PublishedProposal = Omit<SubmittedProposal, "submitterUserId">;

const withoutOwner = ({
  submitterUserId: _owner,
  ...proposal
}: SubmittedProposal): PublishedProposal => proposal;

/** The organizer's proposal: authorship parsed out of its answers, and no owner id. */
const withCoAuthors = (submitted: SubmittedProposal) => {
  const proposal = withoutOwner(submitted);
  const answer = proposal.answers.find(({ fieldId }) => fieldId === "coauthors")?.value;
  if (!answer) return { ...proposal, coAuthors: [] };
  try {
    const parsed: unknown = JSON.parse(answer);
    if (!Array.isArray(parsed)) return { ...proposal, coAuthors: [] };
    return {
      ...proposal,
      coAuthors: parsed.flatMap((item) =>
        item && typeof item === "object" && "name" in item && "role" in item
          ? [{ name: String(item.name), role: String(item.role) }]
          : [],
      ),
    };
  } catch {
    // ERROR-INTENT: malformed optional authorship is shown as absent; the proposal remains readable.
    return { ...proposal, coAuthors: [] };
  }
};

/**
 * The reviewer's proposal in a round that is **not** anonymized.
 *
 * Open review is a real setting — a programme committee reading each other's names is how many
 * second rounds actually run — but it is not the organizer's projection. The author's *name* and
 * the co-author roles are shown, because that is what "not blind" means; the contact address is
 * not, because it is organizer-only in every round and no reviewer surface has ever needed it.
 * The owning account id goes too, for the same reason `withoutSubmitter` drops it: it is a stable
 * identifier for one person across every event, and open authorship on one round is not consent
 * to be joined across all of them.
 */
const withOpenAuthorship = (proposal: SubmittedProposal) => ({
  ...withCoAuthors(proposal),
  submitter: null,
});

/**
 * The reviewer's proposal in a blind round: no name, no address, no account, **no co-authors**.
 *
 * Co-authors are absent rather than masked, because a masked list still leaks its length — "three
 * co-authors, one of them a professor" is enough to identify a submission in a small field — and
 * because `withoutSubmitter` never added the key in the first place. This wrapper exists so that
 * the choice is visible at the call site beside its open-review sibling rather than being a
 * property of which helper somebody happened to reach for.
 */
const blindProjection = (proposal: SubmittedProposal) => ({
  ...withoutSubmitter(proposal),
  coAuthors: [] as readonly { name: string; role: string }[],
});

/**
 * Why an assignment cannot be removed once it has been scored. Named here so the service and
 * the storage race path answer with the same sentence.
 */
const ASSIGNMENT_EVALUATED_REFUSAL =
  "This reviewer has already completed their evaluation, and that score is counted in the abstract's aggregate. Remove is only offered before an evaluation is completed.";

/**
 * The criteria a set of values does not usably answer.
 *
 * One definition, two callers — a reviewer saving their own scores and a reviewer accepting a
 * drafted set — because "in range for this criterion" must mean exactly the same thing on both
 * paths. If it did not, a suggestion could be accepted carrying a value the reviewer's own save
 * would have refused, and the difference would surface as an unexplained failure one step later.
 */
const criteriaWithoutUsableValue = (
  criteria: readonly ReviewCriterion[],
  values: ReadonlyMap<string, number | string | undefined>,
): readonly ReviewCriterion[] =>
  criteria.filter((criterion) => {
    const value = values.get(criterion.id);
    if (value === undefined) return true;
    if (!criterion.type || criterion.type === "numeric")
      return typeof value !== "number" || value < criterion.minScore || value > criterion.maxScore;
    if (criterion.type === "dropdown")
      return typeof value !== "string" || !criterion.options.includes(value);
    if (criterion.type === "text")
      return typeof value !== "string" || !value.trim() || value.length > criterion.maxLength;
    return true;
  });

/**
 * A promise, or a `PROVIDER_TIMEOUT` once the deadline passes.
 *
 * The port's contract says implementations honour `timeoutMs` themselves, and the live adapter
 * does — this is the backstop for the one that does not, so a provider that hangs cannot hold a
 * reviewer's request open indefinitely. It does not *cancel* the underlying call, which is why it
 * is a backstop rather than the mechanism: the same relationship the outbox's lease has with its
 * per-call ceiling.
 */
const withDeadline = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SuggestionUnavailableError("PROVIDER_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * How long a reviewer waits before the assistant is declared unavailable.
 *
 * Longer than the outbox's ten seconds, deliberately: that ceiling protects a scheduled drain
 * working through a hundred deliveries, while this one is a person who pressed a button and is
 * watching a spinner. Twenty seconds is long enough for a model to draft against a rubric and
 * short enough that giving up and scoring by hand is still the faster path.
 */
const SUGGESTION_TIMEOUT_MS = 20_000;

/**
 * The given statuses with every missing reserved decision status appended.
 *
 * Completion, never rejection: an organizer may relabel or reorder `accepted`/`declined` — a
 * definition they supply for one of those keys wins — but cannot delete the decision vocabulary
 * the content domain acts on, so a missing key comes back with its default label. Migration 0021
 * backfilled every event that existed then, and the CFP's own insert trigger seeds only
 * `submitted` for an event created afterwards; both arrive here and leave complete.
 */
const withReservedStatuses = (
  statuses: readonly ProposalStatusDefinition[],
): readonly ProposalStatusDefinition[] => {
  const keys = new Set(statuses.map(({ key }) => key));
  return [...statuses, ...RESERVED_PROPOSAL_STATUSES.filter(({ key }) => !keys.has(key))];
};

// @spec PRD-ABS-001 PRD-REV-001
export class ReviewService implements AcceptedProposalQuery {
  constructor(private readonly dependencies: ReviewServiceDependencies) {}

  private organizer(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "review:manage");
  }

  private reviewer(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "review:evaluate");
  }

  /**
   * The event's configured statuses, persisting the reserved decision statuses first if storage
   * is missing them.
   *
   * Storage is the single source of truth. The organizer projection used to synthesize the
   * reserved keys on the way out while `transitionAtomically` validated against what was
   * actually stored, so the board advertised `accepted`/`declined` and the very next transition
   * to one of them answered 400. Everything that reads or advertises a status set goes through
   * here, so what is shown is what is stored.
   */
  private async storedStatuses(eventId: string): Promise<readonly ProposalStatusDefinition[]> {
    const statuses = await this.dependencies.proposals.listStatuses(eventId);
    const completed = withReservedStatuses(statuses);
    // Additive only — no configured key is ever removed here — so the CFP's in-use guard on
    // `saveStatuses` cannot fire from this call.
    if (completed.length !== statuses.length)
      await this.dependencies.proposals.saveStatuses(eventId, completed);
    return completed;
  }

  /**
   * Two different questions about the same event, answered separately.
   *
   * `directory` is every reviewer of the event — the name an *existing* assignment is resolved
   * through. `assignable` is who this organizer may hand a new abstract to: the directory minus
   * themselves. The seeded organizer also holds the reviewer role, so triage offered "Olivia
   * Organizer" as the first assignable reviewer — and assigning to her produced work nobody
   * could ever do, because the organizer console has no reviewer queue. Withholding her is
   * right; answering "who is already assigned?" out of that same shortened list was not, and it
   * printed a raw user id in the Reviewers column for every assignment the viewer could not
   * have made herself.
   */
  /**
   * The round an event falls back to when nobody has configured one.
   *
   * An event that has never had a round behaves exactly as it did before rounds existed: the
   * first assignment creates `Round 1`, open, blind, scoring against the event plan, admitting
   * every reviewer staffed on the event. That is not a convenience — it is the compatibility
   * contract. Migration `1312` installs a trigger that refuses an assignment naming a round that
   * does not exist, so without this every existing caller (the template slice, the seeded demo,
   * every test that assigns before configuring anything) would start failing on a rule about a
   * concept it has never heard of.
   *
   * It creates **only** when the event has no rounds at all. Once an organizer has configured
   * rounds, their configuration governs and a request naming a round they did not create is
   * refused rather than quietly granted one.
   */
  private async ensureDefaultRound(eventId: string): Promise<readonly ReviewRound[]> {
    const existing = await this.dependencies.repository.listRounds(eventId);
    if (existing.length) return existing;
    const now = this.dependencies.now().toISOString();
    const round: ReviewRound = {
      eventId,
      sequence: 1,
      name: "Round 1",
      opensAt: null,
      closesAt: null,
      state: "open",
      anonymized: true,
      criteria: null,
      poolMode: "event",
      reviewerIds: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.dependencies.repository.createRound(round);
    } catch (error) {
      // Two requests arriving together both see no rounds and both create one; the loser reads
      // what the winner wrote rather than failing a request that asked for nothing unusual.
      if (error instanceof ReviewStateConflictError)
        return this.dependencies.repository.listRounds(eventId);
      throw error;
    }
    return [round];
  }

  /**
   * The round work is about to be recorded in, or a refusal naming the round and the reason.
   *
   * Every write path that touches a round goes through here — assignment, distribution,
   * advancement, evaluation, conflict declaration and suggestion drafting — because "this round is
   * accepting work" has to mean one thing. `field` names the request field the refusal belongs to
   * so the caller's own form can point at it.
   */
  private async openRound(eventId: string, sequence: number, field: string): Promise<ReviewRound> {
    await this.ensureDefaultRound(eventId);
    const round = await this.dependencies.repository.findRound(eventId, sequence);
    if (!round)
      throw new ReviewValidationError({
        [field]: [
          `Round ${sequence} does not exist for this event. Create it in Review rounds first.`,
        ],
      });
    const closed = roundClosedReason(round, this.dependencies.now());
    if (closed) throw new ReviewValidationError({ [field]: [closed] });
    return round;
  }

  /**
   * The round this assignment sits in, refusing if it is not currently taking work.
   *
   * The reviewer-side counterpart of `openRound`, and read-only where that one may create the
   * default round: a reviewer holding an assignment is not the caller who should be writing an
   * event's first round row, and an event whose rounds were never configured must keep behaving
   * exactly as it did — so a missing round is `null` and permissive here rather than a refusal.
   *
   * This is what makes "preserve immutable completed-round history" true on the reviewer's side:
   * once a round closes, its evaluations, conflicts and drafts stay readable and stop being
   * writable, on every path rather than on the ones somebody remembered.
   */
  private async workableRound(
    eventId: string,
    sequence: number,
    field: string,
  ): Promise<ReviewRound | null> {
    const round = await this.dependencies.repository.findRound(eventId, sequence);
    if (!round) return null;
    const closed = roundClosedReason(round, this.dependencies.now());
    if (closed) throw new ReviewValidationError({ [field]: [closed] });
    return round;
  }

  /** Every round of this event with its pool. Organizer-only; the pool is staffing information. */
  async listRounds(actor: Actor | null, eventId: string): Promise<readonly ReviewRound[]> {
    this.organizer(actor, eventId);
    return this.ensureDefaultRound(eventId);
  }

  /**
   * Create a round.
   *
   * The sequence is allocated here rather than chosen by the caller: it is the number every
   * assignment, outcome and suggestion of this round will carry, and letting a client pick it is
   * how two clients end up describing different rounds with the same number. `criteria` absent
   * means "score against the event plan"; supplied, it is this round's own scorecard and the
   * aggregate is weighted under it.
   */
  async createRound(
    actor: Actor | null,
    eventId: string,
    input: {
      readonly name: string;
      readonly opensAt?: string | null | undefined;
      readonly closesAt?: string | null | undefined;
      readonly state?: ReviewRoundState | undefined;
      readonly anonymized?: boolean | undefined;
      readonly criteria?: EvaluationPlan["criteria"] | null | undefined;
      readonly poolMode?: ReviewRoundPoolMode | undefined;
      readonly reviewerIds?: readonly string[] | undefined;
    },
  ): Promise<ReviewRound> {
    const authorized = this.organizer(actor, eventId);
    const existing = await this.ensureDefaultRound(eventId);
    const reviewerIds = await this.validatedPool(
      authorized,
      eventId,
      input.reviewerIds ?? [],
      "reviewerIds",
    );
    this.validateWindow(input.opensAt ?? null, input.closesAt ?? null);
    if (input.criteria) this.validateCriteria(input.criteria);
    const now = this.dependencies.now().toISOString();
    const round: ReviewRound = {
      eventId,
      sequence: Math.max(0, ...existing.map(({ sequence }) => sequence)) + 1,
      name: input.name,
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      state: input.state ?? "draft",
      anonymized: input.anonymized ?? true,
      criteria: input.criteria ?? null,
      // A round an organizer creates is `named` unless they say otherwise, which is what makes
      // "a reviewer in round 1 is absent from round 2 until explicitly added" true by default.
      poolMode: input.poolMode ?? "named",
      reviewerIds,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.dependencies.repository.createRound(round);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ name: [error.message] });
      throw error;
    }
    return round;
  }

  /**
   * Change a round's name, window, state, anonymization policy or scorecard.
   *
   * The pool is not changed here — `setRoundPool` owns it — so an organizer editing dates cannot
   * silently restate a membership list somebody else just edited. A closed round's terms are
   * refused by storage; reopening one is allowed, because closing early has to be undoable.
   */
  async updateRound(
    actor: Actor | null,
    eventId: string,
    sequence: number,
    input: {
      readonly name: string;
      readonly opensAt?: string | null | undefined;
      readonly closesAt?: string | null | undefined;
      readonly state: ReviewRoundState;
      readonly anonymized: boolean;
      readonly criteria?: EvaluationPlan["criteria"] | null | undefined;
      readonly poolMode: ReviewRoundPoolMode;
    },
  ): Promise<ReviewRound> {
    this.organizer(actor, eventId);
    const existing = await this.dependencies.repository.findRound(eventId, sequence);
    if (!existing) throw new ReviewNotFoundError("Review round not found");
    this.validateWindow(input.opensAt ?? null, input.closesAt ?? null);
    if (input.criteria) this.validateCriteria(input.criteria);
    /*
     * Switching a round to `named` with reviewers already holding work in it would leave those
     * assignments outside the pool that authorized them. Refused here with the list, because the
     * repair is to add them to the pool or unassign them, and neither is guessable from a bare
     * "pool violation".
     */
    if (input.poolMode === "named" && existing.poolMode === "event") {
      const assigned = [
        ...new Set(
          (await this.dependencies.repository.listAssignments(eventId))
            .filter((assignment) => (assignment.round ?? 1) === sequence)
            .map(({ reviewerId }) => reviewerId),
        ),
      ];
      const outside = assigned.filter((reviewerId) => !existing.reviewerIds.includes(reviewerId));
      if (outside.length)
        throw new ReviewValidationError({
          poolMode: [
            `${outside.length} reviewer${outside.length === 1 ? "" : "s"} already hold assignments in this round but ${outside.length === 1 ? "is" : "are"} not in its pool. Add them to the pool, or unassign them, before restricting the round.`,
          ],
        });
    }
    const round = {
      eventId,
      sequence,
      name: input.name,
      opensAt: input.opensAt ?? null,
      closesAt: input.closesAt ?? null,
      state: input.state,
      anonymized: input.anonymized,
      criteria: input.criteria ?? null,
      poolMode: input.poolMode,
      updatedAt: this.dependencies.now().toISOString(),
    };
    try {
      await this.dependencies.repository.updateRound(round);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ state: [error.message] });
      throw error;
    }
    return { ...round, reviewerIds: existing.reviewerIds, createdAt: existing.createdAt };
  }

  /** Replace a round's reviewer pool. Refused for a reviewer who already holds work in it. */
  async setRoundPool(
    actor: Actor | null,
    eventId: string,
    sequence: number,
    reviewerIds: readonly string[],
  ): Promise<ReviewRound> {
    const authorized = this.organizer(actor, eventId);
    const existing = await this.dependencies.repository.findRound(eventId, sequence);
    if (!existing) throw new ReviewNotFoundError("Review round not found");
    const validated = await this.validatedPool(authorized, eventId, reviewerIds, "reviewerIds");
    try {
      await this.dependencies.repository.setRoundMembers(
        eventId,
        sequence,
        validated,
        this.dependencies.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ reviewerIds: [error.message] });
      throw error;
    }
    return { ...existing, reviewerIds: validated };
  }

  /** Every named reviewer, checked against this event's directory and against self-assignment. */
  private async validatedPool(
    actor: Actor,
    eventId: string,
    reviewerIds: readonly string[],
    field: string,
  ): Promise<readonly string[]> {
    const unique = [...new Set(reviewerIds)].sort();
    // The same refusal `assign` gives, at the moment the pool is set rather than at the moment
    // somebody is given work: the organizer console has no reviewer queue, so an organizer in a
    // pool is work nobody can do.
    if (unique.includes(actor.id))
      throw new ReviewValidationError({
        [field]: ["You cannot be a reviewer on your own event"],
      });
    for (const reviewerId of unique)
      if (!(await this.dependencies.identities.isReviewerForEvent(reviewerId, eventId)))
        throw new ReviewValidationError({
          [field]: ["Every reviewer in a pool must be staffed on this event"],
        });
    return unique;
  }

  private validateWindow(opensAt: string | null, closesAt: string | null): void {
    if (opensAt && closesAt && opensAt >= closesAt)
      throw new ReviewValidationError({ closesAt: ["The round must close after it opens"] });
  }

  /**
   * The rules `configurePlan` applies to the event rubric, applied to a round's own scorecard.
   *
   * Stated once and called from both round writers, because a round scorecard that could omit a
   * numeric criterion would produce an aggregate divided by zero — the failure the event plan has
   * refused since it existed, and there is no reason a round's copy should be allowed to reach it.
   */
  private validateCriteria(criteria: EvaluationPlan["criteria"]): void {
    if (!criteria.length)
      throw new ReviewValidationError({ criteria: ["At least one criterion is required"] });
    if (!criteria.some((criterion) => !criterion.type || criterion.type === "numeric"))
      throw new ReviewValidationError({
        criteria: ["At least one numeric criterion is required for the aggregate"],
      });
    if (new Set(criteria.map(({ id }) => id)).size !== criteria.length)
      throw new ReviewValidationError({ criteria: ["Criterion IDs must be unique"] });
  }

  private async reviewerLists(actor: Actor, eventId: string) {
    const directory = await this.dependencies.identities.listReviewersForEvent(eventId);
    return { directory, assignable: directory.filter(({ id }) => id !== actor.id) };
  }

  async organizerWorkspace(actor: Actor | null, eventId: string, status?: ProposalStatus) {
    const authorized = this.organizer(actor, eventId);
    const [proposals, plan, assignments, outcomes, audit, statuses, reviewers, decisions] =
      await Promise.all([
        this.dependencies.proposals.list(eventId, status),
        this.dependencies.repository.getPlan(eventId),
        this.dependencies.repository.listAssignments(eventId),
        this.dependencies.repository.listOutcomes(eventId),
        this.dependencies.proposals.listAudit(eventId),
        this.storedStatuses(eventId),
        this.reviewerLists(authorized, eventId),
        this.dependencies.repository.listDecisions(eventId),
      ]);
    const evaluations = await this.dependencies.repository.listEvaluations(eventId);
    const rounds = await this.ensureDefaultRound(eventId);
    /*
     * Progress per reviewer, and per reviewer *per round*.
     *
     * Both, not one. The event-wide row is what the reminder list and the "is anybody late?"
     * question need, and it is the shape the console already renders — but an outstanding count
     * that pools a finished first round with a live second one is the number that makes a
     * reviewer look behind when they are not, and the issue asks for counts "per reviewer and
     * round". Neither is derivable from the other without the assignments, which the caller has,
     * so both are computed once here rather than twice on the surface.
     */
    const completedAssignmentIds = new Set(
      evaluations
        .filter((evaluation) => evaluation.state === "completed")
        .map(({ assignmentId }) => assignmentId),
    );
    const countOf = (owned: readonly ReviewAssignment[]) => {
      const completed = owned.filter(({ id }) => completedAssignmentIds.has(id)).length;
      return { assigned: owned.length, completed, outstanding: owned.length - completed };
    };
    const progress = reviewers.directory.map(({ id: reviewerId }) => ({
      reviewerId,
      ...countOf(assignments.filter((assignment) => assignment.reviewerId === reviewerId)),
    }));
    const roundProgress = rounds.flatMap((round) =>
      reviewers.directory.flatMap(({ id: reviewerId }) => {
        const owned = assignments.filter(
          (assignment) =>
            assignment.reviewerId === reviewerId && (assignment.round ?? 1) === round.sequence,
        );
        // A reviewer with nothing in this round is omitted rather than listed as 0/0: the list is
        // read as "who is working on this round", and padding it with everybody staffed on the
        // event turns a short answer into a table nobody can scan.
        return owned.length ? [{ round: round.sequence, reviewerId, ...countOf(owned) }] : [];
      }),
    );
    return {
      proposals: proposals.map(withCoAuthors),
      plan,
      rounds,
      assignments,
      outcomes,
      evaluations,
      audit,
      statuses,
      reviewers: reviewers.assignable,
      reviewerDirectory: reviewers.directory,
      decisions,
      progress,
      roundProgress,
    };
  }

  /**
   * The event's review configuration, read without repairing it.
   *
   * For a caller deciding whether it needs to write at all — a template preview, which promises
   * to write nothing — `organizerWorkspace` is the wrong read twice over: it loads proposals,
   * evaluations, outcomes, decisions and progress that such a caller never looks at, and it goes
   * through `storedStatuses`, whose completion of the reserved keys is itself a write. So this
   * answers from `listStatuses` as storage holds it and leaves the completion to whoever writes.
   *
   * `statusesInUse` is the vocabulary `configureStatuses` refuses to drop, and `hasAssignments`
   * is what locks the rubric; both are stated here so a caller can report those two refusals
   * before provoking either.
   */
  async reviewConfiguration(actor: Actor | null, eventId: string) {
    this.organizer(actor, eventId);
    const [statuses, plan, assignments, proposals] = await Promise.all([
      this.dependencies.proposals.listStatuses(eventId),
      this.dependencies.repository.getPlan(eventId),
      this.dependencies.repository.listAssignments(eventId),
      this.dependencies.proposals.list(eventId),
    ]);
    return {
      statuses,
      plan,
      statusesInUse: [...new Set(proposals.map(({ status }) => status))],
      hasAssignments: assignments.length > 0,
    };
  }

  async configureStatuses(
    actor: Actor | null,
    eventId: string,
    statuses: readonly { key: string; label: string; sortOrder: number }[],
  ) {
    this.organizer(actor, eventId);
    if (new Set(statuses.map(({ key }) => key)).size !== statuses.length)
      throw new ReviewValidationError({ statuses: ["Status keys must be unique"] });
    // Acceptance is not a label an organizer can delete out from under the content domain — but
    // leaving it out is not an error either. The request is completed rather than refused, so a
    // caller that only ever configured its own pipeline keeps working and still ends up with a
    // stored set the decision routes can transition into.
    const completed = withReservedStatuses(statuses);
    const keys = new Set(completed.map(({ key }) => key));
    const proposals = await this.dependencies.proposals.list(eventId);
    if (proposals.some(({ status }) => !keys.has(status)))
      throw new ReviewValidationError({
        statuses: ["Configured statuses must include every status currently in use"],
      });
    try {
      await this.dependencies.proposals.saveStatuses(eventId, completed);
    } catch (error) {
      if (error instanceof ProposalStatusConfigurationError)
        throw new ReviewValidationError({ statuses: [error.message] });
      throw error;
    }
    return completed;
  }

  async configurePlan(
    actor: Actor | null,
    eventId: string,
    criteria: EvaluationPlan["criteria"],
  ): Promise<EvaluationPlan> {
    this.organizer(actor, eventId);
    this.validateCriteria(criteria);
    const [existing, assignments] = await Promise.all([
      this.dependencies.repository.getPlan(eventId),
      this.dependencies.repository.listAssignments(eventId),
    ]);
    if (
      assignments.length &&
      existing &&
      JSON.stringify(existing.criteria) !== JSON.stringify(criteria)
    )
      throw new ReviewValidationError({
        criteria: ["The rubric is locked after reviewer assignments are created"],
      });
    const plan = { eventId, criteria, updatedAt: this.dependencies.now().toISOString() };
    try {
      await this.dependencies.repository.savePlan(plan);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ criteria: [error.message] });
      throw error;
    }
    return plan;
  }

  async assign(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    reviewerId: string,
    round = 1,
  ): Promise<readonly ReviewAssignment[]> {
    const authorized = this.organizer(actor, eventId);
    // The organizer console has no reviewer queue, so an organizer who assigns an abstract to
    // themselves creates an evaluation nobody can open — and locks the rubric doing it. The
    // list this request chooses from already excludes them; refusing it here is what stops a
    // request that did not come from that list.
    if (reviewerId === authorized.id)
      throw new ReviewValidationError({
        reviewerId: ["Assign this abstract to another reviewer; you cannot review your own event"],
      });
    if (!(await this.dependencies.identities.isReviewerForEvent(reviewerId, eventId)))
      throw new ReviewValidationError({ reviewerId: ["Choose a reviewer assigned to this event"] });
    // The round has to exist, be open, be inside its window, and admit this reviewer. Checked here
    // so the organizer gets a sentence naming the round; `1312` installs the same four rules as
    // triggers, which is what catches a round closed between this read and the insert.
    const target = await this.openRound(eventId, round, "round");
    if (!roundAdmits(target, reviewerId))
      throw new ReviewValidationError({
        reviewerId: [
          `That reviewer is not in “${target.name}”'s pool. Add them to the round's reviewers first — membership in one round does not carry into another.`,
        ],
      });
    const uniqueProposalIds = [...new Set(proposalIds)];
    const proposals = await this.dependencies.proposals.findMany(eventId, uniqueProposalIds);
    if (proposals.length !== uniqueProposalIds.length)
      throw new ReviewNotFoundError("Proposal not found");
    const existing = await this.dependencies.repository.listAssignments(eventId);
    const now = this.dependencies.now().toISOString();
    const assignments = uniqueProposalIds
      .filter(
        (proposalId) =>
          !existing.some(
            (assignment) =>
              assignment.proposalId === proposalId &&
              assignment.reviewerId === reviewerId &&
              (assignment.round ?? 1) === round,
          ),
      )
      .map((proposalId) => ({
        id: this.dependencies.newId(),
        eventId,
        proposalId,
        reviewerId,
        round,
        createdAt: now,
      }));
    let created: readonly ReviewAssignment[];
    try {
      created = await this.dependencies.repository.createAssignments(assignments);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ plan: [error.message] });
      throw error;
    }
    // Nothing new was assigned, so there is nothing to tell anybody. Without this an organizer
    // re-submitting the same list would mail the reviewer again about work they already have.
    await this.notifyAssigned(eventId, round, created);
    return created;
  }

  async distribute(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    reviewerIds: readonly string[],
    maxAssignmentsPerReviewer: number,
    round?: number,
  ) {
    const authorized = this.organizer(actor, eventId);
    const uniqueReviewers = [...new Set(reviewerIds)].sort();
    if (uniqueReviewers.includes(authorized.id))
      throw new ReviewValidationError({
        reviewerIds: ["Distribution cannot assign the organizer to their own event"],
      });
    for (const reviewerId of uniqueReviewers)
      if (!(await this.dependencies.identities.isReviewerForEvent(reviewerId, eventId)))
        throw new ReviewValidationError({
          reviewerIds: ["Every reviewer must belong to this event"],
        });
    const proposals = [...new Set(proposalIds)].sort();
    const found = await this.dependencies.proposals.findMany(eventId, proposals);
    if (found.length !== proposals.length) throw new ReviewNotFoundError("Proposal not found");
    const existing = await this.dependencies.repository.listAssignments(eventId);
    const targetRound = round ?? Math.max(1, ...existing.map((item) => item.round ?? 1));
    const openTarget = await this.openRound(eventId, targetRound, "round");
    // Named before the loop, not discovered inside it. Distribution that dropped an inadmissible
    // reviewer silently would answer 201 having quietly given the work to somebody else, and the
    // organizer would learn about it by reading the Reviewers column.
    const outside = uniqueReviewers.filter((reviewerId) => !roundAdmits(openTarget, reviewerId));
    if (outside.length)
      throw new ReviewValidationError({
        reviewerIds: [
          `${outside.length} of the selected reviewers ${outside.length === 1 ? "is" : "are"} not in “${openTarget.name}”'s pool. Add them to the round's reviewers first.`,
        ],
      });
    const counts = new Map(
      uniqueReviewers.map((reviewerId) => [
        reviewerId,
        existing.filter(
          (item) => item.reviewerId === reviewerId && (item.round ?? 1) === targetRound,
        ).length,
      ]),
    );
    const created = [];
    const available = [...counts.values()].reduce(
      (total, count) => total + Math.max(0, maxAssignmentsPerReviewer - count),
      0,
    );
    if (available < proposals.length)
      throw new ReviewValidationError({
        proposalIds: ["Reviewer capacity is too small for every selected proposal"],
      });
    for (const proposalId of proposals) {
      const reviewerId = uniqueReviewers
        .filter(
          (candidate) =>
            (counts.get(candidate) ?? 0) < maxAssignmentsPerReviewer &&
            !existing.some(
              (item) =>
                item.proposalId === proposalId &&
                item.reviewerId === candidate &&
                (item.round ?? 1) === targetRound,
            ),
        )
        .sort(
          (left, right) =>
            (counts.get(left) ?? 0) - (counts.get(right) ?? 0) || left.localeCompare(right),
        )[0];
      if (!reviewerId)
        throw new ReviewValidationError({ proposalIds: ["No reviewer capacity remains"] });
      created.push({
        id: this.dependencies.newId(),
        eventId,
        proposalId,
        reviewerId,
        round: targetRound,
        createdAt: this.dependencies.now().toISOString(),
      });
      counts.set(reviewerId, (counts.get(reviewerId) ?? 0) + 1);
    }
    let stored: readonly ReviewAssignment[];
    try {
      stored = await this.dependencies.repository.createCappedAssignments(
        created,
        new Map(uniqueReviewers.map((reviewerId) => [reviewerId, maxAssignmentsPerReviewer])),
      );
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ reviewerIds: [error.message] });
      throw error;
    }
    // One message per reviewer, not one per abstract: a distribution that hands somebody twelve
    // proposals is one thing that happened to them, and twelve emails about it is the kind of
    // notification people filter out.
    await this.notifyAssigned(eventId, targetRound, stored);
    return stored;
  }

  /**
   * Tell each reviewer, once, that they have work in this round.
   *
   * Grouped by reviewer and keyed on the round rather than on the assignments, because an
   * organizer distributing in several passes — a batch now, more when late proposals arrive — is
   * one reviewer being given work in one round, and they should hear about it once. That is also
   * why the message does not name a count: a count stated at the first pass would be wrong after
   * the second, and a message that says "you have 3 abstracts" when the queue holds 11 is worse
   * than one that says there is work waiting.
   */
  private async notifyAssigned(
    eventId: string,
    round: number,
    assignments: readonly ReviewAssignment[],
  ): Promise<void> {
    const notifications = this.dependencies.notifications;
    if (!notifications || assignments.length === 0) return;
    const byReviewer = new Map<string, ReviewAssignment[]>();
    for (const assignment of assignments) {
      const list = byReviewer.get(assignment.reviewerId);
      if (list) list.push(assignment);
      else byReviewer.set(assignment.reviewerId, [assignment]);
    }
    for (const [reviewerId, theirs] of byReviewer)
      await notifications.reviewerAssigned({
        eventId,
        reviewerId,
        round,
        assignmentIds: theirs.map(({ id }) => id),
        proposalCount: theirs.length,
      });
  }

  /**
   * Advance the abstracts in one status into the next round, creating that round if it is new.
   *
   * The round it creates is `named` and its pool is exactly the reviewers this call distributes
   * to, which is what makes the issue's "a reviewer in round 1 is absent from round 2 until
   * explicitly added" true through the ordinary path rather than only through the rounds console:
   * advancing does not carry the previous round's pool forward, because the reviewers of a second
   * pass are usually not the reviewers of the first.
   *
   * It inherits the previous round's anonymization policy and scorecard override. Inheriting is
   * the safer default of the two: a second round that silently stopped being blind would expose
   * authors to reviewers who have every reason to assume they are still reading blind, and the
   * rounds console is where that is changed deliberately.
   */
  async advanceRound(
    actor: Actor | null,
    eventId: string,
    fromStatus: ProposalStatus,
    reviewerIds: readonly string[],
    maxAssignmentsPerReviewer: number,
    currentRound: number,
  ) {
    const authorized = this.organizer(actor, eventId);
    const [proposals, existing] = await Promise.all([
      this.dependencies.proposals.list(eventId, fromStatus),
      this.dependencies.repository.listAssignments(eventId),
    ]);
    const round = currentRound + 1;
    const alreadyAdvanced = existing.filter(
      (item) =>
        (item.round ?? 1) === round &&
        proposals.some(({ id }) => id === item.proposalId) &&
        reviewerIds.includes(item.reviewerId),
    );
    if (
      proposals.length > 0 &&
      new Set(alreadyAdvanced.map(({ proposalId }) => proposalId)).size === proposals.length
    )
      return { round, assignments: alreadyAdvanced };
    const actualRound = Math.max(0, ...existing.map((item) => item.round ?? 1));
    if (actualRound !== currentRound)
      throw new ReviewValidationError({
        currentRound: ["Review assignments changed; reload before starting another round"],
      });
    const rounds = await this.ensureDefaultRound(eventId);
    const previous = rounds.find((item) => item.sequence === currentRound);
    if (!rounds.some((item) => item.sequence === round)) {
      const pool = await this.validatedPool(authorized, eventId, reviewerIds, "reviewerIds");
      const now = this.dependencies.now().toISOString();
      try {
        await this.dependencies.repository.createRound({
          eventId,
          sequence: round,
          name: `Round ${round}`,
          opensAt: null,
          closesAt: null,
          state: "open",
          anonymized: previous?.anonymized ?? true,
          criteria: previous?.criteria ?? null,
          poolMode: "named",
          reviewerIds: pool,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        // Another organizer advanced first. Their round is the one this distributes into, which
        // is the same outcome the idempotent early return above produces.
        if (!(error instanceof ReviewStateConflictError)) throw error;
      }
    }
    const assignments = await this.distribute(
      actor,
      eventId,
      proposals.map(({ id }) => id),
      reviewerIds,
      maxAssignmentsPerReviewer,
      round,
    );
    return { round, assignments };
  }

  /**
   * Remind selected reviewers that they still have outstanding evaluations in a round.
   *
   * The half of `GAP-010` that belonged to review, and the reason it stayed open: there was no
   * `reviewer.reminder` trigger type, and the recorded ruling was that review must not substitute
   * `reviewer.assigned` for one. Migration `1706` adds the value; this is the caller.
   *
   * Three properties, each of which is a way the obvious version goes wrong:
   *
   * **Only reviewers who actually have outstanding work.** A reviewer who finished between the
   * organizer's page load and their click is reported as `nothing_outstanding` rather than sent a
   * message telling them to do work they have already done. The count is recomputed here rather
   * than taken from the request, because the request is a snapshot of a screen.
   *
   * **Only reviewers in the round.** A request naming somebody with no assignments in it is a
   * refusal, not a message about nothing.
   *
   * **Idempotent per reviewer per round.** Pressing twice queues one delivery; the second answers
   * `already_sent`, which the console shows, so the organizer can tell "sent" from "sent again".
   */
  async remindOutstandingReviewers(
    actor: Actor | null,
    eventId: string,
    round: number,
    reviewerIds: readonly string[],
  ): Promise<
    readonly {
      readonly reviewerId: string;
      readonly outstanding: number;
      readonly state: ReviewReminderResult | "nothing_outstanding";
    }[]
  > {
    this.organizer(actor, eventId);
    const notifications = this.dependencies.notifications;
    if (!notifications)
      throw new ReviewValidationError({
        reviewerIds: ["This deployment has no communications binding, so nothing can be sent"],
      });
    const target = await this.dependencies.repository.findRound(eventId, round);
    if (!target) throw new ReviewNotFoundError("Review round not found");
    const [assignments, evaluations] = await Promise.all([
      this.dependencies.repository.listAssignments(eventId),
      this.dependencies.repository.listEvaluations(eventId),
    ]);
    const completed = new Set(
      evaluations
        .filter((evaluation) => evaluation.state === "completed")
        .map(({ assignmentId }) => assignmentId),
    );
    const unique = [...new Set(reviewerIds)].sort();
    if (!unique.length)
      throw new ReviewValidationError({ reviewerIds: ["Choose at least one reviewer"] });
    const results: {
      reviewerId: string;
      outstanding: number;
      state: ReviewReminderResult | "nothing_outstanding";
    }[] = [];
    for (const reviewerId of unique) {
      const owned = assignments.filter(
        (assignment) =>
          assignment.reviewerId === reviewerId && (assignment.round ?? 1) === target.sequence,
      );
      if (!owned.length)
        throw new ReviewValidationError({
          reviewerIds: [`That reviewer has no assignments in “${target.name}”`],
        });
      const outstanding = owned.filter(({ id }) => !completed.has(id)).length;
      if (outstanding === 0) {
        results.push({ reviewerId, outstanding, state: "nothing_outstanding" });
        continue;
      }
      results.push({
        reviewerId,
        outstanding,
        state: await notifications.remindOutstanding({
          eventId,
          reviewerId,
          round: target.sequence,
          roundName: target.name,
          outstanding,
        }),
      });
    }
    return results;
  }

  /**
   * Remove one review assignment.
   *
   * The correction a mis-assignment needs. Without it an abstract stayed with whoever was named
   * first — including somebody with no queue to open it in — and, because the rubric locks on
   * the existence of any assignment, a single stray click froze the evaluation criteria for the
   * whole event with no way back.
   *
   * The rule: an assignment may be removed until its reviewer completes an evaluation. A draft
   * and a declared conflict go with it, because both describe an assignment that is going away.
   * A *completed* evaluation does not: its score is already counted in this abstract's
   * aggregate and it has emitted `EVT-REVIEW-COMPLETED`, so dropping the assignment under it
   * would quietly restate a number an organizer has already read. That case is refused and says
   * so. Reviewers who should not have been given the abstract declare a conflict instead, which
   * is the reviewer-side exit and leaves the record intact.
   */
  async unassign(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
  ): Promise<ReviewAssignment> {
    this.organizer(actor, eventId);
    const assignment = await this.dependencies.repository.findAssignment(eventId, assignmentId);
    // An assignment belonging to another event is indistinguishable from one that does not
    // exist, so this cannot be used to probe another event's ids (`ARC-AUTH-001`).
    if (!assignment) throw new ReviewNotFoundError("Review assignment not found");
    const evaluation = await this.dependencies.repository.getEvaluation(
      assignment.id,
      assignment.reviewerId,
    );
    if (evaluation?.state === "completed")
      throw new ReviewValidationError({
        assignmentId: [ASSIGNMENT_EVALUATED_REFUSAL],
      });
    try {
      await this.dependencies.repository.deleteAssignment(eventId, assignmentId);
    } catch (error) {
      // Storage refuses the same case the read above refuses, for an evaluation completed
      // between the two.
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({ assignmentId: [ASSIGNMENT_EVALUATED_REFUSAL] });
      throw error;
    }
    return assignment;
  }

  async bulkTransition(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    toStatus: ProposalStatus,
  ) {
    const authorized = this.organizer(actor, eventId);
    /*
     * The pipeline moves an abstract between triage steps; it does not decide it.
     *
     * `accepted` and `declined` are reserved because reaching one of them is the *effect* of a
     * recorded decision, and it is that stored decision — not the status string — that
     * authorizes the abstract to become a session. A transition straight into one produced
     * exactly half of an acceptance: a green pill and a raised count, with no decision, no
     * session, no speaker, and a content domain that then refused the abstract the board showed
     * as Accepted. The triage UI stopped offering it; this is the same refusal for a request
     * that did not come from the UI.
     */
    if (RESERVED_PROPOSAL_STATUSES.some(({ key }) => key === toStatus))
      throw new ReviewValidationError({
        toStatus: [
          `“${toStatus}” is recorded by an accept or decline, not by moving an abstract into it. POST /api/events/${eventId}/review/decisions with that outcome instead: it stores who decided and when, and creates the session.`,
        ],
      });
    try {
      return (
        await this.dependencies.proposals.transitionAtomically({
          eventId,
          proposalIds: [...new Set(proposalIds)],
          toStatus,
          actorId: authorized.id,
          occurredAt: this.dependencies.now().toISOString(),
          auditIds: proposalIds.map(() => this.dependencies.newId()),
        })
      ).map(withoutOwner);
    } catch (error) {
      if (error instanceof ProposalStatusConfigurationError)
        throw new ReviewValidationError({ toStatus: [error.message] });
      throw error;
    }
  }

  /**
   * Record an accept/decline decision on proposals.
   *
   * The status transition runs first through the CFP interface, which audits it atomically and
   * refuses an unconfigured status; the decision record is written second. Ordered that way a
   * partial failure leaves a proposal that looks accepted on the board but carries no decision,
   * so `acceptedProposal` — and therefore content acceptance — still refuses it. The reverse
   * order would authorize content off a half-written decision. Re-deciding overwrites, so a
   * retry heals the gap.
   */
  async decide(
    actor: Actor | null,
    eventId: string,
    proposalIds: readonly string[],
    outcome: DecisionOutcome,
    note = "",
  ): Promise<{
    proposals: readonly PublishedProposal[];
    decisions: readonly ProposalDecision[];
  }> {
    const authorized = this.organizer(actor, eventId);
    const uniqueProposalIds = [...new Set(proposalIds)];
    const found = await this.dependencies.proposals.findMany(eventId, uniqueProposalIds);
    if (found.length !== uniqueProposalIds.length)
      throw new ReviewNotFoundError("Proposal not found");
    // Self-healing: an event whose status set predates the reserved keys gets them persisted
    // before the transition rather than a "choose a configured proposal status" failure.
    await this.storedStatuses(eventId);
    const decidedAt = this.dependencies.now().toISOString();
    const proposals = await this.dependencies.proposals.transitionAtomically({
      eventId,
      proposalIds: uniqueProposalIds,
      toStatus: outcome,
      actorId: authorized.id,
      occurredAt: decidedAt,
      auditIds: uniqueProposalIds.map(() => this.dependencies.newId()),
    });
    /*
     * The revision each decision now stands at, allocated by storage rather than by this loop.
     *
     * `saveDecision` computes it inside its own upsert, so two organizers deciding one proposal
     * at once cannot both read the old value and write the same new one. Re-deciding the same way
     * holds it; deciding differently advances it. That is the only fact separating a retry from a
     * reinstatement, and the audit timeline needs it (`PRD-OPS-003`, migration 1311).
     */
    const decisions = await Promise.all(
      uniqueProposalIds.map(async (proposalId) => {
        const pending = {
          eventId,
          proposalId,
          outcome,
          decidedBy: authorized.id,
          decidedAt,
          note,
        };
        return { ...pending, revision: await this.dependencies.repository.saveDecision(pending) };
      }),
    );
    const revisionOf = new Map(decisions.map((entry) => [entry.proposalId, entry.revision]));
    // Told after both the status transition and the decision record are durable. A submitter who
    // hears "accepted" from a decision that did not save would be told again on the retry, and
    // the two messages would disagree about which one was real.
    for (const proposal of proposals) {
      const revision = revisionOf.get(proposal.id);
      if (revision === undefined)
        throw new Error(`No persisted decision revision was returned for proposal ${proposal.id}`);
      await this.dependencies.notifications?.decisionRecorded({
        eventId,
        proposalId: proposal.id,
        outcome,
        submitterName: proposal.submitterName,
        // Null rather than a guess: a form that collected no address leaves nobody to write to,
        // and inventing one would send somebody else's decision to somebody else.
        submitterEmail: proposal.submitter?.email ?? null,
        submitterUserId: proposal.submitterUserId,
        proposalTitle: proposal.title,
        revision,
      });
    }
    // The owner id has done its work — it addressed the notifications above — and does not go out
    // with the response. See `withoutOwner`.
    return { proposals: proposals.map(withoutOwner), decisions };
  }

  /**
   * The review domain's answer to "may this proposal become program content?".
   *
   * `AcceptedProposalQuery`; the content domain calls exactly this and never touches
   * `cfp_submissions`.
   */
  async acceptedProposal(eventId: string, proposalId: string): Promise<AcceptedProposal> {
    const proposal = await this.dependencies.proposals.find(eventId, proposalId);
    // A proposal belonging to another event is indistinguishable from one that does not exist,
    // so acceptance cannot be used to probe another event's ids (`ARC-AUTH-001`).
    if (!proposal) throw new ProposalNotFoundError("Proposal not found for this event");
    const decision = await this.dependencies.repository.findDecision(eventId, proposalId);
    if (decision?.outcome !== ACCEPTED_PROPOSAL_STATUS)
      throw new ProposalNotAcceptedError("Proposal has no recorded acceptance decision");
    if (!proposal.submitter)
      throw new ProposalSubmitterUnavailableError(
        "The published form collected no contact address for this proposal",
      );
    return {
      eventId,
      proposalId,
      title: proposal.title,
      abstract: proposal.abstract,
      format: formatOf(proposal),
      submitter: proposal.submitter,
      decidedAt: decision.decidedAt,
    };
  }

  /**
   * Whether this deployment has an assistant at all.
   *
   * Read by the transport so the reviewer's surface can offer a Draft control only where pressing
   * it would do something. A getter rather than a field on the queue's items because it is a fact
   * about the deployment, not about any one abstract.
   */
  get suggestionsEnabled(): boolean {
    return Boolean(this.dependencies.suggestions);
  }

  /**
   * The reviewer's queue, each item projected under the policy of the round it belongs to.
   *
   * Two things are per-round here and both used to be per-event. **Anonymization** decides which
   * projection the abstract goes through, so a reviewer in a blind round and a reviewer in an open
   * one reading the same abstract genuinely receive different bytes. And **the scorecard** the
   * item carries is the round's own where it has one, so the form a reviewer fills in is the form
   * their save is validated against — a reviewer scoring a round-2 rubric against a round-1 form
   * would meet a refusal naming criteria their screen never showed.
   *
   * `roundState` and `roundClosedReason` travel with the item because a queue that silently
   * refuses a save is worse than one that says the round is closed before the reviewer types.
   */
  async reviewerQueue(actor: Actor | null, eventId: string) {
    const authorized = this.reviewer(actor, eventId);
    const [assignments, plan, suggestions, rounds] = await Promise.all([
      this.dependencies.repository.listAssignments(eventId, authorized.id),
      this.dependencies.repository.getPlan(eventId),
      // One read for the whole queue rather than one per assignment: a reviewer with twelve
      // abstracts should cost twelve reads, not twenty-four.
      this.dependencies.suggestions
        ? this.dependencies.repository.listSuggestionsForReviewer(eventId, authorized.id)
        : Promise.resolve([]),
      this.dependencies.repository.listRounds(eventId),
    ]);
    const now = this.dependencies.now();
    return Promise.all(
      assignments.map(async (assignment) => {
        const [proposal, conflict, evaluation] = await Promise.all([
          this.dependencies.proposals.find(eventId, assignment.proposalId),
          this.dependencies.repository.getConflict(assignment.id, authorized.id),
          this.dependencies.repository.getEvaluation(assignment.id, authorized.id),
        ]);
        if (!proposal) throw new ReviewNotFoundError("Assigned proposal not found");
        const round = rounds.find((item) => item.sequence === (assignment.round ?? 1)) ?? null;
        /*
         * Reviewers evaluate the proposal, never the person — unless this round says otherwise,
         * which is a policy an organizer sets rather than a default anything falls into. A round
         * this queue cannot find is treated as blind: an unknown policy is not a licence to
         * publish an author's name, and the failure of masking when we should not have is a
         * reviewer seeing less than they could.
         */
        const projected =
          round?.anonymized === false ? withOpenAuthorship(proposal) : blindProjection(proposal);
        // Recomputed from what the reviewer is about to read, so a suggestion drafted against an
        // earlier version of the abstract can be shown as exactly that rather than presented as
        // current. The comparison is the surface's; supplying both halves is this method's.
        const proposalRevision = proposalRevisionOf(projected);
        const criteria = roundCriteria(round, plan?.criteria);
        return {
          assignment,
          proposal: projected,
          // The round's scorecard where it has one, the event plan where it does not — presented
          // in the same shape either way so the surface has one thing to render.
          plan: criteria.length
            ? {
                eventId,
                criteria,
                updatedAt: round?.criteria
                  ? round.updatedAt
                  : (plan?.updatedAt ?? round?.updatedAt ?? ""),
              }
            : null,
          round,
          roundClosedReason: round ? roundClosedReason(round, now) : null,
          conflict,
          evaluation,
          proposalRevision,
          suggestions: suggestions.filter((item) => item.assignmentId === assignment.id),
        };
      }),
    );
  }

  /**
   * Draft a suggestion for one of this reviewer's assignments.
   *
   * What this writes is one `review_suggestions` row in the `offered` state, and nothing else. No
   * evaluation, no outcome, no decision, no status transition — so the strongest thing a
   * misbehaving provider can achieve is a bad draft on a screen the reviewer can dismiss. Every
   * refusal below exists to keep the drafting path from touching work that is already finished:
   * a completed evaluation is not redrafted, and a conflicted assignment is not drafted for at
   * all, because a reviewer who has recused themselves should not be handed an opinion about it.
   *
   * The proposal crosses the port **masked**. `withoutSubmitter` is the same projection the queue
   * renders, so blind review holds for a live model exactly as it holds for a reviewer.
   */
  async requestSuggestion(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
  ): Promise<ReviewSuggestion> {
    const authorized = this.reviewer(actor, eventId);
    const port = this.dependencies.suggestions;
    if (!port)
      throw new SuggestionsDisabledError("AI-assisted review is switched off for this deployment");
    const assignment = await this.ownedAssignment(eventId, assignmentId, authorized.id);
    if (await this.dependencies.repository.getConflict(assignment.id, authorized.id))
      throw new ReviewConflictError("Conflicted assignments cannot be evaluated");
    const round = await this.workableRound(eventId, assignment.round ?? 1, "round");
    const [existingEvaluation, plan, proposal] = await Promise.all([
      this.dependencies.repository.getEvaluation(assignment.id, authorized.id),
      this.dependencies.repository.getPlan(eventId),
      this.dependencies.proposals.find(eventId, assignment.proposalId),
    ]);
    if (existingEvaluation?.state === "completed")
      throw new ReviewValidationError({
        evaluation: ["A completed evaluation cannot be redrafted"],
      });
    const criteria = roundCriteria(round, plan?.criteria);
    if (!criteria.length)
      throw new ReviewValidationError({
        plan: ["The organizer has not configured a plan, so there is nothing to draft against"],
      });
    if (!proposal) throw new ReviewNotFoundError("Assigned proposal not found");
    /*
     * Masked in **every** round, blind or open.
     *
     * This is deliberately not `round.anonymized`. "The provider never receives an author" is a
     * stronger promise than "the provider receives whatever this round's reviewers receive", it is
     * the one the staging smoke verified over the wire, and an open-review round is not a reason
     * to weaken it: the reviewer can see the name on their own screen without it being sent to a
     * model. The invariant `PRD-AI-001` states is identity-free provider input, full stop.
     */
    const masked = withoutSubmitter(proposal);

    const draft = await withDeadline(
      port.suggest({
        title: masked.title,
        abstract: masked.abstract,
        answers: masked.answers.map(({ label, value }) => ({ label, value })),
        criteria,
        round: assignment.round ?? 1,
        timeoutMs: this.dependencies.suggestionTimeoutMs ?? SUGGESTION_TIMEOUT_MS,
      }),
      this.dependencies.suggestionTimeoutMs ?? SUGGESTION_TIMEOUT_MS,
    );

    // Drafted values are kept only for criteria this rubric actually has, and only the first
    // value per criterion.
    // ERROR-INTENT: an entry for a criterion the plan does not contain is dropped rather than
    // stored — it can never be accepted, and storing it would render a score against a criterion
    // the reviewer's form does not show. A criterion left with no draft is visible on the screen
    // and named when acceptance is refused, which is where the reviewer needs it.
    const planCriteria = new Set(criteria.map(({ id }) => id));
    const seen = new Set<string>();
    const scores: SuggestedScore[] = draft.scores.filter(({ criterionId }) => {
      if (!planCriteria.has(criterionId) || seen.has(criterionId)) return false;
      seen.add(criterionId);
      return true;
    });

    const now = this.dependencies.now().toISOString();
    const suggestion: ReviewSuggestion = {
      id: this.dependencies.newId(),
      eventId,
      assignmentId: assignment.id,
      reviewerId: authorized.id,
      proposalId: assignment.proposalId,
      round: assignment.round ?? 1,
      summary: draft.summary,
      scores,
      state: "offered",
      provenance: {
        model: draft.model,
        promptVersion: draft.promptVersion,
        // Ours, not the provider's: a provider must not be able to backdate its own suggestion.
        generatedAt: now,
        proposalRevision: proposalRevisionOf(masked),
      },
      respondedBy: null,
      respondedAt: null,
      createdAt: now,
    };
    await this.dependencies.repository.saveSuggestion(suggestion);
    return suggestion;
  }

  /**
   * Accept or reject a suggestion. This is the human action the whole port is arranged around.
   *
   * **Accepting produces a draft, never a completed evaluation.** The reviewer still has to press
   * Complete, which is a second explicit act and the only thing that moves an aggregate or emits
   * `EVT-REVIEW-COMPLETED`. Two actions rather than one is not ceremony: it is the difference
   * between a reviewer who read a draft and agreed with it, and a reviewer who clicked once.
   *
   * **Rejecting writes no evaluation.** The suggestion row flips to `rejected` with the reviewer's
   * name on it and nothing else changes — the audit record of what was offered and declined,
   * which is the only trace `PRD-AI-001` wants left behind.
   *
   * A suggestion whose values the rubric would refuse is not accepted at all. The reviewer is told
   * which criteria have no usable draft and scores those by hand, rather than being handed a
   * half-populated form whose gaps they have to notice for themselves.
   */
  async respondToSuggestion(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
    suggestionId: string,
    response: "accepted" | "rejected",
    options: { readonly includeSummaryInNotes?: boolean } = {},
  ): Promise<{ suggestion: ReviewSuggestion; evaluation: Evaluation | null }> {
    const authorized = this.reviewer(actor, eventId);
    // The same refusal `requestSuggestion` gives, on the path that answers an *existing* draft.
    // Without it, a deployment that switched the assistant off could still have a stale tab accept
    // a suggestion stored before the switch — which is not what "withdrawn entirely" means, and
    // not what the routes tell every other caller.
    if (!this.dependencies.suggestions)
      throw new SuggestionsDisabledError("AI-assisted review is switched off for this deployment");
    const assignment = await this.ownedAssignment(eventId, assignmentId, authorized.id);
    const suggestion = await this.dependencies.repository.findSuggestion(
      eventId,
      suggestionId,
      authorized.id,
    );
    // A suggestion belonging to another assignment, another reviewer or another event is
    // indistinguishable from one that does not exist (`ARC-AUTH-001`).
    if (!suggestion || suggestion.assignmentId !== assignment.id)
      throw new ReviewNotFoundError("Review suggestion not found");
    if (suggestion.state !== "offered")
      throw new ReviewConflictError("This suggestion has already been answered");
    const respondedAt = this.dependencies.now().toISOString();

    if (response === "rejected") {
      try {
        await this.dependencies.repository.rejectSuggestion(
          suggestion.id,
          authorized.id,
          respondedAt,
        );
      } catch (error) {
        if (error instanceof ReviewStateConflictError)
          throw new ReviewConflictError("This suggestion has already been answered");
        throw error;
      }
      return {
        suggestion: { ...suggestion, state: "rejected", respondedBy: authorized.id, respondedAt },
        evaluation: null,
      };
    }

    if (await this.dependencies.repository.getConflict(assignment.id, authorized.id))
      throw new ReviewConflictError("Conflicted assignments cannot be evaluated");
    // Accepting writes the reviewer's draft, so it is a write into the round and refused once
    // that round closes — the same rule as saving scores by hand, because it produces the same
    // record. Rejecting, above, is not: dismissing an offer left over from a closed round is
    // tidying, and it changes no evaluation.
    const round = await this.workableRound(eventId, assignment.round ?? 1, "round");
    const [plan, existingEvaluation] = await Promise.all([
      this.dependencies.repository.getPlan(eventId),
      this.dependencies.repository.getEvaluation(assignment.id, authorized.id),
    ]);
    const criteria = roundCriteria(round, plan?.criteria);
    if (!criteria.length)
      throw new ReviewValidationError({ plan: ["The organizer has not configured a plan"] });
    if (existingEvaluation?.state === "completed")
      throw new ReviewValidationError({
        evaluation: ["A completed evaluation cannot be replaced by a suggestion"],
      });
    const values = new Map(suggestion.scores.map(({ criterionId, value }) => [criterionId, value]));
    const unusable = criteriaWithoutUsableValue(criteria, values);
    if (unusable.length)
      throw new ReviewValidationError({
        scores: [
          `This suggestion has no usable value for ${unusable.map(({ name }) => name).join(", ")}. Score ${unusable.length === 1 ? "it" : "those"} yourself, or dismiss the suggestion.`,
        ],
      });

    const evaluation: Evaluation = {
      assignmentId: assignment.id,
      reviewerId: authorized.id,
      scores: criteria.map(({ id }) => {
        const value = values.get(id) as number | string;
        return { criterionId: id, value, ...(typeof value === "number" ? { score: value } : {}) };
      }),
      // The summary becomes the reviewer's private notes only when they asked for it on this
      // acceptance. Defaulting it on would put model prose into a field organizers read as the
      // reviewer's own opinion — the quiet version of exactly what this feature must not do.
      notes: options.includeSummaryInNotes
        ? [existingEvaluation?.notes, suggestion.summary].filter(Boolean).join("\n\n")
        : (existingEvaluation?.notes ?? ""),
      // Draft. Always. Completing it is the reviewer's separate act.
      state: "draft",
      updatedAt: respondedAt,
      source: "suggested" satisfies EvaluationSource,
      suggestionId: suggestion.id,
    };
    try {
      await this.dependencies.repository.acceptSuggestion(
        suggestion.id,
        authorized.id,
        respondedAt,
        evaluation,
      );
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewConflictError("This suggestion has already been answered");
      throw error;
    }
    const persisted = await this.dependencies.repository.getEvaluation(
      assignment.id,
      authorized.id,
    );
    if (!persisted) throw new Error("Evaluation persistence did not return a saved record");
    return {
      suggestion: { ...suggestion, state: "accepted", respondedBy: authorized.id, respondedAt },
      evaluation: persisted,
    };
  }

  async declareConflict(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
    reason: string,
  ) {
    const authorized = this.reviewer(actor, eventId);
    const assignment = await this.ownedAssignment(eventId, assignmentId, authorized.id);
    // A conflict is a record about work in this round, so it is refused once the round is history
    // — recusing yourself from a round that finished changes nothing and would rewrite what the
    // organizer already read.
    await this.workableRound(eventId, assignment.round ?? 1, "round");
    if (
      (await this.dependencies.repository.getEvaluation(assignment.id, authorized.id))?.state ===
      "completed"
    )
      throw new ReviewValidationError({
        assignment: ["A completed evaluation cannot be marked conflicted"],
      });
    const conflict = {
      assignmentId: assignment.id,
      reviewerId: authorized.id,
      reason,
      declaredAt: this.dependencies.now().toISOString(),
    };
    try {
      await this.dependencies.repository.saveConflict(conflict);
    } catch (error) {
      if (error instanceof ReviewStateConflictError)
        throw new ReviewValidationError({
          assignment: ["A completed evaluation cannot be marked conflicted"],
        });
      throw error;
    }
    return conflict;
  }

  async saveEvaluation(
    actor: Actor | null,
    eventId: string,
    assignmentId: string,
    input: { scores: readonly EvaluationScore[]; notes: string; complete: boolean },
    correlationId: string,
  ): Promise<Evaluation> {
    const authorized = this.reviewer(actor, eventId);
    const assignment = await this.ownedAssignment(eventId, assignmentId, authorized.id);
    if (await this.dependencies.repository.getConflict(assignment.id, authorized.id))
      throw new ReviewConflictError("Conflicted assignments cannot be evaluated");
    // A closed round is view-only. This is the refusal that makes completed-round history
    // immutable, and it is checked before the scores are looked at so the reviewer is told the
    // round is shut rather than that their perfectly good scores are wrong.
    const round = await this.workableRound(eventId, assignment.round ?? 1, "round");
    const plan = await this.dependencies.repository.getPlan(eventId);
    const criteria = roundCriteria(round, plan?.criteria);
    if (!criteria.length)
      throw new ReviewValidationError({ plan: ["The organizer has not configured a plan"] });
    const scoreMap = new Map(
      input.scores.map((score) => [score.criterionId, score.value ?? score.score]),
    );
    const invalid = criteriaWithoutUsableValue(criteria, scoreMap);
    if (
      invalid.length ||
      scoreMap.size !== criteria.length ||
      input.scores.length !== criteria.length
    )
      throw new ReviewValidationError({
        scores: ["Provide one in-range score for every evaluation criterion"],
      });
    const existingEvaluation = await this.dependencies.repository.getEvaluation(
      assignment.id,
      authorized.id,
    );
    if (existingEvaluation?.state === "completed" && !input.complete)
      throw new ReviewValidationError({
        evaluation: ["A completed evaluation cannot return to draft"],
      });
    const timestamp = this.dependencies.now().toISOString();
    const requestedEvaluation: Evaluation = {
      assignmentId,
      reviewerId: authorized.id,
      scores: criteria.map(({ id }) => {
        const value = scoreMap.get(id) as number | string;
        return { criterionId: id, value, ...(typeof value === "number" ? { score: value } : {}) };
      }),
      notes: input.notes,
      state: input.complete ? "completed" : "draft",
      updatedAt: timestamp,
      ...(input.complete ? { completedAt: timestamp } : {}),
      // Editing a draft that began as an accepted suggestion does not make it hand-written.
      // Provenance describes where the record started, so it is carried forward rather than
      // recomputed from whatever this particular save happens to contain.
      source: existingEvaluation?.source ?? "manual",
      suggestionId: existingEvaluation?.suggestionId ?? null,
    };
    const evaluation =
      existingEvaluation?.state === "completed" ? existingEvaluation : requestedEvaluation;
    if (input.complete) {
      const proposal = await this.dependencies.proposals.find(eventId, assignment.proposalId);
      if (!proposal) throw new ReviewNotFoundError("Proposal not found");
      const scopedEvent = await this.dependencies.events.get(authorized, eventId);
      if (!scopedEvent) throw new ReviewNotFoundError("Event not found");
      const event: ReviewCompletedEvent = {
        type: "EVT-REVIEW-COMPLETED",
        version: 1,
        id: this.dependencies.newId(),
        organizationId: scopedEvent.organizationId,
        eventId,
        proposalId: proposal.id,
        assignmentId,
        reviewerId: authorized.id,
        occurredAt: timestamp,
        correlationId,
        causationId: assignmentId,
      };
      try {
        await this.dependencies.repository.completeEvaluation(evaluation, event);
      } catch (error) {
        if (error instanceof ReviewStateConflictError)
          throw new ReviewConflictError("Conflicted assignments cannot be evaluated");
        throw error;
      }
    } else await this.dependencies.repository.saveEvaluation(evaluation);
    const persisted = await this.dependencies.repository.getEvaluation(
      assignment.id,
      authorized.id,
    );
    if (!persisted) throw new Error("Evaluation persistence did not return a saved record");
    return persisted;
  }

  private async ownedAssignment(eventId: string, assignmentId: string, reviewerId: string) {
    const assignment = await this.dependencies.repository.findAssignment(eventId, assignmentId);
    if (!assignment || assignment.reviewerId !== reviewerId)
      throw new CapabilityDeniedError("Assignment access denied");
    return assignment;
  }
}
