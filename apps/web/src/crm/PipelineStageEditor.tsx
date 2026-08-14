/*
 * Configuring the board: add a stage, rename one, reorder them, remove one.
 *
 * The whole list is sent on save, because on a board those are one act — a reorder moves every
 * column. The editor therefore holds a draft and shows what is unsaved, rather than writing on
 * every keystroke and leaving an organizer's half-typed stage name on somebody else's screen.
 *
 * Deleting is the one thing that cannot be a draft: it moves real prospects, so it asks where
 * they should go and does it immediately, through its own request. That request answers with a
 * fresh board, which re-seeds the draft — so deleting waits until the draft is settled rather
 * than carrying somebody's unsaved renames off with it.
 */

import type { PipelineStageDto, StageCategoryDto } from "@greenroom/contracts";
import { type FormEvent, useMemo, useState } from "react";
import { EmptyState, Pill } from "../ui/primitives";

const CATEGORIES: { value: StageCategoryDto; label: string; hint: string }[] = [
  { value: "open", label: "Open", hint: "Still being worked" },
  { value: "won", label: "Won", hint: "Speaking, or as good as" },
  { value: "nurture", label: "Nurture", hint: "Not this year" },
  { value: "lost", label: "Lost", hint: "Not happening" },
];

/** The stage the product writes rather than the organizer; it cannot be renamed away. */
const CONVERTED = "converted";

interface Draft {
  readonly key: string;
  readonly label: string;
  readonly category: StageCategoryDto;
}

/**
 * A key from a label, for a *new* stage only.
 *
 * Never recomputed on rename: the key is what every prospect row and every history entry
 * stores, so deriving it from the current name would mint a new key the moment somebody fixed a
 * typo, stranding every card standing in that stage.
 */
function keyFrom(label: string, taken: readonly string[]): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "stage";
  if (!taken.includes(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1)
    if (!taken.includes(`${base}-${suffix}`)) return `${base}-${suffix}`;
  return `${base}-${Date.now()}`;
}

export function PipelineStageEditor({
  stages,
  counts,
  busy,
  onSave,
  onDelete,
}: {
  stages: readonly PipelineStageDto[];
  /** How many prospects stand in each stage, so a delete says what it would move. */
  counts: ReadonlyMap<string, number>;
  busy: boolean;
  onSave: (stages: Draft[]) => void;
  onDelete: (stageKey: string, migrateTo: string) => void;
}) {
  const saved = useMemo<Draft[]>(
    () => stages.map(({ key, label, category }) => ({ key, label, category })),
    [stages],
  );
  const savedSignature = JSON.stringify(saved);
  const [draft, setDraft] = useState<Draft[]>(saved);
  const [syncedTo, setSyncedTo] = useState(savedSignature);
  // Re-seed when the server's answer changes, the way the speaker profile form does.
  if (syncedTo !== savedSignature) {
    setSyncedTo(savedSignature);
    setDraft(saved);
  }
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<StageCategoryDto>("open");
  const [removing, setRemoving] = useState<string | null>(null);
  const [migrateTo, setMigrateTo] = useState("");
  /** The stage whose removal was refused because the draft was unsaved, so it can be named. */
  const [refused, setRefused] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== savedSignature;
  const edit = (index: number, change: Partial<Draft>) =>
    setDraft((current) =>
      current.map((item, at) => (at === index ? { ...item, ...change } : item)),
    );
  const swap = (index: number, with_: number) =>
    setDraft((current) => {
      if (with_ < 0 || with_ >= current.length) return current;
      const next = [...current];
      const moved = next[index] as Draft;
      next[index] = next[with_] as Draft;
      next[with_] = moved;
      return next;
    });

  function add(event: FormEvent) {
    event.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    setDraft((current) => [
      ...current,
      {
        key: keyFrom(
          label,
          current.map(({ key }) => key),
        ),
        label,
        category: newCategory,
      },
    ]);
    setNewLabel("");
  }

  /**
   * Whether this removal has to wait, recording which stage asked so the refusal can name it.
   *
   * Removing is its own request, and the board it returns re-seeds this draft above — so a
   * removal started with unsaved names, order or added stages in hand took them with it, with
   * no message and nothing to undo from. Refused rather than merged: the returned board has
   * renumbered its order and may have moved prospects, so a draft written against the board
   * before the delete is no longer a description of the board after it, and quietly reapplying
   * half of it is a worse answer than asking. Both ways out — Save board and Discard changes —
   * are on this screen, and neither of them loses the typing.
   *
   * Checked again when the dialog is confirmed, not only when it opens: the name inputs stay
   * live while it is open, so an edit typed in between must not slip past the first check.
   */
  const removalMustWait = (stageKey: string) => {
    if (!dirty) return false;
    setRefused(stageKey);
    setRemoving(null);
    return true;
  };

  const target = stages.find(({ key }) => key === removing);
  const destinations = stages.filter(({ key }) => key !== removing && key !== CONVERTED);
  // Only while the draft is still unsaved: saving or discarding answers the message, so it
  // clears itself rather than lingering as an accusation about work already dealt with.
  const refusedLabel = dirty ? draft.find(({ key }) => key === refused)?.label : undefined;

  return (
    <div className="stage-editor">
      {stages.length === 0 ? (
        <EmptyState title="No stages yet">Add the first column of this event's board.</EmptyState>
      ) : (
        <ol className="stage-list">
          {draft.map((stage, index) => {
            const held = counts.get(stage.key) ?? 0;
            const locked = stage.key === CONVERTED;
            return (
              <li key={stage.key} className="stage-row">
                <span className="stage-position" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="field">
                  <label htmlFor={`stage-label-${stage.key}`}>Stage name</label>
                  <input
                    id={`stage-label-${stage.key}`}
                    value={stage.label}
                    maxLength={80}
                    disabled={busy}
                    onChange={(event) => edit(index, { label: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`stage-category-${stage.key}`}>Counts as</label>
                  <select
                    id={`stage-category-${stage.key}`}
                    value={stage.category}
                    disabled={busy || locked}
                    onChange={(event) =>
                      edit(index, { category: event.target.value as StageCategoryDto })
                    }
                  >
                    {CATEGORIES.map(({ value, label, hint }) => (
                      <option key={value} value={value}>
                        {label} — {hint}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="stage-held">
                  <Pill tone={held ? "info" : "neutral"}>
                    {held} {held === 1 ? "prospect" : "prospects"}
                  </Pill>
                  {/* The key is shown because it is what the API and the history use, and an
                      organizer debugging an export should not have to guess it. */}
                  <code className="stage-key">{stage.key}</code>
                </span>
                <span className="stage-actions">
                  <button
                    type="button"
                    className="secondary small"
                    disabled={busy || index === 0}
                    onClick={() => swap(index, index - 1)}
                  >
                    Move up<span className="visually-hidden"> — {stage.label}</span>
                  </button>
                  <button
                    type="button"
                    className="secondary small"
                    disabled={busy || index === draft.length - 1}
                    onClick={() => swap(index, index + 1)}
                  >
                    Move down<span className="visually-hidden"> — {stage.label}</span>
                  </button>
                  {/*
                   * Converting is what puts a card in Converted, so the stage cannot be removed
                   * and the control says why rather than being greyed out with no explanation —
                   * which is #149's shape and the thing #206's sweep exists to catch.
                   */}
                  {locked ? (
                    <span className="stage-locked">Reached by converting a prospect</span>
                  ) : (
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      onClick={() => {
                        if (removalMustWait(stage.key)) return;
                        setRemoving(stage.key);
                        setMigrateTo(
                          stages.find(({ key }) => key !== stage.key && key !== CONVERTED)?.key ??
                            "",
                        );
                      }}
                    >
                      Remove<span className="visually-hidden"> — {stage.label}</span>
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {/* `role="alert"`, unlike the unsaved-changes hint below: this is the answer to a button
          the organizer just pressed, and it appears where the removal itself would have. */}
      {refusedLabel ? (
        <p className="hint" role="alert">
          Save or discard your changes before removing “{refusedLabel}”. Removing a stage reloads
          this board from the server, and your unsaved names and order would go with it.
        </p>
      ) : null}

      {target ? (
        <fieldset className="stage-remove">
          {/* A legend rather than a heading with `role="group"`: a fieldset is the element that
              means "these controls belong to one decision", and this is one decision. */}
          <legend>Remove “{target.label}”?</legend>
          <p>
            {counts.get(target.key)
              ? `${counts.get(target.key)} prospect${counts.get(target.key) === 1 ? "" : "s"} stand here and must move somewhere.`
              : "Nobody stands here, so nothing moves."}
          </p>
          <div className="field">
            <label htmlFor="stage-migrate-to">Move them to</label>
            <select
              id="stage-migrate-to"
              value={migrateTo}
              disabled={busy}
              onChange={(event) => setMigrateTo(event.target.value)}
            >
              {destinations.map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.label}
                </option>
              ))}
            </select>
          </div>
          <div className="stage-remove-actions">
            <button
              type="button"
              disabled={busy || !migrateTo}
              onClick={() => {
                if (removalMustWait(target.key)) return;
                onDelete(target.key, migrateTo);
                setRemoving(null);
              }}
            >
              Remove and move them
            </button>
            <button type="button" className="secondary" onClick={() => setRemoving(null)}>
              Keep it
            </button>
          </div>
        </fieldset>
      ) : null}

      <form className="stage-add" onSubmit={add}>
        <div className="field">
          <label htmlFor="stage-new-label">New stage name</label>
          <input
            id="stage-new-label"
            value={newLabel}
            placeholder="Shortlisted"
            maxLength={80}
            disabled={busy}
            onChange={(event) => setNewLabel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="stage-new-category">Counts as</label>
          <select
            id="stage-new-category"
            value={newCategory}
            disabled={busy}
            onChange={(event) => setNewCategory(event.target.value as StageCategoryDto)}
          >
            {CATEGORIES.map(({ value, label, hint }) => (
              <option key={value} value={value}>
                {label} — {hint}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="secondary" disabled={busy || !newLabel.trim()}>
          Add stage
        </button>
      </form>

      <div className="stage-save">
        <button type="button" disabled={busy || !dirty} onClick={() => onSave(draft)}>
          Save board
        </button>
        {dirty ? (
          <>
            <button type="button" className="secondary" onClick={() => setDraft(saved)}>
              Discard changes
            </button>
            <p className="hint" role="status">
              Unsaved changes. Names, order and categories are saved together.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
