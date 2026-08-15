/*
 * Review rounds: the organizer's console for the rounds an event runs.
 *
 * A round is not a number here. It has a name organizers use in conversation, a window it takes
 * work in, a lifecycle state, a policy about whether its reviewers see the author, a scorecard of
 * its own, and a pool of reviewers. Every one of those was previously either absent or an integer
 * nobody could reach, which is why this panel exists at all.
 *
 * Owned by the `review` domain. @spec PRD-REV-001 PRD-ABS-001
 */

import type { OrganizerReviewWorkspaceDto } from "@greenroom/contracts";
import { type FormEvent, useState } from "react";
import {
  createReviewRound,
  inviteReviewRound,
  recomputeReviewRound,
  setReviewRoundPool,
  updateReviewRound,
} from "../api/review";
import "../styles/review.css";
import { IconPlus, IconReview, IconWarning } from "../ui/icons";
import { Card, EmptyState, Notice, Pill, useActionFeedback } from "../ui/primitives";
import { fieldErrorsOf, message, type Round, ROUND_STATE, roundDate } from "./shared";

/**
 * A round's editable terms, as the form holds them.
 *
 * Dates are `datetime-local` strings rather than ISO instants, because that is what the control
 * produces and converting at the edge keeps one representation inside the form.
 */
type Terms = {
  name: string;
  instructions: string;
  aiPersona: string;
  opensAt: string;
  closesAt: string;
  state: Round["state"];
  anonymized: boolean;
  poolMode: Round["poolMode"];
  /** Whether this round overrides the event plan. The criteria themselves are edited in the rubric. */
  ownScorecard: boolean;
  visibleFieldIds: string;
  filesVisible: boolean;
  maxEvaluationsPerProposal: number;
  weeklyReminderWeekday: string;
  weeklyReminderHour: string;
  reminderTimezone: string;
  filters: string;
};

/** ISO instant to the `datetime-local` value the browser control wants, in the viewer's zone. */
const toLocalInput = (instant: string | null) => {
  if (!instant) return "";
  const when = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
};
/** And back. Empty means unbounded on that side, which is `null` rather than an invented instant. */
const toInstant = (local: string) => (local ? new Date(local).toISOString() : null);

const termsOf = (round: Round): Terms => ({
  name: round.name,
  instructions: round.instructions,
  aiPersona: round.aiPersona,
  opensAt: toLocalInput(round.opensAt),
  closesAt: toLocalInput(round.closesAt),
  state: round.state,
  anonymized: round.anonymized,
  poolMode: round.poolMode,
  ownScorecard: round.criteria !== null,
  visibleFieldIds: round.visibleFieldIds.join(", "),
  filesVisible: round.filesVisible,
  maxEvaluationsPerProposal: round.maxEvaluationsPerProposal,
  weeklyReminderWeekday: round.weeklyReminderWeekday?.toString() ?? "",
  weeklyReminderHour: round.weeklyReminderHour?.toString() ?? "",
  reminderTimezone: round.reminderTimezone ?? "",
  filters: round.filters.map(({ field, values }) => `${field}=${values.join(",")}`).join("\n"),
});

const filtersOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [field = "", ...tail] = line.split("=");
      return {
        field: field.trim(),
        values: tail
          .join("=")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      };
    });

export function RoundsPanel({
  eventId,
  data,
  reviewerName,
  onSaved,
}: {
  eventId: string;
  data: OrganizerReviewWorkspaceDto;
  reviewerName: (reviewerId: string) => string;
  onSaved: () => Promise<void>;
}) {
  const rounds = data.rounds ?? [];
  const [editing, setEditing] = useState<number | null>(null);
  const [terms, setTerms] = useState<Terms | null>(null);
  const [pool, setPool] = useState<readonly string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const feedback = useActionFeedback();

  async function invite(sequence: number, mode: "new" | "all") {
    setBusy(true);
    try {
      const result = await inviteReviewRound(eventId, sequence, { mode });
      const count = (state: string) =>
        result.invitations.filter((invitation) => invitation.state === state).length;
      feedback.announce(
        "success",
        `Invitations: ${count("queued")} queued, ${count("already_sent")} already sent, ${count("unaddressable")} unaddressable.`,
      );
    } catch (reason) {
      // ERROR-INTENT: the shared live region reports this organizer-triggered delivery failure.
      feedback.announce("error", message(reason, "Reviewer invitations could not be queued."));
    } finally {
      setBusy(false);
    }
  }

  // The assignable list, which withholds the signed-in organizer: a pool is who may be *given*
  // work, and the organizer console has no reviewer queue to open it in.
  const assignable = data.reviewers;
  const countIn = (sequence: number) =>
    data.assignments.filter((assignment) => assignment.round === sequence).length;

  const open = (round: Round) => {
    setEditing(round.sequence);
    setTerms(termsOf(round));
    setPool(round.reviewerIds);
    setErrors({});
    feedback.clear();
  };

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setErrors({});
    try {
      await action();
      await onSaved();
      feedback.announce("success", success);
      return true;
    } catch (reason) {
      const fields = fieldErrorsOf(reason);
      setErrors(fields);
      const detail = Object.values(fields).flat();
      // ERROR-INTENT: this panel's live region reports the handled failure. The envelope message
      // for a refusal here is "The review request is invalid.", which nobody can act on; the
      // sentence that can be acted on is in the field errors, so that is what gets announced.
      feedback.announce(
        "error",
        detail.length ? detail.join(" ") : message(reason, "That change could not be saved."),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (editing === null || !terms) return;
    const round = rounds.find((item) => item.sequence === editing);
    if (!round) return;
    /*
     * Two requests, and the order matters.
     *
     * The pool is written first. Widening a pool then restricting the round is safe in either
     * order, but *restricting* the round while its pool is still the old one is a window in which
     * the round admits people the organizer has just removed — and the terms write is the one that
     * flips `poolMode`. Writing the pool first means the round is never `named` against a stale
     * membership list.
     *
     * They are separate calls rather than one because the pool has its own refusal — a reviewer
     * holding work in the round cannot leave it — and folding that into a terms save would report
     * a dates edit as failing for a reason about reviewers.
     */
    const poolChanged =
      pool.length !== round.reviewerIds.length ||
      pool.some((reviewerId) => !round.reviewerIds.includes(reviewerId));
    if (
      poolChanged &&
      !(await act(() => setReviewRoundPool(eventId, editing, pool), "Pool saved."))
    )
      return;
    const saved = await act(
      () =>
        updateReviewRound(eventId, editing, {
          name: terms.name,
          instructions: terms.instructions,
          aiPersona: terms.aiPersona,
          opensAt: toInstant(terms.opensAt),
          closesAt: toInstant(terms.closesAt),
          state: terms.state,
          anonymized: terms.anonymized,
          // Turning the override off hands the round back to the event plan. Turning it on copies
          // the plan as it stands right now, which is the snapshot semantics the round type
          // documents: the event plan can go on changing without restating a round's rubric.
          criteria: terms.ownScorecard ? (round.criteria ?? data.plan?.criteria ?? null) : null,
          filters: round.filters,
          visibleFieldIds: terms.visibleFieldIds
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          filesVisible: terms.filesVisible,
          maxEvaluationsPerProposal: terms.maxEvaluationsPerProposal,
          weeklyReminderWeekday:
            terms.weeklyReminderWeekday === "" ? null : Number(terms.weeklyReminderWeekday),
          weeklyReminderHour:
            terms.weeklyReminderHour === "" ? null : Number(terms.weeklyReminderHour),
          reminderTimezone: terms.reminderTimezone.trim() || null,
          poolMode: terms.poolMode,
        }),
      `“${terms.name}” saved.`,
    );
    if (saved) setEditing(null);
  }

  async function recompute() {
    if (editing === null || !terms) return;
    await act(
      () => recomputeReviewRound(eventId, editing, { filters: filtersOf(terms.filters) }),
      "Filter membership recomputed as a new snapshot version.",
    );
  }

  async function duplicate(round: Round) {
    await act(
      () =>
        createReviewRound(eventId, {
          name: `${round.name} copy`,
          instructions: round.instructions,
          aiPersona: round.aiPersona,
          opensAt: round.opensAt,
          closesAt: round.closesAt,
          state: "draft",
          anonymized: round.anonymized,
          criteria: round.criteria,
          poolMode: round.poolMode,
          reviewerIds: round.reviewerIds,
          filters: round.filters,
          visibleFieldIds: round.visibleFieldIds,
          filesVisible: round.filesVisible,
          maxEvaluationsPerProposal: round.maxEvaluationsPerProposal,
          weeklyReminderWeekday: round.weeklyReminderWeekday,
          weeklyReminderHour: round.weeklyReminderHour,
          reminderTimezone: round.reminderTimezone,
        }),
      `“${round.name}” duplicated as configuration only.`,
    );
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const created = await act(
      () =>
        createReviewRound(eventId, {
          name: newName,
          anonymized: true,
          // `named` with nobody in it, deliberately: a new round admits nobody until an organizer
          // says who, which is the whole of "membership in one round does not carry into another".
          poolMode: "named",
          state: "draft",
          reviewerIds: [],
        }),
      `“${newName}” created as a draft. Add its reviewers, then open it.`,
    );
    if (created) {
      setCreating(false);
      setNewName("");
    }
  }

  return (
    <Card
      labelledBy="review-rounds"
      title="Review rounds"
      hint="Each round has its own dates, scorecard, blind-review policy and reviewer pool."
      actions={
        <button
          type="button"
          className="secondary small"
          disabled={busy}
          onClick={() => {
            setCreating((value) => !value);
            setEditing(null);
          }}
        >
          <IconPlus size={14} /> New round
        </button>
      }
    >
      {feedback.node}

      {creating ? (
        <form className="round-create" onSubmit={create}>
          <div className="field">
            <label htmlFor="new-round-name">Round name</label>
            <input
              id="new-round-name"
              value={newName}
              required
              maxLength={80}
              placeholder="Programme committee"
              onChange={(event) => setNewName(event.target.value)}
            />
            <p className="hint">
              Its number is allocated in order, and every assignment, result and draft in the round
              carries it.
            </p>
            {errors.name?.length ? (
              <p className="field-error" role="alert">
                {errors.name.join(" ")}
              </p>
            ) : null}
          </div>
          <div className="toolbar">
            <button type="submit" disabled={busy || !newName.trim()}>
              Create round
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {rounds.length === 0 ? (
        <EmptyState title="No rounds configured yet" icon={<IconReview size={20} />}>
          A round groups the abstracts, reviewers and scores of one pass through the submissions.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data review-rounds-table">
            <caption className="visually-hidden">
              Review rounds, with their dates, policies, pools and assignment counts
            </caption>
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">State</th>
                <th scope="col">Window</th>
                <th scope="col">Reviewers see</th>
                <th scope="col">Scorecard</th>
                <th scope="col">Pool</th>
                <th scope="col" className="num">
                  Assigned
                </th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((round) => (
                <tr key={round.sequence} className={round.sequence === editing ? "is-open" : ""}>
                  <td className="primary-cell" data-label="Round">
                    {round.name}
                    <span className="sub">Round {round.sequence}</span>
                  </td>
                  <td data-label="State">
                    <Pill tone={ROUND_STATE[round.state].tone}>
                      {ROUND_STATE[round.state].label}
                    </Pill>
                  </td>
                  <td data-label="Window">
                    {roundDate(round.opensAt)} → {roundDate(round.closesAt)}
                  </td>
                  {/* The policy stated as what a reviewer actually sees, not as a flag name. */}
                  <td data-label="Reviewers see">
                    {round.anonymized ? "No author (blind)" : "Author and co-authors"}
                  </td>
                  <td data-label="Scorecard">
                    {round.criteria ? `Its own (${round.criteria.length})` : "The event plan"}
                  </td>
                  <td data-label="Pool">
                    {round.poolMode === "event" ? (
                      <span className="empty-text">Every event reviewer</span>
                    ) : round.reviewerIds.length ? (
                      round.reviewerIds.map((reviewerId) => reviewerName(reviewerId)).join(", ")
                    ) : (
                      <span className="empty-text">Nobody yet</span>
                    )}
                  </td>
                  <td className="num" data-label="Assigned">
                    {countIn(round.sequence)}
                  </td>
                  <td data-label="Actions">
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy || countIn(round.sequence) === 0}
                      onClick={() => {
                        // ERROR-INTENT: invite reports failures through the shared panel feedback.
                        void invite(round.sequence, "new");
                      }}
                    >
                      Invite new
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy || countIn(round.sequence) === 0}
                      onClick={() => {
                        // ERROR-INTENT: invite reports failures through the shared panel feedback.
                        void invite(round.sequence, "all");
                      }}
                    >
                      Invite all
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      onClick={() => {
                        // ERROR-INTENT: duplicate reports failures through the shared panel feedback.
                        void duplicate(round);
                      }}
                    >
                      Duplicate<span className="visually-hidden"> {round.name}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      onClick={() => (editing === round.sequence ? setEditing(null) : open(round))}
                      aria-expanded={editing === round.sequence}
                      aria-controls="round-editor"
                    >
                      Edit
                      <span className="visually-hidden"> {round.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && terms ? (
        <form className="round-editor" id="round-editor" onSubmit={save}>
          <h4>Editing “{terms.name}”</h4>
          {rounds.find((round) => round.sequence === editing)?.state === "closed" ? (
            <Notice tone="info">
              <IconWarning size={15} />
              <span>
                This round is closed, so its window, scorecard, blind-review policy and pool are
                frozen — an aggregate already read must not be re-explained by different terms.
                Reopening it is still allowed.
              </span>
            </Notice>
          ) : null}
          <div className="field">
            <label htmlFor="round-name">Name</label>
            <input
              id="round-name"
              value={terms.name}
              required
              maxLength={80}
              onChange={(event) => setTerms({ ...terms, name: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="round-instructions">Reviewer instructions</label>
            <textarea
              id="round-instructions"
              rows={4}
              maxLength={5000}
              value={terms.instructions}
              onChange={(event) => setTerms({ ...terms, instructions: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="round-ai-persona">AI evaluator perspective</label>
            <textarea
              id="round-ai-persona"
              rows={3}
              maxLength={2000}
              value={terms.aiPersona}
              onChange={(event) => setTerms({ ...terms, aiPersona: event.target.value })}
            />
            <p className="hint">
              Guides distinguishable AI drafts only. It never creates or completes a human
              evaluation.
            </p>
          </div>
          <div className="round-editor-row">
            <div className="field">
              <label htmlFor="round-opens">Opens</label>
              <input
                id="round-opens"
                type="datetime-local"
                value={terms.opensAt}
                onChange={(event) => setTerms({ ...terms, opensAt: event.target.value })}
              />
              <p className="hint">Leave empty for no start bound.</p>
            </div>
            <div className="field">
              <label htmlFor="round-closes">Closes</label>
              <input
                id="round-closes"
                type="datetime-local"
                value={terms.closesAt}
                onChange={(event) => setTerms({ ...terms, closesAt: event.target.value })}
              />
              <p className="hint">After this, the round records no new work.</p>
              {errors.closesAt?.length ? (
                <p className="field-error" role="alert">
                  {errors.closesAt.join(" ")}
                </p>
              ) : null}
            </div>
          </div>
          <div className="field">
            <label htmlFor="round-state">Lifecycle</label>
            <select
              id="round-state"
              value={terms.state}
              onChange={(event) =>
                setTerms({ ...terms, state: event.target.value as Round["state"] })
              }
            >
              <option value="draft">Draft — configured, taking no work yet</option>
              <option value="open">Open — assignments and scores are accepted</option>
              <option value="closed">Closed — view-only history</option>
            </select>
            {errors.state?.length ? (
              <p className="field-error" role="alert">
                {errors.state.join(" ")}
              </p>
            ) : null}
          </div>
          <fieldset className="field">
            <legend className="group-label">Blind review</legend>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={terms.anonymized}
                onChange={(event) => setTerms({ ...terms, anonymized: event.target.checked })}
              />
              Hide the author and co-authors from this round's reviewers
            </label>
            <p className="hint">
              This is enforced in the reviewer's queue itself — a blind round sends no author, no
              contact details and no co-author list, rather than hiding them on screen. Organizer
              surfaces, including this console and the CSV export, always show the author. The
              review assistant never receives one in any round.
            </p>
          </fieldset>
          <fieldset className="field">
            <legend className="group-label">Proposal membership snapshot</legend>
            <label htmlFor="round-filters">Filters</label>
            <textarea
              id="round-filters"
              rows={4}
              value={terms.filters}
              placeholder={"track=Platform, Practice\nformat=Workshop\nstatus=under_review"}
              onChange={(event) => setTerms({ ...terms, filters: event.target.value })}
            />
            <p className="hint">
              One field=value list per line. Snapshot v
              {rounds.find((item) => item.sequence === editing)?.filterVersion ?? 1} currently
              includes{" "}
              {rounds.find((item) => item.sequence === editing)?.includedProposalIds.length ?? 0}{" "}
              proposals. Source edits never change it silently.
            </p>
            {errors.filters?.length ? (
              <p className="field-error" role="alert">
                {errors.filters.join(" ")}
              </p>
            ) : null}
            <button
              type="button"
              className="secondary small"
              disabled={busy}
              onClick={() => {
                // ERROR-INTENT: recompute reports failures through the shared panel feedback.
                void recompute();
              }}
            >
              Recompute membership
            </button>
          </fieldset>
          <fieldset className="field">
            <legend className="group-label">Reviewer visibility and cap</legend>
            <label htmlFor="round-visible-fields">Visible CFP field IDs</label>
            <input
              id="round-visible-fields"
              value={terms.visibleFieldIds}
              placeholder="level, language, format"
              onChange={(event) => setTerms({ ...terms, visibleFieldIds: event.target.value })}
            />
            <p className="hint">Leave empty to show every non-authorship answer.</p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={terms.filesVisible}
                onChange={(event) => setTerms({ ...terms, filesVisible: event.target.checked })}
              />
              Permit uploaded proposal files when the CFP supports them
            </label>
            <label htmlFor="round-proposal-cap">Maximum evaluations per proposal</label>
            <input
              id="round-proposal-cap"
              type="number"
              min={1}
              max={100}
              value={terms.maxEvaluationsPerProposal}
              onChange={(event) =>
                setTerms({ ...terms, maxEvaluationsPerProposal: Number(event.target.value) || 1 })
              }
            />
          </fieldset>
          <fieldset className="field">
            <legend className="group-label">Weekly reminder</legend>
            <div className="round-editor-row">
              <label>
                Weekday (0–6)
                <input
                  type="number"
                  min={0}
                  max={6}
                  value={terms.weeklyReminderWeekday}
                  onChange={(event) =>
                    setTerms({ ...terms, weeklyReminderWeekday: event.target.value })
                  }
                />
              </label>
              <label>
                Local hour
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={terms.weeklyReminderHour}
                  onChange={(event) =>
                    setTerms({ ...terms, weeklyReminderHour: event.target.value })
                  }
                />
              </label>
              <label>
                Timezone
                <input
                  value={terms.reminderTimezone}
                  placeholder="America/Los_Angeles"
                  onChange={(event) => setTerms({ ...terms, reminderTimezone: event.target.value })}
                />
              </label>
            </div>
            <p className="hint">
              A scheduled tick sends only while this round is open and work remains; each local week
              is one occurrence.
            </p>
          </fieldset>
          <fieldset className="field">
            <legend className="group-label">Scorecard</legend>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={terms.ownScorecard}
                disabled={!data.plan}
                onChange={(event) => setTerms({ ...terms, ownScorecard: event.target.checked })}
              />
              Give this round its own copy of the scorecard
            </label>
            <p className="hint">
              {terms.ownScorecard
                ? "Scores and weighted aggregates in this round use its own criteria. Turning this off hands the round back to the event plan."
                : "This round scores against the event plan in Evaluation setup. Turning this on copies that plan as it stands now, so later edits to it leave this round alone."}
            </p>
          </fieldset>
          <fieldset className="field">
            <legend className="group-label">Reviewer pool</legend>
            <label htmlFor="round-pool-mode" className="visually-hidden">
              Who may be assigned in this round
            </label>
            <select
              id="round-pool-mode"
              value={terms.poolMode}
              onChange={(event) =>
                setTerms({ ...terms, poolMode: event.target.value as Round["poolMode"] })
              }
            >
              <option value="named">Only the reviewers named below</option>
              <option value="event">Every reviewer staffed on this event</option>
            </select>
            {errors.poolMode?.length ? (
              <p className="field-error" role="alert">
                {errors.poolMode.join(" ")}
              </p>
            ) : null}
            {assignable.length === 0 ? (
              <p className="hint">
                No reviewers are staffed on this event yet, so there is nobody to add.
              </p>
            ) : (
              <ul className="round-pool">
                {assignable.map((reviewer) => (
                  <li key={reviewer.id}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={pool.includes(reviewer.id)}
                        disabled={terms.poolMode === "event"}
                        onChange={(event) =>
                          setPool((current) =>
                            event.target.checked
                              ? [...current, reviewer.id]
                              : current.filter((id) => id !== reviewer.id),
                          )
                        }
                      />
                      {reviewer.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              A reviewer added here is in this round only. Somebody who reviewed an earlier round is
              not carried forward, and a reviewer already holding work in this round cannot be
              removed until that work is unassigned.
            </p>
            {errors.reviewerIds?.length ? (
              <p className="field-error" role="alert">
                {errors.reviewerIds.join(" ")}
              </p>
            ) : null}
          </fieldset>
          <div className="toolbar">
            <button type="submit" disabled={busy}>
              Save round
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
