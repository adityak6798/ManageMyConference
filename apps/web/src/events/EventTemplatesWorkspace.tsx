/*
 * Reusable event templates, from the organizer's side.
 *
 * The surface answers four questions in the order an organizer asks them: what does this
 * organization already have, what would applying one of them do to the event I am on, which
 * days does the clone land on, and what actually happened.
 *
 * Three things it deliberately refuses to be vague about.
 *
 * A preview is not a promise, so it is taken before every apply and the apply sends the exact
 * command the preview resolved — not whatever the controls hold by then. The version select
 * and both date boxes stay live while the breakdown is on screen, and rebuilding the command
 * at the click would let an organizer approve one clone and commit another.
 *
 * The destination range is not prefilled, because there is nothing honest to prefill it from:
 * an event in this system carries no dates of its own (`PRD-EVT-001`), so the range is a
 * parameter of the clone rather than a property the destination already holds. The form says
 * that where the organizer types it instead of leaving two mysterious empty boxes.
 *
 * And a partial application is reported as one. Nothing here spans a transaction across
 * domains, so a category that fails leaves the categories that already succeeded in place; the
 * summary states exactly that and names re-applying as the repair, because every category
 * converges rather than duplicating (`ARC-FLOW-006`).
 *
 * That last one used to be true only for the length of one response. The per-category outcome
 * was stored on every apply and read back by nothing, so an organizer who closed the tab — or
 * who inherited the event from the colleague who ran the clone — met an event that was
 * configured in part and said nothing about it. The first card on this page is now that state,
 * read from storage: it names the categories that did not land, and its button re-applies the
 * same version onto the same range, which is the repair (issue #175).
 *
 * @spec PRD-EVT-002 ARC-FLOW-006
 */

import type { ApplyEventTemplateInput, EventTemplateDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyEventTemplate,
  captureEventTemplateVersion,
  duplicateEventTemplate,
  EventTemplateApiError,
  type EventTemplateApplicationDto,
  type EventTemplateDetailDto,
  getEventTemplate,
  listEventTemplates,
  listTemplateApplications,
  type OutstandingConfigurationCategoryDto,
  previewTemplateApplication,
  type SlicePreviewDto,
  type SliceResultDto,
  saveEventTemplate,
  type TemplateApplicationPlanDto,
  type TemplateApplicationResultDto,
  updateEventTemplate,
} from "../api/event-templates";
import "../styles/events.css";
import { IconCalendar, IconCheck, IconInbox, IconWarning } from "../ui/icons";
import { Card, EmptyState, Notice, Pill, useActionFeedback } from "../ui/primitives";

type Feedback = ReturnType<typeof useActionFeedback>;
type SliceEntry = SlicePreviewDto["copies"][number];

/** One template and the versions it holds, which is what an organizer chooses between. */
interface TemplateRow {
  readonly template: EventTemplateDto;
  readonly versions: EventTemplateDetailDto["versions"];
}

/** A plan, and the exact command that produced it, so applying cannot mean something else. */
interface ReviewedPlan {
  readonly plan: TemplateApplicationPlanDto;
  readonly reviewed: ApplyEventTemplateInput;
}

/*
 * Preview and result vocabularies are separate on the wire and stay separate here: saying
 * "applied" before anything is written would be a claim a preview has no standing to make.
 */
const PREVIEW_WORDS: Record<SlicePreviewDto["outcome"], string> = {
  copies: "Would copy",
  skipped: "Skipped",
  incompatible: "Incompatible",
  unauthorized: "Unauthorized",
  failed: "Could not be previewed",
};

const RESULT_WORDS: Record<SliceResultDto["outcome"], string> = {
  applied: "Applied",
  skipped: "Skipped",
  incompatible: "Incompatible",
  unauthorized: "Unauthorized",
  failed: "Failed",
};

/*
 * A stored version reports the slice *keys* it carries, and a key is a storage identifier: an
 * organizer offered "content-checklists, content-resources" is reading this system's internals.
 * These are the words the server's own preview and result use for the same six categories, so
 * the version list and the breakdown below it call a category the same thing. A key this console
 * has no word for is counted rather than printed — a version captured by a newer API is exactly
 * the case where printing the key would put one back on screen.
 */
const SLICE_LABELS: Record<string, string> = {
  review: "Triage statuses and scoring rubric",
  cfp: "CFP form and routing",
  agenda: "Agenda rooms, tracks and time slots",
  publishing: "Public page details",
  "content-resources": "Speaker portal resources",
  "content-checklists": "Speaker task checklists",
};

const TONES: Record<string, "ok" | "neutral" | "warn" | "danger"> = {
  copies: "ok",
  applied: "ok",
  skipped: "neutral",
  incompatible: "warn",
  unauthorized: "warn",
  failed: "danger",
};

function describe(reason: unknown, fallback: string): string {
  if (reason instanceof EventTemplateApiError)
    return `${reason.message} Reference: ${reason.envelope.error.correlationId}`;
  return reason instanceof Error && reason.message ? `${fallback} (${reason.message})` : fallback;
}

/**
 * Both words are named rather than derived: the noun this surface counts most is "category",
 * and a rule that appends an "s" puts "categorys" in front of an organizer.
 */
const countLabel = (count: number, singular: string, plural: string) =>
  `${count} ${count === 1 ? singular : plural}`;

/** What a stored version carries, counted first because the count is what is compared. */
const carriedCategories = (keys: readonly string[]) => {
  const named = keys.map((key) => SLICE_LABELS[key]).filter((label) => label !== undefined);
  const listed =
    named.length === keys.length
      ? named
      : [
          ...named,
          `${countLabel(keys.length - named.length, "category", "categories")} this console cannot name`,
        ];
  return `${countLabel(keys.length, "category", "categories")}: ${listed.join(", ")}`;
};

/**
 * The two readings of a result's categories, named once and shared by everything that counts
 * them — the verdict heading, the announcement after an apply, and the repair card.
 *
 * A `skipped` category is deliberately in neither list. It is not a refusal: it is a category
 * this template carries nothing for, so it neither qualifies a success nor counts as a write.
 */
const writtenCategories = (slices: readonly SliceResultDto[]) =>
  slices.filter(({ outcome }) => outcome === "applied");

/** Categories the destination refused, the account may not write, or that faulted. */
const refusedCategories = (slices: readonly SliceResultDto[]) =>
  slices.filter(({ outcome }) => outcome !== "applied" && outcome !== "skipped");

/**
 * The heading and tone the categories below the card actually support.
 *
 * Read from the per-category outcomes rather than from the envelope's own word: "Applied" over a
 * category reading "Incompatible" is a claim the list underneath it contradicts, and the
 * envelope's vocabulary belongs to the server, which may widen it.
 */
function verdict(slices: readonly SliceResultDto[]) {
  const written = writtenCategories(slices).length;
  const refused = refusedCategories(slices).length;
  if (written && !refused) return { title: "Applied", tone: "success" as const };
  if (written) return { title: "Applied in part", tone: "warn" as const };
  return { title: "Not applied", tone: "warn" as const };
}

const stampedDay = (instant: string) =>
  new Date(instant).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const stampedTime = (instant: string) =>
  new Date(instant).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** A calendar day is a day, not an instant: read it at UTC noon so no zone shifts it. */
const stampedCalendarDay = (day: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(
        new Date(`${day}T12:00:00Z`),
      )
    : day;

/**
 * One named set inside a category.
 *
 * A list rather than a sentence: this is read to find the one entry that should not be there,
 * and a comma-separated paragraph of eleven field names is not read at all.
 */
function SliceEntries({ title, entries }: { title: string; entries: readonly SliceEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="template-entry-group">
      <p className="template-entry-label">{title}</p>
      <ul className="template-entries">
        {entries.map((entry) => (
          <li key={entry.id}>{entry.label}</li>
        ))}
      </ul>
    </div>
  );
}

// @spec PRD-EVT-002
export function EventTemplatesWorkspace({
  organizationId,
  eventId,
  eventName,
  canApply,
  canAuthor,
}: {
  organizationId: string;
  eventId: string;
  eventName: string;
  /** `events:settings:update` on *this* event. Previewing needs only the read grant. */
  canApply: boolean;
  /** The organization-level grant behind saving, renaming, archiving and duplicating. */
  canAuthor: boolean;
}) {
  const run = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * A failure to *load*, and only that: it replaces the surface, because controls backed by
   * templates this workspace never read would offer to clone something nobody can see. Every
   * other failure belongs to the control that caused it and is announced beside it.
   */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedId, setSelectedId] = useState("");
  const [newName, setNewName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [duplicateName, setDuplicateName] = useState("");

  const [version, setVersion] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [reviewed, setReviewed] = useState<ReviewedPlan | null>(null);
  const [result, setResult] = useState<TemplateApplicationResultDto | null>(null);
  /**
   * What this event has already been configured from, and how each of those went.
   *
   * Kept beside the templates rather than folded into them, because it answers a different
   * question: the library is what this organization *could* clone, and this is what has already
   * happened to the event in front of the organizer.
   */
  const [applications, setApplications] = useState<EventTemplateApplicationDto[]>([]);
  /**
   * The categories this event still owes, folded server-side across every application.
   *
   * Held apart from `applications` because it answers a different question and is not derivable
   * from that list here: the fold is a domain rule (`outstandingConfiguration`) with two readers
   * — this workspace and the operational inbox — and a rule with two readers must not live in
   * either of them (issue #203).
   */
  const [outstanding, setOutstanding] = useState<OutstandingConfigurationCategoryDto[]>([]);
  /** A history this page could not read, reported in place of the card rather than everywhere. */
  const [historyError, setHistoryError] = useState<string | null>(null);

  const libraryFeedback = useActionFeedback();
  const manageFeedback = useActionFeedback();
  const applyFeedback = useActionFeedback();
  const repairFeedback = useActionFeedback();

  const reload = useCallback(async () => {
    const generation = ++run.current;
    const templates = await listEventTemplates(organizationId);
    /*
     * The list route answers with templates alone, and the version count is half of what an
     * organizer is choosing between — "the starter, three versions in" is a different thing
     * from "the starter somebody saved this morning". The detail route is the only place that
     * reports versions, and they are the same versions the apply form offers, so this read
     * serves both rather than being repeated on every selection.
     */
    const loaded = await Promise.all(
      templates.map(async (template) => ({
        template,
        versions: [...(await getEventTemplate(template.id)).versions].sort(
          (left, right) => right.version - left.version,
        ),
      })),
    );
    if (generation !== run.current) return;
    setRows(loaded);
  }, [organizationId]);

  /**
   * What has already been applied to this event, read on its own.
   *
   * Separate from `reload` on purpose, and not only for tidiness: reloading the library mints
   * new row objects, which re-arms the per-template controls and clears the result card. An
   * apply has to refresh this list — it is what the repair card reads — and must not throw away
   * the breakdown the organizer is looking at while doing so.
   */
  const readApplications = useCallback(async () => {
    const generation = run.current;
    /*
     * ERROR-INTENT: caught rather than allowed to reject, so a history this page could not read
     * reports itself in its own card instead of replacing the whole workspace. Nothing is
     * discarded — the reason is rendered — and the distinction is real: not knowing what has
     * already been applied says nothing about whether a template can be applied now.
     */
    const configured = await listTemplateApplications(eventId).then(
      (found) => ({ found }),
      (reason: unknown) => ({
        failure: describe(reason, "This event's template history could not be read."),
      }),
    );
    if (generation !== run.current) return;
    setApplications("found" in configured ? configured.found.applications : []);
    setOutstanding("found" in configured ? configured.found.outstanding : []);
    setHistoryError("failure" in configured ? configured.failure : null);
  }, [eventId]);

  /** The load, with its two outcomes rendered in place of the surface rather than beside it. */
  const load = useCallback(
    (isActive: () => boolean = () => true) => {
      setError(null);
      setLoading(true);
      return Promise.all([reload(), readApplications()])
        .catch((reason: unknown) => {
          if (isActive()) setError(describe(reason, "The templates could not be loaded."));
        })
        .finally(() => {
          if (isActive()) setLoading(false);
        });
    },
    [readApplications, reload],
  );

  useEffect(() => {
    let active = true;
    // Selection, both forms and the plan are all organization-scoped. Carrying them across a
    // switch would leave the apply card describing a template this organization does not have.
    setSelectedId("");
    setReviewed(null);
    setResult(null);
    // ERROR-INTENT: React effects cannot await; load renders both of its outcomes.
    void load(() => active);
    return () => {
      active = false;
      run.current += 1;
    };
  }, [load]);

  const selected = rows.find(({ template }) => template.id === selectedId) ?? null;
  const versions = useMemo(() => selected?.versions ?? [], [selected]);
  const newest = versions[0] ?? null;
  /*
   * The server refuses to apply an archived template, and this surface has already said so in
   * two places. Preview does not inspect state at all, so leaving these controls live would walk
   * an organizer through a full per-category breakdown to a refusal the page called certain.
   */
  const isArchived = selected?.template.state === "archived";
  /** What the categories in the result support, which is all the card above them may claim. */
  const resultVerdict = result ? verdict(result.slices) : null;
  /*
   * Every category this event still owes — folded per *category*, not per application.
   *
   * This card used to show the **most recent** application, and only when its stored envelope
   * word was `partial` or `failed`. That rule was a safety rule with a real cost, and issue #203
   * is the cost coming due. An application row is keyed per version, so applying a newer version
   * — or a different template, or the same one with a narrower selection — writes its own row
   * and leaves an older `partial` one exactly where it was. The newer row could read `applied`
   * while the category the earlier one could not write was still unconfigured, and this card
   * then went quiet about precisely the condition it exists to raise.
   *
   * The safety half of the old rule survives, and is now structural rather than conventional.
   * Offering an *older application* as a whole-clone repair would write its payload over the
   * configuration that superseded it — every category converges on the payload it is given, so
   * "re-apply version 1" against an event since configured from version 2 is a revert wearing
   * the word repair. Folding per category dissolves that: the deciding application for a
   * category is the newest one that reached it, so a category a later application configured is
   * not outstanding at all, and the repair offered here is one version and one category rather
   * than a whole selection.
   *
   * Read from the server rather than recomputed here, for the same reason the envelope word was:
   * the fold is a domain rule and this console is one of its two readers.
   */
  const incomplete = outstanding;

  // Opening a template arms its own controls: the rename box holds the current name, the apply
  // form offers its newest version, and a plan built against the previous template is dropped.
  useEffect(() => {
    setRenameName(selected?.template.name ?? "");
    setDuplicateName(selected ? `${selected.template.name} copy` : "");
    setVersion(selected?.versions[0] ? String(selected.versions[0].version) : "");
    setReviewed(null);
    setResult(null);
  }, [selected]);

  async function guard(work: () => Promise<string>, feedback: Feedback) {
    setBusy(true);
    try {
      feedback.announce("success", await work());
    } catch (reason) {
      feedback.announce("error", describe(reason, "That action could not be completed."));
    } finally {
      setBusy(false);
    }
  }

  /** Categories that stored nothing are named, because a quietly short capture applies cleanly. */
  const captureSummary = (slices: readonly { label: string; outcome: string }[]) => {
    const captured = slices.filter(({ outcome }) => outcome === "captured");
    const missing = slices.filter(
      ({ outcome }) => outcome === "unauthorized" || outcome === "failed",
    );
    const missed = missing.length
      ? ` ${missing.map(({ label }) => label).join(", ")} stored nothing.`
      : "";
    return `${countLabel(captured.length, "category", "categories")} captured.${missed}`;
  };

  async function save(formEvent: FormEvent) {
    formEvent.preventDefault();
    await guard(async () => {
      const capture = await saveEventTemplate(organizationId, {
        name: newName.trim(),
        sourceEventId: eventId,
      });
      setNewName("");
      await reload();
      setSelectedId(capture.template.id);
      return `Saved “${capture.template.name}” as version 1. ${captureSummary(capture.slices)}`;
    }, libraryFeedback);
  }

  async function capture() {
    if (!selected) return;
    await guard(async () => {
      const captured = await captureEventTemplateVersion(selected.template.id, eventId);
      await reload();
      return `${eventName} captured as version ${captured.version.version}. ${captureSummary(captured.slices)}`;
    }, manageFeedback);
  }

  async function rename(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    await guard(async () => {
      const renamed = await updateEventTemplate(selected.template.id, { name: renameName.trim() });
      await reload();
      return `Renamed to “${renamed.name}”.`;
    }, manageFeedback);
  }

  async function setArchived(archived: boolean) {
    if (!selected) return;
    await guard(async () => {
      const updated = await updateEventTemplate(selected.template.id, {
        state: archived ? "archived" : "active",
      });
      await reload();
      return archived
        ? `“${updated.name}” archived. It stays readable and can be restored; it cannot be applied or captured into.`
        : `“${updated.name}” restored.`;
    }, manageFeedback);
  }

  async function duplicate(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    await guard(async () => {
      const copy = await duplicateEventTemplate(selected.template.id, duplicateName.trim());
      await reload();
      setSelectedId(copy.template.id);
      return `Duplicated as “${copy.template.name}”, starting at version 1.`;
    }, manageFeedback);
  }

  async function preview(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    await guard(async () => {
      const command: ApplyEventTemplateInput = {
        templateId: selected.template.id,
        version: Number(version),
        destination: { startsOn, endsOn },
      };
      const plan = await previewTemplateApplication(eventId, command);
      setResult(null);
      setReviewed({ plan, reviewed: command });
      const copying = plan.slices.filter(({ outcome }) => outcome === "copies").length;
      return `Previewed version ${plan.version}: ${countLabel(copying, "category", "categories")} would be written, ${plan.slices.length - copying} would not. Nothing has been written.`;
    }, applyFeedback);
  }

  async function apply() {
    // The command the preview resolved, never the live controls: the version select and both
    // date boxes stay editable while the breakdown is on screen, so rebuilding the command here
    // could clone a different version onto a different range than the one just approved.
    const command = reviewed?.reviewed;
    if (!command) return;
    await guard(async () => {
      const applied = await applyEventTemplate(eventId, command);
      setReviewed(null);
      setResult(applied);
      // The result is the answer to the click and it renders below the fold on a long preview.
      requestAnimationFrame(() => resultRef.current?.focus({ preventScroll: false }));
      // The repair card reads this list, and this apply has just changed what it says. The
      // library is deliberately not reloaded: doing so re-arms the controls and clears the very
      // breakdown this click produced.
      await readApplications();
      // Counted the way the card below is titled, so the announcement cannot call an application
      // complete while the breakdown it points at names a category the destination refused.
      const written = writtenCategories(applied.slices).length;
      const refused = refusedCategories(applied.slices).length;
      return refused
        ? `Version ${applied.version} applied in part: ${countLabel(written, "category", "categories")} written, ${countLabel(refused, "category", "categories")} not. The written ones stand.`
        : `Version ${applied.version} applied: ${countLabel(written, "category", "categories")} written.`;
    }, applyFeedback);
  }

  /**
   * Apply the same version, onto the same days, with the same categories selected.
   *
   * The command is rebuilt from what was *stored*, not from the controls on this page: the
   * repair has to be the same act as the application it repairs, or it is a different clone
   * wearing its name. Every category converges, so the ones that already landed are written
   * back identically and the ones that did not get another attempt (`ARC-FLOW-006`).
   */
  /**
   * Settle one outstanding category by re-applying it from the version that owes it.
   *
   * Narrow on purpose, and the narrowness is what makes it safe rather than what makes it
   * polite: `slices: [category.key]` writes that category and nothing else, so a repair for a
   * version somebody has since superseded cannot touch what superseded it. The destination range
   * travels from the stored outcome because it is a parameter of the clone rather than a
   * property of the event — nothing else could reconstruct it, and a repair that began by asking
   * for two dates again would not be one action away (issue #203).
   */
  async function repair(category: OutstandingConfigurationCategoryDto) {
    await guard(async () => {
      const applied = await applyEventTemplate(eventId, {
        templateId: category.templateId,
        version: category.version,
        destination: category.destination,
        slices: [category.key],
      });
      setReviewed(null);
      setResult(applied);
      await readApplications();
      const refused = refusedCategories(applied.slices);
      return refused.length
        ? `${category.label} still did not land: ${refused.map(({ reason }) => reason).join(" ")}`
        : `${category.label} is now configured from version ${applied.version} of “${category.templateName}”.`;
    }, repairFeedback);
  }

  if (loading)
    return (
      <Card>
        <div className="template-loading" aria-hidden="true">
          <div className="skeleton" style={{ height: 18, width: "34%" }} />
          <div className="skeleton" style={{ height: 96, width: "100%" }} />
        </div>
        <p className="visually-hidden" role="status">
          Loading the event templates.
        </p>
      </Card>
    );

  if (error)
    return (
      <Card
        labelledBy="event-templates-unavailable"
        title="The templates could not be opened"
        actions={
          <button
            type="button"
            onClick={() => {
              // ERROR-INTENT: handlers cannot await; load renders both of its outcomes.
              void load();
            }}
          >
            Try again
          </button>
        }
      >
        <Notice tone="error">{error}</Notice>
        <p className="template-note">
          Nothing is offered until the organization's templates load, so a retry cannot apply a
          template this surface never managed to read.
        </p>
      </Card>
    );

  return (
    <>
      {historyError ? (
        <Card labelledBy="event-template-history-unavailable" title="Template history unavailable">
          <Notice tone="error">{historyError}</Notice>
          <p className="template-note">
            The templates below are unaffected — this is only the record of what has already been
            applied to {eventName}, so a clone made now would still be reported in full.
          </p>
        </Card>
      ) : null}

      {incomplete.length ? (
        <Card
          labelledBy="event-template-incomplete"
          title={`${eventName} is configured in part`}
          hint={`${countLabel(incomplete.length, "category", "categories")} this event was cloned from never arrived, and nothing else in the console says so. Each repair below re-applies one category from the version that could not write it, which converges rather than duplicating and cannot overwrite a category configured since. If you have fixed one by hand, applying again is still safe and is what clears it.`}
        >
          <div className="template-stack">
            {/*
              One entry per outstanding *category*, each carrying the version that owes it. Two
              categories left owing by two different applications are two entries with two
              repairs, which is the shape the old per-application card could not express.
            */}
            {incomplete.map((category) => {
              const archived = category.templateState === "archived";
              return (
                <div
                  className="template-stack"
                  key={`${category.templateVersionId}:${category.key}`}
                >
                  <Notice tone="warn">
                    <IconWarning size={15} />
                    <span>
                      <strong>{category.label}</strong> was not configured from version{" "}
                      {category.version} of “{category.templateName}”, applied on{" "}
                      {stampedTime(category.outstandingSince)} onto{" "}
                      {stampedCalendarDay(category.destination.startsOn)} –{" "}
                      {stampedCalendarDay(category.destination.endsOn)}. Nothing applied since has
                      configured it.
                    </span>
                  </Notice>
                  <div className="section-heading">
                    <h3>{category.label}</h3>
                    <Pill tone={TONES[category.outcome] ?? "neutral"}>
                      {RESULT_WORDS[category.outcome]}
                    </Pill>
                  </div>
                  <span className="sub">{category.reason}</span>
                  {/* The entities the destination named in refusing. The first draft of the
                      per-category card dropped these, leaving the reason sentence without the
                      list of rooms, slots or rules it refers to. */}
                  <SliceEntries
                    title={`${eventName} would not accept`}
                    entries={category.incompatible}
                  />
                  <div className="toolbar">
                    <button
                      type="button"
                      disabled={busy || !canApply || archived}
                      onClick={() => {
                        // ERROR-INTENT: handlers cannot await; repair announces both outcomes.
                        void repair(category);
                      }}
                    >
                      Apply {category.label} from version {category.version} to {eventName}
                    </button>
                  </div>
                  {canApply ? null : (
                    <p className="template-note">
                      Your role on {eventName} can see what is missing but not apply a template, so
                      this repair belongs to an organizer who can.
                    </p>
                  )}
                  {archived ? (
                    <p className="template-note">
                      “{category.templateName}” has been archived since, and an archived template
                      cannot be applied. Restoring it is what makes this repair available.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}
      {/*
        Outside the card, and deliberately: the repair's own announcement is "that worked", and
        a card whose whole condition is "something is still missing" is gone by the time it is
        true. `useActionFeedback` also wants one element that is never remounted, which a node
        living inside a conditional card is not.
      */}
      {repairFeedback.node}

      <Card
        labelledBy="event-templates-library"
        title="Templates"
        hint={`Every reusable template this organization holds. Applying one writes into ${eventName}; capturing one only reads.`}
      >
        {rows.length === 0 ? (
          <EmptyState title="No templates yet" icon={<IconInbox size={20} />}>
            Save {eventName}'s configuration below and it becomes version 1 of the first template
            this organization can clone from.
          </EmptyState>
        ) : (
          <ul className="plain-list template-list">
            {rows.map(({ template, versions: held }) => {
              const latest = held[0];
              return (
                <li key={template.id}>
                  <div className="section-heading">
                    <button
                      type="button"
                      className="ghost"
                      aria-current={template.id === selectedId ? "true" : undefined}
                      onClick={() => setSelectedId(template.id)}
                    >
                      {template.name}
                    </button>
                    <Pill tone={template.state === "active" ? "ok" : "neutral"}>
                      {template.state === "active" ? "Active" : "Archived"}
                    </Pill>
                  </div>
                  <span className="sub">
                    {countLabel(held.length, "version", "versions")}
                    {latest
                      ? ` · newest captured from ${latest.sourceEventName} on ${stampedDay(latest.createdAt)}`
                      : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        labelledBy="event-templates-save"
        title="Save this event as a template"
        hint={`Reads ${eventName}'s configuration and stores it as version 1 of a new template. Nothing on this event changes.`}
      >
        {canAuthor ? (
          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="event-template-new-name">Template name</label>
              <div className="form-row">
                <input
                  id="event-template-new-name"
                  value={newName}
                  onChange={(changeEvent) => setNewName(changeEvent.target.value)}
                  placeholder="Annual summit starter"
                  required
                  maxLength={120}
                />
                <button type="submit" disabled={busy || !newName.trim()}>
                  Save template
                </button>
              </div>
              {libraryFeedback.node}
            </div>
          </form>
        ) : (
          <p className="template-note">
            Your account can apply this organization's templates but not create one — saving reads
            an event's configuration on behalf of the whole organization.
          </p>
        )}
      </Card>

      {selected ? (
        <>
          <Card
            labelledBy="event-template-versions"
            title={<span className="template-name">{selected.template.name}</span>}
            hint="Versions, newest first. Applying always names one: “latest” would make the same request produce a different event next week."
            actions={
              canAuthor ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || selected.template.state === "archived"}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; capture announces both outcomes.
                    void capture();
                  }}
                >
                  Capture {eventName} as version {(newest?.version ?? 0) + 1}
                </button>
              ) : undefined
            }
          >
            <ul className="plain-list template-list">
              {versions.map((held) => (
                <li key={held.id}>
                  <div className="section-heading">
                    <h3>Version {held.version}</h3>
                    <Pill tone={held.slices.length ? "info" : "warn"}>
                      {countLabel(held.slices.length, "category", "categories")}
                    </Pill>
                  </div>
                  {/*
                   * The capturing account resolved to a person, the way content revisions were
                   * resolved in issue #154 and as issue #176 asked for here. The fallback still
                   * says "account", because that is what the value is when identity holds no
                   * user for it — an id printed after a bare "by" reads as somebody's name.
                   */}
                  <span className="sub">
                    Captured from {held.sourceEventName} on {stampedDay(held.createdAt)}, by{" "}
                    {held.createdByName ?? `account ${held.createdBy}`}
                    {held.slices.length
                      ? ` · carries ${carriedCategories(held.slices)}`
                      : " · carries nothing, so applying it would write nothing"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {canAuthor ? (
            <Card
              labelledBy="event-template-manage"
              title="Manage this template"
              hint="Renaming, archiving and duplicating change the template. An event already configured from it is untouched."
            >
              <div className="template-stack">
                <div className="grid-auto">
                  <form className="field" onSubmit={rename}>
                    <label htmlFor="event-template-rename">Rename</label>
                    <div className="form-row">
                      <input
                        id="event-template-rename"
                        value={renameName}
                        onChange={(changeEvent) => setRenameName(changeEvent.target.value)}
                        required
                        maxLength={120}
                      />
                      <button
                        type="submit"
                        className="secondary"
                        disabled={
                          busy || !renameName.trim() || renameName.trim() === selected.template.name
                        }
                      >
                        Rename
                      </button>
                    </div>
                  </form>

                  <form className="field" onSubmit={duplicate}>
                    <label htmlFor="event-template-duplicate">Duplicate as</label>
                    <div className="form-row">
                      <input
                        id="event-template-duplicate"
                        value={duplicateName}
                        onChange={(changeEvent) => setDuplicateName(changeEvent.target.value)}
                        required
                        maxLength={120}
                      />
                      <button
                        type="submit"
                        className="secondary"
                        disabled={busy || !duplicateName.trim()}
                      >
                        Duplicate
                      </button>
                    </div>
                    <p className="hint">
                      The newest version is copied under the new name and starts again at version 1.
                      The history stays with the original, which is where it was actually captured.
                    </p>
                  </form>

                  <div className="field">
                    <p className="template-entry-label">
                      {selected.template.state === "active" ? "Active" : "Archived"}
                    </p>
                    <div className="form-row">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          // ERROR-INTENT: handlers cannot await; setArchived announces both.
                          void setArchived(selected.template.state === "active");
                        }}
                      >
                        {selected.template.state === "active" ? "Archive" : "Restore"}
                      </button>
                    </div>
                    <p className="hint">
                      An archived template stays readable and can be restored. It cannot be applied,
                      and no new version can be captured into it.
                    </p>
                  </div>
                </div>
                {manageFeedback.node}
              </div>
            </Card>
          ) : null}

          <Card
            labelledBy="event-template-apply"
            title={`Apply to ${eventName}`}
            hint="Preview first: it writes nothing and reports every category. Applying then writes exactly what the preview listed."
          >
            <form className="template-stack" onSubmit={preview}>
              <div className="grid-auto">
                <div className="field">
                  <label htmlFor="event-template-version">Version to apply</label>
                  <select
                    id="event-template-version"
                    value={version}
                    onChange={(changeEvent) => setVersion(changeEvent.target.value)}
                  >
                    {versions.map((held) => (
                      <option key={held.id} value={held.version}>
                        Version {held.version} · captured {stampedDay(held.createdAt)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="event-template-starts-on">First day</label>
                  <input
                    id="event-template-starts-on"
                    type="date"
                    value={startsOn}
                    onChange={(changeEvent) => setStartsOn(changeEvent.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="event-template-ends-on">Last day</label>
                  <input
                    id="event-template-ends-on"
                    type="date"
                    value={endsOn}
                    onChange={(changeEvent) => setEndsOn(changeEvent.target.value)}
                    required
                  />
                </div>
              </div>

              <Notice tone="info">
                <IconCalendar size={15} />
                <span>
                  These two days are part of the clone rather than a fact about {eventName}: an
                  event here carries no dates of its own, so there is nothing to prefill them from
                  and nothing that would fill them in later. Confirm them, and anything dated in the
                  template is remapped onto the range you confirmed.
                </span>
              </Notice>

              <div className="toolbar">
                <button
                  type="submit"
                  disabled={busy || isArchived || !version || !startsOn || !endsOn}
                >
                  Preview this clone
                </button>
              </div>
              {isArchived ? (
                <p className="template-note">
                  “{selected.template.name}” is archived, and an archived template cannot be applied
                  — so there is nothing here worth previewing. Restoring it is what puts it back in
                  circulation.
                </p>
              ) : null}
              {applyFeedback.node}
            </form>
          </Card>
        </>
      ) : (
        <Card labelledBy="event-template-none" title="Nothing selected">
          <EmptyState title="Open a template to preview it" icon={<IconInbox size={20} />}>
            Choosing one above shows its versions, what applying it would copy into {eventName}, and
            the two days the clone lands on.
          </EmptyState>
        </Card>
      )}

      {reviewed ? (
        <Card
          labelledBy="event-template-plan"
          title="Preview"
          hint={`Version ${reviewed.plan.version} of “${reviewed.plan.templateName}”, captured from ${reviewed.plan.sourceEventName}, onto ${stampedCalendarDay(reviewed.plan.destination.startsOn)} – ${stampedCalendarDay(reviewed.plan.destination.endsOn)}. Nothing has been written.`}
        >
          <div className="template-stack">
            <ul className="plain-list">
              {reviewed.plan.slices.map((slice) => (
                <li key={slice.key}>
                  <div className="section-heading">
                    <h3>{slice.label}</h3>
                    <Pill tone={TONES[slice.outcome] ?? "neutral"}>
                      {PREVIEW_WORDS[slice.outcome]}
                    </Pill>
                  </div>
                  <span className="sub">{slice.reason}</span>
                  <SliceEntries title="Would be copied" entries={slice.copies} />
                  <SliceEntries title="Deliberately left behind" entries={slice.excludes} />
                  <SliceEntries
                    title={`${eventName} will not accept`}
                    entries={slice.incompatible}
                  />
                </li>
              ))}
            </ul>

            <div className="toolbar">
              <button
                type="button"
                disabled={busy || !canApply || isArchived}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; apply announces both outcomes.
                  void apply();
                }}
              >
                Apply version {reviewed.plan.version} to {eventName}
              </button>
            </div>
            {canApply ? null : (
              <p className="template-note">
                Your role on {eventName} can preview a template but not apply it.
              </p>
            )}
          </div>
        </Card>
      ) : null}

      {result && resultVerdict ? (
        <Card
          labelledBy="event-template-result"
          title={resultVerdict.title}
          hint={`Version ${result.version} of “${result.templateName}” onto ${eventName} at ${stampedTime(result.appliedAt)}.`}
        >
          {/* tabIndex={-1} is the focus target for the outcome of the apply button, not a tab stop. */}
          <div className="template-stack" ref={resultRef} tabIndex={-1}>
            <Notice tone={resultVerdict.tone}>
              {resultVerdict.tone === "success" ? (
                <IconCheck size={15} />
              ) : (
                <IconWarning size={15} />
              )}
              <span>
                Categories are written one at a time, and nothing in this system spans a transaction
                across them. A category that fails does <strong>not</strong> roll back the
                categories that succeeded — those writes stand. Applying this same version again is
                the repair: every category converges on the template rather than duplicating what it
                already wrote.
              </span>
            </Notice>

            <ul className="plain-list">
              {result.slices.map((slice) => (
                <li key={slice.key}>
                  <div className="section-heading">
                    <h3>{slice.label}</h3>
                    <Pill tone={TONES[slice.outcome] ?? "neutral"}>
                      {RESULT_WORDS[slice.outcome]}
                    </Pill>
                  </div>
                  <span className="sub">{slice.reason}</span>
                  <SliceEntries title="Written" entries={slice.applied} />
                  <SliceEntries
                    title={`${eventName} would not accept`}
                    entries={slice.incompatible}
                  />
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}
    </>
  );
}
