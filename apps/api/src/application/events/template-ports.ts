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

/**
 * A refusal a slice raises on purpose, whose sentence an organizer is meant to read.
 *
 * Everything else a slice throws is a fault, and a fault's message names this system's
 * internals — a driver's constraint text, an id nobody outside the domain has seen — so the
 * orchestrator answers a fixed sentence instead and reports the throw through `onSliceFault`
 * (`ARC-OBS-001`). A slice that has something an organizer can act on says so with this type.
 */
export class SliceRefusalError extends Error {}

/**
 * One slice throwing something this orchestrator did not expect.
 *
 * Carried out through a port rather than logged here: the application layer imports no logger,
 * so this file owns the shape and the composition root owns the sink.
 *
 * **The sink must not throw.** It is reached from inside the catch whose whole purpose is to stop
 * one category's trouble from becoming a 500 that hides every other category's outcome, and by
 * then the slices ordered before the failing one have already written — so a throwing sink would
 * lose the per-category report *and* the application record describing what landed, which is the
 * one thing this design promises when it declines to be atomic.
 *
 * This is a requirement on the implementer rather than a guard in the service, and the reason is
 * that there is nothing the application layer could do in that guard. It holds no second sink and
 * no logger, so the catch would have to swallow — and a swallow here is indistinguishable, to
 * every later reader and to `tools/check-errors.mjs`, from the swallows that policy exists to
 * catch. Stating the obligation where it is met is the honest version. The composition root's
 * sink in `apps/api/src/index.ts` meets it for every value this application throws: each throw
 * site constructs an `Error`, and the sink reads `message` and `name` off it.
 */
export interface SliceFault {
  readonly sliceKey: string;
  readonly stage: "export" | "preview" | "apply";
  /** The event being read, for `export`, and the one being written for the other two. */
  readonly eventId: string;
  readonly error: unknown;
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
  /**
   * Facts this category will have made true by the time later ones run.
   *
   * Declared by the slice because only the slice knows: a category can be `incompatible` overall
   * and still write the half a later one depends on, or `copies` overall and write nothing at
   * all. Omit it — most slices have nothing to promise — or name only what this preview has
   * established will actually happen. A provision that does not materialise is a preview that
   * misled the category downstream of it, which is the defect this replaced.
   */
  readonly provides?: readonly SliceProvision[] | undefined;
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
/**
 * What else this application will do, so a preview can be accurate about ordering.
 *
 * Apply runs the slices in composition order and each one sees a destination the ones before it
 * have already changed — that is what makes review's triage statuses exist before CFP validates
 * its routing rules against them. A preview writes nothing, so it has no such destination to
 * read, and without this it would report against a state the apply will never actually meet.
 *
 * Only these **tokens** cross the boundary, never another domain's payload. A slice learns that
 * the one fact it depends on will be true; it does not learn what the category providing it
 * contains, which is the whole reason the payloads are opaque to everyone but their author.
 */
export interface SliceContext {
  /**
   * What the categories applied before this one will have written by the time it runs.
   *
   * This carries provisions rather than slice keys, and the difference is the whole design. Four
   * readings of "which earlier slices count" were tried against a slice's outcome — every
   * selected one, `copies` only, `copies` or `incompatible`, "will attempt to write" — and each
   * traded one destination state for another, because **no whole-category verdict answers the
   * question a dependent slice is actually asking.** CFP does not need to know whether review
   * succeeded; it needs to know whether the triage status set will be written. Review reports
   * `incompatible` on a path that writes the statuses (a locked rubric) and on a path that does
   * not (an abstract holding a status the template omits), so the verdict cannot distinguish
   * them and only review can.
   *
   * So the slice that knows declares it. A provision is a promise about a specific fact, made by
   * the category that will make it true, and a dependent slice tests for exactly that fact.
   *
   * One limit survives and must not be forgotten: a provision is **category-grained**. Review can
   * promise that its status set will be written; it cannot promise that the set contains the
   * particular status a routing rule names, because saying which keys it holds would put review's
   * payload across this boundary — the one thing the design forbids. A dependent slice therefore
   * still words its preview as a dependency ("once the triage statuses category creates that
   * status") rather than as a guarantee, and CFP's own comment says so where it reads this.
   */
  readonly providedBefore: readonly SliceProvision[];
}

/**
 * The vocabulary of facts one category can promise another, and deliberately a very short list.
 *
 * It lives here rather than in the domain that provides it because the alternative is a
 * cross-domain import: CFP may not reach into review to learn the name of the thing it depends
 * on. That makes this file the seam's shared vocabulary, exactly as the slice keys are — and
 * every entry names its owner, because an entry nobody provides is one a dependent slice waits
 * on for ever.
 */
export type SliceProvision =
  /** Provided by the review slice when it will write the destination's triage status set. */
  "review:triage-statuses";

export interface EventConfigurationSlice {
  /** Stable slice key: `"cfp" | "review" | "agenda" | "publishing" | "content-resources"`. */
  readonly key: string;
  /** What an organizer calls this category in the preview. */
  readonly label: string;
  /** Read this event's configuration as serializable JSON, or null when there is none. */
  export(actor: Actor | null, eventId: string): Promise<unknown | null>;
  /**
   * What `apply` would create, skip, or refuse — writing nothing.
   *
   * A slice whose answer depends on a category applied before it reads `context.appliedBefore`;
   * everything else may ignore the parameter, since a shorter implementation stays assignable.
   */
  preview(
    actor: Actor | null,
    eventId: string,
    payload: unknown,
    remap: DateRemap,
    context: SliceContext,
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
 *
 * `applied` is reserved for an application that wrote something and refused nothing: a category
 * the destination would not accept or the actor may not write leaves `partial`, and an
 * application that wrote nothing at all — every category unselected or carrying no payload — is
 * `skipped` rather than a success with no writes behind it.
 */
export interface TemplateApplicationResult extends Omit<TemplateApplicationPlan, "slices"> {
  readonly appliedAt: string;
  readonly outcome: "applied" | "partial" | "failed" | "skipped";
  readonly slices: readonly SliceResultReport[];
}
