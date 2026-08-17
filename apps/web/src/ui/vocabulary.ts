/*
 * The product's shared vocabulary: how Greenroom names a state, a dataset and a permission.
 *
 * Wire enums are storage spellings. `under_review`, `terminal`, `reports:pii` and
 * `event-cfp` are all correct on the wire and all wrong on a screen, and until this module
 * existed each surface decided for itself — so the same delivery was "terminal" in the
 * outbox, "Failed" in the webhook history and "terminal_failure" in the attempt list, and
 * an API-client form printed thirteen raw scope tokens beside checkboxes and let the reader
 * guess what granting one would do.
 *
 * The rule this file enforces: no surface prints a raw enum or a permission token. It reads
 * the label from here, and where the reader is being asked to *decide* something — granting
 * a scope, retrying a delivery — it prints the consequence sentence with it.
 *
 * Labels are sentence case, active, and named for what the reader controls rather than for
 * how the system stores it. See docs/product/design-language.md.
 *
 * @spec PRD-IAM-001 PRD-OPS-004
 */
import type {
  DeliveryDto,
  EmbedDto,
  ReportDefinitionDto,
  SiteDto,
  SubmitterProposalDto,
  capabilitySchema,
} from "@greenroom/contracts";
import type { z } from "zod";

/**
 * The tone a state carries, matching `Pill`'s vocabulary so a caller can pass it straight
 * through. Tones live beside the labels because a state that is amber in one workspace and
 * grey in the next is the same defect as a state that is named twice.
 */
export type StateTone = "neutral" | "ok" | "warn" | "danger" | "info";

/** A state's name and its tone, as every surface must render it. */
export type StateTerm = { readonly label: string; readonly tone: StateTone };

/**
 * A key nothing in these maps recognises, made readable rather than printed raw.
 *
 * Proposal statuses are configured per event, so an unrecognised key is expected here and
 * is not a defect — `shortlist_maybe` becomes "Shortlist maybe" instead of leaking an
 * underscore into the interface.
 */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ---- submissions -------------------------------------------------------- */

/**
 * The triage statuses every event starts with, including the two the review domain reserves
 * for a recorded decision (`0021_review_decisions.sql` seeds `accepted` and `declined`).
 *
 * An event may configure its own set, and when it has, the configured label wins — which is
 * what `proposalStatusLabel` is for. This map is the floor, not the list.
 */
export const PROPOSAL_STATUS_TERMS: Readonly<Record<string, StateTerm>> = {
  submitted: { label: "Submitted", tone: "neutral" },
  under_review: { label: "Under review", tone: "info" },
  reviewed: { label: "Reviewed", tone: "info" },
  shortlisted: { label: "Shortlisted", tone: "info" },
  accepted: { label: "Accepted", tone: "ok" },
  declined: { label: "Declined", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

/** What this event calls a status: its own label first, then the shared floor, then the key. */
export function proposalStatusLabel(
  key: string,
  configured: readonly { readonly key: string; readonly label: string }[] = [],
): string {
  const own = configured.find((status) => status.key === key);
  return own?.label ?? PROPOSAL_STATUS_TERMS[key]?.label ?? humanizeKey(key);
}

export const proposalStatusTone = (key: string): StateTone =>
  PROPOSAL_STATUS_TERMS[key]?.tone ?? "neutral";

/**
 * The submitter's half of the same noun, which is a different vocabulary on purpose.
 *
 * An applicant is never shown organizer triage — "Under consideration" covers every status
 * between arrival and a decision, because an event may configure `shortlist_maybe` and
 * publishing the inside of a review process is not the applicant's business (PRD-CFP-002).
 */
export const SUBMITTER_PROPOSAL_STATE_TERMS: Readonly<
  Record<SubmitterProposalDto["state"], StateTerm>
> = {
  draft: { label: "Draft", tone: "neutral" },
  under_consideration: { label: "Under consideration", tone: "info" },
  accepted: { label: "Accepted", tone: "ok" },
  declined: { label: "Not accepted", tone: "neutral" },
};

/* ---- delivery ----------------------------------------------------------- */

/**
 * One delivery vocabulary for both outbound halves: broadcast deliveries and webhook
 * deliveries share these four states, and used to name them differently on each screen.
 *
 * `terminal` is the one worth the words. It means the worker will not try again by itself,
 * which is a different sentence from "failed" — somebody has to retry it.
 */
export const DELIVERY_STATE_TERMS: Readonly<Record<DeliveryDto["state"], StateTerm>> = {
  queued: { label: "Queued", tone: "neutral" },
  retrying: { label: "Retrying", tone: "warn" },
  succeeded: { label: "Delivered", tone: "ok" },
  terminal: { label: "Stopped", tone: "danger" },
};

/** What each state means for the reader, for the line under a delivery row. */
export const DELIVERY_STATE_CONSEQUENCE: Readonly<Record<DeliveryDto["state"], string>> = {
  queued: "Waiting for the worker to pick it up.",
  retrying: "The last attempt failed and the worker will try again.",
  succeeded: "The recipient's server accepted it.",
  terminal: "No further attempt will be made until somebody retries it.",
};

/* ---- publishing --------------------------------------------------------- */

/**
 * A portal's publication state. `unpublished` is not `draft`: it was live and was taken
 * down, so its URL is one press away from working again.
 */
export const SITE_STATE_TERMS: Readonly<Record<SiteDto["state"], StateTerm>> = {
  draft: { label: "Draft", tone: "neutral" },
  published: { label: "Live", tone: "ok" },
  unpublished: { label: "Taken down", tone: "warn" },
};

/** What a saved embed renders on somebody else's page. */
export const EMBED_VIEW_LABELS: Readonly<Record<EmbedDto["view"], string>> = {
  schedule: "Schedule",
  speakers: "Speakers",
  gallery: "Speaker gallery",
  itinerary: "Personal itinerary",
};

/**
 * A session's publication readiness, which is content's state rather than the agenda's.
 *
 * `ready` is the one that needs naming: the session is complete and will appear the next
 * time the schedule is published, which is why a scheduled draft can be missing from a
 * public schedule that looks finished.
 */
export const SESSION_STATE_TERMS: Readonly<Record<"draft" | "ready" | "published", StateTerm>> = {
  draft: { label: "Draft", tone: "neutral" },
  ready: { label: "Ready to publish", tone: "info" },
  published: { label: "Published", tone: "ok" },
};

/* ---- reporting ---------------------------------------------------------- */

/** The allowlisted datasets a report may ask a question of, named as the reader knows them. */
export const REPORT_DATASET_LABELS: Readonly<Record<ReportDefinitionDto["dataset"], string>> = {
  sessions: "Sessions",
  speakers: "Speakers",
  submissions: "Submissions",
  reviews: "Reviews",
  deliverables: "Deliverables",
  contacts: "Contacts",
  agenda: "Agenda placements",
  communications: "Communications",
};

/* ---- capabilities ------------------------------------------------------- */

export type Capability = z.infer<typeof capabilitySchema>;

/**
 * A capability, in the words somebody granting it needs.
 *
 * `consequence` is the reason this map exists rather than a plain label list: an
 * organization admin ticking a box on an API client or composing a custom role is deciding
 * what a stranger's credential may do, and `crm:manage` does not tell them that private
 * notes travel with it.
 *
 * `sensitive` marks a capability that carries personal data out of the product. Any surface
 * that offers one must show the consequence beside the control rather than in a tooltip.
 */
export type CapabilityTerm = {
  readonly label: string;
  readonly consequence: string;
  readonly sensitive?: boolean;
};

export const CAPABILITY_TERMS: Readonly<Record<Capability, CapabilityTerm>> = {
  "events:read": {
    label: "Read events",
    consequence: "Sees every event in the organization and the context around it.",
  },
  "events:create": {
    label: "Create events",
    consequence: "Adds new events to the organization. Existing events are untouched.",
  },
  "events:settings:read": {
    label: "Read event settings",
    consequence: "Sees an event's dates, time zone, and public details.",
  },
  "events:settings:update": {
    label: "Change event settings",
    consequence: "Edits dates, time zone, and public details, which the public pages follow.",
  },
  "communications:manage": {
    label: "Send communications",
    consequence: "Sends broadcasts to speakers and contacts, and configures outbound webhooks.",
  },
  "agenda:manage": {
    label: "Build the agenda",
    consequence: "Places, moves, and removes sessions on the schedule, published ones included.",
  },
  "crm:manage": {
    label: "Manage the speaker CRM",
    consequence: "Reads and edits every prospect, contact, and note in the pipeline.",
  },
  "content:read": {
    label: "Read sessions and speakers",
    consequence: "Sees session abstracts, speaker profiles, and uploaded assets.",
  },
  "content:manage": {
    label: "Edit sessions and speakers",
    consequence: "Edits abstracts and profiles, and marks them ready to publish.",
  },
  "review:manage": {
    label: "Run review",
    consequence: "Configures rounds, assigns reviewers, and records accept and decline decisions.",
  },
  "review:evaluate": {
    label: "Score assigned submissions",
    consequence: "Scores and comments on its own assignments, and sees no others.",
  },
  "identity:manage": {
    label: "Manage people and access",
    consequence: "Invites members, changes their roles, and revokes access for this event.",
  },
  "reports:pii": {
    label: "Read personal data unmasked",
    consequence:
      "Reports return names, email addresses, and phone numbers with no masking, and export them.",
    sensitive: true,
  },
};

/** The label for a scope, including one the browser's schema does not recognise. */
export const capabilityLabel = (scope: string): string =>
  CAPABILITY_TERMS[scope as Capability]?.label ?? humanizeKey(scope.replace(/:/g, " · "));

/**
 * The grantable capabilities, in the order somebody deciding reads them.
 *
 * Two surfaces ask this question — composing a custom role, and issuing an API client — and each
 * had grown its own grouping, so `review:evaluate` was filed under "The programme" on one screen
 * and under "Submissions and review" on the other, and `identity:manage` under "People" on one
 * and "People and data" on the other. Granting the same capability should not be a different act
 * depending on which page is open, which is what this module exists to hold.
 *
 * What it can see, what it can change about the programme, who decides on submissions, who it can
 * talk to and administer, and — last and alone — the personal data it can carry out of the
 * product. `1006_reports_pii_capability.sql` admits `reports:pii` on a client scope, so
 * withholding it here would leave a grantable capability nobody can grant.
 */
export const CAPABILITY_GROUPS: readonly {
  readonly title: string;
  readonly scopes: readonly Capability[];
}[] = [
  {
    title: "The event itself",
    scopes: ["events:read", "events:create", "events:settings:read", "events:settings:update"],
  },
  { title: "The programme", scopes: ["content:read", "content:manage", "agenda:manage"] },
  { title: "Submissions and review", scopes: ["review:manage", "review:evaluate"] },
  { title: "People", scopes: ["crm:manage", "communications:manage", "identity:manage"] },
  { title: "Personal data", scopes: ["reports:pii"] },
];

/** Every capability this build knows how to describe, in the order the groups declare them. */
export const GRANTABLE_CAPABILITIES: readonly Capability[] = Object.keys(
  CAPABILITY_TERMS,
) as Capability[];

/**
 * `grantable` grouped for a form: declared order, empty groups dropped, nothing lost.
 *
 * The trailing "Everything else" bucket is the point. The grantable set comes from the server on
 * the roles screen, so a capability added to the allowlist and not to `CAPABILITY_GROUPS` must
 * still reach the form — a permission that silently disappears from the picker is a permission
 * nobody can grant and nobody can see was withheld.
 */
export function groupCapabilities(
  grantable: readonly string[],
): { title: string; scopes: Capability[] }[] {
  const remaining = new Set<string>(grantable);
  const groups = CAPABILITY_GROUPS.map((group) => {
    const scopes = group.scopes.filter((scope) => remaining.has(scope));
    for (const scope of scopes) remaining.delete(scope);
    return { title: group.title, scopes: [...scopes] };
  }).filter((group) => group.scopes.length > 0);
  return remaining.size
    ? [...groups, { title: "Everything else", scopes: [...remaining] as Capability[] }]
    : groups;
}
