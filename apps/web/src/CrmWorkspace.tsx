/*
 * Speaker CRM.
 *
 * Outreach is a pipeline, so the surface is a stage-filtered table with live counts
 * next to a detail panel: an organizer can answer "who is stuck, and in which stage"
 * without leaving the page. The whole pipeline is fetched once per event and filtered
 * in the browser because the tab counts have to be readable *before* a stage is
 * picked, and the list endpoint returns one stage at a time.
 *
 * Owner is a select rather than free text, populated from the same identity-access query the
 * server validates writes against: the event's organizers and reviewers. An owner id that does
 * not exist violated the crm_prospects.owner_id foreign key and surfaced as a 500, so the UI
 * offers only identities the server will accept — and renders the server's refusal on the
 * owner control when it disagrees anyway.
 *
 * The two owner controls are the only native `<select>` elements left on this surface, and they
 * stay native deliberately: the refusal above is delivered as `aria-invalid` plus a described-by
 * error on the element that was refused, and that wiring — including the acceptance tests that
 * read the element's own `options` and `value` — is the contract between this form and the
 * server's field errors. Stage, and every select in the stage editor beside it, is the shared
 * listbox.
 */

import type { ProspectDto, ProspectOwnerDto } from "@greenroom/contracts";
import type { PipelineStageDto, StageCategoryDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  convertProspect,
  createProspect,
  crmFieldErrors,
  deletePipelineStage,
  listPipelineStages,
  listProspectOwners,
  listProspects,
  savePipelineStages,
  updateProspect,
} from "./api/crm";
import { type ApiFailure, describeApiFailure } from "./api/config";
import { Inspector } from "./crm/inspector";
import { PipelineBoard } from "./crm/PipelineBoard";
import { PipelineStageEditor } from "./crm/PipelineStageEditor";
import "./styles/crm.css";
import { Select } from "./ui/fields";
import { IconCheck, IconClock, IconPlus, IconSpeakers } from "./ui/icons";
import {
  Card,
  EmptyState,
  LoadFailure,
  Notice,
  Pill,
  SkeletonRows,
  Stat,
  Tabs,
  useActionFeedback,
} from "./ui/primitives";

type PillTone = "neutral" | "ok" | "warn" | "danger" | "info" | "strong";

/**
 * The tone a stage is drawn in, by what it *means* rather than by its name.
 *
 * The five hard-coded stages this replaces could carry a tone each because the list was fixed.
 * A configurable board cannot: an organizer's "Shortlisted" has no entry in any table here, and
 * its semantic category is exactly the thing that survives their renaming it (#197).
 */
const CATEGORY_TONE: Record<StageCategoryDto, PillTone> = {
  open: "info",
  won: "ok",
  nurture: "warn",
  lost: "neutral",
};

/** The stage converting a prospect writes; the API refuses a move into it, so it is not offered. */
const CONVERTED = "converted";

const ACTIVITY_TONES: Record<ProspectDto["activities"][number]["kind"], PillTone> = {
  note: "neutral",
  email: "info",
  call: "info",
  meeting: "info",
  engagement: "ok",
  "stage-change": "warn",
  conversion: "ok",
};

/**
 * What each entry in the timeline is, written out.
 *
 * The kind is a wire enum, and printing it with its hyphen swapped for a space ("stage change")
 * is a title-cased token rather than a name — the same defect `ui/vocabulary.ts` exists to end.
 * These stay local because an outreach activity is the CRM's own vocabulary and no other surface
 * renders one.
 */
const ACTIVITY_LABELS: Record<ProspectDto["activities"][number]["kind"], string> = {
  note: "Note",
  email: "Email",
  call: "Call",
  meeting: "Meeting",
  engagement: "Engagement",
  "stage-change": "Moved stage",
  conversion: "Converted",
};

const localDateTimeValue = (instant: string | null) => {
  if (!instant) return "";
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const shortDate = (instant: string) =>
  new Date(instant).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const stampedTime = (instant: string) =>
  new Date(instant).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Mirrors the server's overdue filter: a future speaker never counts as overdue. */
const isOverdue = (prospect: ProspectDto, now: number) =>
  !prospect.speakerId &&
  prospect.nextActionAt !== null &&
  new Date(prospect.nextActionAt).getTime() < now;

/*
 * The reference travels beside the sentence, never inside it.
 *
 * This used to answer "…could not be saved. Reference: 01JD…", which buries the one value the
 * reader is asked to quote in the one part of the message nobody reads character by character.
 * `Notice`, `LoadFailure` and `useActionFeedback` all take an `ApiFailure` and render its
 * reference as a selectable measure with its own copy control.
 */
const readCrmError = (reason: unknown, fallback: string) => describeApiFailure(reason, fallback);

function FieldErrors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (!messages.length) return null;
  return (
    <p className="error-text" id={id}>
      {messages.join(" ")}
    </p>
  );
}

// @spec PRD-CRM-001
export function CrmWorkspace({ eventId, ownerId }: { eventId: string; ownerId: string }) {
  const loadSequence = useRef(0);
  const [prospects, setProspects] = useState<ProspectDto[]>([]);
  const [owners, setOwners] = useState<ProspectOwnerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingConvert, setConfirmingConvert] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [newDueAt, setNewDueAt] = useState("");
  const [newOwner, setNewOwner] = useState(ownerId);
  const [newOwnerErrors, setNewOwnerErrors] = useState<string[]>([]);

  const [stages, setStages] = useState<PipelineStageDto[]>([]);
  /*
   * Board or table. Both read the same stages and the same prospects; they answer different
   * questions — "where is everybody" and "who is stuck" — which is why the table stayed rather
   * than being replaced by the board #197 asks for.
   */
  const [view, setView] = useState<"board" | "table">("board");
  const [configuring, setConfiguring] = useState(false);
  const [stage, setStage] = useState<ProspectDto["stage"]>("identified");
  const [assignedOwner, setAssignedOwner] = useState(ownerId);
  const [assignedOwnerErrors, setAssignedOwnerErrors] = useState<string[]>([]);
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [note, setNote] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const pipelineFeedback = useActionFeedback();
  const detailFeedback = useActionFeedback();

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const [loaded, staff, board] = await Promise.all([
      listProspects(eventId),
      listProspectOwners(eventId),
      listPipelineStages(eventId),
    ]);
    // A response that lands after the organizer switched events describes the old
    // workspace; rendering it would show another event's pipeline.
    if (sequence !== loadSequence.current) return;
    setProspects(loaded);
    setOwners(staff);
    setStages(board);
    // The new-prospect form defaults to the signed-in organizer. If this event's staff list
    // does not contain the pending choice — a different event, or an identity that has left —
    // fall back to somebody the server will accept rather than posting a doomed owner.
    setNewOwner((current) =>
      staff.some(({ id }) => id === current)
        ? current
        : (staff.find(({ id }) => id === ownerId)?.id ?? staff[0]?.id ?? current),
    );
  }, [eventId, ownerId]);

  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(true);
    setSelectedId("");
    setConfirmingConvert(false);
    // ERROR-INTENT: React effects cannot await; both outcomes are rendered below.
    void reload()
      .catch((reason: unknown) => {
        if (active) setError(readCrmError(reason, "Could not load the speaker pipeline."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      loadSequence.current += 1;
    };
  }, [reload]);

  const now = Date.now();
  const selected = prospects.find(({ id }) => id === selectedId);

  // The event's staff, as identity-access reports it — the same set the server validates
  // against, so the select cannot offer an owner the write path will refuse.
  const ownerOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const owner of owners)
      options.set(owner.id, owner.id === ownerId ? `${owner.name} (you)` : owner.name);
    // An owner already stored on a prospect stays selectable even after leaving the event,
    // otherwise saving an unrelated field would silently reassign the prospect to somebody else.
    for (const prospect of prospects)
      if (!options.has(prospect.ownerId)) options.set(prospect.ownerId, prospect.ownerId);
    return [...options].map(([id, label]) => ({ id, name: label }));
  }, [owners, ownerId, prospects]);

  const ownerName = useCallback(
    (id: string) => ownerOptions.find((owner) => owner.id === id)?.name ?? id,
    [ownerOptions],
  );

  /*
   * Who is overdue, as a set rather than as a count.
   *
   * The "Overdue next actions" tile names a number; the board below it has to be able to say
   * which cards that number is. Derived once here so there is one answer to "is this overdue"
   * on the surface, rather than a tile counting by one rule and a board marking by another.
   */
  const overdueIds = useMemo(
    () =>
      new Set(
        prospects.filter((prospect) => isOverdue(prospect, now)).map((prospect) => prospect.id),
      ),
    [prospects, now],
  );

  const counts = useMemo(() => {
    const byStage = new Map<string, number>();
    for (const prospect of prospects)
      byStage.set(prospect.stage, (byStage.get(prospect.stage) ?? 0) + 1);
    return { all: prospects.length, overdue: overdueIds.size, byStage };
  }, [prospects, overdueIds]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return prospects.filter((prospect) => {
      // The same set the tile counts, the board marks and the gutter colours: one derivation of
      // "overdue" on this surface, so the tab cannot select a different population from the one
      // its own count names.
      if (
        tab === "overdue" ? !overdueIds.has(prospect.id) : tab !== "all" && prospect.stage !== tab
      )
        return false;
      if (!query) return true;
      return (
        prospect.name.toLowerCase().includes(query) ||
        prospect.contacts.some(
          (contact) =>
            contact.email.toLowerCase().includes(query) ||
            contact.name.toLowerCase().includes(query),
        )
      );
    });
  }, [prospects, tab, search, overdueIds]);

  const timeline = useMemo(
    () =>
      [...(selected?.activities ?? [])].sort(
        (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
      ),
    [selected],
  );

  function open(prospect: ProspectDto) {
    setSelectedId(prospect.id);
    setConfirmingConvert(false);
    detailFeedback.clear();
    setAssignedOwnerErrors([]);
    setStage(prospect.stage === "converted" ? "invited" : prospect.stage);
    setAssignedOwner(prospect.ownerId);
    setNextAction(prospect.nextAction ?? "");
    setNextActionAt(localDateTimeValue(prospect.nextActionAt));
    setNote("");
    setContactName("");
    setContactEmail("");
  }

  async function add(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setNewOwnerErrors([]);
    try {
      const created = await createProspect(eventId, {
        name,
        email,
        ownerId: newOwner,
        nextActionAt: newDueAt ? new Date(newDueAt).toISOString() : undefined,
      });
      setName("");
      setEmail("");
      setNewDueAt("");
      setComposing(false);
      await reload();
      pipelineFeedback.announce("success", `${created.name} added to the pipeline as identified.`);
    } catch (reason) {
      // A refusal the server pinned to a field is shown on that field as well as announced,
      // so the organizer sees which control to fix.
      setNewOwnerErrors(crmFieldErrors(reason).ownerId ?? []);
      pipelineFeedback.announce("error", readCrmError(reason, "Could not add the prospect."));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Move one card to one stage.
   *
   * A request rather than an optimistic reorder: the server decides whether the target exists
   * and whether this prospect may leave where it is, and a card that snapped across and then
   * snapped back is the most confusing possible way to learn that it could not.
   */
  async function moveProspect(prospect: ProspectDto, target: PipelineStageDto) {
    setBusy(true);
    try {
      await updateProspect(eventId, prospect.id, { stage: target.key, source: "board" });
      await reload();
      pipelineFeedback.announce("success", `${prospect.name} moved to ${target.label}.`);
    } catch (reason) {
      pipelineFeedback.announce(
        "error",
        readCrmError(reason, `${prospect.name} could not be moved.`),
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveBoard(next: { key: string; label: string; category: StageCategoryDto }[]) {
    setBusy(true);
    try {
      setStages(await savePipelineStages(eventId, next));
      await reload();
      pipelineFeedback.announce("success", "Board saved.");
    } catch (reason) {
      // The server's refusal names the stages that still hold prospects, which is the thing to
      // act on — so it is surfaced verbatim rather than replaced with a generic sentence.
      pipelineFeedback.announce("error", readCrmError(reason, "The board could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function removeStage(stageKey: string, migrateTo: string) {
    const from = stages.find(({ key }) => key === stageKey);
    const to = stages.find(({ key }) => key === migrateTo);
    setBusy(true);
    try {
      setStages(await deletePipelineStage(eventId, stageKey, migrateTo));
      await reload();
      pipelineFeedback.announce(
        "success",
        `${from?.label ?? stageKey} removed. Anybody standing there is now in ${to?.label ?? migrateTo}.`,
      );
    } catch (reason) {
      pipelineFeedback.announce("error", readCrmError(reason, "That stage could not be removed."));
    } finally {
      setBusy(false);
    }
  }

  async function save(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    setBusy(true);
    setAssignedOwnerErrors([]);
    try {
      await updateProspect(eventId, selected.id, {
        stage,
        ownerId: assignedOwner,
        nextAction: nextAction || null,
        nextActionAt: nextActionAt ? new Date(nextActionAt).toISOString() : null,
        activity: note ? { kind: "note", summary: note, private: true } : undefined,
      });
      setNote("");
      await reload();
      // The stage as the organizer named it, not as the wire spells it. `moveProspect` already
      // announced the label; this one announced the key, so the same move read two ways
      // depending on whether it was made on the board or in the form.
      const landed = stages.find(({ key }) => key === stage)?.label ?? stage;
      detailFeedback.announce(
        "success",
        `Saved. ${selected.name} is in ${landed}, owned by ${ownerName(assignedOwner)}.`,
      );
    } catch (reason) {
      setAssignedOwnerErrors(crmFieldErrors(reason).ownerId ?? []);
      detailFeedback.announce("error", readCrmError(reason, "Could not update the prospect."));
    } finally {
      setBusy(false);
    }
  }

  async function addContact(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await updateProspect(eventId, selected.id, {
        contact: { name: contactName, email: contactEmail, isPrimary: false },
      });
      const added = contactEmail;
      setContactName("");
      setContactEmail("");
      await reload();
      detailFeedback.announce("success", `Added ${added} as a contact.`);
    } catch (reason) {
      detailFeedback.announce("error", readCrmError(reason, "Could not add the contact."));
    } finally {
      setBusy(false);
    }
  }

  async function convert(prospect: ProspectDto) {
    setBusy(true);
    try {
      await convertProspect(eventId, prospect.id);
      setConfirmingConvert(false);
      await reload();
      detailFeedback.announce("success", `${prospect.name} is now a speaker.`);
    } catch (reason) {
      detailFeedback.announce("error", readCrmError(reason, "Could not convert the prospect."));
    } finally {
      setBusy(false);
    }
  }

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "overdue", label: "Overdue", count: counts.overdue },
    ...stages.map((item) => ({
      id: item.key,
      label: item.label,
      count: counts.byStage.get(item.key) ?? 0,
    })),
  ];

  const inPipeline = prospects.filter((prospect) => prospect.stage !== CONVERTED).length;
  const converted = counts.byStage.get(CONVERTED) ?? 0;

  if (error)
    return (
      <LoadFailure
        what="the speaker pipeline"
        error={error.message}
        reference={error.reference}
        onRetry={() => {
          setError(null);
          setLoading(true);
          return reload()
            .catch((reason: unknown) =>
              setError(readCrmError(reason, "Could not load the speaker pipeline.")),
            )
            .finally(() => setLoading(false));
        }}
      />
    );

  return (
    <div className="crm">
      <dl className="grid-auto">
        <Stat
          label="In pipeline"
          value={loading ? "—" : inPipeline}
          hint={`${counts.all} prospect${counts.all === 1 ? "" : "s"} tracked`}
          icon={<IconSpeakers size={15} />}
        />
        <Stat
          label="Overdue next actions"
          value={loading ? "—" : counts.overdue}
          hint={counts.overdue ? "Chase these first" : "Nothing has slipped"}
          icon={<IconClock size={15} />}
          attention={counts.overdue > 0}
        />
        <Stat
          label="Converted to speakers"
          value={loading ? "—" : converted}
          hint="Linked speaker profiles"
          icon={<IconCheck size={15} />}
        />
      </dl>

      {/*
       * The board wants the whole width — eight columns in half a page shows three — so the
       * detail panel drops beneath it rather than beside it. The table keeps the two-pane
       * layout, where a row and its detail genuinely are read together.
       */}
      <div className={view === "board" ? "crm-stack" : "split"}>
        <Card
          labelledBy="crm-pipeline"
          title="Prospect pipeline"
          hint="Filter by stage, then open a prospect to work its next action."
          actions={
            <button
              type="button"
              className="secondary"
              aria-expanded={composing}
              onClick={() => {
                setComposing((open) => !open);
                pipelineFeedback.clear();
              }}
            >
              <IconPlus size={15} />
              {composing ? "Close new prospect" : "New prospect"}
            </button>
          }
          tight
        >
          <div className="crm-toolbar-row">
            {composing ? (
              <form className="crm-create" onSubmit={add}>
                <div className="grid-auto">
                  <div className="field">
                    <label htmlFor="crm-new-name">Prospect name</label>
                    <input
                      id="crm-new-name"
                      value={name}
                      onChange={(changeEvent) => setName(changeEvent.target.value)}
                      placeholder="Dr. Ada Rivera"
                      required
                      maxLength={160}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="crm-new-email">Contact email</label>
                    <input
                      id="crm-new-email"
                      type="email"
                      value={email}
                      onChange={(changeEvent) => setEmail(changeEvent.target.value)}
                      placeholder="ada@example.test"
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="crm-new-owner">Owner</label>
                    <select
                      id="crm-new-owner"
                      value={newOwner}
                      onChange={(changeEvent) => {
                        setNewOwner(changeEvent.target.value);
                        setNewOwnerErrors([]);
                      }}
                      aria-invalid={Boolean(newOwnerErrors.length)}
                      aria-describedby={newOwnerErrors.length ? "crm-new-owner-error" : undefined}
                    >
                      {ownerOptions.map((owner) => (
                        <option key={owner.id} value={owner.id}>
                          {owner.name}
                        </option>
                      ))}
                    </select>
                    <FieldErrors id="crm-new-owner-error" messages={newOwnerErrors} />
                  </div>
                  <div className="field">
                    <label htmlFor="crm-new-due">First action due</label>
                    <input
                      id="crm-new-due"
                      type="datetime-local"
                      value={newDueAt}
                      onChange={(changeEvent) => setNewDueAt(changeEvent.target.value)}
                    />
                    <p className="hint">Outreach is scheduled as "Send introductory outreach".</p>
                  </div>
                </div>
                <div className="crm-form-actions">
                  <button className="primary" type="submit" disabled={busy}>
                    {busy ? "Adding…" : "Add prospect"}
                  </button>
                  <button type="button" className="secondary" onClick={() => setComposing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
            {pipelineFeedback.node}
            {/*
              One rail: what is being searched, how it is being read, and the way into the board's
              own settings. These were three stacked rows — a search box stretched to the full
              1100px of the card, a segmented switch below it, and "Configure stages" sitting
              inside that switch as though it were a third view.
            */}
            <div className="toolbar crm-pipeline-rail">
              <div className="field search">
                <label className="visually-hidden" htmlFor="crm-search">
                  Search prospects
                </label>
                <input
                  id="crm-search"
                  type="search"
                  value={search}
                  onChange={(changeEvent) => setSearch(changeEvent.target.value)}
                  placeholder="Search name or contact email"
                />
              </div>
              {/* One switch, two readings of the same pipeline. The tabs below filter the table
                  and are hidden with it: a board already shows every stage at once, so a stage
                  filter over it would be a control with nothing to do. */}
              <fieldset className="pipeline-views">
                <legend className="visually-hidden">Pipeline view</legend>
                <button
                  type="button"
                  className={view === "board" ? "secondary is-active" : "secondary"}
                  aria-pressed={view === "board"}
                  onClick={() => setView("board")}
                >
                  Board
                </button>
                <button
                  type="button"
                  className={view === "table" ? "secondary is-active" : "secondary"}
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                >
                  Table
                </button>
              </fieldset>
              {/* Not a third view. Editing the stages is a different act from choosing how to
                  read them, so it stands outside the switch rather than inside its frame. */}
              <button
                type="button"
                className="ghost"
                aria-expanded={configuring}
                onClick={() => setConfiguring((open) => !open)}
              >
                {configuring ? "Close stage settings" : "Configure stages"}
              </button>
            </div>
            {view === "table" ? (
              <Tabs items={tabs} active={tab} onSelect={setTab} label="Pipeline stage" />
            ) : null}
          </div>

          {configuring ? (
            <div className="stage-editor-panel">
              <h3>Stages</h3>
              <PipelineStageEditor
                stages={stages}
                counts={counts.byStage}
                busy={busy}
                onSave={(next) => {
                  // ERROR-INTENT: handlers cannot await; saveBoard announces both outcomes.
                  void saveBoard(next);
                }}
                onDelete={(stageKey, migrateTo) => {
                  // ERROR-INTENT: handlers cannot await; removeStage announces both outcomes.
                  void removeStage(stageKey, migrateTo);
                }}
              />
            </div>
          ) : null}

          {view === "board" ? (
            loading ? (
              <div className="crm-loading">
                <SkeletonRows rows={3} label="Loading the sourcing board" />
              </div>
            ) : (
              <PipelineBoard
                stages={stages}
                prospects={prospects}
                selectedId={selectedId}
                busy={busy}
                overdueIds={overdueIds}
                onOpen={open}
                onMove={(prospect, target) => {
                  // ERROR-INTENT: handlers cannot await; moveProspect announces both outcomes.
                  void moveProspect(prospect, target);
                }}
              />
            )
          ) : null}

          <div
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            hidden={view !== "table"}
          >
            {loading ? (
              <div className="crm-loading">
                <SkeletonRows rows={4} label="Loading the speaker pipeline" />
              </div>
            ) : visible.length === 0 ? (
              <EmptyState
                title={counts.all ? "No prospects in this view" : "No prospects yet"}
                icon={<IconSpeakers size={20} />}
                action={
                  counts.all ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setTab("all");
                        setSearch("");
                      }}
                    >
                      Show every prospect
                    </button>
                  ) : (
                    <button className="primary" type="button" onClick={() => setComposing(true)}>
                      <IconPlus size={15} />
                      New prospect
                    </button>
                  )
                }
              >
                {counts.all
                  ? "Nobody matches this stage and search. Clear the filters to see the whole pipeline."
                  : "Track the speakers you are courting here, then convert them once they accept."}
              </EmptyState>
            ) : (
              <div className="table-wrap">
                {/*
                  The table view answers "who is stuck", so the figure every row is about is when
                  its next action falls due — which is why this is the CRM's cue gutter.

                  It used to sit at the far right of the "Next action" cell as a `<Pill>` with a
                  clock glyph in it, one row's worth of red furniture per overdue prospect, while
                  the leading edge of the table carried nothing at all. The measure column states
                  it once, in the same face and the same 56px track the audit log and the board
                  use, and the pill comes off.
                */}
                <table className="data crm-table">
                  <thead>
                    <tr>
                      <th scope="col" className="gutter">
                        Due
                      </th>
                      <th scope="col">Prospect</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Next action</th>
                      <th scope="col" className="num">
                        Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((prospect) => {
                      const overdue = overdueIds.has(prospect.id);
                      const meta = stages.find(({ key }) => key === prospect.stage);
                      const primary =
                        prospect.contacts.find((contact) => contact.isPrimary) ??
                        prospect.contacts[0];
                      return (
                        /* `aria-selected` rather than a local `.is-selected` class: the shared
                           table system owns the one selection treatment, and this workspace's
                           own copy of it was one of the three that disagreed. */
                        <tr
                          key={prospect.id}
                          aria-selected={prospect.id === selectedId ? true : undefined}
                        >
                          <td className={overdue ? "gutter is-overdue" : "gutter"} data-label="Due">
                            <span className="figure">
                              <span className="visually-hidden">
                                {prospect.nextActionAt
                                  ? overdue
                                    ? "Overdue since "
                                    : "Next action due "
                                  : "No next action scheduled"}
                              </span>
                              {prospect.nextActionAt ? shortDate(prospect.nextActionAt) : "—"}
                            </span>
                          </td>
                          <td className="primary-cell" data-label="Prospect">
                            <button
                              type="button"
                              className="ghost crm-row-open"
                              aria-current={prospect.id === selectedId ? "true" : undefined}
                              onClick={() => open(prospect)}
                            >
                              {prospect.name}
                            </button>
                            {primary ? <span className="sub">{primary.email}</span> : null}
                          </td>
                          <td data-label="Stage">
                            <Pill tone={meta ? CATEGORY_TONE[meta.category] : "neutral"}>
                              {meta?.label ?? prospect.stage}
                            </Pill>
                            {prospect.speakerId ? (
                              <span className="sub">Speaker linked</span>
                            ) : null}
                          </td>
                          <td data-label="Owner">{ownerName(prospect.ownerId)}</td>
                          <td data-label="Next action">
                            {prospect.nextAction ?? "No next action scheduled"}
                            {overdue ? <span className="sub is-overdue">Overdue</span> : null}
                          </td>
                          <td className="num" data-label="Activity">
                            <span className="figure">{prospect.activities.length}</span>
                            <span className="sub figure">{shortDate(prospect.updatedAt)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>

        {/*
          Opening a prospect moves focus into the panel and the panel stays in view: it is a
          sticky column with its own scroll, and a drawer once the split has collapsed.

          Beside the table it renders even when nothing is chosen, because an empty second
          column is what says the column is there. Under the *board* it is the full width of the
          page, and an empty full-width card is 300px of nothing between the cards an organizer
          came to read and the bottom of the screen — so there it appears with the prospect.
        */}
        {view === "board" && !selected ? null : (
          <Inspector
            open={Boolean(selected)}
            focusKey={selectedId}
            labelledBy="crm-detail"
            title={selected ? selected.name : "Prospect detail"}
            {...(selected ? { hint: `Owned by ${ownerName(selected.ownerId)}` } : {})}
            closeLabel="Close prospect"
            onClose={() => setSelectedId("")}
          >
            {selected ? (
              <div className="crm-detail">
                {detailFeedback.node}

                {selected.speakerId ? (
                  <Notice tone="success">
                    <span>
                      Converted on {stampedTime(selected.convertedAt ?? selected.updatedAt)}.
                      Converted prospects are read-only so the outreach history stays intact.
                    </span>
                  </Notice>
                ) : null}

                <section aria-labelledby="crm-contacts">
                  <h3 id="crm-contacts">Contacts</h3>
                  <ul className="crm-contacts">
                    {selected.contacts.map((contact) => (
                      <li key={contact.id}>
                        <span className="crm-contact-name">{contact.name}</span>
                        <a href={`mailto:${contact.email}`}>{contact.email}</a>
                        {contact.isPrimary ? <Pill tone="info">Primary</Pill> : null}
                      </li>
                    ))}
                  </ul>
                  {selected.speakerId ? null : (
                    <details className="crm-details">
                      <summary>Add another contact</summary>
                      <form onSubmit={addContact}>
                        <div className="field">
                          <label htmlFor="crm-contact-name">Contact name</label>
                          <input
                            id="crm-contact-name"
                            value={contactName}
                            onChange={(changeEvent) => setContactName(changeEvent.target.value)}
                            required
                            maxLength={160}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="crm-contact-email">Additional contact email</label>
                          <input
                            id="crm-contact-email"
                            type="email"
                            value={contactEmail}
                            onChange={(changeEvent) => setContactEmail(changeEvent.target.value)}
                            required
                          />
                        </div>
                        <button type="submit" className="secondary" disabled={busy}>
                          Add contact
                        </button>
                      </form>
                    </details>
                  )}
                </section>

                {selected.speakerId ? null : (
                  <section aria-labelledby="crm-working">
                    <h3 id="crm-working">Stage and next action</h3>
                    <form onSubmit={save}>
                      {/* The shared listbox: a native select drew the operating system's own
                        chevron at the operating system's own height beside inputs the product
                        draws, which is the mismatch the control tier exists to end. */}
                      <Select
                        id="crm-stage"
                        label="Stage"
                        value={stage}
                        onChange={(next) => setStage(next as ProspectDto["stage"])}
                        options={stages
                          .filter(({ key }) => key !== CONVERTED)
                          .map((item) => ({ value: item.key, label: item.label }))}
                      />
                      <div className="field">
                        <label htmlFor="crm-owner">Owner</label>
                        <select
                          id="crm-owner"
                          value={assignedOwner}
                          onChange={(changeEvent) => {
                            setAssignedOwner(changeEvent.target.value);
                            setAssignedOwnerErrors([]);
                          }}
                          aria-invalid={Boolean(assignedOwnerErrors.length)}
                          aria-describedby={
                            assignedOwnerErrors.length
                              ? "crm-owner-error crm-owner-hint"
                              : "crm-owner-hint"
                          }
                        >
                          {ownerOptions.map((owner) => (
                            <option key={owner.id} value={owner.id}>
                              {owner.name}
                            </option>
                          ))}
                        </select>
                        <p className="hint" id="crm-owner-hint">
                          Only organizers and reviewers on this event can own a prospect.
                        </p>
                        <FieldErrors id="crm-owner-error" messages={assignedOwnerErrors} />
                      </div>
                      <div className="field">
                        <label htmlFor="crm-next-action">Next action</label>
                        <input
                          id="crm-next-action"
                          value={nextAction}
                          onChange={(changeEvent) => setNextAction(changeEvent.target.value)}
                          placeholder="Send formal invitation"
                          maxLength={300}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="crm-next-action-at">Next action due</label>
                        <input
                          id="crm-next-action-at"
                          type="datetime-local"
                          value={nextActionAt}
                          onChange={(changeEvent) => setNextActionAt(changeEvent.target.value)}
                        />
                      </div>
                      {/* A thousand characters of context about a person, in a control that showed
                        about sixty of them at a time. The next action stays a single line — it is
                        one instruction — but a note is prose and is sized like prose. */}
                      <div className="field">
                        <label htmlFor="crm-note">Private note</label>
                        <textarea
                          className="control"
                          id="crm-note"
                          rows={3}
                          value={note}
                          onChange={(changeEvent) => setNote(changeEvent.target.value)}
                          placeholder="Available after 2pm"
                          maxLength={1000}
                        />
                        <p className="hint">
                          Saved to the timeline alongside the stage change this save records.
                        </p>
                      </div>
                      <button className="primary" type="submit" disabled={busy}>
                        {busy ? "Saving…" : "Save prospect"}
                      </button>
                    </form>
                  </section>
                )}

                {selected.speakerId ? null : (
                  <section aria-labelledby="crm-convert">
                    <h3 id="crm-convert">Convert to speaker</h3>
                    {confirmingConvert ? (
                      <>
                        <Notice tone="warn">
                          <span>
                            Convert {selected.name}? This creates a speaker profile from the primary
                            contact and locks the prospect record.
                          </span>
                        </Notice>
                        <div className="crm-form-actions">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              // ERROR-INTENT: handlers cannot await; convert announces both outcomes.
                              void convert(selected);
                            }}
                          >
                            {busy ? "Converting…" : `Yes, convert ${selected.name}`}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setConfirmingConvert(false)}
                          >
                            Keep as a prospect
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="crm-help">
                          Creates the speaker profile, links it to this prospect, and hands the
                          onboarding tasks to the speaker portal.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => setConfirmingConvert(true)}
                        >
                          <IconCheck size={15} />
                          Convert to speaker
                        </button>
                      </>
                    )}
                  </section>
                )}

                <section aria-labelledby="crm-timeline">
                  <h3 id="crm-timeline">Activity timeline</h3>
                  {timeline.length ? (
                    <ol className="crm-timeline">
                      {timeline.map((activity) => (
                        <li key={activity.id}>
                          <div className="crm-timeline-head">
                            <Pill tone={ACTIVITY_TONES[activity.kind]}>
                              {ACTIVITY_LABELS[activity.kind]}
                            </Pill>
                            <time dateTime={activity.occurredAt}>
                              {stampedTime(activity.occurredAt)}
                            </time>
                            {/* The shared pill rather than a bespoke outlined tag beside it: the
                              timeline was drawing two badge shapes on one line to say two
                              things of the same kind. */}
                            {activity.private ? <Pill>Private</Pill> : null}
                          </div>
                          <p>{activity.summary}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="crm-help">
                      No activity recorded yet. Moving the stage or saving a private note adds the
                      first entry.
                    </p>
                  )}
                </section>
              </div>
            ) : (
              <EmptyState title="Select a prospect" icon={<IconSpeakers size={20} />}>
                Open a name from the pipeline to see its contacts, activity timeline, next action,
                and the convert-to-speaker action.
              </EmptyState>
            )}
          </Inspector>
        )}
      </div>
    </div>
  );
}
