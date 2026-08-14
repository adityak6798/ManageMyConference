/*
 * The event's speaker checklist, authored from the console (issue #176).
 *
 * `speaker_task_templates` shipped with commands, routes, contracts, a seed and a template slice
 * that clones it — and no surface. An organizer could only declare a checklist through the API,
 * which means in practice that nobody using the product could create one, and the category
 * cloned correctly only because the seed had populated it.
 *
 * Two things this shape is deliberate about.
 *
 * **A line is not a task.** Declaring the checklist writes event configuration and tells nobody;
 * assigning it puts dated work in named speakers' portals and mails them about it. They are two
 * buttons for that reason, not one, and the assign control says how many people it is about to
 * write to before it does.
 *
 * **The empty state teaches.** A checklist nobody has declared is the normal state of a new
 * event, not a failure, so the panel says what a checklist is *for* and offers the first line —
 * rather than showing an empty list that reads like something that did not load.
 *
 * The roster-with-one-editor arrangement follows `ResourceEditor`, and for the same reason
 * (#144): a form per line makes the panel grow without bound with the length of the checklist.
 *
 * @spec PRD-SPK-002 PRD-CNT-001 PRD-EVT-002
 */

import type { SpeakerTaskTemplateDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  assignSpeakerChecklist,
  ContentApiError,
  createSpeakerTaskTemplate,
  deleteSpeakerTaskTemplate,
  listSpeakerTaskTemplates,
  updateSpeakerTaskTemplate,
} from "../api/content";
import { EmptyState, Notice, Pill, useActionFeedback } from "../ui/primitives";
import { plural, type Run, type Workspace, withReference } from "./shared";

/**
 * A due date expressed as a distance, in the words an organizer used to say it.
 *
 * The column stores a signed day count because an event carries no dates of its own, so the real
 * date is derived when the checklist is instantiated. "-14" is not a sentence; "14 days before"
 * is the thing somebody actually means by it.
 */
export function dueOffsetLabel(days: number): string {
  if (days === 0) return "On the anchor date";
  const magnitude = Math.abs(days);
  return `${magnitude} ${plural(magnitude, "day")} ${days < 0 ? "before" : "after"}`;
}

/** The authoring fields, one definition for a new line and an existing one. */
function ChecklistForm({
  entry,
  nextSortOrder,
  busy,
  onSubmit,
  onCancel,
}: {
  entry?: SpeakerTaskTemplateDto;
  /** Where a new line lands: after everything already declared. */
  nextSortOrder: number;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(entry);
  /*
   * Explicit ids and `aria-describedby` rather than a hint nested inside the `<label>`.
   *
   * A hint inside the label becomes part of the control's accessible name, so a screen reader
   * announces two sentences of guidance every time focus lands on the box. Described-by keeps
   * the name short and the guidance available on demand, which is what it is for.
   */
  const field = entry ? `checklist-${entry.id}` : "checklist-new";
  return (
    <form className="form-stack checklist-form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor={`${field}-title`}>What the speaker is asked for</label>
        <input
          id={`${field}-title`}
          name="title"
          required
          maxLength={160}
          defaultValue={entry?.title}
          aria-describedby={`${field}-title-hint`}
        />
        {/* The title is what a cloned checklist converges on in another event, and it is also
            what an assigned task is keyed by — so renaming a line here does not rename work
            already given out. Said where it is typed, because it is not guessable. */}
        <span className="hint" id={`${field}-title-hint`}>
          Also the line's identity: cloning this event's checklist elsewhere matches on the title,
          and tasks already assigned keep the title they were given.
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${field}-due`}>Due</label>
        <input
          id={`${field}-due`}
          name="dueOffsetDays"
          type="number"
          required
          min={-3650}
          max={3650}
          defaultValue={entry?.dueOffsetDays ?? -14}
          aria-describedby={`${field}-due-hint`}
        />
        <span className="hint" id={`${field}-due-hint`}>
          Days from the date you choose when assigning. Negative counts backwards — “-14” is two
          weeks before it.
        </span>
      </div>
      <div className="field checklist-form-wide">
        <label htmlFor={`${field}-description`}>Instructions</label>
        <textarea
          id={`${field}-description`}
          name="description"
          rows={3}
          maxLength={4000}
          defaultValue={entry?.description}
        />
      </div>
      <div className="field">
        <label htmlFor={`${field}-order`}>Order</label>
        {/* `required`, because an empty number box reads as `Number("") === 0` — which is a
            valid order that silently moves the line to the front of the checklist. */}
        <input
          id={`${field}-order`}
          name="sortOrder"
          type="number"
          required
          min={0}
          defaultValue={entry ? entry.sortOrder : nextSortOrder}
        />
      </div>
      <div className="row-actions checklist-form-wide">
        <button type="submit" disabled={busy}>
          {editing ? "Save line" : "Add line"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ChecklistEditor({
  eventId,
  workspace,
  busy,
  run,
}: {
  eventId: string;
  workspace: Workspace;
  busy: boolean;
  run: Run;
}) {
  const feedback = useActionFeedback();
  const [entries, setEntries] = useState<SpeakerTaskTemplateDto[] | null>(null);
  /** A checklist this panel could not read, said here rather than left as an empty list. */
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  // One editor at a time: "new", a line's id, or nothing open.
  const [open, setOpen] = useState<string | null>(null);
  const [selectedSpeakers, setSelectedSpeakers] = useState<string[]>([]);
  // Closing an editor unmounts the control holding focus, so its toggle takes focus back.
  const toggles = useRef<Record<string, HTMLButtonElement | null>>({});

  const load = useCallback(async () => {
    try {
      setEntries(await listSpeakerTaskTemplates(eventId));
      setLoadFailure(null);
    } catch (reason) {
      // ERROR-INTENT: rendered in place of the roster rather than discarded. An empty list and a
      // list that could not be read look identical, and only one of them means "declare a line".
      setLoadFailure(
        withReference(
          reason instanceof ContentApiError
            ? reason.message
            : "The speaker checklist could not be read.",
          reason,
        ),
      );
    }
  }, [eventId]);

  useEffect(() => {
    // ERROR-INTENT: effects cannot await; load renders both of its outcomes.
    void load();
  }, [load]);

  const lines = entries ?? [];
  const editing = lines.find(({ id }) => id === open);
  const nextSortOrder = lines.reduce(
    (highest, { sortOrder }) => Math.max(highest, sortOrder + 1),
    0,
  );

  /**
   * Close the editor that just finished, and only that one.
   *
   * A save is asynchronous, so by the time it lands the organizer may have opened a different
   * line; clearing `open` unconditionally would unmount whatever they had opened since.
   */
  function close(id: string) {
    setOpen((current) => {
      if (current !== id) return current;
      toggles.current[id]?.focus();
      return null;
    });
  }

  function fields(form: HTMLFormElement) {
    const data = new FormData(form);
    return {
      title: String(data.get("title")).trim(),
      description: String(data.get("description") ?? "").trim(),
      sortOrder: Number(data.get("sortOrder")),
      dueOffsetDays: Number(data.get("dueOffsetDays")),
    };
  }

  function announce(result: { ok: true } | { ok: false; error: unknown }, success: string) {
    feedback.announce(
      result.ok ? "success" : "error",
      result.ok
        ? success
        : withReference(
            result.error instanceof ContentApiError
              ? result.error.message
              : "That change could not be saved.",
            result.error,
          ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>, id?: string) {
    event.preventDefault();
    const input = fields(event.currentTarget);
    /*
     * Every write answers with the whole checklist, and that answer is what is rendered. A
     * reorder moves lines the request never named, so re-deriving the roster from the one line
     * that was edited would show an order the server does not hold.
     */
    // ERROR-INTENT: run() owns rejection handling and hands failures back to be announced here.
    void run(async () => {
      setEntries(
        id
          ? await updateSpeakerTaskTemplate(id, input)
          : await createSpeakerTaskTemplate(eventId, input),
      );
    }).then((result) => {
      if (result.ok) close(id ?? "new");
      announce(result, id ? `“${input.title}” saved.` : `“${input.title}” added to the checklist.`);
    });
  }

  function remove(entry: SpeakerTaskTemplateDto) {
    // ERROR-INTENT: run() owns rejection handling and hands failures back to be announced here.
    void run(async () => {
      setEntries(await deleteSpeakerTaskTemplate(entry.id));
    }).then((result) => {
      if (result.ok) setOpen((current) => (current === entry.id ? null : current));
      announce(
        result,
        `“${entry.title}” removed from the checklist. Tasks already assigned from it are untouched.`,
      );
    });
  }

  function assign() {
    if (busy || !selectedSpeakers.length) return;
    let created = 0;
    // ERROR-INTENT: run() owns rejection handling and hands failures back to be announced here.
    void run(async () => {
      created = (await assignSpeakerChecklist(eventId, selectedSpeakers)).length;
    }).then((result) => {
      announce(
        result,
        // Nothing created is a real, correct answer — everybody selected already has every line
        // — and reporting it as a success with no number would read as work that vanished.
        created
          ? `${created} ${plural(created, "task")} assigned across ${selectedSpeakers.length} ${plural(selectedSpeakers.length, "speaker")}.`
          : "Everybody selected already has every line on this checklist. Nothing was assigned twice.",
      );
    });
  }

  if (loadFailure)
    return (
      <div className="checklist-manager">
        <Notice tone="error">{loadFailure}</Notice>
        <button
          type="button"
          className="secondary small"
          onClick={() => {
            // ERROR-INTENT: handlers cannot await; load renders both of its outcomes.
            void load();
          }}
        >
          Try again
        </button>
      </div>
    );

  return (
    <div className="checklist-manager">
      {feedback.node}

      <div className="row-actions">
        <button
          type="button"
          className="secondary small"
          aria-expanded={open === "new"}
          aria-controls="checklist-new-form"
          ref={(node) => {
            toggles.current.new = node;
          }}
          onClick={() => {
            if (busy) return;
            setOpen(open === "new" ? null : "new");
          }}
          // aria-disabled rather than disabled: after a successful add, focus returns to this
          // button while the request is still settling, and a disabled element cannot take it.
          aria-disabled={busy}
        >
          {open === "new" ? "Cancel new line" : "New checklist line"}
        </button>
      </div>

      {open === "new" ? (
        <div id="checklist-new-form">
          <ChecklistForm
            nextSortOrder={nextSortOrder}
            busy={busy}
            onSubmit={submit}
            onCancel={() => close("new")}
          />
        </div>
      ) : null}

      {entries === null ? (
        <p className="visually-hidden" role="status">
          Loading the speaker checklist.
        </p>
      ) : lines.length ? (
        <ul className="checklist-list">
          {lines.map((entry) => {
            const isOpen = open === entry.id;
            return (
              <li key={entry.id}>
                <div className="checklist-entry">
                  <span className="checklist-entry-name">
                    {entry.title}
                    {entry.description ? <span className="sub">{entry.description}</span> : null}
                  </span>
                  <Pill tone="neutral">{dueOffsetLabel(entry.dueOffsetDays)}</Pill>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="secondary small"
                      aria-expanded={isOpen}
                      aria-controls={`checklist-form-${entry.id}`}
                      ref={(node) => {
                        toggles.current[entry.id] = node;
                      }}
                      aria-disabled={busy}
                      onClick={() => {
                        if (busy) return;
                        setOpen(isOpen ? null : entry.id);
                      }}
                    >
                      {isOpen ? "Close" : "Edit"}
                      <span className="visually-hidden"> {entry.title}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      onClick={() => remove(entry)}
                    >
                      Remove
                      <span className="visually-hidden"> {entry.title}</span>
                    </button>
                  </div>
                </div>
                {isOpen && editing ? (
                  <div id={`checklist-form-${entry.id}`}>
                    <ChecklistForm
                      key={editing.id}
                      entry={editing}
                      nextSortOrder={nextSortOrder}
                      busy={busy}
                      onSubmit={(event) => submit(event, editing.id)}
                      onCancel={() => close(editing.id)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        // What an organizer should do, not a report that something is missing. A new event has
        // no checklist because nobody has written one yet, which is the normal state.
        <EmptyState title="No checklist yet">
          A checklist is what every speaker at this event is asked for — a bio, a headshot, slides —
          written once here instead of retyped per person per year. Add the first line above, then
          assign it to the speakers who need it.
        </EmptyState>
      )}

      <div className="checklist-assign">
        <label>
          Assign to
          <select
            multiple
            value={selectedSpeakers}
            onChange={(event) =>
              setSelectedSpeakers(
                Array.from(event.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {workspace.speakers.map((speaker) => (
              <option key={speaker.id} value={speaker.id}>
                {speaker.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row-actions">
          <button
            type="button"
            disabled={busy || !selectedSpeakers.length || !lines.length}
            onClick={assign}
          >
            Assign {lines.length ? `${lines.length} ${plural(lines.length, "line")}` : ""} to{" "}
            {selectedSpeakers.length} {plural(selectedSpeakers.length, "speaker")}
          </button>
        </div>
        <p className="hint">
          {workspace.speakers.length
            ? "Dates are counted from today. Running this again after a speaker joins assigns only what is missing — nobody is asked for the same thing twice."
            : "Speaker records are created when you accept a proposal, import a CSV, or sync registrations. There is nobody to assign work to yet."}
        </p>
      </div>
    </div>
  );
}
