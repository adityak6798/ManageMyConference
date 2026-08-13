/**
 * The seam that lets `events` orchestrate a clone without importing six domains.
 *
 * Events declares this port; each domain implements its own slice inside its own application
 * directory and exports it from that domain's `public.ts`; `apps/api/src/index.ts` — the
 * declared composition root — constructs the slices and hands the array to
 * `EventTemplateService`. Events therefore depends on nothing but its own port type, and no
 * architecture allowlist entry is created by any of it.
 *
 * The repository already uses this shape twice: `OutreachDispatchPort`, declared in
 * `application/crm/public.ts` so CRM never imports communications, and `PreparedDeliveryWriter`
 * in `application/communications/public.ts`.
 *
 * @spec PRD-EVT-002 ARC-DOM-001 ARC-FLOW-006
 */
import type { Actor } from "../identity/actor";

/**
 * The destination range an organizer confirmed, and the two timezones a slice needs to remap
 * against it.
 *
 * Events carry no date range of their own (`PRD-EVT-001`), so this is a parameter of the clone
 * command rather than a read of the destination event — see `ARC-FLOW-006` and the pull request
 * that introduced it. A slice with absolute instants in its payload derives its own offset from
 * its own anchor: agenda's earliest slot day, for instance, is agenda's business, not events'.
 */
export interface DateRemap {
  readonly destination: {
    /** Inclusive, `YYYY-MM-DD`, read in `destination.timezone`. */
    readonly startsOn: string;
    readonly endsOn: string;
    readonly eventId: string;
    /** The destination event's IANA timezone. */
    readonly timezone: string;
  };
  readonly source: {
    readonly eventId: string;
    readonly timezone: string;
  };
}

/** One nameable thing inside a slice: a CFP field, a triage status, a room. */
export interface SliceEntry {
  /** Stable within the slice — a field id, a status key, a slug. */
  readonly id: string;
  /** What an organizer would call it. */
  readonly label: string;
}

/**
 * What a preview may conclude. Deliberately not the same union as `SliceOutcome`: saying
 * "applied" before anything is written would be a claim a preview has no standing to make.
 * `failed` here means the *preview itself* could not be determined — not that a write failed.
 */
export type SlicePreviewOutcome = "copies" | "skipped" | "incompatible" | "unauthorized" | "failed";

export type SliceOutcome = "applied" | "skipped" | "incompatible" | "unauthorized" | "failed";

export interface SlicePreview {
  readonly outcome: SlicePreviewOutcome;
  /** One sentence an organizer can act on. Always present, including on `copies`. */
  readonly reason: string;
  readonly copies: readonly SliceEntry[];
  /** Present in the source and deliberately not copied, with the reason in `reason`. */
  readonly excludes: readonly SliceEntry[];
  /** Present in the source and refused by the destination as it stands. */
  readonly incompatible: readonly SliceEntry[];
}

export interface SliceResult {
  readonly outcome: SliceOutcome;
  readonly reason: string;
  readonly applied: readonly SliceEntry[];
  readonly incompatible: readonly SliceEntry[];
}

/**
 * One domain's contribution to a template.
 *
 * `preview` and `apply` report a refusal rather than throwing it: a slice the actor cannot
 * write is `unauthorized`, a destination that will not accept the payload is `incompatible`,
 * and both are outcomes an organizer reads, not 500s. A thrown error is a fault, and the
 * orchestrator reports it as `failed` against that slice alone.
 */
export interface EventConfigurationSlice {
  /** Stable slice key: `"cfp" | "review" | "agenda" | "publishing" | "content-resources"`. */
  readonly key: string;
  /** What an organizer calls this category in the preview. */
  readonly label: string;
  /** Read this event's configuration as serializable JSON, or null when there is none. */
  export(actor: Actor | null, eventId: string): Promise<unknown | null>;
  /** What `apply` would create, skip, or refuse — writing nothing. */
  preview(
    actor: Actor | null,
    eventId: string,
    payload: unknown,
    remap: DateRemap,
  ): Promise<SlicePreview>;
  /** Apply, idempotently: re-applying the same payload converges rather than duplicating. */
  apply(
    actor: Actor | null,
    eventId: string,
    payload: unknown,
    remap: DateRemap,
  ): Promise<SliceResult>;
}

/**
 * A category the issue's scope names that this system copies nothing for, and why.
 *
 * Reported so the preview's category list is complete rather than quietly short. The one
 * entry today is communications: `message_templates` is keyed
 * `unique(organization_id, template_key, version)` with no `event_id` column, so two events in
 * one organization already share every template and there is nothing to copy. Claiming to have
 * copied them would be a false statement in a product surface.
 */
export interface DeclaredExclusion {
  readonly key: string;
  readonly label: string;
  readonly reason: string;
}

export const declaredExclusions: readonly DeclaredExclusion[] = [
  {
    key: "communications",
    label: "Message and reminder templates",
    reason:
      "Already shared at the organization — nothing to copy. Message templates are keyed by " +
      "organization, not by event, so the destination already resolves the same templates as " +
      "the source.",
  },
];

/**
 * What one slice contributed when a version was captured.
 *
 * A slice the capturing actor cannot read is `unauthorized` and stores nothing, which is why
 * this is reported rather than swallowed: a template that is quietly missing its review
 * configuration would apply cleanly and leave the destination wrong.
 */
export interface SliceCaptureReport {
  readonly key: string;
  readonly label: string;
  readonly outcome: "captured" | "empty" | "unauthorized" | "failed";
  readonly reason: string;
}

/** One slice's line in a preview or a result, as the transport and the console read it. */
export interface SlicePreviewReport extends SlicePreview {
  readonly key: string;
  readonly label: string;
}

export interface SliceResultReport extends SliceResult {
  readonly key: string;
  readonly label: string;
}

export interface TemplateApplicationPlan {
  readonly templateId: string;
  readonly templateName: string;
  readonly versionId: string;
  readonly version: number;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly eventId: string;
  readonly destination: { readonly startsOn: string; readonly endsOn: string };
  readonly slices: readonly SlicePreviewReport[];
}

/**
 * The result of applying one template version to one event.
 *
 * There is no cross-domain transaction in this repository, and this result does not pretend
 * otherwise: a `failed` slice does not roll back the slices that already succeeded, and
 * `partial` says exactly that. Re-applying is the repair, because every slice is idempotent.
 */
export interface TemplateApplicationResult extends Omit<TemplateApplicationPlan, "slices"> {
  readonly appliedAt: string;
  readonly outcome: "applied" | "partial" | "failed";
  readonly slices: readonly SliceResultReport[];
}
