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
  AgendaGenerationApiError,
  compareDraft,
  type DraftComparison,
  discardDraft,
  generateDraft,
  type GeneratedDrafts as GeneratedDraftsResponse,
  listGeneratedDrafts,
} from "../api/agenda-generation";
import { Card, EmptyState, Notice, Pill, useLoad } from "../ui/primitives";

const describe = (reason: unknown) =>
  reason instanceof AgendaGenerationApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

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
  announce: (tone: "success" | "error", text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [comparison, setComparison] = useState<DraftComparison | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const drafts = useLoad<string, GeneratedDraftsResponse>(
    eventId,
    useCallback((id: string) => listGeneratedDrafts(id), []),
    describe,
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

  if (drafts.loading && !drafts.data) return <Card title="Generated arrangements">Loading…</Card>;
  /*
   * A failure here is reported inside this panel, and quietly.
   *
   * The board above is the surface the organizer came for and is unaffected by this list failing
   * to load; raising a page-level alert beside the board's own would make a working board look
   * broken. It carries no live-region role either: this is a state the panel renders, not an
   * announcement it makes, and the page's one announcer belongs to the board.
   */
  if (drafts.error)
    return (
      <Card title="Generated arrangements">
        <Notice tone="warn">{drafts.error}</Notice>
      </Card>
    );
  const list = drafts.data?.drafts ?? [];

  return (
    <div className="stack">
      <Card
        title="Generated arrangements"
        hint="Generating changes nothing. The board only moves when you accept specific sessions."
      >
        {list.length === 0 ? (
          <EmptyState title="Nothing generated yet">
            Generate an arrangement from your scheduling criteria, compare it with the board, and
            accept the parts you want.
          </EmptyState>
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
                      {draft.placements.length}
                      {draft.unplaced.length > 0 ? (
                        <span className="sub">{draft.unplaced.length} could not be seated</span>
                      ) : null}
                    </td>
                    <td data-label="State">
                      <Pill tone={draft.status === "accepted" ? "ok" : "neutral"}>
                        {draft.status}
                      </Pill>
                    </td>
                    <td data-label="Actions">
                      <button type="button" disabled={busy} onClick={() => open(draft.id)}>
                        Compare
                      </button>
                      {canManage && draft.status === "proposed" ? (
                        <button
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
        {canManage ? (
          <form
            className="stack"
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
            <label>
              Name this arrangement
              <input
                required
                maxLength={120}
                value={name}
                onChange={(changed) => setName(changed.target.value)}
              />
            </label>
            <button type="submit" disabled={busy || !name.trim()}>
              Generate
            </button>
          </form>
        ) : null}
      </Card>

      {comparison ? (
        <Card
          title={`${comparison.draft.name} beside the board`}
          hint="Tick the sessions to apply. Anything you leave keeps whatever the board says."
          actions={
            <button type="button" onClick={() => setComparison(null)}>
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
    </div>
  );
}
