// @spec PRD-AGD-001
/*
 * The Unscheduled rail: what still has no slot, and which of it the next assisted pass is for.
 *
 * It owns its own surface rather than being a fragment of the board (issue #70's rule): the
 * rail is a drop target in its own right — dragging a placed card here unschedules it — it is
 * the only place a session can be picked up from, and it is where an assisted pass explains
 * what it left alone. Selection state itself lives one level up in `useSessionSelection`,
 * because the toolbar control has to name the same count this rail draws.
 *
 * Every pointer gesture here has a keyboard equivalent, which is the board's standing rule and
 * the reason selection is a checkbox per session plus a select-all rather than a click-and-
 * shift-click range: a native checkbox is reachable by Tab and toggled by Space with no code of
 * ours in the way, so there is no mouse-only path to have an equivalent *for*. Ticking a session
 * is deliberately not the same gesture as picking it up — one says what to seat later, the other
 * moves something now — so the two live in separate controls with separate names.
 */

import { useRef } from "react";
import { IconCheck, IconGrip } from "../ui/icons";
import { Card, EmptyState } from "../ui/primitives";
import type { Carry } from "./model";
import type { SessionSelection } from "./useSessionSelection";

/** Only what the rail draws; the board holds the whole session. */
type RailSession = { id: string; title: string };

export function UnscheduledRail({
  sessions,
  selection,
  unplaced,
  heldSessionId,
  busy,
  trackId,
  searching,
  over,
  accepts,
  onOver,
  onDropHere,
  onPickUp,
  onCancelCarry,
  onSourceKeys,
  onStartDrag,
  onDragEnd,
}: {
  /** The unscheduled sessions currently listed, after any search has narrowed them. */
  sessions: readonly RailSession[];
  selection: SessionSelection;
  /** Why the last assisted pass left a session alone, keyed by session. */
  unplaced: ReadonlyMap<string, string>;
  /** The session being carried from this rail, if the operator is holding one. */
  heldSessionId: string | null;
  busy: boolean;
  /** The track a newly placed session lands on; no track means nothing can be picked up. */
  trackId: string;
  searching: boolean;
  over: boolean;
  /** Whether what is being dragged can be dropped here at all. */
  accepts: () => boolean;
  onOver: (over: boolean) => void;
  onDropHere: () => void;
  onPickUp: (source: Carry) => void;
  onCancelCarry: () => void;
  onSourceKeys: (event: React.KeyboardEvent) => void;
  onStartDrag: (event: React.DragEvent, source: Carry) => void;
  onDragEnd: () => void;
}) {
  const listed = new Set(sessions.map(({ id }) => id));
  // Selected sessions the current search is hiding. The selection is about sessions rather than
  // about the view, so this number is said out loud instead of being silently acted on.
  const hidden = selection.ids.filter((id) => !listed.has(id)).length;
  const allListed = sessions.length > 0 && sessions.every(({ id }) => selection.isSelected(id));
  const someListed = sessions.some(({ id }) => selection.isSelected(id));
  // Clearing takes the control that did it off the screen, and a control that removes itself
  // leaves keyboard focus on `document.body` — which on this page means Tab restarts at the
  // top of the console. Focus lands on the group control instead, or on the rail itself when
  // a search has left nothing to group.
  const group = useRef<HTMLInputElement | null>(null);
  const rail = useRef<HTMLElement | null>(null);

  return (
    <aside
      ref={rail}
      className="agenda-rail"
      // Only a focus target for the recovery above; it is never in the tab order.
      tabIndex={-1}
      data-over={over ? "true" : undefined}
      onDragOver={(event) => {
        if (!accepts()) return;
        // Preventing the default is what marks the rail as a valid drop target.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onOver(true);
      }}
      onDragLeave={() => onOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        onDropHere();
      }}
    >
      <Card
        labelledBy="agenda-unscheduled"
        title="Unscheduled"
        hint={`${sessions.length} session${sessions.length === 1 ? "" : "s"} without a slot`}
        tight
      >
        {sessions.length || selection.count ? (
          <div className="agenda-rail-select">
            {sessions.length ? (
              <label className="agenda-rail-all">
                <input
                  type="checkbox"
                  checked={allListed}
                  disabled={busy}
                  // Partly-ticked is a real third state, and saying it is the difference
                  // between "all of these" and "some of these" for a screen-reader user.
                  ref={(node) => {
                    group.current = node;
                    if (node) node.indeterminate = !allListed && someListed;
                  }}
                  onChange={(event) =>
                    selection.chooseMany(
                      sessions.map(({ id }) => id),
                      event.target.checked,
                    )
                  }
                />
                {searching
                  ? `Select all ${sessions.length} shown`
                  : `Select all ${sessions.length}`}
              </label>
            ) : null}
            {selection.count ? (
              <button
                type="button"
                className="secondary small agenda-rail-clear"
                disabled={busy}
                onClick={() => {
                  selection.clear();
                  (group.current ?? rail.current)?.focus();
                }}
              >
                Clear selection
              </button>
            ) : null}
          </div>
        ) : null}

        {/*
         * Mounted whenever the rail is, and only its text changes, because a live region has
         * to be on the page before the change it is announcing. Ticking a box otherwise says
         * only "checked" — never that the toolbar action now means one session instead of the
         * whole board, which is the very promise this affordance exists to keep.
         *
         * `aria-live` without `role="status"` on purpose: the workspace's action feedback is
         * the page's one `status` region, and it reports what an action *did*.
         */}
        {sessions.length || selection.count ? (
          <p className="agenda-rail-status" aria-live="polite">
            {selection.count ? (
              <span className="agenda-rail-chosen">{selection.count} selected</span>
            ) : null}
            {hidden ? (
              <span className="agenda-rail-hidden">
                {hidden === 1 ? "1 selected session is" : `${hidden} selected sessions are`} hidden
                by your search, and will still be placed.
              </span>
            ) : null}
          </p>
        ) : null}

        {sessions.length ? (
          <div className="agenda-rail-list">
            {sessions.map((session) => {
              const held = heldSessionId === session.id;
              const chosen = selection.isSelected(session.id);
              const reason = unplaced.get(session.id);
              const source: Carry = {
                sessionId: session.id,
                title: session.title,
                trackId,
                placementId: null,
                viaKeyboard: true,
              };
              return (
                <div
                  className="agenda-rail-item"
                  key={session.id}
                  data-selected={chosen ? "true" : undefined}
                >
                  <input
                    type="checkbox"
                    className="agenda-rail-check"
                    // The card beside this box replaces its own content with an `aria-label`,
                    // so the box has to name the session itself rather than borrow it.
                    aria-label={`Select ${session.title} for assisted placement`}
                    checked={chosen}
                    disabled={busy}
                    onChange={(event) => selection.choose(session.id, event.target.checked)}
                  />
                  <button
                    id={`agenda-session-${session.id}`}
                    type="button"
                    className="sched-card"
                    draggable={!busy}
                    disabled={busy || !trackId}
                    data-carrying={held ? "true" : undefined}
                    // `aria-label` replaces the content rather than adding to it, so the
                    // reason has to be repeated here or a screen reader never hears it.
                    aria-label={`${session.title}. Not scheduled. ${reason ? `${reason} ` : ""}${
                      held ? "Press Enter to cancel." : "Press Enter to pick this session up."
                    }`}
                    onDragStart={(event) => onStartDrag(event, { ...source, viaKeyboard: false })}
                    onDragEnd={onDragEnd}
                    onKeyDown={onSourceKeys}
                    onClick={() => (held ? onCancelCarry() : onPickUp(source))}
                  >
                    <span className="sched-title">{session.title}</span>
                    {reason ? <span className="sched-unplaced">{reason}</span> : null}
                    <span className="sched-meta">
                      <IconGrip size={12} />
                      Drag, or press Enter to place
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="Everything is scheduled" icon={<IconCheck size={20} />}>
            {searching
              ? "No unscheduled session matches your search."
              : "Every accepted session has a room and a time slot."}
          </EmptyState>
        )}
      </Card>
    </aside>
  );
}
