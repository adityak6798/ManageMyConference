// @spec PRD-AGD-001
/*
 * Which unscheduled sessions the next assisted pass should seat.
 *
 * The assisted endpoint has always accepted a `sessionIds` subset meaning "seat only these"
 * (issue #96); this hook is the board's half of it. It is a hook rather than state inside the
 * rail because two surfaces read the same answer: the rail draws the ticks, and the toolbar
 * control names the count so it can never promise something different from its effect.
 *
 * Selection is a fact about *sessions*, not about what the board is currently showing. It
 * therefore survives a search, a view change, and a day change — narrowing the rail must not
 * quietly narrow what the button is about to do, which is the defect class issue #113 fixed
 * for the enabled state of that same button.
 *
 * The one thing it must not survive is a session ceasing to be unscheduled. A tick on a session
 * that has since been placed would make the count — and the request — describe a board that no
 * longer exists, so `selectable` is the authority and everything read here is narrowed to it.
 *
 * Nothing in the body is agenda-specific — it is opaque ids in, opaque ids out — and the review
 * of #119 was right that the review and content workspaces each hand-roll a weaker version of
 * the same thing. It stays here anyway, deliberately: it has one caller, #70's rule is that a
 * shared primitive earns `ui/primitives.tsx` by being shared rather than by being general, and
 * promoting it usefully means converting those two surfaces — other domains' code, in a PR about
 * a rail. The second caller is what should move it, and should bring them with it.
 */
import { useEffect, useState } from "react";

/** What the rail and the toolbar both read. */
export type SessionSelection = {
  /** The chosen sessions that are still selectable, in the order they were offered. */
  readonly ids: readonly string[];
  readonly count: number;
  isSelected: (sessionId: string) => boolean;
  choose: (sessionId: string, chosen: boolean) => void;
  /** Tick or clear a whole listed group at once, for the rail's select-all control. */
  chooseMany: (sessionIds: readonly string[], chosen: boolean) => void;
  clear: () => void;
};

/**
 * @param selectable every session that may be chosen right now — the unscheduled ones,
 * before any search narrows what is on screen.
 */
export function useSessionSelection(selectable: readonly string[]): SessionSelection {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());

  /*
   * Forget a session that is no longer selectable.
   *
   * Narrowing on read (below) is what keeps every render honest; this only stops a stale tick
   * from *coming back*. Without it, placing a selected session by hand and then unscheduling it
   * again would return it pre-ticked — a selection the organizer never made, on the one control
   * whose whole job is to say exactly what it will act on.
   *
   * The caller is expected to memoise `selectable` on the draft it came from, which is what
   * makes this run when the board changes rather than on every keystroke. It stays correct
   * either way: a fresh array each render re-runs the body, and an unchanged selection returns
   * the same set, which React bails out on rather than re-rendering.
   */
  useEffect(() => {
    const live = new Set(selectable);
    setChosen((current) => {
      const kept = [...current].filter((id) => live.has(id));
      // Same set, same reference: an unchanged selection must not re-render the board.
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [selectable]);

  // Narrowed on read rather than only in the effect, so no render can ever count or send a
  // session that is already on the board — not even the one before the effect above runs.
  const ids = selectable.filter((id) => chosen.has(id));
  const live = new Set(ids);

  return {
    ids,
    count: ids.length,
    isSelected: (sessionId) => live.has(sessionId),
    choose: (sessionId, picked) =>
      setChosen((current) => {
        if (current.has(sessionId) === picked) return current;
        const next = new Set(current);
        if (picked) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      }),
    chooseMany: (sessionIds, picked) =>
      setChosen((current) => {
        const next = new Set(current);
        for (const sessionId of sessionIds)
          if (picked) next.add(sessionId);
          else next.delete(sessionId);
        return next.size === current.size ? current : next;
      }),
    clear: () => setChosen((current) => (current.size ? new Set() : current)),
  };
}
