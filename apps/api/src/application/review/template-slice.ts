/**
 * Review's contribution to a reusable event template.
 *
 * Exactly two things in this domain are configuration an organizer sets up before a single
 * abstract exists: the triage status set (`cfp_statuses`, owned by review) and the scoring
 * rubric (`review_plans.criteria_json`). Everything else review stores describes real proposals
 * — assignments, evaluations, conflicts, outcomes, decisions and the status audit trail — and
 * copying any of it would be inventing an event's history. Rounds belong in that second group
 * rather than in this payload: a round is an integer on an assignment that comes into existence
 * through `advanceRound` over real abstracts, so there is nothing round-shaped to clone.
 *
 * Statuses are written before the rubric, and the composition root orders this slice before
 * CFP's, because a routing rule naming `shortlisted` is only copyable into a destination that
 * configures `shortlisted`.
 *
 * @spec PRD-ABS-001 PRD-REV-001 PRD-EVT-002 ARC-DOM-001
 */
import { RESERVED_PROPOSAL_STATUSES, type ReviewCriterion } from "../../domain/review/review";
import type {
  EventConfigurationSlice,
  SliceEntry,
  SlicePreview,
  SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import { type ReviewService, ReviewValidationError } from "./review-service";

export const REVIEW_TEMPLATE_SLICE_KEY = "review";

interface TemplateStatus {
  readonly key: string;
  readonly label: string;
  readonly sortOrder: number;
}

interface ReviewTemplatePayload {
  readonly statuses: readonly TemplateStatus[];
  /** Empty when the source event never configured a rubric. */
  readonly criteria: readonly ReviewCriterion[];
}

type ReviewTemplateCommands = Pick<
  ReviewService,
  "configurePlan" | "configureStatuses" | "reviewConfiguration"
>;

/**
 * Everything review stores that describes this event's actual proposals, named rather than
 * merely omitted — the preview promises a complete category list, and a category nobody can see
 * was excluded reads as one that was copied. Rounds are on the list because an organizer who
 * ran three rounds will look for them; the entry is where they find out that a round is not a
 * setting.
 */
const EXCLUDED: readonly SliceEntry[] = [
  { id: "assignments", label: "Reviewer assignments" },
  { id: "evaluations", label: "Reviewer scores, drafts and notes" },
  { id: "conflicts", label: "Declared conflicts of interest" },
  { id: "outcomes", label: "Aggregate scores per abstract" },
  { id: "decisions", label: "Accept and decline decisions" },
  {
    id: "rounds",
    label: "Review rounds, which exist only as assignments over abstracts this event received",
  },
  { id: "status-audit", label: "The triage status history" },
];

/** The whole rubric, refused as one thing: `configurePlan` accepts or refuses a criteria list. */
const RUBRIC: SliceEntry = { id: "rubric", label: "The scoring rubric" };

/*
 * The two refusals this slice determines for itself, written once so that what a preview
 * promises and what an apply reports are the same sentence rather than two paraphrases an
 * organizer has to reconcile. Present tense reads correctly in both.
 */
const STATUSES_IN_USE_REFUSAL =
  "Abstracts in the destination hold triage statuses this template does not configure, so its status set is left as it is.";
const RUBRIC_LOCKED_REFUSAL =
  "Reviewers in the destination already hold assignments scored against different criteria, and the rubric is locked once that is true, so the template's rubric is not applied.";

export function reviewTemplateSlice(service: ReviewTemplateCommands): EventConfigurationSlice {
  return {
    key: REVIEW_TEMPLATE_SLICE_KEY,
    label: "Triage statuses and scoring rubric",

    async export(actor: Actor | null, eventId: string): Promise<unknown | null> {
      const { plan, statuses } = await service.reviewConfiguration(actor, eventId);
      // `accepted`/`declined` are the decision vocabulary the content domain acts on rather than
      // anything an organizer set up, so an event whose stored set holds only those — or holds
      // nothing yet — and which has no rubric has nothing to contribute. Saying so leaves the key
      // out of the payload entirely, which is what the orchestrator reports as `empty`.
      if (!plan && statuses.every(({ key }) => isReserved(key))) return null;
      const payload: ReviewTemplatePayload = {
        statuses: statuses.map(({ key, label, sortOrder }) => ({ key, label, sortOrder })),
        criteria: plan?.criteria ?? [],
      };
      return payload;
    },

    async preview(actor: Actor | null, eventId: string, raw: unknown): Promise<SlicePreview> {
      const payload = readPayload(raw);
      const destination = await assess(service, actor, eventId, payload);
      const statusesRefused = destination.statusesInUse.length > 0;
      const copies = [
        ...(statusesRefused ? [] : statusEntries(destination.desired)),
        ...(destination.rubricLocked ? [] : criterionEntries(payload.criteria)),
      ];
      const incompatible = [
        ...destination.statusesInUse,
        ...(destination.rubricLocked ? [RUBRIC] : []),
      ];
      return {
        /*
         * A refused half makes the whole category `incompatible`, which is where this slice
         * parts company with CFP's — there, a dropped routing rule leaves a form that is still
         * the form. Here each half is a whole thing: a destination whose evaluation criteria are
         * not the template's has not had this category applied, and reporting it as copied would
         * be a false statement in the one surface an organizer checks before trusting the clone.
         */
        outcome: incompatible.length ? "incompatible" : "copies",
        reason:
          refusals(destination).join(" ") ||
          (destination.unchanged
            ? "The destination already matches this template; applying writes nothing."
            : `Replaces the destination's triage statuses${payload.criteria.length ? " and its scoring rubric" : ""}. Nothing about abstracts already submitted there is touched.`),
        copies,
        excludes: EXCLUDED,
        incompatible,
      };
    },

    async apply(actor: Actor | null, eventId: string, raw: unknown): Promise<SliceResult> {
      const payload = readPayload(raw);
      const destination = await assess(service, actor, eventId, payload);
      /*
       * Re-applying converges *and* writes nothing.
       *
       * `configurePlan` stamps `updatedAt` on every call and `configureStatuses` rewrites every
       * row it is given, so a second apply of the same template would leave byte-different
       * storage for no change in configuration. Comparing first is what makes "apply twice, then
       * compare" a meaningful assertion instead of one that has to make an exception for a
       * timestamp.
       */
      if (destination.unchanged)
        return {
          outcome: "applied",
          reason: "Already identical to the template; nothing needed to be written.",
          applied: appliedEntries(destination.desired, payload.criteria),
          incompatible: [],
        };
      // Statuses first: the rubric does not depend on them, but CFP's routing rules do, and a
      // half-applied clone should leave the destination in the state the next slice expects.
      const statuses = await applyStatuses(service, actor, eventId, destination);
      const rubric = await applyRubric(service, actor, eventId, payload, destination);
      const incompatible = [...statuses.incompatible, ...rubric.incompatible];
      return {
        outcome: incompatible.length ? "incompatible" : "applied",
        reason:
          [statuses.refusal, rubric.refusal].filter((sentence) => sentence !== null).join(" ") ||
          `Copied the triage statuses${payload.criteria.length ? " and the scoring rubric" : ""}.`,
        applied: [...statuses.applied, ...rubric.applied],
        incompatible,
      };
    },
  };
}

/** One half of this category: what the destination now has, and what it would not take. */
interface HalfResult {
  readonly applied: readonly SliceEntry[];
  readonly incompatible: readonly SliceEntry[];
  /** The organizer's answer when the destination refused, or null when it did not. */
  readonly refusal: string | null;
}

async function applyStatuses(
  service: ReviewTemplateCommands,
  actor: Actor | null,
  eventId: string,
  destination: Assessment,
): Promise<HalfResult> {
  if (destination.statusesInUse.length)
    return {
      applied: [],
      incompatible: destination.statusesInUse,
      refusal: STATUSES_IN_USE_REFUSAL,
    };
  if (!destination.statusesNeedWriting)
    return { applied: statusEntries(destination.desired), incompatible: [], refusal: null };
  try {
    await service.configureStatuses(actor, eventId, destination.desired);
  } catch (error) {
    // ERROR-INTENT: A status set the destination will not accept is the issue's "incompatible"
    // category, not a fault — a validation refusal is the organizer's answer, not a 500. The
    // check above already reports the in-use case, so reaching here means the destination's
    // abstracts moved underneath us, and review's own sentence is carried back rather than
    // discarded.
    if (error instanceof ReviewValidationError)
      return {
        applied: [],
        incompatible: statusEntries(destination.desired),
        refusal: refusalOf(error),
      };
    throw error;
  }
  return { applied: statusEntries(destination.desired), incompatible: [], refusal: null };
}

async function applyRubric(
  service: ReviewTemplateCommands,
  actor: Actor | null,
  eventId: string,
  payload: ReviewTemplatePayload,
  destination: Assessment,
): Promise<HalfResult> {
  if (destination.rubricLocked)
    return { applied: [], incompatible: [RUBRIC], refusal: RUBRIC_LOCKED_REFUSAL };
  if (!destination.rubricNeedsWriting)
    return { applied: criterionEntries(payload.criteria), incompatible: [], refusal: null };
  try {
    await service.configurePlan(actor, eventId, payload.criteria);
  } catch (error) {
    // ERROR-INTENT: Belt and braces for the same reason `applyStatuses` catches — the lock is
    // detected above rather than provoked, so this answers a rubric that locked between the read
    // and the write, and any other refusal `configurePlan` makes about the criteria themselves.
    if (error instanceof ReviewValidationError)
      return { applied: [], incompatible: [RUBRIC], refusal: refusalOf(error) };
    throw error;
  }
  return { applied: criterionEntries(payload.criteria), incompatible: [], refusal: null };
}

/** What the destination would do with this payload, read once and answered without writing. */
interface Assessment {
  /** The status set as `configureStatuses` would store it, reserved keys completed. */
  readonly desired: readonly TemplateStatus[];
  readonly statusesNeedWriting: boolean;
  readonly rubricNeedsWriting: boolean;
  readonly rubricLocked: boolean;
  /** Statuses abstracts in the destination hold that this template does not configure. */
  readonly statusesInUse: readonly SliceEntry[];
  readonly unchanged: boolean;
}

async function assess(
  service: ReviewTemplateCommands,
  actor: Actor | null,
  eventId: string,
  payload: ReviewTemplatePayload,
): Promise<Assessment> {
  /*
   * The one read both `preview` and `apply` work from, and the authorization check for both:
   * an actor without `review:manage` on the destination leaves through `CapabilityDeniedError`,
   * which the orchestrator turns into `unauthorized` for this category alone.
   *
   * It is `reviewConfiguration` rather than the organizer workspace because that read completes
   * an event's missing reserved statuses in storage, and a preview that wrote to the destination
   * it is describing would be a preview in name only.
   */
  const {
    hasAssignments,
    plan,
    statuses,
    statusesInUse: heldStatuses,
  } = await service.reviewConfiguration(actor, eventId);
  const desired = withReserved(payload.statuses);
  const statusesNeedWriting = canonicalStatuses(statuses) !== canonicalStatuses(desired);
  const keys = new Set(desired.map(({ key }) => key));
  const labels = new Map(statuses.map(({ key, label }) => [key, label]));
  /*
   * `configureStatuses` refuses a set that omits a status some proposal currently holds, and
   * `saveStatuses` deletes the keys the set leaves out, so in a destination with abstracts in
   * flight that refusal is a real "incompatible" rather than a fault. It is determined here
   * because a preview has to state it too, and a preview cannot catch a throw it never causes.
   *
   * A set that needs no write cannot be refused, which is why this is empty in that case: the
   * destination is already storing these statuses, whatever its abstracts hold.
   */
  const statusesInUse = statusesNeedWriting
    ? heldStatuses
        .filter((status) => !keys.has(status))
        .map((status) => ({
          id: `status:${status}`,
          label: `Triage status “${labels.get(status) ?? status}”, which abstracts in this event currently hold`,
        }))
    : [];
  // The rubric is compared exactly as `configurePlan` compares it, so this slice's verdict and
  // the service's own lock can never disagree about whether two rubrics are the same.
  const rubricMatches =
    plan !== null && JSON.stringify(plan.criteria) === JSON.stringify(payload.criteria);
  const rubricNeedsWriting = payload.criteria.length > 0 && !rubricMatches;
  return {
    desired,
    statusesNeedWriting,
    rubricNeedsWriting,
    rubricLocked: rubricNeedsWriting && plan !== null && hasAssignments,
    statusesInUse,
    unchanged: !statusesNeedWriting && !rubricNeedsWriting,
  };
}

/** What a preview says about the same two refusals, before anything is attempted. */
const refusals = (destination: Assessment): readonly string[] => [
  ...(destination.statusesInUse.length ? [STATUSES_IN_USE_REFUSAL] : []),
  ...(destination.rubricLocked ? [RUBRIC_LOCKED_REFUSAL] : []),
];

/**
 * `ReviewValidationError.message` is the constant "Review data is invalid"; the sentence an
 * organizer can act on is in `fields`. Flattening it is what makes the reported reason the
 * domain's own answer rather than a label.
 */
function refusalOf(error: ReviewValidationError): string {
  const sentences = Object.values(error.fields).flat();
  return sentences.length ? sentences.join(" ") : error.message;
}

const isReserved = (key: string): boolean =>
  RESERVED_PROPOSAL_STATUSES.some((status) => status.key === key);

/**
 * The payload's statuses as `configureStatuses` will store them.
 *
 * That command completes rather than rejects a set missing the reserved decision keys, so a
 * payload written before those existed — or edited by hand — must be compared against the
 * destination in its completed form. Comparing the raw list would report a difference that
 * applying could never close, and this slice would write on every apply forever.
 */
function withReserved(statuses: readonly TemplateStatus[]): readonly TemplateStatus[] {
  const keys = new Set(statuses.map(({ key }) => key));
  return [...statuses, ...RESERVED_PROPOSAL_STATUSES.filter(({ key }) => !keys.has(key))];
}

/**
 * Order-insensitive: D1 returns statuses ordered by `(sort_order, key)` while a payload carries
 * whatever order it was captured in, and a difference in array order is not a difference in
 * configuration. Sorting by key first compares the three fields that are.
 */
const canonicalStatuses = (statuses: readonly TemplateStatus[]): string =>
  JSON.stringify(
    [...statuses]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key, label, sortOrder }) => [key, label, sortOrder]),
  );

const statusEntries = (statuses: readonly TemplateStatus[]): readonly SliceEntry[] =>
  statuses.map(({ key, label }) => ({ id: `status:${key}`, label: `Triage status: ${label}` }));

const criterionEntries = (criteria: readonly ReviewCriterion[]): readonly SliceEntry[] =>
  criteria.map(({ id, name }) => ({ id: `criterion:${id}`, label: `Rubric criterion: ${name}` }));

const appliedEntries = (
  statuses: readonly TemplateStatus[],
  criteria: readonly ReviewCriterion[],
): readonly SliceEntry[] => [...statusEntries(statuses), ...criterionEntries(criteria)];

/**
 * A stored template payload is untrusted input by the time it is applied.
 *
 * It was serialized by this slice, but it has since been at rest in a table an operator can
 * write to, and it reaches `configureStatuses` and `configurePlan` without passing the Zod
 * schemas that guard review's HTTP surface. So it is validated here instead of trusted here.
 */
function readPayload(raw: unknown): ReviewTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.statuses) || !Array.isArray(candidate.criteria)) throw unreadable();
  return {
    statuses: candidate.statuses.map(readStatus),
    criteria: candidate.criteria.map(readCriterion),
  };
}

function readStatus(raw: unknown): TemplateStatus {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.sortOrder !== "number"
  )
    throw unreadable();
  return { key: candidate.key, label: candidate.label, sortOrder: candidate.sortOrder };
}

function readCriterion(raw: unknown): ReviewCriterion {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.description !== "string" ||
    (candidate.weight !== undefined && typeof candidate.weight !== "number")
  )
    throw unreadable();
  const shared = {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    ...(typeof candidate.weight === "number" ? { weight: candidate.weight } : {}),
  };
  if (candidate.type === "dropdown") {
    if (
      !Array.isArray(candidate.options) ||
      candidate.options.some((option) => typeof option !== "string")
    )
      throw unreadable();
    return { ...shared, type: "dropdown", options: candidate.options as string[] };
  }
  if (candidate.type === "text") {
    if (typeof candidate.maxLength !== "number") throw unreadable();
    return { ...shared, type: "text", maxLength: candidate.maxLength };
  }
  if (
    (candidate.type !== undefined && candidate.type !== "numeric") ||
    typeof candidate.minScore !== "number" ||
    typeof candidate.maxScore !== "number"
  )
    throw unreadable();
  // An absent `type` is the numeric shape stored before dropdown and text criteria existed, and
  // it is left absent rather than filled in: the destination's stored rubric is compared to this
  // payload with `JSON.stringify`, and a key this slice added on the way through would make an
  // identical rubric read as a different one and never converge.
  return candidate.type === "numeric"
    ? {
        ...shared,
        type: "numeric",
        minScore: candidate.minScore,
        maxScore: candidate.maxScore,
      }
    : { ...shared, minScore: candidate.minScore, maxScore: candidate.maxScore };
}

function unreadable(): Error {
  return new Error("This template's stored review configuration could not be read.");
}
