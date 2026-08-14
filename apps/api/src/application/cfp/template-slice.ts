/**
 * CFP's contribution to a reusable event template.
 *
 * The form composer is the cleanest slice in the system to clone: `cfp_forms` is one row per
 * event keyed by `event_id`, and `CfpService.save` already forces `status: "draft"` and
 * `publishedAt: null`, which is exactly what a clone should produce. Nothing here reaches
 * another domain's tables, and events never learns what a CFP field is — it holds this payload
 * as opaque JSON (`ARC-FLOW-006`).
 *
 * @spec PRD-CFP-001 PRD-EVT-002 ARC-DOM-001
 */
import type { CfpField, CfpFieldType, CfpRoutingRule } from "../../domain/cfp/cfp";
import {
  type DateRemap,
  type EventConfigurationSlice,
  type SliceContext,
  type SliceEntry,
  type SlicePreview,
  type SliceProvision,
  SliceRefusalError,
  type SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import { CfpRoutingConfigurationError, type CfpService } from "./cfp-service";

export const CFP_TEMPLATE_SLICE_KEY = "cfp";

/**
 * The one fact this slice depends on another category for, taken from the seam's own vocabulary
 * rather than from the review domain: CFP must not reach into review's modules, and what review's
 * statuses actually are stays review's business either way.
 *
 * It is a provision rather than review's slice key on purpose. A key would only say "review is
 * running", and review runs — reporting `incompatible` — both when it writes the status set and
 * when it leaves it alone, which are opposite answers to the only question asked here.
 */
const REVIEW_TRIAGE_STATUSES: SliceProvision = "review:triage-statuses";

/**
 * The two destinations a routing rule may never name, restated for the same reason the provision
 * above is: CFP must not reach into review's modules. `CfpService` holds the same pair.
 */
const DECISION_STATUSES: readonly string[] = ["accepted", "declined"];

interface CfpTemplatePayload {
  readonly title: string;
  readonly description: string;
  readonly fields: readonly CfpField[];
  readonly routing: readonly CfpRoutingRule[];
}

type CfpTemplateCommands = Pick<CfpService, "getForOrganizer" | "routingStatuses" | "save">;

/**
 * The published snapshot, and everything derived from applicants, are named here rather than
 * merely omitted — the preview promises to list every excluded category, and a category nobody
 * can see was excluded reads as one that was copied.
 */
const EXCLUDED: readonly SliceEntry[] = [
  { id: "published", label: "The live published form and its publication date" },
  { id: "submissions", label: "Submitted proposals and their answers" },
  /*
   * The window is excluded rather than remapped, and it is the one exclusion here that had a real
   * alternative. `DateRemap` exists precisely to shift a template's dates onto a new event's
   * range, and a deadline is a date — so remapping it would have "worked".
   *
   * It would also have announced a deadline nobody chose. A submission deadline is a commitment
   * made to a specific audience; derived from a previous conference's dates it is arithmetic
   * presented as a promise, and the applicant cannot tell the difference. A destination whose
   * window is absent reads as an unbounded call, which is both true and visibly unfinished, so
   * the organizer sets one deliberately.
   */
  { id: "window", label: "The scheduled submission window (open and close timestamps)" },
];

/** Said whenever review is applying first, because then it, not this event, decides the rules. */
const ROUTING_FOLLOWS_STATUSES =
  "Its routing rules are checked against the triage statuses the review category writes first, not against the statuses this event configures today.";

export function cfpTemplateSlice(service: CfpTemplateCommands): EventConfigurationSlice {
  return {
    key: CFP_TEMPLATE_SLICE_KEY,
    label: "CFP form and routing",

    async export(actor: Actor | null, eventId: string): Promise<unknown | null> {
      const form = await service.getForOrganizer(actor, eventId);
      if (!form) return null;
      const payload: CfpTemplatePayload = {
        title: form.title,
        description: form.description,
        fields: form.fields,
        routing: form.routing ?? [],
      };
      return payload;
    },

    async preview(
      actor: Actor | null,
      eventId: string,
      raw: unknown,
      _remap: DateRemap,
      context: SliceContext,
    ): Promise<SlicePreview> {
      const payload = readPayload(raw);
      /*
       * What this preview cannot know, stated rather than guessed.
       *
       * Review writes the destination's triage statuses before this slice runs, and only that
       * one fact crosses the boundary — never its payload, and not even its verdict. So a rule
       * naming a status the destination is missing today is copyable by the time the write
       * happens, and a rule naming one the destination holds today is not, if review's set turns
       * out to drop it. Both directions are the same fact: while review is writing that set, it
       * is the one the rules are checked against, and the preview says so instead of predicting
       * which rules survive it.
       */
      const statusesArriving = context.providedBefore.includes(REVIEW_TRIAGE_STATUSES);
      const { usable, pending, refused } = await partitionRouting(
        service,
        actor,
        eventId,
        payload.routing,
        statusesArriving,
      );
      const current = await service.getForOrganizer(actor, eventId);
      // "Applying writes nothing" is a claim about a destination nothing else is about to change,
      // so it is not made while review is rewriting the status set these rules are validated
      // against: the rules that set adds or drops are exactly the ones apply would then write.
      const dependsOnStatuses = statusesArriving && payload.routing.length > 0;
      const unchanged = !dependsOnStatuses && current !== null && matches(current, payload, usable);
      return {
        outcome: "copies",
        reason: [
          unchanged
            ? "The destination CFP already matches this template; applying writes nothing."
            : current
              ? "Replaces the destination's CFP draft. The live published form is untouched."
              : "Creates the destination's CFP draft.",
          ...(dependsOnStatuses ? [ROUTING_FOLLOWS_STATUSES] : []),
        ].join(" "),
        copies: [
          { id: "form", label: `Form details: ${payload.title}` },
          ...payload.fields.map((field) => ({ id: field.id, label: `Field: ${field.label}` })),
          ...usable.map((rule) => ({
            id: rule.id,
            label: `Routing rule to “${rule.routeTo.status}”`,
          })),
          ...pending.map((rule) => ({
            id: rule.id,
            label: `Routing rule to “${rule.routeTo.status}”, once the triage statuses category creates that status`,
          })),
        ],
        excludes: EXCLUDED,
        incompatible: refused,
      };
    },

    async apply(actor: Actor | null, eventId: string, raw: unknown): Promise<SliceResult> {
      const payload = readPayload(raw);
      // No `appliedBefore` here: apply runs after the categories before it have written, so the
      // destination it reads is already the one the rules have to satisfy.
      const { usable, refused } = await partitionRouting(
        service,
        actor,
        eventId,
        payload.routing,
        false,
      );
      const current = await service.getForOrganizer(actor, eventId);
      /*
       * Re-applying converges *and* writes nothing.
       *
       * `CfpService.save` allocates the next optimistic-concurrency version on every call, so a
       * second apply of the same template would leave a byte-different row for no change in
       * configuration. Comparing first is what makes "apply twice, then compare" a meaningful
       * assertion instead of one that has to make an exception for a counter.
       */
      if (current && matches(current, payload, usable))
        return {
          outcome: "applied",
          reason: "Already identical to the template; nothing needed to be written.",
          applied: appliedEntries(payload, usable),
          incompatible: refused,
        };
      try {
        await service.save(actor, {
          eventId,
          title: payload.title,
          description: payload.description,
          fields: payload.fields,
          routing: usable,
          expectedVersion: current?.version ?? 0,
        });
      } catch (error) {
        // ERROR-INTENT: A routing status the destination does not configure is the issue's
        // "incompatible" category, not a fault. `partitionRouting` removes those before this
        // call, so reaching here means the destination's status set changed underneath us —
        // reported with the CFP's own message rather than raised as a 500.
        if (error instanceof CfpRoutingConfigurationError)
          return {
            outcome: "incompatible",
            reason: error.message,
            applied: [],
            incompatible: [
              ...refused,
              ...usable.map((rule) => ({
                id: rule.id,
                label: `Routing rule to “${rule.routeTo.status}”`,
              })),
            ],
          };
        throw error;
      }
      return {
        outcome: "applied",
        reason: refused.length
          ? // Two different things get refused here — a status this event does not configure, and a
            // status that is a *decision* and so is never routed to — and each refused rule already
            // carries its own reason in `incompatible`. This sentence used to name only the first,
            // so an organizer whose template routed to `accepted` was told the destination does not
            // configure it, directly beside a line saying the opposite. It now points at the list
            // rather than paraphrasing half of it.
            "Copied as a draft. Some routing rules were left out; each is listed with its reason."
          : "Copied as a draft.",
        applied: appliedEntries(payload, usable),
        incompatible: refused,
      };
    },
  };
}

function appliedEntries(
  payload: CfpTemplatePayload,
  usable: readonly CfpRoutingRule[],
): readonly SliceEntry[] {
  return [
    { id: "form", label: `Form details: ${payload.title}` },
    ...payload.fields.map((field) => ({ id: field.id, label: `Field: ${field.label}` })),
    ...usable.map((rule) => ({ id: rule.id, label: `Routing rule to “${rule.routeTo.status}”` })),
  ];
}

/**
 * Split routing rules into the ones the destination can accept and the ones it cannot.
 *
 * `CfpService.save` refuses the whole form if *any* rule names an unconfigured status, so the
 * choice is between copying nothing and copying the form without those rules. The second is
 * what the issue asks for — every rule dropped is named back to the organizer — and it is why
 * the review slice's triage statuses must apply before this one.
 *
 * `statusesArriving` is that ordering, seen from here: a status the destination is missing while
 * review is still to write is not a refusal but a dependency, and it is `pending` rather than
 * `refused` so that the preview promises what the apply will do. Only a preview passes it — an
 * apply reads the statuses after review wrote them.
 *
 * **A decision destination is refused for a second reason, and it took a regression to find.**
 * `accepted` and `declined` are configured on every event (migration `0021`), so a rule naming one
 * passed the check above and went into `usable` — and `CfpService.save` now refuses such a rule
 * outright, because reaching a decision is the effect of a *recorded* decision and the submitter's
 * dashboard reads that status. So a template captured from an event that already held such a rule
 * previewed as "copies", then discarded the **whole CFP category** on apply: no form, no fields, no
 * title. Partitioning on it here restores this module's own promise — every rule dropped is named
 * back to the organizer, and the form arrives without it.
 */
async function partitionRouting(
  service: CfpTemplateCommands,
  actor: Actor | null,
  eventId: string,
  routing: readonly CfpRoutingRule[],
  statusesArriving: boolean,
): Promise<{ usable: CfpRoutingRule[]; pending: CfpRoutingRule[]; refused: SliceEntry[] }> {
  if (routing.length === 0) return { usable: [], pending: [], refused: [] };
  const configured = new Set((await service.routingStatuses(actor, eventId)).map(({ key }) => key));
  const usable: CfpRoutingRule[] = [];
  const pending: CfpRoutingRule[] = [];
  const refused: SliceEntry[] = [];
  for (const rule of routing)
    if (DECISION_STATUSES.includes(rule.routeTo.status))
      refused.push({
        id: rule.id,
        label: `Routing rule to “${rule.routeTo.status}”, which is recorded by an accept or decline rather than by routing`,
      });
    else if (configured.has(rule.routeTo.status)) usable.push(rule);
    else if (statusesArriving) pending.push(rule);
    else
      refused.push({
        id: rule.id,
        label: `Routing rule to “${rule.routeTo.status}”, which this event does not configure`,
      });
  return { usable, pending, refused };
}

function matches(
  current: { title: string; description: string; fields: readonly CfpField[]; routing?: unknown },
  payload: CfpTemplatePayload,
  usable: readonly CfpRoutingRule[],
): boolean {
  return (
    current.title === payload.title &&
    current.description === payload.description &&
    JSON.stringify(current.fields) === JSON.stringify(payload.fields) &&
    JSON.stringify(current.routing ?? []) === JSON.stringify(usable)
  );
}

const FIELD_TYPES: readonly CfpFieldType[] = ["short_text", "long_text", "email", "select"];

/**
 * The form's shape limits, as `cfpFieldSchema`, `cfpFieldsSchema` and `saveCfpInputSchema` state
 * them in `packages/contracts/src/domains/cfp.ts`. Repeated rather than imported because the
 * application layer may import no external package — the same reason the domain repeats
 * `CFP_FIELD_MAX_LENGTHS` — so the two must stay in agreement.
 */
const LIMIT = {
  answer: 10_000,
  description: 2_000,
  fields: 40,
  guidance: 500,
  id: 80,
  label: 120,
  option: 120,
  options: 30,
  routing: 20,
  title: 120,
  value: 120,
  values: 30,
} as const;

/**
 * A stored template payload is untrusted input by the time it is applied.
 *
 * It was serialized by this slice, but it has since been at rest in a table an operator can
 * write to, and it reaches `CfpService.save` without passing the Zod schema that guards the
 * HTTP form composer. So it is validated here instead of trusted here.
 *
 * "Validated" means every invariant that decides whether the result is a form the composer would
 * have accepted: its bounds, unique ids, a `select` with something to select, and a condition
 * that names a question the applicant has already been asked. What is deliberately *not*
 * duplicated is the schema's normalisation — the `.trim()` and `.default()` steps that rewrite a
 * value on the way through. This reader answers whether a payload is usable, and rewriting it
 * would break the comparison the slice converges on: a payload edited here would differ from the
 * form the destination stores, so every apply would write again forever.
 */
function readPayload(raw: unknown): CfpTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.title !== "string" || typeof candidate.description !== "string")
    throw unreadable();
  if (!Array.isArray(candidate.fields) || !Array.isArray(candidate.routing ?? []))
    throw unreadable();
  if (
    !within(candidate.title.trim(), 1, LIMIT.title) ||
    candidate.description.trim().length > LIMIT.description
  )
    throw unreadable();
  return whole({
    title: candidate.title,
    description: candidate.description,
    fields: candidate.fields.map(readField),
    routing: ((candidate.routing ?? []) as unknown[]).map(readRule),
  });
}

/**
 * The invariants that are about the form rather than about one field or one rule, which is why
 * they are checked once the parts have been read: a duplicate id, a condition pointing forwards,
 * and a rule routing on a question this form does not ask are all refusals `CfpService.save`
 * makes no attempt at, because at the HTTP boundary the schema had already made them.
 */
function whole(payload: CfpTemplatePayload): CfpTemplatePayload {
  if (payload.fields.length < 1 || payload.fields.length > LIMIT.fields) throw unreadable();
  if (payload.routing.length > LIMIT.routing) throw unreadable();
  const fieldIds = new Set<string>();
  payload.fields.forEach((field, index) => {
    if (fieldIds.has(field.id)) throw unreadable();
    fieldIds.add(field.id);
    if (field.type === "select" && field.options.length === 0) throw unreadable();
    // A question can only be shown or hidden by an answer the applicant has already given, so the
    // condition's source must sit earlier in the list.
    if (field.visibleWhen && !earlier(payload.fields, field.visibleWhen.fieldId, index))
      throw unreadable();
  });
  const ruleIds = new Set<string>();
  for (const rule of payload.routing) {
    if (ruleIds.has(rule.id) || !fieldIds.has(rule.when.fieldId)) throw unreadable();
    ruleIds.add(rule.id);
  }
  return payload;
}

const earlier = (fields: readonly CfpField[], fieldId: string, index: number): boolean => {
  const source = fields.findIndex(({ id }) => id === fieldId);
  return source >= 0 && source < index;
};

const within = (value: string, min: number, max: number): boolean =>
  value.length >= min && value.length <= max;

const counted = (value: unknown, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

function readField(raw: unknown): CfpField {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.guidance !== "string" ||
    typeof candidate.required !== "boolean" ||
    !FIELD_TYPES.includes(candidate.type as CfpFieldType) ||
    !Array.isArray(candidate.options) ||
    candidate.options.some((option) => typeof option !== "string")
  )
    throw unreadable();
  if (
    !within(candidate.id, 1, LIMIT.id) ||
    !within(candidate.label.trim(), 1, LIMIT.label) ||
    candidate.guidance.trim().length > LIMIT.guidance ||
    candidate.options.length > LIMIT.options ||
    (candidate.options as string[]).some((option) => !within(option.trim(), 1, LIMIT.option)) ||
    (candidate.maxLength !== undefined && !counted(candidate.maxLength, LIMIT.answer))
  )
    throw unreadable();
  return {
    id: candidate.id,
    type: candidate.type as CfpFieldType,
    label: candidate.label,
    guidance: candidate.guidance,
    required: candidate.required,
    options: candidate.options as string[],
    ...(typeof candidate.maxLength === "number" ? { maxLength: candidate.maxLength } : {}),
    ...(candidate.visibleWhen === undefined
      ? {}
      : { visibleWhen: readCondition(candidate.visibleWhen) }),
  };
}

function readRule(raw: unknown): CfpRoutingRule {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  const routeTo = candidate.routeTo as Record<string, unknown> | undefined;
  if (typeof candidate.id !== "string" || typeof routeTo?.status !== "string") throw unreadable();
  if (!within(candidate.id, 1, LIMIT.id) || !within(routeTo.status.trim(), 1, LIMIT.id))
    throw unreadable();
  return {
    id: candidate.id,
    when: readCondition(candidate.when),
    routeTo: { status: routeTo.status },
  };
}

function readCondition(raw: unknown): CfpRoutingRule["when"] {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.fieldId !== "string" ||
    (candidate.operator !== "equals" &&
      candidate.operator !== "in" &&
      candidate.operator !== "notEmpty") ||
    !Array.isArray(candidate.values) ||
    candidate.values.some((value) => typeof value !== "string")
  )
    throw unreadable();
  if (
    !within(candidate.fieldId, 1, LIMIT.id) ||
    candidate.values.length > LIMIT.values ||
    (candidate.values as string[]).some((value) => value.length > LIMIT.value)
  )
    throw unreadable();
  return {
    fieldId: candidate.fieldId,
    operator: candidate.operator,
    values: candidate.values as string[],
  };
}

/**
 * A refusal, not a fault: what this reader turns down is a fixed property of bytes already at
 * rest, so the orchestrator's generic "apply this version again" would be false advice and an
 * operator paged for it would find nothing broken. The organizer is told which category of which
 * version to recapture instead, which is the only act that changes the answer.
 */
function unreadable(): SliceRefusalError {
  return new SliceRefusalError("This template's stored CFP configuration could not be read.");
}
