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
import type {
  EventConfigurationSlice,
  SliceEntry,
  SlicePreview,
  SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import { CfpRoutingConfigurationError, type CfpService } from "./cfp-service";

export const CFP_TEMPLATE_SLICE_KEY = "cfp";

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
];

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

    async preview(actor: Actor | null, eventId: string, raw: unknown): Promise<SlicePreview> {
      const payload = readPayload(raw);
      const { usable, refused } = await partitionRouting(service, actor, eventId, payload.routing);
      const current = await service.getForOrganizer(actor, eventId);
      const unchanged = current !== null && matches(current, payload, usable);
      return {
        outcome: "copies",
        reason: unchanged
          ? "The destination CFP already matches this template; applying writes nothing."
          : current
            ? "Replaces the destination's CFP draft. The live published form is untouched."
            : "Creates the destination's CFP draft.",
        copies: [
          { id: "form", label: `Form details: ${payload.title || "untitled"}` },
          ...payload.fields.map((field) => ({ id: field.id, label: `Field: ${field.label}` })),
          ...usable.map((rule) => ({
            id: rule.id,
            label: `Routing rule to “${rule.routeTo.status}”`,
          })),
        ],
        excludes: EXCLUDED,
        incompatible: refused,
      };
    },

    async apply(actor: Actor | null, eventId: string, raw: unknown): Promise<SliceResult> {
      const payload = readPayload(raw);
      const { usable, refused } = await partitionRouting(service, actor, eventId, payload.routing);
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
          ? "Copied as a draft. Routing rules naming statuses the destination does not configure were left out."
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
    { id: "form", label: `Form details: ${payload.title || "untitled"}` },
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
 */
async function partitionRouting(
  service: CfpTemplateCommands,
  actor: Actor | null,
  eventId: string,
  routing: readonly CfpRoutingRule[],
): Promise<{ usable: CfpRoutingRule[]; refused: SliceEntry[] }> {
  if (routing.length === 0) return { usable: [], refused: [] };
  const configured = new Set((await service.routingStatuses(actor, eventId)).map(({ key }) => key));
  const usable: CfpRoutingRule[] = [];
  const refused: SliceEntry[] = [];
  for (const rule of routing)
    if (configured.has(rule.routeTo.status)) usable.push(rule);
    else
      refused.push({
        id: rule.id,
        label: `Routing rule to “${rule.routeTo.status}”, which this event does not configure`,
      });
  return { usable, refused };
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
 * A stored template payload is untrusted input by the time it is applied.
 *
 * It was serialized by this slice, but it has since been at rest in a table an operator can
 * write to, and it reaches `CfpService.save` without passing the Zod schema that guards the
 * HTTP form composer. So it is validated here instead of trusted here.
 */
function readPayload(raw: unknown): CfpTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.title !== "string" || typeof candidate.description !== "string")
    throw unreadable();
  if (!Array.isArray(candidate.fields) || !Array.isArray(candidate.routing ?? []))
    throw unreadable();
  return {
    title: candidate.title,
    description: candidate.description,
    fields: candidate.fields.map(readField),
    routing: ((candidate.routing ?? []) as unknown[]).map(readRule),
  };
}

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
  return {
    fieldId: candidate.fieldId,
    operator: candidate.operator,
    values: candidate.values as string[],
  };
}

function unreadable(): Error {
  return new Error("This template's stored CFP configuration could not be read.");
}
