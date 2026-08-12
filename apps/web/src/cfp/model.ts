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

import { type CfpField, publicationPreviewResponseSchema } from "@greenroom/contracts";
import { CfpApiError } from "../api/cfp";
import "../styles/cfp.css";

const DEFAULT_TITLE = "Call for proposals";

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
    })),
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

/**
 * One renderer for every rendition of a question, so the preview cannot drift from
 * the control an applicant actually types into.
 */

export type { FormShape };
export {
  DEFAULT_TITLE,
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
