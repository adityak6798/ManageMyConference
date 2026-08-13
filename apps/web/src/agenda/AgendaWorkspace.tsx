// @spec PRD-AGD-001
/*
 * Agenda board.
 *
 * Scheduling is the surface organizers live in, so this is a board rather than a stack
 * of dropdowns: sessions are dragged onto a room x time-slot grid. Every drag has a
 * keyboard equivalent — pick up, arrow to a cell, drop — because a scheduling tool that
 * needs a mouse is unusable for part of an organizing team, and because that same code
 * path is what an acceptance test can drive.
 *
 * Conflict detection stays in the API (`agenda.conflicts`); this file only makes the
 * conflicts it returns impossible to miss, in every view rather than in one panel.
 *
 * Slots are stored as instants and rendered in the *event's* timezone: an organizer
 * scheduling a Los Angeles conference reads Los Angeles clock times, and a 21:00 local
 * session belongs to its local day even when that instant is already tomorrow in UTC.
 * That makes the day buckets — not only the labels — a function of the event zone, so
 * the formatters are per-render values derived from the event rather than constants.
 *
 * Timeslots are also *written* on that clock. The organizer types a start and an end,
 * this file converts them to instants in the event's zone, and nothing anywhere invents
 * a date: an event with no slots yet defaults to the next whole hour on its own clock,
 * which is a suggestion the operator can overwrite before anything is sent.
 *
 * Every outcome lands where the action was taken. Success and failure share one live
 * region under the toolbar, and anything about a single room, track, or timeslot is
 * repeated inside that row. The parent's `onError` is reserved for a failure to *load*,
 * which is the only failure that leaves no workspace to report it in.
 */

import type { EventDto } from "@greenroom/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AgendaApiError,
  autoPlaceSessions,
  getAgenda,
  publishAgenda,
  removePlacement,
  saveAgendaResources,
  savePlacement,
} from "../api/agenda";
import "../styles/agenda.css";
import { IconCalendar, IconCheck, IconClock, IconGrip, IconPlus, IconWarning } from "../ui/icons";
import { Card, EmptyState, Notice, Pill, Tabs, useActionFeedback } from "../ui/primitives";
import {
  byInstant,
  byStart,
  type Carry,
  type Cell,
  CONFLICT_LABELS,
  conflictPublicationSummary,
  type Conflict,
  cellKey,
  clockFor,
  DEFAULT_TRACK_COLOR,
  type Draft,
  errorsByRow,
  HOUR_MS,
  inUseNote,
  isViewId,
  NEW_SLOT,
  type Placement,
  readViewFromUrl,
  type Slot,
  type SlotForm,
  VIEW_LABELS,
  VIEW_TITLES,
  VIEWS,
  type ViewId,
} from "./model";
import { UnscheduledRail } from "./UnscheduledRail";
import { useSessionSelection } from "./useSessionSelection";

function newAgenda(eventId: string): Draft {
  return {
    eventId,
    rooms: [{ id: crypto.randomUUID(), name: "Main room" }],
    tracks: [{ id: crypto.randomUUID(), name: "General", color: DEFAULT_TRACK_COLOR }],
    slots: [],
    sessions: [],
    placements: [],
    conflicts: [],
  };
}

// This state-owning board intentionally exceeds 400 lines: pointer/keyboard drag, focus recovery,
// slot drafts, resource edits, and conflict narration share one atomic agenda draft. Its nested
// board/list renderers are single-use views of that state, so extracting them would violate issue
// #70's higher-priority rule against presentational fragments. Pure clock/model logic is isolated
// in model.ts, the Unscheduled rail owns its own surface in UnscheduledRail.tsx, and which
// sessions the assisted pass is for owns its lifecycle in useSessionSelection.ts; no further
// section owns an independent lifecycle that earns another file.
export function AgendaWorkspace({
  event,
  onError,
}: {
  event: EventDto;
  onError: (message: string) => void;
}) {
  const eventId = event.id;
  // Keyed on the zone rather than the whole event: the same formatters survive the many
  // re-renders of a drag, and a switch to an event in another zone rebuilds them.
  const clock = useMemo(() => clockFor(event.timezone), [event.timezone]);
  const [agenda, setAgenda] = useState<Draft | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewId>(readViewFromUrl);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [trackForNew, setTrackForNew] = useState<string | null>(null);
  /**
   * Why the last assisted pass left certain sessions alone, keyed by session.
   *
   * Held here rather than derived, because it is a fact about an action the organizer took and
   * not about the board: once they move something by hand the explanation is stale, so any
   * later placement of that session clears its entry.
   */
  const [unplaced, setUnplaced] = useState<ReadonlyMap<string, string>>(new Map());
  const [carry, setCarryState] = useState<Carry | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null);
  /** Where focus goes after the next render, and whether it may take it from someone. */
  const [pendingFocus, setPendingFocus] = useState<{
    readonly id: string;
    readonly onlyIfDropped?: boolean | undefined;
  } | null>(null);
  // Typed-but-unsaved timeslot rows, keyed by slot id (and `NEW_SLOT` for the one that
  // has no id yet). A row with no entry here simply shows what the server holds.
  const [slotForms, setSlotForms] = useState<Record<string, SlotForm>>({});
  // Why one row was refused, keyed the same way plus room and track ids: a refusal about
  // a single resource belongs in that resource's row, not in a page-wide notice.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // "Now" is read once per mount so the suggested start cannot slide out from under an
  // operator who is mid-edit; it is only ever a default, and it is theirs to overwrite.
  const [openedAt] = useState(() => Date.now());
  const feedback = useActionFeedback();
  const mounted = useRef(true);
  // Native drag events fire faster than React can re-render, so the drop handlers read
  // what is being carried from a ref; the state copy only drives what is painted.
  const carried = useRef<Carry | null>(null);
  const setCarry = (next: Carry | null) => {
    carried.current = next;
    setCarryState(next);
  };

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setAgenda(null);
    setMissing(false);
    // Half-typed times belong to the event they were typed for, never to the next one.
    setSlotForms({});
    setRowErrors({});
    // ERROR-INTENT: React effects cannot await; failures are rendered by the parent boundary.
    void getAgenda(eventId)
      .then((loaded) => {
        if (active) setAgenda(loaded);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof AgendaApiError && error.envelope.error.code === "NOT_FOUND") {
          setAgenda(newAgenda(eventId));
          setMissing(true);
          return;
        }
        onError(error instanceof Error ? error.message : "Agenda failed to load.");
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [eventId, onError]);

  // Back and forward through a shared board link must land on the view that was linked.
  useEffect(() => {
    const sync = () => setView(readViewFromUrl());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  /*
   * Focus follows the operator across a re-render, in one of two ways.
   *
   * Most actions *move* it: picking a session up puts the operator on the grid that can receive
   * it, dropping one puts them on the card that moved, cancelling gives them back the card they
   * were holding. That is the default, because in each case the element they pressed is gone or
   * is no longer where the work is.
   *
   * An action that only disabled its own control instead *recovers* focus (`onlyIfDropped`).
   * The browser drops focus to the body when a focused control is disabled, so a body focus is
   * the signal that nobody else has taken it. Without that test, an assisted pass finishing
   * while the operator types in the search box would pull the caret out of the field, and their
   * next space would press the button it had landed on rather than typing a space.
   *
   * Either way, when the named element is gone or still disabled and focus *has* been dropped,
   * the panel takes it rather than leaving it on the body, where the next Tab would restart at
   * the top of the console. The panel is read here rather than named when the action started,
   * because the operator may have changed view while the request was in flight.
   */
  useEffect(() => {
    if (!pendingFocus) return;
    const { id, onlyIfDropped } = pendingFocus;
    setPendingFocus(null);
    const dropped = document.activeElement === null || document.activeElement === document.body;
    const target = document.getElementById(id);
    const landable = target && !target.matches(":disabled") ? target : null;
    if (landable) {
      if (!onlyIfDropped || dropped) landable.focus();
      return;
    }
    if (dropped) document.getElementById(`panel-${view}`)?.focus();
  }, [pendingFocus, view]);

  /*
   * Which sessions the assisted pass may be asked to seat, before any search narrows the rail.
   *
   * Read here, above the loading return, because the selection it feeds is a hook and hooks
   * cannot be conditional. It is also the honest input: a session the organizer has since
   * placed is no longer selectable, and the selection is narrowed to this list on every read.
   */
  const unscheduledIds = useMemo(() => {
    if (!agenda) return [];
    const placed = new Set(agenda.placements.map(({ sessionId }) => sessionId));
    return agenda.sessions.filter(({ id }) => !placed.has(id)).map(({ id }) => id);
  }, [agenda]);
  const selection = useSessionSelection(unscheduledIds);

  if (!agenda)
    return (
      <div className="agenda">
        <p role="status">Loading agenda…</p>
      </div>
    );

  // One non-null binding keeps every render helper below free of null checks.
  const draft = agenda;
  const rooms = draft.rooms;
  const tracks = draft.tracks;
  const slotRange = (slot: Slot) => `${clock.hhmm(slot.startsAt)}–${clock.hhmm(slot.endsAt)}`;
  const allSlots = [...draft.slots].sort(byStart);
  // Day buckets are the *event's* calendar days. A 21:00 local slot stays on its local
  // day even when that instant already belongs to tomorrow in UTC, so the Day, Week,
  // Room and Track views group the way the organizer's own programme reads.
  const days = [...new Set(allSlots.map((slot) => clock.dayKey(slot.startsAt)))].sort();
  // Each key is labelled from a real instant on that day, so no synthetic midday
  // timestamp has to be invented and no zone offset is assumed.
  const dayLabels = new Map(
    allSlots.map((slot) => [clock.dayKey(slot.startsAt), clock.dayLabel(slot.startsAt)]),
  );
  const labelForDay = (day: string) => dayLabels.get(day) ?? day;
  const activeDay = selectedDay && days.includes(selectedDay) ? selectedDay : (days[0] ?? null);
  const daySlots = allSlots.filter((slot) => clock.dayKey(slot.startsAt) === activeDay);
  const newTrackId = trackForNew ?? tracks[0]?.id ?? "";
  // DST makes the abbreviation date-dependent, so it is read at a time the board shows.
  const zoneAbbreviation = clock.abbreviation(allSlots[0]?.startsAt ?? new Date().toISOString());
  const zoneLabel =
    zoneAbbreviation && zoneAbbreviation !== clock.zone
      ? `${clock.zone} (${zoneAbbreviation})`
      : clock.zone;

  const roomName = (id: string) => rooms.find((room) => room.id === id)?.name ?? "Unassigned room";
  const trackOf = (id: string) => tracks.find((track) => track.id === id);
  const slotOf = (id: string) => draft.slots.find((slot) => slot.id === id);
  const placementOf = (id: string) => draft.placements.find((placement) => placement.id === id);
  const sessionTitle = (id: string) =>
    draft.sessions.find((session) => session.id === id)?.title ?? "Removed session";

  const conflictsByPlacement = new Map<string, Conflict[]>();
  for (const conflict of draft.conflicts)
    for (const id of [conflict.placementId, conflict.conflictingPlacementId])
      conflictsByPlacement.set(id, [...(conflictsByPlacement.get(id) ?? []), conflict]);

  const needle = query.trim().toLowerCase();
  /*
   * Everything without a slot, before the search box narrows it.
   *
   * The assisted pass places every unscheduled session — or every *selected* one — and neither
   * is "the ones currently matching a search", so the control that starts it is enabled from
   * this count. Reading the filtered list instead made a search for something else disable a
   * button that had plenty to do, and a search matching one of ten enable a button that then
   * placed all ten.
   */
  const unscheduledCount = unscheduledIds.length;
  // Filtered from the very list the selection is narrowed against, rather than from a second
  // copy of the same predicate: two derivations of "unscheduled" can disagree, and the rail
  // would then offer a tick that could never stay set.
  const selectable = new Set(unscheduledIds);
  const unscheduled = draft.sessions.filter(
    (session) =>
      selectable.has(session.id) && (!needle || session.title.toLowerCase().includes(needle)),
  );
  const sortedPlacements = [...draft.placements].sort((left, right) => {
    const leftSlot = slotOf(left.slotId);
    const rightSlot = slotOf(right.slotId);
    if (!leftSlot || !rightSlot) return leftSlot ? -1 : 1;
    return (
      byInstant(leftSlot.startsAt, rightSlot.startsAt) ||
      roomName(left.roomId).localeCompare(roomName(right.roomId))
    );
  });

  // Cell order matches DOM order so the arrow keys move focus where the eye expects.
  const boardCells: Cell[] =
    view === "room"
      ? daySlots.flatMap((slot) =>
          rooms.map((room) => ({
            key: cellKey(room.id, slot.id),
            roomId: room.id,
            slotId: slot.id,
          })),
        )
      : view === "day"
        ? rooms.flatMap((room) =>
            daySlots.map((slot) => ({
              key: cellKey(room.id, slot.id),
              roomId: room.id,
              slotId: slot.id,
            })),
          )
        : [];
  const boardColumns = Math.max(1, view === "room" ? rooms.length : daySlots.length);
  const isBoardView = view === "room" || view === "day";

  /* The API sends a remediation hint but not the story; this reconstructs the story. */
  function explain(conflict: Conflict): string {
    const own = placementOf(conflict.placementId);
    const other = placementOf(conflict.conflictingPlacementId);
    const slot = own ? slotOf(own.slotId) : undefined;
    const when = slot ? `${clock.dayLabel(slot.startsAt)} ${slotRange(slot)}` : "an unknown time";
    const ownTitle = own ? sessionTitle(own.sessionId) : "a removed placement";
    const otherTitle = other ? sessionTitle(other.sessionId) : "a removed placement";
    switch (conflict.kind) {
      case "ROOM_OVERLAP":
        return `${roomName(conflict.resourceId)} holds “${ownTitle}” and “${otherTitle}” at the same time (${when}).`;
      case "SPEAKER_OVERLAP":
        return `One speaker is on stage for both “${ownTitle}” and “${otherTitle}” at ${when}.`;
      case "SESSION_OVERLAP":
        return `“${sessionTitle(conflict.resourceId)}” is placed twice at ${when}.`;
      case "MISSING_SESSION":
        return "This placement points at a session that is no longer schedulable.";
    }
  }

  function selectView(next: string) {
    const chosen = isViewId(next) ? next : "room";
    setView(chosen);
    const params = new URLSearchParams(window.location.search);
    params.set("view", chosen);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  /** Drops one row's refusal, because the action it was about has now succeeded. */
  function clearRowError(key: string) {
    setRowErrors((current) =>
      current[key] === undefined
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => id !== key)),
    );
  }

  /**
   * `focusId` is applied only once the new draft is on screen: the element it names
   * (the card that just moved) does not exist until then.
   *
   * `row` names the room, track, or timeslot the action was about, if any. A refusal
   * always reaches the live region under the toolbar — the same place the success would
   * have gone — and a refusal about one row is repeated inside that row.
   */
  async function act(
    action: () => Promise<Draft>,
    describe: (updated: Draft) => string,
    {
      focusId,
      /** Recover focus only if the action's own disabling dropped it. See the focus effect. */
      recoverFocusOnly,
      row,
      explanations,
    }: {
      focusId?: string | undefined;
      recoverFocusOnly?: boolean | undefined;
      row?: string | undefined;
      /**
       * Assisted-placement reasons this action produced; anything else clears them.
       *
       * Read after the action resolves, because the reasons arrive with its response.
       */
      explanations?: (() => ReadonlyMap<string, string>) | undefined;
    } = {},
  ) {
    setBusy(true);
    try {
      const updated = await action();
      if (!mounted.current) return;
      setMissing(false);
      setAgenda(updated);
      /*
       * Every explanation is dropped on any board change, and only the assisted pass puts them
       * back. "Every room and time slot is already taken" stops being true the moment another
       * card is unscheduled, and a note about a room clash stops being true when the rooms
       * change — so keeping the ones whose session is still unplaced was not enough. These are
       * the verdict of one pass over one board; when the board moves, the verdict is stale
       * whether or not the session it names has moved with it.
       */
      setUnplaced((current) => explanations?.() ?? (current.size ? new Map() : current));
      if (row) clearRowError(row);
      feedback.announce("success", describe(updated));
      if (focusId) setPendingFocus({ id: focusId, onlyIfDropped: recoverFocusOnly });
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : "Agenda update failed.";
      feedback.announce("error", message);
      if (row) setRowErrors((current) => ({ ...current, [row]: message }));
      /*
       * A refusal always *recovers* focus, whatever the caller asked for on success.
       *
       * Nothing moved, so there is nowhere to move focus to — and the operator has had the
       * length of a request to go somewhere else. Restoring unconditionally here would take the
       * caret out of the search box they had started typing in, and hand their next keystroke
       * to whatever card it landed on. What is worth repairing is only the focus the control's
       * own disabling dropped.
       */
      if (focusId) setPendingFocus({ id: focusId, onlyIfDropped: true });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * Fill the board in one pass, then say what is left and why.
   *
   * One request for the whole pass, so the board never shows a half-generated draft and the
   * cost does not grow with the number of sessions — and a subset costs exactly what the whole
   * board costs, because it is the same one request and the same one draft revision. What comes
   * back is an ordinary draft: every card it produced can be dragged, removed, or moved exactly
   * as a hand-placed one, the conflict panel judges it by the same rules, and nothing is public
   * until the organizer presses Publish.
   *
   * With nothing ticked this seats everything unscheduled, which is what the control says it
   * will do; with a selection it names those sessions, and the control says that instead.
   */
  function generateDraft() {
    const chosen = selection.count ? [...selection.ids] : undefined;
    let couldNotPlace: readonly { sessionId: string; reason: string }[] = [];
    let seated = 0;
    return act(
      async () => {
        try {
          const { placed, unplaced: reported, ...board } = await autoPlaceSessions(eventId, chosen);
          couldNotPlace = reported;
          /*
           * The server's own answer, not a diff of two boards. Only it can separate what this
           * pass seated from what another organizer did in the same seconds, and this control
           * exists to say what it did.
           */
          seated = placed.length;
          return board;
        } catch (error) {
          /*
           * The board this screen is holding has outgrown the server's: either a named session
           * is gone, or the whole draft is. Both arrive as the same NOT_FOUND, and this request
           * is refused whole either way, so the message says what is certain — nothing was
           * placed, and the screen is out of date — instead of naming a cause it cannot know.
           */
          if (error instanceof AgendaApiError && error.envelope.error.code === "NOT_FOUND")
            throw new Error(
              "The board has changed since it was loaded, so nothing was placed. Reload it, then try again.",
            );
          throw error;
        }
      },
      () => {
        const placed = seated === 1 ? "Placed 1 session." : `Placed ${seated} sessions.`;
        if (!couldNotPlace.length) return `${placed} Review the board, then publish when ready.`;
        return `${placed} ${couldNotPlace.length} could not be placed; each one says why in Unscheduled.`;
      },
      {
        // Focus survives the press, and survives a refusal: this control disables itself
        // while the request is in flight, and a disabled control cannot hold focus. Recovery
        // only, because the operator may have moved on to the search box meanwhile.
        focusId: "agenda-assisted-action",
        recoverFocusOnly: true,
        /*
         * This pass's verdicts, and only this pass's.
         *
         * A subset pass judged just the sessions it was given, so it is tempting to keep the
         * notes on the others — and the first review of #119 asked for exactly that. Two later
         * passes showed why it cannot be done from here: whether those notes are still true
         * depends on whether the board moved, and this screen cannot tell. A placement, a room,
         * a slot, or another organizer's edit arrives in the same response, and a reason that
         * survives the change which disproved it is worse than no reason at all. So the rule
         * stays the one this map has always followed: a pass replaces the verdicts wholesale,
         * and a session it was not asked about goes back to saying nothing until something
         * judges it again.
         */
        explanations: () =>
          new Map(couldNotPlace.map(({ sessionId, reason }) => [sessionId, reason])),
      },
    );
  }

  const saveResources = (
    resources: Pick<Draft, "rooms" | "tracks" | "slots">,
    done: string,
    row?: string,
  ) =>
    act(
      () => saveAgendaResources(eventId, resources),
      () => done,
      { row },
    );

  /**
   * Timeslots take their own save path rather than `saveResources` because they are the
   * only resource an operator can get *wrong*: the API answers a bad start/end pair with
   * per-field errors, and those have to land on the row that caused them instead of in
   * the workspace-wide alert. `keys` names the row that owns each entry of `slots`, so a
   * `slots.2.endsAt` from the API can be traced back to the inputs the operator sees.
   *
   * `row` names the one row this submission is *about* — the row whose Save, Remove, or
   * Add was pressed. Every other row on screen may be holding times the operator typed
   * and has not sent yet, and those are unsaved work: they survive this response, which
   * is only an answer about `row`.
   */
  async function saveSlots(
    slots: Slot[],
    done: string,
    row: string,
    keys: string[] = slots.map(({ id }) => id),
  ) {
    setBusy(true);
    try {
      const updated = await saveAgendaResources(eventId, {
        rooms: draft.rooms,
        tracks: draft.tracks,
        slots,
      });
      if (!mounted.current) return;
      setMissing(false);
      setAgenda(updated);
      /*
       * Adding or removing a time slot is a board change like any other, so the assisted
       * pass's verdicts go with it. This is the one board-changing path that does not run
       * through `act`, and leaving the map alone here was how "every room and time slot is
       * already taken" could survive the operator adding the slot that disproves it.
       */
      setUnplaced((current) => (current.size ? new Map() : current));
      // Answered: this row's draft and its refusal both go. Drafts belonging to slots
      // that no longer exist go with them; the rest is still the operator's to save.
      const live = new Set(updated.slots.map(({ id }) => id));
      const settled = (key: string) => key === row || (key !== NEW_SLOT && !live.has(key));
      setSlotForms((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !settled(key))),
      );
      setRowErrors((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !settled(key))),
      );
      feedback.announce("success", done);
    } catch (error) {
      if (!mounted.current) return;
      const fields = error instanceof AgendaApiError ? error.envelope.error.fieldErrors : undefined;
      const rows = fields ? errorsByRow(fields, keys) : {};
      const rejected = Object.values(rows);
      if (rejected.length) {
        setRowErrors((current) => ({ ...current, ...rows }));
        feedback.announce("error", `Timeslot not saved. ${rejected.join(" ")}`);
        return;
      }
      // Anything the API did not attach to a field is still about the row the operator
      // pressed — a timeslot that cannot be removed while it holds a session, say — so
      // it announces under the toolbar and is repeated in that row.
      const message = error instanceof Error ? error.message : "Timeslot update failed.";
      feedback.announce("error", message);
      setRowErrors((current) => ({ ...current, [row]: message }));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Refuses a row before anything is sent, and says why where the operator is looking. */
  function refuseSlot(key: string, message: string): null {
    setRowErrors((current) => ({ ...current, [key]: message }));
    feedback.announce("error", message);
    return null;
  }

  /** The instants a row means, or null once the reason it means none has been shown. */
  function readSlotForm(key: string, form: SlotForm) {
    const startsAt = clock.toInstant(form.start);
    const endsAt = clock.toInstant(form.end);
    if (!startsAt || !endsAt) return refuseSlot(key, "Enter both a start time and an end time.");
    if (Date.parse(endsAt) <= Date.parse(startsAt))
      return refuseSlot(key, "End must be after start.");
    return { startsAt, endsAt };
  }

  const slotInputs = (slot: Pick<Slot, "startsAt" | "endsAt">): SlotForm => ({
    start: clock.toInput(slot.startsAt),
    end: clock.toInput(slot.endsAt),
  });

  const editSlotForm = (key: string, saved: SlotForm, patch: Partial<SlotForm>) => {
    // Retyping a row answers the refusal it is carrying, so the message and the
    // `aria-invalid` that goes with it are dropped rather than left contradicting the
    // values now on screen; the next submit decides again.
    clearRowError(key);
    setSlotForms((current) => ({
      ...current,
      [key]: { ...saved, ...current[key], ...patch },
    }));
  };

  // The suggested first slot is a real choice for *this* event: the end of its own last
  // slot, or the next whole hour on its own clock. No instant is ever carried over from
  // another event, and nothing is sent until the operator submits the form.
  const lastSlotEnd = [...draft.slots]
    .sort((left, right) => byInstant(left.endsAt, right.endsAt))
    .at(-1)?.endsAt;
  const suggestedStart = lastSlotEnd ?? clock.nextRoundHour(openedAt);
  const newSlotForm =
    slotForms[NEW_SLOT] ??
    slotInputs({
      startsAt: suggestedStart,
      endsAt: new Date(Date.parse(suggestedStart) + HOUR_MS).toISOString(),
    });

  function pickUp(source: Carry, from?: Placement) {
    setCarry(source);
    if (source.viaKeyboard) {
      const slot = from ? slotOf(from.slotId) : undefined;
      if (slot) setSelectedDay(clock.dayKey(slot.startsAt));
      // Picking a session up from a summary view moves the operator to the board that
      // can actually receive it, rather than leaving them with nowhere to drop.
      if (!isBoardView) selectView("room");
      const fallbackRoom = rooms[0];
      const fallbackSlot = daySlots[0] ?? allSlots[0];
      const target = from
        ? cellKey(from.roomId, from.slotId)
        : fallbackRoom && fallbackSlot
          ? cellKey(fallbackRoom.id, fallbackSlot.id)
          : null;
      if (target) setPendingFocus({ id: `agenda-cell-${target}` });
    }
    feedback.announce(
      "success",
      `Holding “${source.title}”. Choose a slot and press Enter to place it.`,
    );
  }

  function cancelCarry() {
    if (!carry) return;
    setPendingFocus({
      id: carry.placementId
        ? `agenda-placement-${carry.placementId}`
        : `agenda-session-${carry.sessionId}`,
    });
    feedback.announce("success", `Cancelled. “${carry.title}” was not moved.`);
    setCarry(null);
    setOverCell(null);
  }

  function place(source: Carry, roomId: string, slotId: string) {
    const id = source.placementId ?? `placement-${source.sessionId}`;
    setCarry(null);
    setOverCell(null);
    // ERROR-INTENT: React event handlers cannot await; act renders both outcomes.
    void act(
      () =>
        savePlacement(eventId, {
          id,
          sessionId: source.sessionId,
          roomId,
          trackId: source.trackId,
          slotId,
        }),
      (updated) => {
        const slot = updated.slots.find((candidate) => candidate.id === slotId);
        const room = updated.rooms.find((candidate) => candidate.id === roomId);
        const created = updated.conflicts.filter(
          (conflict) => conflict.placementId === id || conflict.conflictingPlacementId === id,
        );
        const where = `${room?.name ?? "a room"} at ${slot ? slotRange(slot) : "the chosen time"}`;
        return created.length
          ? `“${source.title}” placed in ${where}, and it now has ${created.length} conflict${created.length === 1 ? "" : "s"}. Open the Conflicts view.`
          : `“${source.title}” placed in ${where}.`;
      },
      { focusId: `agenda-placement-${id}` },
    );
  }

  function unschedule(placement: Placement) {
    const title = sessionTitle(placement.sessionId);
    setCarry(null);
    setOverCell(null);
    // ERROR-INTENT: React event handlers cannot await; act renders both outcomes.
    void act(
      async () => {
        await removePlacement(eventId, placement.id);
        return getAgenda(eventId);
      },
      () => `“${title}” moved back to Unscheduled.`,
      { focusId: `agenda-session-${placement.sessionId}` },
    );
  }

  function carryFor(placement: Placement, viaKeyboard: boolean): Carry {
    return {
      sessionId: placement.sessionId,
      title: sessionTitle(placement.sessionId),
      trackId: placement.trackId,
      placementId: placement.id,
      viaKeyboard,
    };
  }

  function onCellKeys(event: React.KeyboardEvent, key: string) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelCarry();
      return;
    }
    const delta =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? boardColumns
            : event.key === "ArrowUp"
              ? -boardColumns
              : 0;
    if (!delta) return;
    event.preventDefault();
    const index = boardCells.findIndex((cell) => cell.key === key);
    if (index < 0) return;
    const next = boardCells[Math.min(boardCells.length - 1, Math.max(0, index + delta))];
    if (next) document.getElementById(`agenda-cell-${next.key}`)?.focus();
  }

  function onSourceKeys(event: React.KeyboardEvent) {
    if (event.key !== "Escape" || !carry) return;
    event.preventDefault();
    cancelCarry();
  }

  function startDrag(event: React.DragEvent, source: Carry) {
    event.dataTransfer.effectAllowed = "move";
    // Some browsers cancel a drag that carries no payload, so the title travels with it.
    event.dataTransfer.setData("text/plain", source.title);
    setCarry(source);
  }

  /** A placed session: one target for both pointer drags and keyboard pick-up. */
  function renderCard(placement: Placement) {
    const title = sessionTitle(placement.sessionId);
    const slot = slotOf(placement.slotId);
    const track = trackOf(placement.trackId);
    const placementConflicts = conflictsByPlacement.get(placement.id) ?? [];
    const held = carry?.placementId === placement.id;
    return (
      <button
        key={placement.id}
        id={`agenda-placement-${placement.id}`}
        type="button"
        className="sched-card"
        draggable={!busy}
        disabled={busy}
        data-conflict={placementConflicts.length ? "true" : undefined}
        data-carrying={held ? "true" : undefined}
        style={track ? { borderLeftColor: track.color } : undefined}
        aria-label={`${title}. ${roomName(placement.roomId)}, ${slot ? slotRange(slot) : "no time"}${
          track ? `, ${track.name} track` : ""
        }.${
          placementConflicts.length
            ? ` In conflict: ${placementConflicts
                .map((conflict) => CONFLICT_LABELS[conflict.kind])
                .join(", ")}.`
            : ""
        } ${held ? "Press Enter to cancel the move." : "Press Enter to pick this session up."}`}
        onDragStart={(event) => startDrag(event, carryFor(placement, false))}
        onDragEnd={() => {
          setCarry(null);
          setOverCell(null);
        }}
        onKeyDown={onSourceKeys}
        onClick={() => (held ? cancelCarry() : pickUp(carryFor(placement, true), placement))}
      >
        <span className="sched-title">{title}</span>
        <span className="sched-meta">
          {track ? (
            <>
              <span className="track-dot" style={{ background: track.color }} />
              {track.name}
            </>
          ) : null}
          {slot ? <span>{slotRange(slot)}</span> : null}
          {placementConflicts.length ? (
            <Pill tone="danger">
              <IconWarning size={11} />
              {[...new Set(placementConflicts.map(({ kind }) => CONFLICT_LABELS[kind]))].join(", ")}
            </Pill>
          ) : null}
        </span>
      </button>
    );
  }

  /** A read-only card for the views that summarise rather than edit. */
  function renderStaticCard(placement: Placement, withRoom: boolean) {
    const track = trackOf(placement.trackId);
    const slot = slotOf(placement.slotId);
    const placementConflicts = conflictsByPlacement.get(placement.id) ?? [];
    return (
      <div
        key={placement.id}
        className="sched-static"
        data-conflict={placementConflicts.length ? "true" : undefined}
        style={track ? { borderLeftColor: track.color } : undefined}
      >
        <span className="sched-title">{sessionTitle(placement.sessionId)}</span>
        <span className="sched-meta">
          {withRoom ? <span>{roomName(placement.roomId)}</span> : null}
          {slot ? <span>{slotRange(slot)}</span> : null}
          {placementConflicts.length ? (
            <Pill tone="danger">
              <IconWarning size={11} />
              Conflict
            </Pill>
          ) : null}
        </span>
      </div>
    );
  }

  function renderCell(roomId: string, slotId: string) {
    const key = cellKey(roomId, slotId);
    const slot = slotOf(slotId);
    const inCell = draft.placements.filter(
      (placement) => placement.roomId === roomId && placement.slotId === slotId,
    );
    const when = slot ? slotRange(slot) : "this time";
    return (
      <td
        key={key}
        onDragOver={(event) => {
          if (!carried.current) return;
          // Preventing the default is what marks this cell as a valid drop target.
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setOverCell(key);
        }}
        onDragLeave={() => setOverCell((current) => (current === key ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          const source = carried.current;
          if (source) place(source, roomId, slotId);
        }}
      >
        <div className="board-cell" data-over={overCell === key ? "true" : undefined}>
          {inCell.map((placement) => renderCard(placement))}
          {carry?.viaKeyboard ? (
            <button
              id={`agenda-cell-${key}`}
              type="button"
              className="dropzone"
              disabled={busy}
              aria-label={`Place “${carry.title}” in ${roomName(roomId)} at ${when}${
                inCell.length
                  ? `. Already holds ${inCell.length} session${inCell.length === 1 ? "" : "s"}`
                  : ""
              }`}
              onClick={() => place(carry, roomId, slotId)}
              onKeyDown={(event) => onCellKeys(event, key)}
            >
              <IconPlus size={12} />
              Drop here
            </button>
          ) : inCell.length === 0 ? (
            <span className="cell-empty" aria-hidden="true">
              —
            </span>
          ) : null}
        </div>
      </td>
    );
  }

  function renderBoardEmpty() {
    return (
      <EmptyState title="The board needs rooms and time slots" icon={<IconCalendar size={20} />}>
        Open “Manage rooms, tracks, and times” below to add at least one room and one time slot,
        then drag sessions onto the grid.
      </EmptyState>
    );
  }

  function renderRoomBoard() {
    if (!rooms.length || !daySlots.length) return renderBoardEmpty();
    return (
      <div className="table-wrap">
        <table className="data board">
          <caption className="visually-hidden">
            Rooms across the top, time slots down the side, for{" "}
            {activeDay ? labelForDay(activeDay) : "the event"}, in {zoneLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {rooms.map((room) => (
                <th scope="col" key={room.id}>
                  {room.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {daySlots.map((slot) => (
              <tr key={slot.id}>
                <th scope="row">{slotRange(slot)}</th>
                {rooms.map((room) => renderCell(room.id, slot.id))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderDayBoard() {
    if (!rooms.length || !daySlots.length) return renderBoardEmpty();
    return (
      <div className="table-wrap">
        <table className="data board">
          <caption className="visually-hidden">
            One column per time slot on {activeDay ? labelForDay(activeDay) : "the selected day"},
            in {zoneLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Room</th>
              {daySlots.map((slot) => (
                <th scope="col" key={slot.id}>
                  {slotRange(slot)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => (
              <tr key={room.id}>
                <th scope="row">{room.name}</th>
                {daySlots.map((slot) => renderCell(room.id, slot.id))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderWeekBoard() {
    if (!allSlots.length) return renderBoardEmpty();
    // Slots repeat across days, so the rows are the distinct times of day.
    const timeRows = [...new Set(allSlots.map((slot) => slotRange(slot)))].sort();
    return (
      <div className="table-wrap">
        <table className="data board">
          <caption className="visually-hidden">
            Days across the top, time slots down the side, in {zoneLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {days.map((day) => (
                <th scope="col" key={day}>
                  {labelForDay(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {timeRows.map((range) => (
              <tr key={range}>
                <th scope="row">{range}</th>
                {days.map((day) => {
                  const slotIds = allSlots
                    .filter(
                      (slot) => clock.dayKey(slot.startsAt) === day && slotRange(slot) === range,
                    )
                    .map((slot) => slot.id);
                  const inCell = draft.placements.filter((placement) =>
                    slotIds.includes(placement.slotId),
                  );
                  return (
                    <td key={`${day}-${range}`}>
                      <div className="board-cell">
                        {inCell.length ? (
                          inCell.map((placement) => renderStaticCard(placement, true))
                        ) : (
                          <span className="cell-empty" aria-hidden="true">
                            —
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderTrackBoard() {
    if (!tracks.length)
      return (
        <EmptyState title="No tracks yet" icon={<IconCalendar size={20} />}>
          Add a track under “Manage rooms, tracks, and times” to colour-code the programme.
        </EmptyState>
      );
    return (
      <div>
        {tracks.map((track) => {
          const inTrack = sortedPlacements.filter((placement) => placement.trackId === track.id);
          return (
            <section
              className="agenda-track-group"
              key={track.id}
              aria-label={`${track.name} track`}
            >
              <div className="agenda-track-head">
                <span className="agenda-track-swatch" style={{ background: track.color }} />
                <h3>{track.name}</h3>
                <span className="count">
                  {inTrack.length} session{inTrack.length === 1 ? "" : "s"}
                </span>
              </div>
              {inTrack.length ? (
                <ul className="agenda-track-list">
                  {inTrack.map((placement) => (
                    <li key={placement.id}>{renderStaticCard(placement, true)}</li>
                  ))}
                </ul>
              ) : (
                <p className="cell-empty">Nothing scheduled on this track yet.</p>
              )}
            </section>
          );
        })}
      </div>
    );
  }

  function renderListView() {
    const rows = sortedPlacements.filter(
      (placement) => !needle || sessionTitle(placement.sessionId).toLowerCase().includes(needle),
    );
    if (!rows.length)
      return (
        <EmptyState title="Nothing scheduled yet" icon={<IconCalendar size={20} />}>
          Drag a session from Unscheduled onto the room grid, or pick one up with the keyboard and
          press Enter on a slot.
        </EmptyState>
      );
    return (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Day</th>
              <th scope="col">Time</th>
              <th scope="col">Room</th>
              <th scope="col">Track</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((placement) => {
              const slot = slotOf(placement.slotId);
              const placementConflicts = conflictsByPlacement.get(placement.id) ?? [];
              const firstConflict = placementConflicts[0];
              return (
                <tr key={placement.id}>
                  <td className="primary-cell">{sessionTitle(placement.sessionId)}</td>
                  <td>{slot ? clock.dayLabel(slot.startsAt) : "—"}</td>
                  <td>
                    <select
                      aria-label={`Time assignment ${placement.id}`}
                      value={placement.slotId}
                      disabled={busy}
                      onChange={(event) => {
                        // ERROR-INTENT: React event handlers cannot await; act renders failures.
                        void act(
                          () =>
                            savePlacement(eventId, {
                              ...placement,
                              slotId: event.target.value,
                            }),
                          () => `“${sessionTitle(placement.sessionId)}” moved to a new time.`,
                        );
                      }}
                    >
                      {allSlots.map((option) => (
                        <option key={option.id} value={option.id}>
                          {clock.dayLabel(option.startsAt)} · {slotRange(option)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Room assignment ${placement.id}`}
                      value={placement.roomId}
                      disabled={busy}
                      onChange={(event) => {
                        // ERROR-INTENT: React event handlers cannot await; act renders failures.
                        void act(
                          () =>
                            savePlacement(eventId, {
                              ...placement,
                              roomId: event.target.value,
                            }),
                          () => `“${sessionTitle(placement.sessionId)}” moved to a new room.`,
                        );
                      }}
                    >
                      {rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Track assignment ${placement.id}`}
                      value={placement.trackId}
                      disabled={busy}
                      onChange={(event) => {
                        // ERROR-INTENT: React event handlers cannot await; act renders failures.
                        void act(
                          () =>
                            savePlacement(eventId, {
                              ...placement,
                              trackId: event.target.value,
                            }),
                          () => `“${sessionTitle(placement.sessionId)}” moved to a new track.`,
                        );
                      }}
                    >
                      {tracks.map((track) => (
                        <option key={track.id} value={track.id}>
                          {track.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {firstConflict ? (
                      <Pill tone="danger">
                        <IconWarning size={11} />
                        {CONFLICT_LABELS[firstConflict.kind]}
                      </Pill>
                    ) : (
                      <Pill tone="ok">Scheduled</Pill>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => unschedule(placement)}
                    >
                      Unschedule
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderConflictsView() {
    if (!draft.conflicts.length)
      return (
        <EmptyState title="No conflicts" icon={<IconCheck size={20} />}>
          Every placement has its own room, its own slot, and a speaker who is free. This draft can
          be published.
        </EmptyState>
      );
    return (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Conflict</th>
              <th scope="col">Session</th>
              <th scope="col">Clashes with</th>
              <th scope="col">Why</th>
              <th scope="col">How to fix it</th>
            </tr>
          </thead>
          <tbody>
            {draft.conflicts.map((conflict) => {
              const own = placementOf(conflict.placementId);
              const other = placementOf(conflict.conflictingPlacementId);
              const ownSlot = own ? slotOf(own.slotId) : undefined;
              const otherSlot = other ? slotOf(other.slotId) : undefined;
              return (
                <tr
                  key={`${conflict.kind}-${conflict.placementId}-${conflict.conflictingPlacementId}-${conflict.resourceId}`}
                >
                  <td>
                    <Pill tone="danger">
                      <IconWarning size={11} />
                      {CONFLICT_LABELS[conflict.kind]}
                    </Pill>
                  </td>
                  <td className="primary-cell">
                    {own ? sessionTitle(own.sessionId) : "Removed placement"}
                    {own ? (
                      <span className="sub">
                        {roomName(own.roomId)} · {ownSlot ? slotRange(ownSlot) : "no time"}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {other ? sessionTitle(other.sessionId) : "—"}
                    {other ? (
                      <span className="sub">
                        {roomName(other.roomId)} · {otherSlot ? slotRange(otherSlot) : "no time"}
                      </span>
                    ) : null}
                  </td>
                  <td>{explain(conflict)}</td>
                  <td>{conflict.message}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderView() {
    switch (view) {
      case "list":
        return renderListView();
      case "day":
        return renderDayBoard();
      case "week":
        return renderWeekBoard();
      case "room":
        return renderRoomBoard();
      case "track":
        return renderTrackBoard();
      case "conflicts":
        return renderConflictsView();
    }
  }

  const boardHint = isBoardView
    ? `Drag a session onto a cell, or press Enter on a session to pick it up and place it with the arrow keys. Times are shown in ${zoneLabel}.`
    : `Times are shown in ${zoneLabel}.`;

  if (missing)
    return (
      <div className="agenda">
        <Card>
          <EmptyState title="No agenda yet — create the first room and track">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                // ERROR-INTENT: this user-initiated write reports failure through the workspace.
                void saveAgendaResources(eventId, {
                  rooms: draft.rooms,
                  tracks: draft.tracks,
                  slots: draft.slots,
                })
                  .then((loaded) => {
                    if (!mounted.current) return;
                    setMissing(false);
                    setAgenda(loaded);
                  })
                  .catch((reason: unknown) => {
                    if (mounted.current)
                      onError(
                        reason instanceof Error ? reason.message : "Agenda initialization failed.",
                      );
                  })
                  .finally(() => {
                    if (mounted.current) setBusy(false);
                  });
              }}
            >
              Create agenda
            </button>
          </EmptyState>
        </Card>
      </div>
    );

  return (
    <div className="agenda">
      <Tabs
        label="Agenda views"
        active={view}
        onSelect={selectView}
        items={VIEWS.map((id) => ({
          id,
          label: VIEW_LABELS[id],
          ...(id === "conflicts"
            ? { count: draft.conflicts.length }
            : id === "list"
              ? { count: draft.placements.length }
              : {}),
        }))}
      />

      <div className="toolbar agenda-toolbar">
        <label className="visually-hidden" htmlFor="agenda-search">
          Search sessions
        </label>
        <input
          id="agenda-search"
          className="search"
          type="search"
          placeholder="Search sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {isBoardView && days.length ? (
          <label className="agenda-inline-field">
            Day
            <select
              value={activeDay ?? ""}
              disabled={busy}
              onChange={(event) => setSelectedDay(event.target.value)}
            >
              {days.map((day) => (
                <option key={day} value={day}>
                  {labelForDay(day)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {isBoardView && tracks.length ? (
          <label className="agenda-inline-field">
            Track
            <select
              aria-label="Track for new placements"
              value={newTrackId}
              disabled={busy}
              onChange={(event) => setTrackForNew(event.target.value)}
            >
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="spacer" />
        {/* The zone is stated on the board itself, not only in a card hint: every time
            on this screen is a wall-clock time and the reader has to know whose. */}
        <span className="agenda-timezone">
          <IconClock size={13} />
          <span className="visually-hidden">Times are shown in </span>
          {zoneLabel}
        </span>
        <span className="agenda-count">
          {draft.sessions.length - unscheduledCount} of {draft.sessions.length} scheduled
        </span>
        {/* Wherever the rail cannot carry the selection — the Conflicts view has no rail, and
            a search that matches nothing leaves no group control to put Clear beside — the
            toolbar carries it instead. Exactly one of the two is ever on screen, so there are
            never two controls with the same name and different homes. */}
        {selection.count && (view === "conflicts" || !unscheduled.length) ? (
          <button
            type="button"
            className="secondary small"
            disabled={busy}
            onClick={() => {
              selection.clear();
              /*
               * This control leaves with the selection it cleared, so focus is handed on rather
               * than dropped — and not to the action beside it. Clearing turns that action back
               * into "Generate draft", so parking focus there would leave a whole-board pass one
               * space bar away from an operator who had just been narrowing one.
               *
               * Where it goes depends on why this hatch is here. With the rail emptied by a
               * search, the search box is where the operator was. In the Conflicts view there is
               * no rail at all and that box filters something off screen, so the conflicts panel
               * takes it. Recovery only, as everywhere else: on a platform where clicking a
               * button never focused it, nothing was dropped and nothing should be taken.
               */
              setPendingFocus({
                id: view === "conflicts" ? `panel-${view}` : "agenda-search",
                onlyIfDropped: true,
              });
            }}
          >
            Clear selection
          </button>
        ) : null}
        {/* Sits before Publish because that is the order the work happens in: fill the board,
            look at it, then commit it. Disabled with nothing to place so the control never
            promises an action that would do nothing, and named for what it will actually do:
            the whole board, or exactly the sessions ticked in the rail. */}
        <button
          id="agenda-assisted-action"
          type="button"
          className="secondary"
          disabled={busy || !unscheduledCount}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; `act` reports both outcomes.
            void generateDraft();
          }}
        >
          <IconCalendar size={15} />
          {selection.count ? `Place ${selection.count} selected` : "Generate draft"}
        </button>
        <button
          type="button"
          disabled={busy || draft.conflicts.length > 0}
          // A disabled control cannot be focused, so the reason it is disabled is
          // attached to it rather than left as a panel the reader has to hunt for.
          aria-describedby={draft.conflicts.length ? "agenda-conflict-summary" : undefined}
          onClick={() => {
            setBusy(true);
            // ERROR-INTENT: React event handlers cannot await; publication is rendered below.
            void publishAgenda(eventId)
              .then((schedule) => {
                if (mounted.current)
                  feedback.announce("success", `Published version ${schedule.version}`);
              })
              .catch((error: unknown) => {
                // A refused publication is news about this button, and the live region
                // sits directly under it.
                if (mounted.current)
                  feedback.announce(
                    "error",
                    error instanceof Error ? error.message : "Publication failed.",
                  );
              })
              .finally(() => {
                if (mounted.current) setBusy(false);
              });
          }}
        >
          <IconCheck size={15} />
          Publish schedule
        </button>
      </div>

      {feedback.node}

      {carry?.viaKeyboard ? (
        <div className="agenda-carry">
          <IconGrip size={15} />
          <span>
            Holding <strong>{carry.title}</strong>. Arrow keys choose a slot, Enter places it,
            Escape cancels.
          </span>
          <span className="carry-actions">
            {carry.placementId ? (
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() => {
                  const placement = carry.placementId ? placementOf(carry.placementId) : undefined;
                  if (placement) unschedule(placement);
                }}
              >
                Unschedule
              </button>
            ) : null}
            <button type="button" className="secondary small" onClick={cancelCarry}>
              Cancel
            </button>
          </span>
        </div>
      ) : null}

      {draft.conflicts.length ? (
        <div
          id="agenda-conflict-summary"
          className="notice warn agenda-conflict-summary"
          role="alert"
        >
          <strong>{conflictPublicationSummary(draft.conflicts.length)}</strong>
          <ul>
            {draft.conflicts.map((conflict) => (
              <li
                key={`${conflict.kind}-${conflict.placementId}-${conflict.conflictingPlacementId}-${conflict.resourceId}`}
              >
                {CONFLICT_LABELS[conflict.kind]} — {explain(conflict)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Notice tone="success">No conflicts. This draft is ready to publish.</Notice>
      )}

      {/* The rail earns a side column only while it holds sessions beside a board view.
          List view keeps the full width for its table and stacks a non-empty rail below. */}
      <div
        className="agenda-layout"
        data-rail={unscheduledCount > 0 && view !== "conflicts" && view !== "list"}
      >
        <div
          className="agenda-panel"
          id={`panel-${view}`}
          role="tabpanel"
          aria-labelledby={`tab-${view}`}
          tabIndex={-1}
        >
          <Card labelledBy="agenda-board" title={VIEW_TITLES[view]} hint={boardHint} tight>
            <div className={isBoardView || view === "track" ? "card-body" : ""}>{renderView()}</div>
          </Card>
        </div>

        {view === "conflicts" || !unscheduledCount ? null : (
          <UnscheduledRail
            sessions={unscheduled}
            selection={selection}
            unplaced={unplaced}
            heldSessionId={carry?.placementId === null ? carry.sessionId : null}
            busy={busy}
            trackId={newTrackId}
            searching={Boolean(needle)}
            over={overCell === "rail"}
            // Read from the ref rather than from state: a native drag fires faster than
            // React re-renders, so what is being carried is only reliable there.
            accepts={() => Boolean(carried.current?.placementId)}
            onOver={(isOver) =>
              setOverCell((current) => (isOver ? "rail" : current === "rail" ? null : current))
            }
            onDropHere={() => {
              const held = carried.current?.placementId;
              const placement = held ? placementOf(held) : undefined;
              if (placement) unschedule(placement);
            }}
            onPickUp={pickUp}
            onCancelCarry={cancelCarry}
            onSourceKeys={onSourceKeys}
            onStartDrag={startDrag}
            onDragEnd={() => {
              setCarry(null);
              setOverCell(null);
            }}
          />
        )}
      </div>

      <details className="agenda-resources">
        <summary>Manage rooms, tracks, and times</summary>
        <h3>Rooms</h3>
        {draft.rooms.map((room) => {
          const note = inUseNote(
            draft.placements.filter((placement) => placement.roomId === room.id).length,
            "room",
          );
          const error = rowErrors[room.id];
          return (
            <div className="resource-row" key={room.id}>
              <span className="name">{room.name}</span>
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  const name = window.prompt("Room name", room.name);
                  if (name?.trim())
                    // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                    void saveResources(
                      {
                        rooms: draft.rooms.map((item) =>
                          item.id === room.id ? { ...item, name: name.trim() } : item,
                        ),
                        tracks: draft.tracks,
                        slots: draft.slots,
                      },
                      "Room renamed.",
                      room.id,
                    );
                }}
              >
                Rename
              </button>
              {/* The note says why this will be refused, but the button stays live: this
                  view can be a few seconds old, and only the API knows what is placed
                  right now. Its refusal lands under the toolbar and in this row. */}
              <button
                type="button"
                className="secondary small"
                aria-describedby={note ? `agenda-room-note-${room.id}` : undefined}
                onClick={() =>
                  // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                  void saveResources(
                    {
                      rooms: draft.rooms.filter(({ id }) => id !== room.id),
                      tracks: draft.tracks,
                      slots: draft.slots,
                    },
                    "Room removed.",
                    room.id,
                  )
                }
              >
                Remove
              </button>
              {note ? (
                <p className="resource-note" id={`agenda-room-note-${room.id}`}>
                  {note}
                </p>
              ) : null}
              {error ? (
                <p className="error-text" id={`agenda-room-error-${room.id}`}>
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="secondary small"
          onClick={() =>
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources(
              {
                rooms: [
                  ...draft.rooms,
                  {
                    id: crypto.randomUUID(),
                    name: `Room ${draft.rooms.length + 1}`,
                  },
                ],
                tracks: draft.tracks,
                slots: draft.slots,
              },
              "Room added.",
            )
          }
        >
          <IconPlus size={13} />
          Add room
        </button>
        <h3>Tracks</h3>
        {draft.tracks.map((track) => {
          const note = inUseNote(
            draft.placements.filter((placement) => placement.trackId === track.id).length,
            "track",
          );
          const error = rowErrors[track.id];
          return (
            <div className="resource-row" key={track.id}>
              <span className="name">
                <span className="agenda-track-swatch" style={{ background: track.color }} />
                {track.name}
              </span>
              <button
                type="button"
                className="secondary small"
                onClick={() => {
                  const name = window.prompt("Track name", track.name);
                  if (name?.trim())
                    // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                    void saveResources(
                      {
                        rooms: draft.rooms,
                        tracks: draft.tracks.map((item) =>
                          item.id === track.id ? { ...item, name: name.trim() } : item,
                        ),
                        slots: draft.slots,
                      },
                      "Track renamed.",
                      track.id,
                    );
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="secondary small"
                aria-describedby={note ? `agenda-track-note-${track.id}` : undefined}
                onClick={() =>
                  // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                  void saveResources(
                    {
                      rooms: draft.rooms,
                      tracks: draft.tracks.filter(({ id }) => id !== track.id),
                      slots: draft.slots,
                    },
                    "Track removed.",
                    track.id,
                  )
                }
              >
                Remove
              </button>
              {note ? (
                <p className="resource-note" id={`agenda-track-note-${track.id}`}>
                  {note}
                </p>
              ) : null}
              {error ? (
                <p className="error-text" id={`agenda-track-error-${track.id}`}>
                  {error}
                </p>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="secondary small"
          onClick={() =>
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources(
              {
                rooms: draft.rooms,
                tracks: [
                  ...draft.tracks,
                  {
                    id: crypto.randomUUID(),
                    name: `Track ${draft.tracks.length + 1}`,
                    color: DEFAULT_TRACK_COLOR,
                  },
                ],
                slots: draft.slots,
              },
              "Track added.",
            )
          }
        >
          <IconPlus size={13} />
          Add track
        </button>
        <h3>Timeslots</h3>
        <p className="hint">Start and end are entered on the event's clock: {zoneLabel}.</p>
        {allSlots.map((slot) => {
          const saved = slotInputs(slot);
          const form = slotForms[slot.id] ?? saved;
          const error = rowErrors[slot.id];
          const note = inUseNote(
            draft.placements.filter((placement) => placement.slotId === slot.id).length,
            "time slot",
          );
          const changed = form.start !== saved.start || form.end !== saved.end;
          // The row is named by what it currently *holds*, so every control inside it
          // says which timeslot it belongs to without repeating a visible label.
          const belongsTo = `${clock.dayLabel(slot.startsAt)} ${slotRange(slot)}`;
          return (
            <form
              className="resource-row slot-row"
              key={slot.id}
              aria-label={`Timeslot ${belongsTo}`}
              onSubmit={(submitted) => {
                submitted.preventDefault();
                const times = readSlotForm(slot.id, form);
                if (!times) return;
                // ERROR-INTENT: React event handlers cannot await; saveSlots renders both outcomes.
                void saveSlots(
                  draft.slots.map((item) => (item.id === slot.id ? { ...item, ...times } : item)),
                  "Timeslot updated.",
                  slot.id,
                );
              }}
            >
              <div className="field">
                <label htmlFor={`agenda-slot-start-${slot.id}`}>
                  Start<span className="visually-hidden"> of {belongsTo}</span>
                </label>
                <input
                  id={`agenda-slot-start-${slot.id}`}
                  type="datetime-local"
                  value={form.start}
                  disabled={busy}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `agenda-slot-error-${slot.id}` : undefined}
                  onChange={(changedInput) =>
                    editSlotForm(slot.id, saved, {
                      start: changedInput.target.value,
                    })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor={`agenda-slot-end-${slot.id}`}>
                  End<span className="visually-hidden"> of {belongsTo}</span>
                </label>
                <input
                  id={`agenda-slot-end-${slot.id}`}
                  type="datetime-local"
                  value={form.end}
                  disabled={busy}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `agenda-slot-error-${slot.id}` : undefined}
                  onChange={(changedInput) =>
                    editSlotForm(slot.id, saved, {
                      end: changedInput.target.value,
                    })
                  }
                />
              </div>
              <button type="submit" className="secondary small" disabled={busy || !changed}>
                Save<span className="visually-hidden"> {belongsTo}</span>
              </button>
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                aria-describedby={note ? `agenda-slot-note-${slot.id}` : undefined}
                onClick={() =>
                  // ERROR-INTENT: React event handlers cannot await; saveSlots renders both outcomes.
                  void saveSlots(
                    draft.slots.filter(({ id }) => id !== slot.id),
                    "Timeslot removed.",
                    slot.id,
                  )
                }
              >
                Remove<span className="visually-hidden"> {belongsTo}</span>
              </button>
              {note ? (
                <p className="resource-note" id={`agenda-slot-note-${slot.id}`}>
                  {note}
                </p>
              ) : null}
              {error ? (
                <p className="error-text" id={`agenda-slot-error-${slot.id}`}>
                  {error}
                </p>
              ) : null}
            </form>
          );
        })}
        <form
          className="resource-row slot-row slot-new"
          aria-label="Add a timeslot"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            const times = readSlotForm(NEW_SLOT, newSlotForm);
            if (!times) return;
            const created = { id: crypto.randomUUID(), ...times };
            // ERROR-INTENT: React event handlers cannot await; saveSlots renders both outcomes.
            void saveSlots([...draft.slots, created], "Timeslot added.", NEW_SLOT, [
              ...draft.slots.map(({ id }) => id),
              NEW_SLOT,
            ]);
          }}
        >
          <div className="field">
            <label htmlFor="agenda-new-slot-start">New timeslot start</label>
            <input
              id="agenda-new-slot-start"
              type="datetime-local"
              value={newSlotForm.start}
              disabled={busy}
              aria-invalid={rowErrors[NEW_SLOT] ? true : undefined}
              aria-describedby={rowErrors[NEW_SLOT] ? "agenda-new-slot-error" : undefined}
              onChange={(changedInput) =>
                editSlotForm(NEW_SLOT, newSlotForm, {
                  start: changedInput.target.value,
                })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="agenda-new-slot-end">New timeslot end</label>
            <input
              id="agenda-new-slot-end"
              type="datetime-local"
              value={newSlotForm.end}
              disabled={busy}
              aria-invalid={rowErrors[NEW_SLOT] ? true : undefined}
              aria-describedby={rowErrors[NEW_SLOT] ? "agenda-new-slot-error" : undefined}
              onChange={(changedInput) =>
                editSlotForm(NEW_SLOT, newSlotForm, {
                  end: changedInput.target.value,
                })
              }
            />
          </div>
          <button type="submit" className="secondary small" disabled={busy}>
            <IconPlus size={13} />
            Add timeslot
          </button>
          {rowErrors[NEW_SLOT] ? (
            <p className="error-text" id="agenda-new-slot-error">
              {rowErrors[NEW_SLOT]}
            </p>
          ) : null}
        </form>
      </details>
    </div>
  );
}
