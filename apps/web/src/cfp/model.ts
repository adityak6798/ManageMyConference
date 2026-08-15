/*
 * Call for proposals composer.
 *
 * This is the public front door of the product: whatever is published here is the
 * form applicants actually fill in, so the surface is built around the two ways it
 * used to mislead the organizer.
 *
 * 1. "Draft saved." rendered roughly 750px below the button that caused it and was
 *    never announced. Every outcome now goes through useActionFeedback(), which
 *    keeps the confirmation beside the toolbar and inside a live region.
 * 2. Saving an edit to a published form forks the draft away from the snapshot the
 *    public is still submitting against — the API keeps serving the old published
 *    version until the organizer publishes again. That divergence used to be
 *    invisible, so the composer shows the live published form next to the draft and
 *    states, in words, which one applicants can see.
 */

import {
  type CfpField,
  type CfpRoutingRule,
  cfpConditionMatches,
  publicationPreviewResponseSchema,
} from "@greenroom/contracts";
import { CfpApiError } from "../api/cfp";
import "../styles/cfp.css";

const DEFAULT_TITLE = "Call for proposals";

/**
 * The two statuses a routing rule may not name, mirrored from the review domain's reserved keys.
 *
 * Migration `0021` configures both on every event, so they pass "is this a configured status" and
 * used to appear in the routing destination dropdown. Reaching one is the *effect* of a recorded
 * decision — it is what creates the session and notifies the submitter — so a rule that assigned it
 * told an applicant they had been accepted with nothing behind it. `CfpService.save` refuses such a
 * rule; this keeps the control from offering one. Restated rather than imported for the same reason
 * `MemorySubmittedProposalAdapter` restates them: the CFP surface does not reach into review.
 */
const DECISION_STATUSES = ["accepted", "declined"];

const starter: CfpField[] = [
  {
    id: "title",
    type: "short_text",
    label: "Proposal title",
    guidance: "A clear, specific title",
    required: true,
    options: [],
  },
];

const FIELD_TYPES: { value: CfpField["type"]; label: string }[] = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "select", label: "Single select" },
];

const typeLabel = (type: CfpField["type"]) =>
  FIELD_TYPES.find((entry) => entry.value === type)?.label ?? type;

type FormShape = {
  title: string;
  description: string;
  fields: readonly CfpField[];
  routing?: readonly CfpRoutingRule[];
};

/**
 * Canonical form of the editable document. Comparing two of these is how the
 * composer knows whether the editor is ahead of the saved draft, and whether the
 * saved draft is ahead of the snapshot the public is being served.
 */
function shape(input: FormShape): string {
  return JSON.stringify({
    title: input.title.trim(),
    description: input.description.trim(),
    fields: input.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label.trim(),
      guidance: field.guidance.trim(),
      required: field.required,
      options: field.options.map((option) => option.trim()),
      choices: field.choices?.map(({ id, label, active }) => ({ id, label: label.trim(), active })),
      visibleWhen: field.visibleWhen,
    })),
    routing: input.routing ?? [],
  });
}

/**
 * Zod throws when the API sends a payload the contract does not describe. That used
 * to collapse into "Something went wrong", which tells nobody which field broke, so
 * the offending path is surfaced instead. Detected structurally to keep zod out of
 * the web app's runtime dependencies.
 */
function schemaIssue(reason: unknown): string | null {
  if (!(reason instanceof Error) || reason.name !== "ZodError") return null;
  const { issues } = reason as {
    issues?: { path?: PropertyKey[]; message?: string }[];
  };
  const first = issues?.[0];
  if (!first) return "the response did not match the published contract";
  const path = (first.path ?? []).join(".") || "response body";
  return `${path} — ${first.message ?? "unexpected value"}`;
}

function describe(reason: unknown, fallback: string): string {
  if (reason instanceof CfpApiError)
    return `${reason.message} Reference: ${reason.envelope.error.correlationId}`;
  const issue = schemaIssue(reason);
  if (issue)
    return `The server sent a call for proposals this app could not read (${issue}). Nothing was changed.`;
  if (reason instanceof Error && reason.message) return `${fallback} (${reason.message})`;
  return fallback;
}

const isNotFound = (reason: unknown) =>
  reason instanceof CfpApiError && reason.envelope.error.code === "NOT_FOUND";

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** The organizer-only publication preview is the only place the public slug lives. */
async function loadPublicSubmissionUrl(eventId: string): Promise<string | null> {
  const response = await fetch(`/api/publishing/events/${eventId}/preview`);
  // ERROR-INTENT: the public link is an accelerator, not the workspace. A missing or
  // unreadable publication degrades to a disabled Copy action with an explanation.
  if (!response.ok) return null;
  const parsed = publicationPreviewResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.publication.draft.cfp.submissionUrl : null;
}

/* ------------------- the submission window, in the event's zone ------------------- */

/*
 * A deadline is stored as an instant and edited as a wall-clock time in the event's timezone, so
 * these two functions are the whole of the conversion between them.
 *
 * Neither uses the browser's own zone, and that is the point: an organizer in Berlin setting the
 * deadline for a conference in Los Angeles means 23:59 *there*. `<input type="datetime-local">`
 * has no timezone at all — it hands over a naive wall-clock string — so the zone has to be applied
 * here or the value is silently the operator's.
 *
 * Storing the instant rather than the wall time is the other half of that decision: a deadline
 * that has been announced must not move because somebody later corrected the event's timezone.
 */

const zonedParts = (utcMillis: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // `hour12: false` yields "24" for midnight in some ICU builds, which parses as the next day.
    hourCycle: "h23",
  }).formatToParts(new Date(utcMillis));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
};

/** How far the zone runs ahead of UTC at this instant, in milliseconds. */
const zoneOffset = (utcMillis: number, timeZone: string) => {
  const at = zonedParts(utcMillis, timeZone);
  return (
    Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) -
    Math.floor(utcMillis / 1000) * 1000
  );
};

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Whether this wall-clock time exists in this zone on this date.
 *
 * A spring-forward date has a gap — in `America/Los_Angeles` on 2026-03-08 the clock goes from
 * 01:59 to 03:00 — and every value inside it converts to the instant the hour before, so a
 * deadline typed as `02:30` is stored as `01:30`. The check is the round trip itself: if reading
 * the instant back does not give the wall time that produced it, that wall time never happened.
 *
 * Separate from `fromZonedInput` rather than folded into it, because the two answers are different
 * kinds. `fromZonedInput` returns `null` for *no bound*, which is a legitimate thing to save; a
 * time that does not exist is a value to refuse and explain, and collapsing it into "no deadline"
 * would clear a deadline the organizer was setting.
 */
export function zonedInputExists(local: string, timeZone: string): boolean {
  const instant = fromZonedInput(local, timeZone);
  return instant === null || toZonedInput(instant, timeZone) === local;
}

/** An instant as the `YYYY-MM-DDTHH:mm` a `datetime-local` input shows, in the event's zone. */
export function toZonedInput(instant: string | null, timeZone: string): string {
  if (!instant) return "";
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return "";
  const parts = zonedParts(at, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * A `datetime-local` value read as a wall-clock time in the event's zone, as a UTC instant.
 *
 * Two passes, because the offset depends on the answer: the first uses the offset at the naive
 * instant and the second re-reads it at the corrected one, which is what makes a deadline set an
 * hour either side of a daylight-saving change land on the time the organizer typed.
 *
 * **It cannot represent a wall time that does not exist**, and callers must not pretend otherwise
 * — see `zonedInputExists`. On a spring-forward date the local clock jumps from 01:59 to 03:00, so
 * `02:30` names no instant; both passes land on the same instant as `01:30` and the deadline the
 * organizer typed silently moves an hour earlier. Returning `null` would be worse still, because
 * `null` here means *no bound at all*.
 */
export function fromZonedInput(local: string, timeZone: string): string | null {
  if (!local) return null;
  const naive = Date.parse(`${local}:00.000Z`);
  if (Number.isNaN(naive)) return null;
  const firstPass = naive - zoneOffset(naive, timeZone);
  return new Date(naive - zoneOffset(firstPass, timeZone)).toISOString();
}

/**
 * One renderer for every rendition of a question, so the preview cannot drift from
 * the control an applicant actually types into.
 */

export type { FormShape };
export {
  DECISION_STATUSES,
  DEFAULT_TITLE,
  cfpConditionMatches as conditionMatches,
  describe,
  FIELD_TYPES,
  formatDate,
  isNotFound,
  loadPublicSubmissionUrl,
  schemaIssue,
  shape,
  starter,
  typeLabel,
};
