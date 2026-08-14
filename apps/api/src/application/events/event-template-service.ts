import type {
  EventTemplate,
  EventTemplatePayload,
  EventTemplateState,
  EventTemplateVersion,
} from "../../domain/events/event-template";
import {
  type OutstandingCategory,
  outstandingConfiguration,
} from "../../domain/events/outstanding-configuration";
import {
  type Actor,
  type Capability,
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { EventService } from "./event-service";
import type {
  EventTemplateApplicationView,
  EventTemplateRepository,
  EventTemplateVersionDraft,
} from "./event-template-repository";
import {
  type DateRemap,
  declaredExclusions,
  type EventConfigurationSlice,
  type SliceCaptureReport,
  type SliceContext,
  type SliceFault,
  type SlicePreviewReport,
  type SliceProvision,
  SliceRefusalError,
  type SliceResultReport,
  type TemplateApplicationPlan,
  type TemplateApplicationResult,
} from "./template-ports";

/**
 * Answered for a template that does not exist **and** for one owned by another organization.
 *
 * Deliberately one error for both. Distinguishing them would turn this route into an oracle
 * for "does organization X have a template with this id", which is exactly the cross-tenant
 * leak the acceptance criterion asks us to close.
 */
export class EventTemplateNotFoundError extends Error {}
export class EventTemplateNameTakenError extends Error {}
export class EventTemplateStateError extends Error {}
export class EventTemplateRangeError extends Error {}
/**
 * Raised for a `slices` key this deployment does not compose.
 *
 * A key nobody answers to used to be indistinguishable from a key the caller left out, so a
 * misspelled category answered 200 with every category `skipped` and an application row behind
 * it. Naming the unknown key and the ones that exist is the only answer that lets a client tell
 * "you asked for nothing" apart from "you asked for something that is not here".
 */
export class EventTemplateSelectionError extends Error {}

export interface SaveTemplateCommand {
  readonly organizationId: string;
  readonly name: string;
  readonly sourceEventId: string;
}

export interface TemplateApplicationCommand {
  readonly templateId: string;
  /**
   * Explicit, never "latest".
   *
   * An event is created from *a version*, and a client that asked for whatever was newest at
   * the moment it called would produce a different event next week from the same request.
   */
  readonly version: number;
  readonly destination: { readonly startsOn: string; readonly endsOn: string };
  /** Slice keys to apply. Omitted means every slice the version carries. */
  readonly slices?: readonly string[] | undefined;
}

/**
 * A stored version with the capturing account resolved to a name.
 *
 * The id stays: it is what storage holds and what an operator would grep for, and the name is
 * an answer to a different question. Null when identity does not know the account or when no
 * directory is composed — never a fabricated string, and never the id dressed up as a name.
 */
export interface EventTemplateVersionView extends EventTemplateVersion {
  readonly createdByName: string | null;
}

export interface EventTemplateApplicationDetail extends EventTemplateApplicationView {
  readonly appliedByName: string | null;
}

export interface EventTemplateCapture {
  readonly template: EventTemplate;
  readonly version: EventTemplateVersionView;
  readonly slices: readonly SliceCaptureReport[];
}

export interface EventTemplateDetail {
  readonly template: EventTemplate;
  readonly versions: readonly EventTemplateVersionView[];
}

/**
 * Identity's answer to "what is this account called?", narrowed to the one call events needs.
 *
 * Declared here rather than imported as a service, the way `ContentActorDirectoryPort` and the
 * platform sources are: events resolves a display name and nothing else — no persona, no role,
 * and deliberately not the address `findRecipient` also carries, which must not travel into an
 * API payload as a side effect of wanting somebody's name.
 *
 * Optional. A composition without it renders the stored id, which is what every one of these
 * surfaces printed before issue #176.
 */
export interface TemplateActorNamePort {
  findRecipient(userId: string): Promise<{ id: string; name: string } | null>;
}

export interface EventTemplateServiceDependencies {
  repository: EventTemplateRepository;
  /** The same domain's event service: identity, ownership, and the destination's timezone. */
  events: Pick<EventService, "get" | "belongsToOrganization">;
  slices: readonly EventConfigurationSlice[];
  /** Who captured a version, and who applied one, as a name rather than an account id. */
  actorNames?: TemplateActorNamePort | undefined;
  newId: () => string;
  now: () => Date;
  /**
   * Where a slice's unexpected throw is reported, once, at this boundary (`ARC-OBS-001`).
   *
   * A port rather than a logger, so the application layer keeps importing nothing external and
   * the composition root decides what a fault is written to. Optional because a caller that
   * omits it is choosing to run the orchestrator with no sink — every test in this repository —
   * not because a fault is ever discardable in a deployment.
   *
   * **It must not throw**, and the obligation is repeated here rather than left on `SliceFault`
   * because this is the line an implementer actually fills in. `SliceFault` says why: the call
   * sits inside the catch that keeps one category's trouble from becoming a 500 hiding all the
   * others, after earlier slices have already written.
   */
  onSliceFault?: ((fault: SliceFault) => void) | undefined;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-02-31` matches the shape and is not a day; `Date` normalises it, so compare back. */
function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

// @spec PRD-EVT-002 ARC-FLOW-006
export class EventTemplateService {
  constructor(private readonly dependencies: EventTemplateServiceDependencies) {}

  /**
   * Capture a new template from an event, as version 1.
   *
   * **Nothing is written until the capture is complete.** Reading the source is six cross-domain
   * exports, and it used to run *between* the template write and the version write — the widest
   * such window in this file. A failure inside it left an active template with no versions:
   * listed in the console with an empty version select, refused for duplication, answering 404
   * for every apply, and holding its name against the partial unique index (issue #177). Now the
   * exports happen first and the pair lands in one transaction, so the two possible outcomes are
   * a usable template or nothing at all.
   */
  async saveFromEvent(
    actor: Actor | null,
    command: SaveTemplateCommand,
  ): Promise<EventTemplateCapture> {
    const authorized = this.organizationMember(actor, command.organizationId, "events:create");
    await this.requireSourceEvent(authorized, command.sourceEventId, command.organizationId);
    const at = this.dependencies.now().toISOString();
    const template: EventTemplate = {
      id: this.dependencies.newId(),
      organizationId: command.organizationId,
      name: command.name,
      state: "active",
      createdAt: at,
      updatedAt: at,
    };
    const captured = await this.capture(authorized, template.id, command.sourceEventId);
    const version = await this.dependencies.repository.createTemplateWithVersion(
      template,
      captured.draft,
    );
    // The capturing account is the request's own actor, so its name needs no lookup.
    return {
      template,
      version: { ...captured.draft, version, createdByName: authorized.name },
      slices: captured.reports,
    };
  }

  /** Capture the same event, or a different one, as the template's next version. */
  async captureVersion(
    actor: Actor | null,
    templateId: string,
    sourceEventId: string,
  ): Promise<EventTemplateCapture> {
    const { authorized, template } = await this.loadTemplate(actor, templateId, "events:create");
    if (template.state === "archived")
      throw new EventTemplateStateError("Restore this template before capturing a new version");
    await this.requireSourceEvent(authorized, sourceEventId, template.organizationId);
    const captured = await this.capture(authorized, template.id, sourceEventId);
    // The number is storage's to allocate, not this service's to read and then hope for: two
    // organizers capturing the same template at once both take one, and neither is refused.
    const version = await this.dependencies.repository.createVersion(captured.draft);
    // The capturing account is the request's own actor, so its name needs no lookup.
    return {
      template,
      version: { ...captured.draft, version, createdByName: authorized.name },
      slices: captured.reports,
    };
  }

  async list(actor: Actor | null, organizationId: string): Promise<readonly EventTemplate[]> {
    this.organizationMember(actor, organizationId, "events:read");
    return this.dependencies.repository.listTemplates(organizationId);
  }

  async get(actor: Actor | null, templateId: string): Promise<EventTemplateDetail> {
    const { template } = await this.loadTemplate(actor, templateId, "events:read");
    const versions = await this.dependencies.repository.listVersions(templateId);
    const names = await this.resolveNames(versions.map(({ createdBy }) => createdBy));
    return {
      template,
      versions: versions.map((version) => ({
        ...version,
        createdByName: names.get(version.createdBy) ?? null,
      })),
    };
  }

  rename(actor: Actor | null, templateId: string, name: string): Promise<EventTemplate> {
    return this.update(actor, templateId, { name });
  }

  archive(actor: Actor | null, templateId: string, archived: boolean): Promise<EventTemplate> {
    return this.update(actor, templateId, { state: archived ? "archived" : "active" });
  }

  async update(
    actor: Actor | null,
    templateId: string,
    changes: {
      readonly name?: string | undefined;
      readonly state?: EventTemplateState | undefined;
    },
  ): Promise<EventTemplate> {
    const { template } = await this.loadTemplate(actor, templateId, "events:create");
    const applied = {
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.state === undefined ? {} : { state: changes.state }),
    };
    const updatedAt = this.dependencies.now().toISOString();
    if (!(await this.dependencies.repository.updateTemplate(templateId, applied, updatedAt)))
      throw new EventTemplateNotFoundError("No such event template");
    return { ...template, ...applied, updatedAt };
  }

  /**
   * Copy a template's newest version into a new template under a new name.
   *
   * The whole version history is deliberately *not* copied. Every historical version names the
   * event and the person it was captured from, and re-stamping those onto a new template would
   * invent provenance; the new template starts at version 1 with the payload it was duplicated
   * from and honest `createdAt`/`createdBy` of its own.
   */
  async duplicate(
    actor: Actor | null,
    templateId: string,
    name: string,
  ): Promise<EventTemplateCapture> {
    const { authorized, template } = await this.loadTemplate(actor, templateId, "events:create");
    const versions = await this.dependencies.repository.listVersions(templateId);
    const newest = versions.at(0);
    if (!newest) throw new EventTemplateStateError("This template has no version to duplicate yet");
    const at = this.dependencies.now().toISOString();
    const copy: EventTemplate = {
      id: this.dependencies.newId(),
      organizationId: template.organizationId,
      name,
      state: "active",
      createdAt: at,
      updatedAt: at,
    };
    const draft: EventTemplateVersionDraft = {
      id: this.dependencies.newId(),
      templateId: copy.id,
      sourceEventId: newest.sourceEventId,
      payload: newest.payload,
      createdAt: at,
      createdBy: authorized.id,
    };
    // One transaction, as in `saveFromEvent` and for the same reason: a copy with no version is
    // a name held against a template nobody can use (issue #177).
    const allocated = await this.dependencies.repository.createTemplateWithVersion(copy, draft);
    const version: EventTemplateVersionView = {
      ...draft,
      version: allocated,
      createdByName: authorized.name,
    };
    return {
      template: copy,
      version,
      slices: this.dependencies.slices.map(({ key, label }) => ({
        key,
        label,
        outcome: version.payload.slices[key] == null ? ("empty" as const) : ("captured" as const),
        reason:
          version.payload.slices[key] == null
            ? "The duplicated version carries nothing for this category."
            : "Copied from the duplicated version.",
      })),
    };
  }

  /** What `apply` would do, writing nothing. */
  async preview(
    actor: Actor | null,
    eventId: string,
    command: TemplateApplicationCommand,
  ): Promise<TemplateApplicationPlan> {
    const context = await this.resolveApplication(actor, eventId, command, "events:settings:read");
    const slices: SlicePreviewReport[] = [];
    /*
     * What this application will already have written by the time each slice's turn comes.
     *
     * Apply runs the array in order against a destination the earlier slices have changed;
     * preview walks the same array against a destination nobody has touched. Without this a
     * slice answers against a state the apply will never meet — which is exactly how CFP's
     * preview called a routing rule incompatible with triage statuses review's slice was about
     * to create for it. Provisions only: no slice learns what another one holds.
     */
    const providedBefore = new Set<SliceProvision>();
    for (const slice of this.dependencies.slices) {
      const selected = this.selection(command, slice.key);
      const payload = context.payload.slices[slice.key];
      if (!selected || payload == null) {
        slices.push({
          key: slice.key,
          label: slice.label,
          outcome: "skipped",
          reason: selected
            ? "The source event had nothing configured for this category."
            : "Not selected for this clone.",
          copies: [],
          excludes: [],
          incompatible: [],
        });
        continue;
      }
      const report = await this.previewSlice(slice, actor, eventId, payload, context.remap, {
        providedBefore: [...providedBefore],
      });
      slices.push({ key: slice.key, label: slice.label, ...report });
      /*
       * The orchestrator collects promises; it does not infer them.
       *
       * Four attempts were made to decide from a slice's own outcome whether the next one should
       * count on it, and each traded one destination state for another. The reason is structural:
       * a category can answer `incompatible` while writing the half a later slice needs, and
       * answer `incompatible` while writing nothing, and the verdict cannot tell those apart. So
       * the slice that knows says so, and this line does nothing but carry it forward.
       */
      for (const provision of report.provides ?? []) providedBefore.add(provision);
    }
    return {
      ...context.identity,
      eventId,
      destination: command.destination,
      slices: [...slices, ...this.excludedCategories()],
    };
  }

  /**
   * Apply one template version to one event, per slice.
   *
   * There is no cross-domain transaction here, and none is claimed: a slice that fails leaves
   * the slices that already succeeded in place, and the result says so. That is the issue's own
   * second option — a documented, repairable per-domain result that hides no partial state —
   * and it is repaired by applying again, because every slice converges.
   */
  async apply(
    actor: Actor | null,
    eventId: string,
    command: TemplateApplicationCommand,
  ): Promise<TemplateApplicationResult> {
    const context = await this.resolveApplication(
      actor,
      eventId,
      command,
      "events:settings:update",
    );
    if (context.template.state === "archived")
      throw new EventTemplateStateError("Restore this template before applying it");
    const slices: SliceResultReport[] = [];
    for (const slice of this.dependencies.slices) {
      const selected = this.selection(command, slice.key);
      const payload = context.payload.slices[slice.key];
      if (!selected || payload == null) {
        slices.push({
          key: slice.key,
          label: slice.label,
          outcome: "skipped",
          reason: selected
            ? "The source event had nothing configured for this category."
            : "Not selected for this clone.",
          applied: [],
          incompatible: [],
        });
        continue;
      }
      slices.push({
        key: slice.key,
        label: slice.label,
        ...(await this.applySlice(slice, actor, eventId, payload, context.remap)),
      });
    }
    const reported: readonly SliceResultReport[] = [
      ...slices,
      ...declaredExclusions.map(({ key, label, reason }) => ({
        key,
        label,
        outcome: "skipped" as const,
        reason,
        applied: [],
        incompatible: [],
      })),
    ];
    const appliedAt = this.dependencies.now().toISOString();
    /*
     * `applied` is the claim that everything the organizer asked for arrived, so a category the
     * destination refused or the account may not write costs it the same way a fault does —
     * the console renders a plain success for `applied`, and a clone whose routing was dropped
     * is not one. `skipped` is the honest answer when nothing was written and nothing refused.
     */
    const refused = reported.some(({ outcome }) =>
      ["failed", "incompatible", "unauthorized"].includes(outcome),
    );
    // `applied` entries, not the slice's own verdict: review refuses a locked rubric while its
    // triage statuses land, and an envelope that called that write nothing would be as wrong in
    // the other direction.
    const landed = reported.some(
      ({ outcome, applied }) => outcome === "applied" || applied.length > 0,
    );
    const result: TemplateApplicationResult = {
      ...context.identity,
      eventId,
      destination: command.destination,
      appliedAt,
      outcome: refused ? (landed ? "partial" : "failed") : landed ? "applied" : "skipped",
      slices: reported,
    };
    await this.dependencies.repository.recordApplication({
      id: this.dependencies.newId(),
      eventId,
      templateVersionId: context.identity.versionId,
      appliedAt,
      appliedBy: context.authorized.id,
      outcome: {
        outcome: result.outcome,
        slices: reported,
        destination: command.destination,
        // What the organizer asked for, so the repair repeats that request rather than a wider
        // one. `undefined` is dropped by `JSON.stringify` and reads back as "none recorded".
        selection: command.slices,
      },
    });
    return result;
  }

  /**
   * Which template versions this event was configured from, newest first, with what each one
   * actually did.
   *
   * The stored per-category outcome travels back out here, which is what makes a `partial`
   * application something an organizer can meet again after the response that reported it
   * (issue #175). Reading it is `events:settings:read` — the same grant as previewing, because
   * this says what has already been done to this event rather than doing anything to it.
   */
  async applications(
    actor: Actor | null,
    eventId: string,
  ): Promise<readonly EventTemplateApplicationDetail[]> {
    return (await this.configuration(actor, eventId)).applications;
  }

  /**
   * Only the outstanding half, for a caller that wants nothing else.
   *
   * This is what platform's operational inbox binds to (`EventConfigurationSource`), and it is a
   * separate entry point rather than the inbox picking a field off `configuration` so that the
   * dependency platform declares is the narrow question rather than the wide answer. It skips
   * the name resolution `configuration` performs, which is a read per distinct account and
   * exists for a column the inbox does not render.
   */
  async outstandingConfiguration(
    actor: Actor | null,
    eventId: string,
  ): Promise<readonly OutstandingCategory[]> {
    requireEventCapability(actor, eventId, "events:settings:read");
    return outstandingConfiguration(await this.dependencies.repository.listApplications(eventId));
  }

  /**
   * What this event was configured from, **and** what it still owes.
   *
   * Two answers to two different questions, produced from one read of the same rows. Issue #175
   * gave the first: what each *application* did. Issue #203 is the second: what the *event* is
   * missing, folded across every application by `outstandingConfiguration`. They disagree
   * exactly where #203 said they would — a later clone naming a different template, or a
   * narrower selection, is a newer application that may read `applied` while a category an
   * earlier one could not write is still unconfigured, and the surface then goes quiet about it.
   *
   * One method rather than two because every surface that wants one wants the other, and two
   * would be two reads of one row set. That is not a micro-optimization: issue #207 measured
   * exactly this shape — an independent read per question — as the reason an ordinary request
   * costs a serialized chain of round trips to D1.
   *
   * `events:settings:read` for both, the same grant as previewing, because this says what has
   * already been done to the event rather than doing anything to it.
   */
  async configuration(
    actor: Actor | null,
    eventId: string,
  ): Promise<{
    readonly applications: readonly EventTemplateApplicationDetail[];
    readonly outstanding: readonly OutstandingCategory[];
  }> {
    requireEventCapability(actor, eventId, "events:settings:read");
    const applications = await this.dependencies.repository.listApplications(eventId);
    const names = await this.resolveNames(applications.map(({ appliedBy }) => appliedBy));
    return {
      applications: applications.map((application) => ({
        ...application,
        appliedByName: names.get(application.appliedBy) ?? null,
      })),
      outstanding: outstandingConfiguration(applications),
    };
  }

  /**
   * Account ids to display names, each id looked up once however often it appears.
   *
   * A composition with no directory answers an empty map rather than failing: the surfaces fall
   * back to naming the id as an account, which is what they printed before.
   */
  private async resolveNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const directory = this.dependencies.actorNames;
    if (!directory) return new Map();
    const unique = [...new Set(ids)];
    const found = await Promise.all(unique.map((id) => directory.findRecipient(id)));
    return new Map(found.flatMap((person) => (person ? [[person.id, person.name] as const] : [])));
  }

  /**
   * Read the source event through every slice and build the version that would store it —
   * **writing nothing**.
   *
   * Separated from the write so both callers can put the whole of this before their first
   * statement. `saveFromEvent` needs it that way (issue #177); `captureVersion` gains the same
   * property for free, and neither can leave a half-written capture behind.
   */
  private async capture(
    actor: Actor,
    templateId: string,
    sourceEventId: string,
  ): Promise<{ draft: EventTemplateVersionDraft; reports: SliceCaptureReport[] }> {
    const source = await this.dependencies.events.get(actor, sourceEventId);
    if (!source) throw new EventTemplateNotFoundError("No such source event");
    const reports: SliceCaptureReport[] = [];
    const slices: Record<string, unknown> = {};
    for (const slice of this.dependencies.slices) {
      const captured = await this.exportSlice(slice, actor, sourceEventId);
      reports.push({ key: slice.key, label: slice.label, ...captured.report });
      if (captured.payload != null) slices[slice.key] = captured.payload;
    }
    const at = this.dependencies.now().toISOString();
    const payload: EventTemplatePayload = {
      capturedAt: at,
      source: { eventId: source.id, eventName: source.name, timezone: source.timezone },
      slices,
    };
    return {
      draft: {
        id: this.dependencies.newId(),
        templateId,
        sourceEventId,
        payload,
        createdAt: at,
        createdBy: actor.id,
      },
      reports,
    };
  }

  private async exportSlice(
    slice: EventConfigurationSlice,
    actor: Actor,
    sourceEventId: string,
  ): Promise<{ payload: unknown; report: Omit<SliceCaptureReport, "key" | "label"> }> {
    try {
      const payload = await slice.export(actor, sourceEventId);
      return payload == null
        ? {
            payload: null,
            report: {
              outcome: "empty",
              reason: "The source event has nothing configured for this category.",
            },
          }
        : { payload, report: { outcome: "captured", reason: "Captured from the source event." } };
    } catch (error) {
      // ERROR-INTENT: A slice the capturing actor may not read becomes a reported gap in the
      // template rather than a 500 or, worse, a silently short capture. Nothing is discarded:
      // the reason travels back in the response and the key is absent from the payload.
      if (error instanceof CapabilityDeniedError)
        return {
          payload: null,
          report: {
            outcome: "unauthorized",
            reason: "Your account cannot read this category on the source event.",
          },
        };
      return {
        payload: null,
        report: { outcome: "failed", reason: this.fault("export", slice, sourceEventId, error) },
      };
    }
  }

  private async previewSlice(
    slice: EventConfigurationSlice,
    actor: Actor | null,
    eventId: string,
    payload: unknown,
    remap: DateRemap,
    context: SliceContext,
  ) {
    try {
      return await slice.preview(actor, eventId, payload, remap, context);
    } catch (error) {
      // ERROR-INTENT: A preview reports; it never fails the request on one category's behalf.
      // Nothing is discarded: the reason travels back in `reason` and `fault` hands an
      // unexpected throw to the composition root's log before this returns.
      if (error instanceof CapabilityDeniedError)
        return {
          outcome: "unauthorized" as const,
          reason: "Your account cannot write this category on the destination event.",
          copies: [],
          excludes: [],
          incompatible: [],
        };
      return {
        outcome: "failed" as const,
        reason: this.fault("preview", slice, eventId, error),
        copies: [],
        excludes: [],
        incompatible: [],
      };
    }
  }

  private async applySlice(
    slice: EventConfigurationSlice,
    actor: Actor | null,
    eventId: string,
    payload: unknown,
    remap: DateRemap,
  ) {
    try {
      return await slice.apply(actor, eventId, payload, remap);
    } catch (error) {
      // ERROR-INTENT: A thrown slice is a fault against that slice alone, reported as `failed`
      // so the organizer can repair and re-apply. Letting it escape would turn one domain's
      // trouble into a 500 that hides every other slice's outcome; `fault` is what keeps the
      // cause itself from being lost with it.
      if (error instanceof CapabilityDeniedError)
        return {
          outcome: "unauthorized" as const,
          reason: "Your account cannot write this category on the destination event.",
          applied: [],
          incompatible: [],
        };
      return {
        outcome: "failed" as const,
        reason: this.fault("apply", slice, eventId, error),
        applied: [],
        incompatible: [],
      };
    }
  }

  /**
   * The sentence a refused category shows, and the one place a slice's fault is recorded.
   *
   * A slice that refuses on purpose says so with `SliceRefusalError` and its own words reach
   * the organizer. Anything else is unexpected here, and its message is written for us rather
   * than for them — a driver's `UNIQUE constraint failed: cfp_forms.event_id` in a product
   * surface is both unreadable and a description of storage this response has no business
   * carrying. So the caller gets the stable sentence and the fault goes to the log, once
   * (`ARC-OBS-001`).
   */
  private fault(
    stage: SliceFault["stage"],
    slice: EventConfigurationSlice,
    eventId: string,
    error: unknown,
  ): string {
    if (error instanceof SliceRefusalError) return error.message;
    this.dependencies.onSliceFault?.({ sliceKey: slice.key, stage, eventId, error });
    return UNEXPECTED[stage];
  }

  private excludedCategories(): SlicePreviewReport[] {
    return declaredExclusions.map(({ key, label, reason }) => ({
      key,
      label,
      outcome: "skipped" as const,
      reason,
      copies: [],
      excludes: [],
      incompatible: [],
    }));
  }

  private selection(command: TemplateApplicationCommand, key: string): boolean {
    return command.slices === undefined || command.slices.includes(key);
  }

  /**
   * Refuse a selected key no slice here answers to.
   *
   * The declared exclusions are known keys too: the plan lists `communications` as a category
   * with a reason, so a console that sends back everything it was shown must not be told it
   * invented one.
   */
  private requireKnownSelection(command: TemplateApplicationCommand): void {
    if (command.slices === undefined) return;
    const known = [
      ...this.dependencies.slices.map(({ key }) => key),
      ...declaredExclusions.map(({ key }) => key),
    ];
    const unknown = [...new Set(command.slices.filter((key) => !known.includes(key)))];
    if (unknown.length > 0)
      throw new EventTemplateSelectionError(
        `No category named ${unknown.map((key) => `"${key}"`).join(", ")}. ` +
          `This deployment copies: ${known.join(", ")}.`,
      );
  }

  private organizationMember(
    actor: Actor | null,
    organizationId: string,
    capability: Capability,
  ): Actor {
    const authorized = requireCapability(actor, capability);
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    return authorized;
  }

  private async loadTemplate(actor: Actor | null, templateId: string, capability: Capability) {
    const authorized = requireCapability(actor, capability);
    const template = await this.dependencies.repository.findTemplate(templateId);
    // One answer for "no such template" and "another organization's template" (see the error).
    if (!template || !authorized.organizations.some(({ id }) => id === template.organizationId))
      throw new EventTemplateNotFoundError("No such event template");
    return { authorized, template };
  }

  private async requireSourceEvent(actor: Actor, eventId: string, organizationId: string) {
    requireEventCapability(actor, eventId, "events:settings:read");
    if (!(await this.dependencies.events.belongsToOrganization(eventId, organizationId)))
      throw new EventTemplateNotFoundError("No such source event");
  }

  private async resolveApplication(
    actor: Actor | null,
    eventId: string,
    command: TemplateApplicationCommand,
    capability: Capability,
  ) {
    /*
     * The destination event is the grant that matters, and it is the one the actor holds
     * demonstrably: `events:settings:read` to preview, `events:settings:update` to apply.
     * Organization *membership* is deliberately not required on top — an organizer invited to
     * one event of an organization they are not a member of still administers that event, and
     * denying them here would be an authorization rule this system does not otherwise have.
     */
    const authorized = requireEventCapability(actor, eventId, capability);
    const { startsOn, endsOn } = command.destination;
    if (!isCalendarDate(startsOn) || !isCalendarDate(endsOn))
      throw new EventTemplateRangeError("Confirm the destination dates as YYYY-MM-DD");
    if (startsOn > endsOn)
      throw new EventTemplateRangeError("The destination event must not end before it starts");
    this.requireKnownSelection(command);
    const template = await this.dependencies.repository.findTemplate(command.templateId);
    // Cross-organization: resolved through the event repository, never from a request field,
    // and answering the same not-found refusal as an id that names nothing.
    if (
      !template ||
      !(await this.dependencies.events.belongsToOrganization(eventId, template.organizationId))
    )
      throw new EventTemplateNotFoundError("No such event template");
    const destination = await this.dependencies.events.get(authorized, eventId);
    if (!destination) throw new EventTemplateNotFoundError("No such event template");
    const version = await this.dependencies.repository.findVersion(
      command.templateId,
      command.version,
    );
    if (!version) throw new EventTemplateNotFoundError("No such event template version");
    const remap: DateRemap = {
      destination: { startsOn, endsOn, eventId, timezone: destination.timezone },
      source: {
        eventId: version.payload.source.eventId,
        timezone: version.payload.source.timezone,
      },
    };
    return {
      authorized,
      template,
      payload: version.payload,
      remap,
      identity: {
        templateId: template.id,
        templateName: template.name,
        versionId: version.id,
        version: version.version,
        sourceEventId: version.sourceEventId,
        sourceEventName: version.payload.source.eventName,
      },
    };
  }
}

/** What an organizer is told about a category that threw something nobody planned for. */
const UNEXPECTED: Record<SliceFault["stage"], string> = {
  export: "This category could not be captured. Capturing a new version is the repair.",
  preview: "This category could not be previewed. Previewing again is the repair.",
  apply: "This category could not be applied. Applying this version again is the repair.",
};
