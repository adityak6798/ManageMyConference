/**
 * Generating agenda arrangements, comparing them with the board, and accepting the parts you want.
 *
 * The shape follows the one property that makes the feature worth having: **generating changes
 * nothing.** So the screen offers "generate" freely, shows the diff session by session with a
 * checkbox each, and puts the only destructive control behind an explicit count of what it will
 * apply.
 *
 * Two things are surfaced rather than smoothed over.
 *
 * **A stale draft says so.** When the board has moved since a draft was generated, the comparison
 * is against something that no longer exists — the banner says that and offers a re-run, because
 * accepting it would apply placements chosen for a different board.
 *
 * **A session the generator could not seat is listed with its reason.** "Nothing fits" is not
 * something an organizer can act on; "every remaining slot falls outside a speaker's
 * availability" names the constraint they would have to relax.
 *
 * @spec PRD-AGD-001
 */
import { useCallback, useState } from "react";
import {
  acceptDraft,
  compareDraft,
  type DraftComparison,
  discardDraft,
  generateDraft,
  type GeneratedDrafts as GeneratedDraftsResponse,
  listGeneratedDrafts,
} from "../api/agenda-generation";
import { type ApiFailure, describeApiFailure } from "../api/config";
import { IconChevronRight } from "../ui/icons";
import { Card, Notice, Pill, SkeletonRows, useLoad } from "../ui/primitives";

/**
 * A refusal as a sentence, with its correlation reference kept apart from it.
 *
 * The reference used to be glued onto the end of the message — "…could not be read. Reference:
 * 01JD…" — which is a paragraph a reader cannot select the identifier out of.
 */
const describe = (reason: unknown) =>
  describeApiFailure(reason, "Generated arrangements could not be read.");

/*
 * What an arrangement's state is called on screen.
 *
 * The pill printed the stored enum — "proposed", "discarded" — which names the row the way the
 * table stores it rather than the way the organizer thinks about it, in the one lowercase word on
 * a page of sentence case. An unmapped state still prints, because a value nobody has named yet is
 * better shown than swallowed.
 */
const STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  discarded: "Discarded",
};

const CHANGE_LABEL: Record<string, string> = {
  add: "Schedules",
  move: "Moves",
  unchanged: "No change",
  remove: "Unschedules",
};

export function GeneratedDrafts({
  eventId,
  canManage,
  announce,
}: {
  eventId: string;
  canManage: boolean;
  /*
   * The board's own announcer, passed in rather than created here.
   *
   * One page, one live region. This panel sits directly beneath the board and everything it does
   * *is* a board change — "applied 4 placements" belongs exactly where "moved to a new room"
   * already goes. A second region on `/agenda` is ambiguous for a screen reader before it is
   * ambiguous for a test.
   */
  announce: (tone: "success" | "error", detail: string | ApiFailure) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [comparison, setComparison] = useState<DraftComparison | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  /*
   * Closed until it is asked for.
   *
   * This panel used to be a 450px card standing open under the board on every visit, empty on
   * every fresh event — so the surface whose whole point is the grid ended with the grid at the
   * top of a page of nothing. Generating an arrangement is a deliberate, occasional act; the
   * summary keeps its count on screen at one row's cost and the work opens on request.
   */
  const [expanded, setExpanded] = useState(false);

  const drafts = useLoad<string, GeneratedDraftsResponse>(
    eventId,
    useCallback((id: string) => listGeneratedDrafts(id), []),
    useCallback((reason: unknown) => describe(reason), []),
  );

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await drafts.reload();
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const open = async (draftId: string) => {
    setBusy(true);
    try {
      const found = await compareDraft(eventId, draftId);
      setComparison(found);
      // Default to every change that is actually a change: the organizer un-ticks what they do
      // not want rather than hunting for what they do.
      setChosen(
        new Set(
          found.changes
            .filter((change) => change.change !== "unchanged")
            .map((change) => change.sessionId),
        ),
      );
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const loading = drafts.loading && !drafts.data;
  const list = drafts.data?.drafts ?? [];

  return (
    <>
      <details
        className="agenda-drafts"
        open={expanded}
        onToggle={(toggled) => setExpanded(toggled.currentTarget.open)}
      >
        {/* The count is the measure this row is about, so it sets as one and stays legible with
            the panel shut: an organizer who has generated three arrangements can see that they
            exist without opening anything. */}
        <summary className="agenda-drafts-summary">
          <IconChevronRight size={16} className="agenda-drafts-marker" />
          <span className="agenda-drafts-heading">Generated arrangements</span>
          <span className="figure agenda-drafts-count">{loading ? "—" : list.length}</span>
          <span className="agenda-drafts-hint">
            Generating changes nothing. The board only moves when you accept specific sessions.
          </span>
        </summary>

        <div className="agenda-drafts-body">
          {loading ? (
            <SkeletonRows rows={2} label="Loading the generated arrangements" />
          ) : /*
           * A failure here is reported inside this panel, and quietly.
           *
           * The board above is the surface the organizer came for and is unaffected by this list
           * failing to load; raising a page-level alert beside the board's own would make a
           * working board look broken. It carries no live-region role either: this is a state the
           * panel renders, not an announcement it makes, and the page's one announcer belongs to
           * the board.
           */
          drafts.error ? (
            <Notice tone="warn" reference={drafts.reference}>
              {drafts.error}
            </Notice>
          ) : list.length === 0 ? (
            <p className="agenda-drafts-empty">
              Nothing generated yet. Name an arrangement and generate it from your scheduling
              criteria, then compare it with the board and accept the parts you want.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption className="visually-hidden">Generated arrangements for this event</caption>
                <thead>
                  <tr>
                    <th scope="col">Arrangement</th>
                    <th scope="col">Seated</th>
                    <th scope="col">State</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((draft) => (
                    <tr key={draft.id}>
                      <td className="primary-cell" data-label="Arrangement">
                        {draft.name}
                        <span className="sub">{new Date(draft.generatedAt).toLocaleString()}</span>
                      </td>
                      <td data-label="Seated">
                        {/* How many sessions this arrangement seats is the figure the row is
                            compared on, so it sets as a measure rather than as running text. */}
                        <span className="figure">{draft.placements.length}</span>
                        {draft.unplaced.length > 0 ? (
                          <span className="sub">{draft.unplaced.length} could not be seated</span>
                        ) : null}
                      </td>
                      <td data-label="State">
                        <Pill tone={draft.status === "accepted" ? "ok" : "neutral"}>
                          {STATUS_LABEL[draft.status] ?? draft.status}
                        </Pill>
                      </td>
                      <td data-label="Actions">
                        <button
                          className="secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => open(draft.id)}
                        >
                          Compare
                        </button>
                        {canManage && draft.status === "proposed" ? (
                          <button
                            className="danger"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              run(`Discarded ${draft.name}.`, async () => {
                                await discardDraft(eventId, draft.id);
                                if (comparison?.draft.id === draft.id) setComparison(null);
                              })
                            }
                          >
                            Discard
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* One field and its action on one line. The button used to be the last child of a
              `.stack` grid, which stretched a muted-green primary the full width of the page —
              a banner that read as disabled rather than as the one thing here that writes. */}
          {canManage ? (
            <form
              className="agenda-drafts-form"
              onSubmit={(formEvent) => {
                formEvent.preventDefault();
                const wanted = name;
                setName("");
                // ERROR-INTENT: `run` reports its own failure through `announce` and never rejects,
                // so awaiting it here would only delay the handler's return.
                void run("Arrangement generated.", async () => {
                  const created = await generateDraft(eventId, wanted);
                  await open(created.draft.id);
                });
              }}
            >
              <div className="field">
                <label htmlFor="agenda-draft-name">Name this arrangement</label>
                <input
                  id="agenda-draft-name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(changed) => setName(changed.target.value)}
                />
              </div>
              <button className="primary" type="submit" disabled={busy || !name.trim()}>
                Generate
              </button>
            </form>
          ) : null}
        </div>
      </details>

      {comparison ? (
        <Card
          title={`${comparison.draft.name} beside the board`}
          hint="Tick the sessions to apply. Anything you leave keeps whatever the board says."
          actions={
            <button className="secondary" type="button" onClick={() => setComparison(null)}>
              Close
            </button>
          }
        >
          {comparison.stale ? (
            <Notice tone="warn">
              The board has changed since this arrangement was generated, so this comparison is
              against a board that no longer exists. Generate a new one to compare against the board
              as it stands.
            </Notice>
          ) : null}

          {comparison.draft.unplaced.length > 0 ? (
            <Notice tone="info">
              <strong>Could not be seated:</strong>
              <ul>
                {comparison.draft.unplaced.map((entry) => (
                  <li key={entry.sessionId}>
                    {entry.title} — {entry.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">Proposed changes, session by session</caption>
              <thead>
                <tr>
                  <th scope="col">Apply</th>
                  <th scope="col">Session</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {comparison.changes.map((change) => (
                  <tr key={change.sessionId}>
                    <td data-label="Apply">
                      <input
                        type="checkbox"
                        aria-label={`Apply the change to ${change.title}`}
                        disabled={change.change === "unchanged" || !canManage}
                        checked={chosen.has(change.sessionId)}
                        onChange={(ticked) =>
                          setChosen((current) => {
                            const next = new Set(current);
                            if (ticked.target.checked) next.add(change.sessionId);
                            else next.delete(change.sessionId);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="primary-cell" data-label="Session">
                      {change.title}
                    </td>
                    <td data-label="Change">
                      <Pill
                        tone={
                          change.change === "remove"
                            ? "warn"
                            : change.change === "unchanged"
                              ? "neutral"
                              : "info"
                        }
                      >
                        {CHANGE_LABEL[change.change] ?? change.change}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canManage ? (
            <button
              className="primary"
              type="button"
              disabled={busy || chosen.size === 0 || comparison.draft.status === "discarded"}
              onClick={() =>
                run("Applied to the board.", async () => {
                  const outcome = await acceptDraft(eventId, comparison.draft.id, [...chosen]);
                  announce(
                    "success",
                    `Applied ${outcome.applied} placement${outcome.applied === 1 ? "" : "s"}` +
                      (outcome.unscheduled > 0 ? ` and unscheduled ${outcome.unscheduled}.` : "."),
                  );
                  setComparison(null);
                })
              }
            >
              {/* The count is on the control, because this is the only thing here that writes. */}
              Apply {chosen.size} change{chosen.size === 1 ? "" : "s"} to the board
            </button>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
