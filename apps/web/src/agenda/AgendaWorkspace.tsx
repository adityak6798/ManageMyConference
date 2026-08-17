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
 * The board is the page. Above it there is one tab row and one 40px bar; everything else
 * an organizer might want — the rooms, the tracks, the times — is a drawer they open, and
 * the two things they came to press are in the page's action row. Seven stacked strips used
 * to sit between the tabs and the grid: a filter toolbar, a day switcher, a standing
 * publication rule, a permanent green "no conflicts" notice, a card titlebar repeating the
 * name of the view already selected in the tabs, and the drag instructions, re-rendered on
 * every keystroke. A scheduler forgives a plain control they can reach; they do not forgive
 * a grid they cannot see.
 *
 * The grid freezes both axes. The time column is the board's cue gutter — the product's
 * measure column, here carrying each row's start time in mono with its duration beneath —
 * and it is sticky, as the room headings are, so neither the question "when" nor the
 * question "where" scrolls off while the other is being read.
 *
 * Conflict detection stays in the API (`agenda.conflicts`); this file only makes the
 * conflicts it returns impossible to miss, in every view rather than in one panel — as one
 * line above the grid that links to the view holding the inventory, rather than as the
 * inventory itself re-announced after every drop.
 *
 * Slots are stored as instants and rendered in the *event's* timezone: an organizer
 * scheduling a Los Angeles conference reads Los Angeles clock times, and a 21:00 local
 * session belongs to its local day even when that instant is already tomorrow in UTC.
 * That makes the day buckets — not only the labels — a function of the event zone, so
 * the formatters are per-render values derived from the event rather than constants.
 *
 * Timeslots are also *written* on that clock, as a day and two times of day rather than as
 * two datetimes: a three-day, eight-slot event used to cost 48 hand-typed datetimes, and it
 * now costs one "generate slots" run and two copies.
 *
 * Every outcome lands where the action was taken. Success and failure share one live
 * region under the board bar, and anything about a single room, track, or timeslot is
 * repeated inside that row. The parent's `onError` is reserved for a failure to *load*,
 * which is the only failure that leaves no workspace to report it in.
 */

import type { ContentWorkspaceDto, EventDto } from "@greenroom/contracts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AgendaApiError,
  autoPlaceSessions,
  getAgenda,
  publishAgenda,
  removePlacement,
  saveAgendaResources,
  savePlacement,
} from "../api/agenda";
import type { ApiFailure } from "../api/config";
import { getContent } from "../api/content";
import "../styles/agenda.css";
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconGrip,
  IconPlus,
  IconSliders,
  IconWarning,
} from "../ui/icons";
import {
  Card,
  Drawer,
  EmptyState,
  Notice,
  Pill,
  SkeletonRows,
  Tabs,
  useActionFeedback,
} from "../ui/primitives";
import {
  addDays,
  byInstant,
  byStart,
  type Carry,
  type Cell,
  CONFLICT_LABELS,
  type Conflict,
  cellKey,
  clockFor,
  conflictPublicationSummary,
  DEFAULT_TRACK_COLOR,
  type Draft,
  durationLabel,
  errorsByRow,
  HOUR_MS,
  inUseNote,
  isViewId,
  NEW_SLOT,
  nextTrackColor,
  type Placement,
  planSlotRun,
  readViewFromUrl,
  type Slot,
  type SlotForm,
  type SlotRunForm,
  TRACK_COLORS,
  trackColorName,
  VIEW_LABELS,
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
    // A board being composed in the browser has no history yet; the server allocates these on the
    // first write and every later read carries the server's numbers.
    occurrences: { sessions: {}, slots: {} },
    conflicts: [],
  };
}

/** What was published from this screen, and the board it was published from. */
type Publication = {
  readonly version: number;
  readonly at: number;
  /** The board's occurrence numbers at that moment, so later edits can be counted. */
  readonly occurrences: Draft["occurrences"];
};

/** How many parts of the board have moved since a publication froze it. */
function changesSince(before: Draft["occurrences"], now: Draft["occurrences"]): number {
  let moved = 0;
  for (const part of ["sessions", "slots"] as const) {
    const keys = new Set([...Object.keys(before[part]), ...Object.keys(now[part])]);
    for (const key of keys) if (before[part][key] !== now[part][key]) moved += 1;
  }
  return moved;
}

/** How long ago something happened, in the coarsest unit that is still true. */
function sinceLabel(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
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
  belowBoard,
}: {
  event: EventDto;
  onError: (message: string) => void;
  /**
   * Anything the workspace wants rendered under the board, given the board's own announcer.
   *
   * A render prop rather than an import, because the board should not know what the agenda
   * domain chooses to put beneath it — but it does own the page's one live region, and a panel
   * whose outcomes are board changes has to announce where board changes announce.
   */
  belowBoard?: (
    announce: (tone: "success" | "error", detail: string | ApiFailure) => void,
  ) => ReactNode;
}) {
  const eventId = event.id;
  // Keyed on the zone rather than the whole event: the same formatters survive the many
  // re-renders of a drag, and a switch to an event in another zone rebuilds them.
  const clock = useMemo(() => clockFor(event.timezone), [event.timezone]);
  const [agenda, setAgenda] = useState<Draft | null>(null);
  const [contentSessions, setContentSessions] = useState<ContentWorkspaceDto["sessions"] | null>(
    null,
  );
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewId>(readViewFromUrl);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [trackForNew, setTrackForNew] = useState<string | null>(null);
  /** The rooms, tracks and times drawer, opened from the board bar and from the empty board. */
  const [resourcesOpen, setResourcesOpen] = useState(false);
  /** Publication is the one irreversible thing here, so it is confirmed with its own preview. */
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  /**
   * What this screen has published, kept rather than announced and forgotten.
   *
   * The only record of what was live used to be a toast that cleared itself after six seconds.
   * There is no read for the current publication yet, so this states what is *known*: nothing
   * until the first publish, and after that the version, when it happened, and how many parts of
   * the board have moved since.
   */
  const [publication, setPublication] = useState<Publication | null>(null);
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
  /** Which grid cell holds the board's single tab stop. See `renderCell`. */
  const [focusedCell, setFocusedCell] = useState<string | null>(null);
  /** Where focus goes after the next render, and whether it may take it from someone. */
  const [pendingFocus, setPendingFocus] = useState<{
    readonly id: string;
    readonly onlyIfDropped?: boolean | undefined;
  } | null>(null);
  // Typed-but-unsaved timeslot rows, keyed by slot id (and `NEW_SLOT` for the one that
  // has no id yet). A row with no entry here simply shows what the server holds.
  const [slotForms, setSlotForms] = useState<Record<string, SlotForm>>({});
  /** Typed-but-unsaved room and track names, keyed by id. Escape drops the entry. */
  const [nameForms, setNameForms] = useState<Record<string, string>>({});
  const [newRoomName, setNewRoomName] = useState("");
  const [newTrackName, setNewTrackName] = useState("");
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
    setContentSessions(null);
    setMissing(false);
    // Half-typed times belong to the event they were typed for, never to the next one.
    setSlotForms({});
    setNameForms({});
    setRowErrors({});
    // What this screen published belongs to the event it published, not to the next one.
    setPublication(null);
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
    // Publication readiness belongs to Content and is read through its public HTTP projection.
    // It is supplementary preflight information: an unavailable Content read must not make the
    // independently owned agenda board unusable.
    // ERROR-INTENT: React effects cannot await; this optional readiness read is handled below.
    void getContent(eventId)
      .then((loaded) => {
        if (active) setContentSessions(loaded.sessions);
      })
      // ERROR-INTENT: the publication preflight is supplementary; the board stays usable without it.
      .catch(() => {
        if (active) setContentSessions(null);
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

  /*
   * The board's own chrome while the board is still arriving.
   *
   * "Loading agenda…" was one line of text where a grid was about to be, so the page jumped by
   * its whole height on arrival. This is the shape that arrives: a bar, a grid, a rail.
   */
  if (!agenda)
    return (
      <div className="agenda">
        <div className="agenda-bar is-loading" aria-hidden="true">
          <span className="skeleton" style={{ width: 180, height: 20 }} />
          <span className="spacer" />
          <span className="skeleton" style={{ width: 120, height: 20 }} />
        </div>
        <div className="agenda-layout" data-rail="true">
          <div className="agenda-panel">
            <SkeletonRows rows={6} label="Loading the run sheet" />
          </div>
          <aside className="agenda-rail" aria-hidden="true">
            <div className="agenda-rail-skeleton">
              {[0, 1, 2].map((row) => (
                <span className="skeleton" key={row} style={{ height: 44 }} />
              ))}
            </div>
          </aside>
        </div>
      </div>
    );

  // One non-null binding keeps every render helper below free of null checks.
  const draft = agenda;
  const rooms = draft.rooms;
  const tracks = draft.tracks;
  const slotRange = (slot: Slot) => `${clock.hhmm(slot.startsAt)}–${clock.hhmm(slot.endsAt)}`;
  const allSlots = [...draft.slots].sort(byStart);
  /*
   * Each slot's day and time-of-day range, read once (`DEBT-009`).
   *
   * Both are `Intl.formatToParts` calls — `dayKey` costs three of them — and both used to be made
   * from inside the week board's nested day × time loop, once per slot per cell, on every render
   * of a drag. Reading them here makes the board's cost linear in slots and leaves the loops
   * doing map lookups.
   */
  const slotDays = new Map(allSlots.map((slot) => [slot.id, clock.dayKey(slot.startsAt)]));
  // Every caller iterates `allSlots`, which is what the index was built from, so a miss is not
  // reachable. `?? ""` rather than a recomputation, because a fallback that silently produced a
  // different answer would be worse than an obviously empty bucket.
  const dayOf = (slot: Slot) => slotDays.get(slot.id) ?? "";
  // Day buckets are the *event's* calendar days. A 21:00 local slot stays on its local
  // day even when that instant already belongs to tomorrow in UTC, so the Day, Week,
  // Room and Track views group the way the organizer's own programme reads.
  const days = [...new Set(slotDays.values())].sort();
  // Each key is labelled from a real instant on that day, so no synthetic midday
  // timestamp has to be invented and no zone offset is assumed.
  const dayLabels = new Map(allSlots.map((slot) => [dayOf(slot), clock.dayLabel(slot.startsAt)]));
  const labelForDay = (day: string) => dayLabels.get(day) ?? day;
  const activeDay = selectedDay && days.includes(selectedDay) ? selectedDay : (days[0] ?? null);
  const daySlots = allSlots.filter((slot) => dayOf(slot) === activeDay);
  const newTrackId = trackForNew ?? tracks[0]?.id ?? "";
  /*
   * The zone's abbreviation, read at an instant the board actually shows (`DEBT-008`).
   *
   * DST makes it date-dependent, so it can only be read from a slot. An empty board therefore
   * gets **no abbreviation at all**, where it used to fall back to `new Date()` and label the
   * conference with today's DST state — "PDT" for a January event configured in the winter half,
   * stated as confidently as a real reading. The event record carries no dates of its own
   * (`EventDto` is id, organization, name, timezone and creation time), so there is no honest
   * instant to substitute: with no slots the board shows no time, and the zone's IANA name alone
   * is the whole of what is known.
   */
  const zoneAbbreviation = allSlots[0] ? clock.abbreviation(allSlots[0].startsAt) : "";
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
  const matchesQuery = (sessionId: string) =>
    !needle || sessionTitle(sessionId).toLowerCase().includes(needle);
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
    (session) => selectable.has(session.id) && matchesQuery(session.id),
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
  /*
   * How many placed cards the search box is pointing at.
   *
   * The box used to filter the rail and the List view only, so on the default Room board typing
   * a title changed nothing visible at all, and on Conflicts — which has no rail — it filtered
   * nothing whatsoever. It now rings the matching cards and fades the rest, and this is the
   * number that says the ring is somewhere off screen.
   */
  const boardMatches = needle
    ? draft.placements.filter((placement) => matchesQuery(placement.sessionId)).length
    : 0;
  const scheduledSessionsByDay = new Map<string, Set<string>>();
  for (const placement of draft.placements) {
    const slot = slotOf(placement.slotId);
    if (!slot) continue;
    const day = dayOf(slot);
    const scheduled = scheduledSessionsByDay.get(day) ?? new Set<string>();
    scheduled.add(placement.sessionId);
    scheduledSessionsByDay.set(day, scheduled);
  }
  const scheduledSessionIds = new Set(draft.placements.map(({ sessionId }) => sessionId));
  const contentSessionById = new Map(
    (contentSessions ?? []).map((session) => [session.id, session]),
  );
  // A successful Content response is not necessarily a complete readiness response. Field-level
  // access may redact publicationState, and row policy may omit a scheduled session altogether.
  // In either case a numeric public count would turn "unknown" into a confidently wrong zero.
  const publicationPreflightAvailable =
    contentSessions !== null &&
    [...scheduledSessionIds].every(
      (sessionId) => contentSessionById.get(sessionId)?.publicationState !== undefined,
    );
  const withheldSessions = (contentSessions ?? []).filter(
    (session) =>
      scheduledSessionIds.has(session.id) &&
      session.publicationState !== undefined &&
      session.publicationState !== "published",
  );
  const publicReadyCount = (contentSessions ?? []).filter(
    (session) => scheduledSessionIds.has(session.id) && session.publicationState === "published",
  ).length;
  const sessionsParams = new URLSearchParams(window.location.search);
  sessionsParams.set("tab", "sessions");
  sessionsParams.delete("view");
  const sessionsHref = `${window.location.pathname}?${sessionsParams.toString()}`;

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
  /*
   * The board's single tab stop.
   *
   * The grid used to be reachable only while something was being carried: at rest there was
   * nothing in it a Tab could land on, so a keyboard user could place into the board but never
   * read it. One cell holds `tabindex="0"` and the arrow keys move it, which is the composite
   * pattern — Tab reaches the grid once, and the grid is then walked rather than tabbed through.
   */
  const tabbableCell =
    boardCells.find((cell) => cell.key === focusedCell)?.key ?? boardCells[0]?.key ?? null;

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
   * always reaches the live region under the board bar — the same place the success would
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
      // it announces under the board bar and is repeated in that row.
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

  /**
   * The instants one day/start/end row means, or null once the reason it means none has been
   * shown.
   *
   * An end at or before the start is read as the next morning, but only when that makes a slot
   * short enough to be one: 22:00–01:00 is what a scheduler means by an overnight session and it
   * round-trips back into these three inputs unchanged, while 11:00–10:00 is a typo and reading
   * it as a 23-hour slot would be worse than refusing it.
   */
  function readSlotForm(key: string, form: SlotForm) {
    const startsAt = clock.toInstant(`${form.day}T${form.start}`);
    const sameDayEnd = clock.toInstant(`${form.day}T${form.end}`);
    if (!startsAt || !sameDayEnd)
      return refuseSlot(key, "Enter a day, a start time and an end time.");
    if (Date.parse(sameDayEnd) > Date.parse(startsAt)) return { startsAt, endsAt: sameDayEnd };
    const overnight = clock.toInstant(`${addDays(form.day, 1)}T${form.end}`);
    const runs = overnight ? Date.parse(overnight) - Date.parse(startsAt) : 0;
    if (!overnight || runs <= 0 || runs > 12 * HOUR_MS)
      return refuseSlot(key, "End must be after start.");
    return { startsAt, endsAt: overnight };
  }

  const slotInputs = (slot: Pick<Slot, "startsAt" | "endsAt">): SlotForm => ({
    day: clock.dayKey(slot.startsAt),
    start: clock.hhmm(slot.startsAt),
    end: clock.hhmm(slot.endsAt),
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
  const suggestedSlot = slotInputs({
    startsAt: suggestedStart,
    endsAt: new Date(Date.parse(suggestedStart) + HOUR_MS).toISOString(),
  });
  const newSlotForm = slotForms[NEW_SLOT] ?? suggestedSlot;

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
      if (target) {
        setFocusedCell(target);
        setPendingFocus({ id: `agenda-cell-${target}` });
      }
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

  function onCellKeys(event: React.KeyboardEvent, cell: Cell) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelCarry();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const held = carry;
      if (!held || busy) return;
      event.preventDefault();
      place(held, cell.roomId, cell.slotId);
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
    const index = boardCells.findIndex((candidate) => candidate.key === cell.key);
    if (index < 0) return;
    const next = boardCells[Math.min(boardCells.length - 1, Math.max(0, index + delta))];
    if (!next) return;
    setFocusedCell(next.key);
    document.getElementById(`agenda-cell-${next.key}`)?.focus();
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

  /** Whether the search box is pointing at this session, and whether it is pointing elsewhere. */
  function searchState(sessionId: string) {
    if (!needle) return {};
    return matchesQuery(sessionId) ? { "data-match": "true" } : { "data-dim": "true" };
  }

  /** A placed session: one target for both pointer drags and keyboard pick-up. */
  function renderCard(placement: Placement) {
    const title = sessionTitle(placement.sessionId);
    const slot = slotOf(placement.slotId);
    const track = trackOf(placement.trackId);
    const placementConflicts = conflictsByPlacement.get(placement.id) ?? [];
    const kinds = [...new Set(placementConflicts.map(({ kind }) => CONFLICT_LABELS[kind]))];
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
        {...searchState(placement.sessionId)}
        style={track ? { borderLeftColor: track.color } : undefined}
        aria-label={`${title}. ${roomName(placement.roomId)}, ${slot ? slotRange(slot) : "no time"}${
          track ? `, ${track.name} track` : ""
        }.${kinds.length ? ` In conflict: ${kinds.join(", ")}.` : ""} ${
          held ? "Press Enter to cancel the move." : "Press Enter to pick this session up."
        }`}
        onDragStart={(event) => startDrag(event, carryFor(placement, false))}
        onDragEnd={() => {
          setCarry(null);
          setOverCell(null);
        }}
        // The cell this card sits in is itself the drop target, so a press on the card must not
        // reach it: picking a session up and immediately dropping it back where it was is not
        // what "Enter" on a card means.
        onKeyDown={(pressed) => {
          if (pressed.key === "Enter" || pressed.key === " ") pressed.stopPropagation();
          onSourceKeys(pressed);
        }}
        onClick={(pressed) => {
          pressed.stopPropagation();
          if (held) cancelCarry();
          else pickUp(carryFor(placement, true), placement);
        }}
      >
        <span className="sched-title">{title}</span>
        <span className="sched-meta">
          {track ? (
            <>
              <span className="track-dot" style={{ background: track.color }} />
              {track.name}
            </>
          ) : null}
          {/* The duration is the line the per-card drag instruction used to occupy. It is a
              measure, so it sets in the mono figure face like every other one on this board. */}
          {slot ? (
            <span className="figure">{durationLabel(slot.startsAt, slot.endsAt)}</span>
          ) : null}
          {kinds.length ? (
            <Pill tone="danger">
              <IconWarning size={11} />
              {kinds.join(", ")}
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
        {...searchState(placement.sessionId)}
        style={track ? { borderLeftColor: track.color } : undefined}
      >
        <span className="sched-title">{sessionTitle(placement.sessionId)}</span>
        <span className="sched-meta">
          {withRoom ? <span>{roomName(placement.roomId)}</span> : null}
          {slot ? <span className="figure">{slotRange(slot)}</span> : null}
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

  const cellOf = (roomId: string, slotId: string): Cell => ({
    key: cellKey(roomId, slotId),
    roomId,
    slotId,
  });

  /**
   * One drop target: the cell itself, rather than a strip inside it.
   *
   * `data-over` used to sit on an auto-height `div` inside this cell, so the drag-over highlight
   * on an empty cell was an 18px band in the top-left corner of a 170×80px target — the
   * affordance misreported where the drop would land. The `<td>` owns the drop handlers, so the
   * `<td>` is what states it, as an inset ring over the whole area that will actually accept it.
   */
  function renderCell(cell: Cell) {
    const { key, roomId, slotId } = cell;
    const slot = slotOf(slotId);
    const inCell = draft.placements.filter(
      (placement) => placement.roomId === roomId && placement.slotId === slotId,
    );
    const when = slot ? slotRange(slot) : "this time";
    const holds = inCell.length
      ? `. Holds ${inCell.length} session${inCell.length === 1 ? "" : "s"}`
      : ". Empty";
    return (
      <td
        key={key}
        id={`agenda-cell-${key}`}
        // A focusable board cell is a WAI-ARIA gridcell; the composite pattern is what makes the
        // grid readable with the keyboard at rest, not only while something is being carried.
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: see above.
        role="gridcell"
        className="board-cell"
        tabIndex={key === tabbableCell ? 0 : -1}
        aria-label={
          carry
            ? `Place “${carry.title}” in ${roomName(roomId)} at ${when}${holds}`
            : `${roomName(roomId)}, ${when}${holds}`
        }
        data-over={overCell === key ? "true" : undefined}
        data-empty={inCell.length ? undefined : "true"}
        data-holding={carry ? "true" : undefined}
        onFocus={() => setFocusedCell(key)}
        onKeyDown={(event) => onCellKeys(event, cell)}
        onClick={() => {
          const held = carried.current;
          if (held && !busy) place(held, roomId, slotId);
        }}
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
        {inCell.map((placement) => renderCard(placement))}
        {/* The empty cell's affordance is the whole cell, revealed on hover, focus or carry —
            not an em dash in its top-left corner, of which a full board drew up to 96. */}
        {inCell.length === 0 ? (
          <span className="board-drop" aria-hidden="true">
            <IconPlus size={16} />
          </span>
        ) : null}
      </td>
    );
  }

  /** The board's cue gutter: the start time, with the duration it runs for beneath it. */
  function renderTimeHeader(slot: Slot) {
    return (
      <th scope="row" className="gutter board-time" key={slot.id}>
        <span className="visually-hidden">{slotRange(slot)}</span>
        <span aria-hidden="true" className="figure">
          {clock.hhmm(slot.startsAt)}
        </span>
        <span aria-hidden="true" className="board-duration">
          {durationLabel(slot.startsAt, slot.endsAt)}
        </span>
      </th>
    );
  }

  function renderBoardEmpty() {
    return (
      <EmptyState
        title="The board needs rooms and time slots"
        icon={<IconCalendar size={20} />}
        action={
          <button type="button" className="primary" onClick={() => setResourcesOpen(true)}>
            Set up rooms and times
          </button>
        }
      >
        A grid needs at least one room and one time slot before anything can be placed on it.
      </EmptyState>
    );
  }

  function renderRoomBoard() {
    if (!rooms.length || !daySlots.length) return renderBoardEmpty();
    return (
      <div className="agenda-board-wrap">
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an editable schedule
            is a grid in ARIA terms — its cells are the drop targets and the arrow keys walk
            them — and a table is the element whose row and column headings say so. */}
        <table className="data board" role="grid">
          <caption className="visually-hidden">
            Rooms across the top, time slots down the side, for{" "}
            {activeDay ? labelForDay(activeDay) : "the event"}, in {zoneLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="gutter board-time">
                Time
              </th>
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
                {renderTimeHeader(slot)}
                {rooms.map((room) => renderCell(cellOf(room.id, slot.id)))}
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
      <div className="agenda-board-wrap">
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an editable schedule
            is a grid in ARIA terms — its cells are the drop targets and the arrow keys walk
            them — and a table is the element whose row and column headings say so. */}
        <table className="data board" role="grid">
          <caption className="visually-hidden">
            One column per time slot on {activeDay ? labelForDay(activeDay) : "the selected day"},
            in {zoneLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="board-room">
                Room
              </th>
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
                <th scope="row" className="board-room">
                  {room.name}
                </th>
                {daySlots.map((slot) => renderCell(cellOf(room.id, slot.id)))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderWeekBoard() {
    if (!allSlots.length) return renderBoardEmpty();
    /*
     * Every slot bucketed by (day, time of day), in one pass (`DEBT-009`).
     *
     * The cells below are the product of those two axes, and each one used to rescan every slot
     * — recomputing its calendar day and its range through `Intl` as it went — so the board cost
     * grew with the square of the slot count while a drag re-rendered it continuously. The rows
     * are read off the same pass, since they are exactly the distinct ranges.
     */
    const cells = new Map<string, string[]>();
    const ranges = new Map<string, Slot>();
    for (const slot of allSlots) {
      const range = slotRange(slot);
      if (!ranges.has(range)) ranges.set(range, slot);
      const key = `${dayOf(slot)}|${range}`;
      cells.set(key, [...(cells.get(key) ?? []), slot.id]);
    }
    // Slots repeat across days, so the rows are the distinct times of day.
    const timeRows = [...ranges.keys()].sort();
    return (
      <div className="agenda-board-wrap">
        <table className="data board">
          <caption className="visually-hidden">
            Days across the top, time slots down the side, in {zoneLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="gutter board-time">
                Time
              </th>
              {days.map((day) => (
                <th scope="col" key={day}>
                  {labelForDay(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {timeRows.map((range) => {
              const exemplar = ranges.get(range);
              return (
                <tr key={range}>
                  {exemplar ? (
                    renderTimeHeader(exemplar)
                  ) : (
                    <th scope="row" className="gutter board-time">
                      {range}
                    </th>
                  )}
                  {days.map((day) => {
                    const slotIds = new Set(cells.get(`${day}|${range}`) ?? []);
                    // Filtered from `placements` rather than gathered per slot, so the cards keep
                    // the board's own placement order where a cell holds more than one slot.
                    const inCell = draft.placements.filter((placement) =>
                      slotIds.has(placement.slotId),
                    );
                    return (
                      <td key={`${day}-${range}`} className="board-cell" data-static="true">
                        {inCell.map((placement) => renderStaticCard(placement, true))}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderTrackBoard() {
    if (!tracks.length)
      return (
        <EmptyState
          title="No tracks yet"
          icon={<IconCalendar size={20} />}
          action={
            <button type="button" className="primary" onClick={() => setResourcesOpen(true)}>
              Add a track
            </button>
          }
        >
          A track gives its sessions a colour, and that colour is the stripe every card on the board
          carries.
        </EmptyState>
      );
    return (
      <div className="agenda-tracks">
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
                <span className="figure">{inTrack.length}</span>
                <span className="visually-hidden">
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
                <p className="agenda-track-empty">Nothing scheduled on this track yet.</p>
              )}
            </section>
          );
        })}
      </div>
    );
  }

  function renderListView() {
    const rows = sortedPlacements.filter((placement) => matchesQuery(placement.sessionId));
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
              <th scope="col" className="gutter">
                Time
              </th>
              <th scope="col">Session</th>
              <th scope="col">Day</th>
              <th scope="col">Slot</th>
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
              // Every kind, not only the first: a card that is both double-booked on its room
              // and on its speaker used to report one of the two, so resolving that one left a
              // row that still said "Scheduled" while the board still refused to publish.
              const kinds = [...new Set(placementConflicts.map(({ kind }) => kind))];
              return (
                <tr key={placement.id}>
                  <td className="gutter" data-label="Time">
                    <span className="figure">{slot ? clock.hhmm(slot.startsAt) : "—"}</span>
                  </td>
                  <td className="primary-cell" data-label="Session">
                    {sessionTitle(placement.sessionId)}
                  </td>
                  <td data-label="Day">{slot ? clock.dayLabel(slot.startsAt) : "—"}</td>
                  <td data-label="Slot">
                    <select
                      className="control is-sm"
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
                  <td data-label="Room">
                    <select
                      className="control is-sm"
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
                  <td data-label="Track">
                    <select
                      className="control is-sm"
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
                  <td data-label="Status">
                    {kinds.length ? (
                      <span className="agenda-status-stack">
                        {kinds.map((kind) => (
                          <Pill tone="danger" key={kind}>
                            <IconWarning size={11} />
                            {CONFLICT_LABELS[kind]}
                          </Pill>
                        ))}
                      </span>
                    ) : (
                      <Pill tone="ok">Scheduled</Pill>
                    )}
                  </td>
                  <td data-label="Actions">
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
                  <td data-label="Conflict">
                    <Pill tone="danger">
                      <IconWarning size={11} />
                      {CONFLICT_LABELS[conflict.kind]}
                    </Pill>
                  </td>
                  <td className="primary-cell" data-label="Session">
                    {own ? sessionTitle(own.sessionId) : "Removed placement"}
                    {own ? (
                      <span className="sub">
                        {roomName(own.roomId)} · {ownSlot ? slotRange(ownSlot) : "no time"}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Clashes with">
                    {other ? sessionTitle(other.sessionId) : "—"}
                    {other ? (
                      <span className="sub">
                        {roomName(other.roomId)} · {otherSlot ? slotRange(otherSlot) : "no time"}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Why">{explain(conflict)}</td>
                  <td data-label="How to fix it">{conflict.message}</td>
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

  function publish() {
    setBusy(true);
    setConfirmingPublish(false);
    // ERROR-INTENT: React event handlers cannot await; publication is rendered below.
    void publishAgenda(eventId)
      .then((schedule) => {
        if (!mounted.current) return;
        setPublication({
          version: schedule.version,
          at: Date.now(),
          occurrences: draft.occurrences,
        });
        const withheld = publicationPreflightAvailable ? withheldSessions.length : 0;
        feedback.announce(
          "success",
          withheld
            ? `Published version ${schedule.version}. ${withheld} scheduled session${withheld === 1 ? " is" : "s are"} still off the public page because ${withheld === 1 ? "it is" : "they are"} not published.`
            : `Published version ${schedule.version}.`,
        );
      })
      .catch((error: unknown) => {
        // A refused publication is news about the action row, and the live region sits
        // directly under the board bar with every other outcome.
        if (mounted.current)
          feedback.announce(
            "error",
            error instanceof Error ? error.message : "Publication failed.",
          );
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }

  if (missing)
    return (
      <div className="agenda">
        <Card>
          <EmptyState
            icon={<IconCalendar size={20} />}
            title="No agenda yet — create the first room and track"
            action={
              <button
                className="primary"
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
                          reason instanceof Error
                            ? reason.message
                            : "Agenda initialization failed.",
                        );
                    })
                    .finally(() => {
                      if (mounted.current) setBusy(false);
                    });
                }}
              >
                Create agenda
              </button>
            }
          >
            One room and one track are enough to start placing sessions; add the rest as the
            programme takes shape.
          </EmptyState>
        </Card>
      </div>
    );

  const publicationChanges = publication
    ? changesSince(publication.occurrences, draft.occurrences)
    : 0;
  const publishPreview = publicationPreflightAvailable
    ? `${publicReadyCount} of ${scheduledSessionIds.size} scheduled session${scheduledSessionIds.size === 1 ? "" : "s"} will appear on the public page; the rest are not published in Sessions.`
    : "Every scheduled session that is published in Sessions will appear on the public page.";

  return (
    <div className="agenda">
      {/*
       * The page's action row: the two things an organizer presses, and the standing answer to
       * "what is live?". Publish used to be the last item in a wrapping filter toolbar, labelled
       * with a parenthetical count, and the only record of a publication was a toast that cleared
       * itself after six seconds.
       */}
      <div className="agenda-actions">
        {/*
         * The state of the public schedule, stated whether or not there is one.
         *
         * It used to render only after a first publication, so on every event that had never
         * published — which is every event an organizer is actually working on — this row was a
         * full-width band with two buttons floating at the far right of it and nothing on the
         * left. "Not published" is the answer to the row's own question, and the row is worth its
         * height only when it carries one. The version and the age are measures and set as
         * measures; the state is prose and sets as prose.
         */}
        <span
          className="agenda-publication"
          data-state={publication ? (publicationChanges ? "draft" : "published") : "none"}
        >
          {publication ? (
            publicationChanges ? (
              <>
                <span>Unpublished changes</span>
                <span className="figure">{`${publicationChanges} since v${publication.version}`}</span>
              </>
            ) : (
              <>
                <span>Published</span>
                <span className="figure">{`v${publication.version} · ${sinceLabel(publication.at, Date.now())}`}</span>
              </>
            )
          ) : (
            <span>Not published yet</span>
          )}
        </span>
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
          <IconCalendar size={16} />
          {selection.count ? `Place ${selection.count} selected` : "Generate draft"}
        </button>
        <button
          className="primary"
          type="button"
          disabled={busy || draft.conflicts.length > 0}
          // A disabled control cannot be focused, so the reason it is disabled is
          // attached to it rather than left as a panel the reader has to hunt for.
          aria-describedby={draft.conflicts.length ? "agenda-conflict-summary" : undefined}
          onClick={() => setConfirmingPublish(true)}
        >
          <IconCheck size={16} />
          Publish schedule
        </button>
      </div>

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

      {/*
       * One bar, sitting directly on the grid: which day, what you are looking for, whose clock,
       * how much is placed, and the way into the rooms and times. The Conflicts tab's own count
       * badge already carries "no conflicts" at zero vertical cost, so nothing here repeats it.
       */}
      <div className="agenda-bar">
        {isBoardView && days.length > 1 ? (
          <div className="agenda-days" role="radiogroup" aria-label="Day">
            {days.map((day) => {
              const count = scheduledSessionsByDay.get(day)?.size ?? 0;
              return (
                // biome-ignore lint/a11y/useSemanticElements: see the radiogroup above.
                <button
                  key={day}
                  type="button"
                  role="radio"
                  className="agenda-day"
                  aria-checked={activeDay === day}
                  tabIndex={activeDay === day ? 0 : -1}
                  disabled={busy}
                  onClick={() => setSelectedDay(day)}
                  onKeyDown={(pressed) => {
                    const step =
                      pressed.key === "ArrowRight" || pressed.key === "ArrowDown"
                        ? 1
                        : pressed.key === "ArrowLeft" || pressed.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (!step) return;
                    pressed.preventDefault();
                    const index = days.indexOf(day);
                    const next = days[(index + step + days.length) % days.length];
                    if (!next) return;
                    setSelectedDay(next);
                    document.getElementById(`agenda-day-${next}`)?.focus();
                  }}
                  id={`agenda-day-${day}`}
                >
                  <span>{labelForDay(day)}</span>
                  <span className="figure" aria-hidden="true">
                    {count}
                  </span>
                  <span className="visually-hidden">{count} scheduled sessions</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <label className="visually-hidden" htmlFor="agenda-search">
          Search sessions
        </label>
        <input
          id="agenda-search"
          className="control is-sm search"
          type="search"
          placeholder="Search sessions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {/* Mounted whether or not it has anything to say, so a screen reader has the region
            before the news arrives rather than with it. */}
        <span className="agenda-matches" aria-live="polite">
          {needle
            ? `${boardMatches} placed session${boardMatches === 1 ? "" : "s"} match`
            : `${draft.sessions.length - unscheduledCount} of ${draft.sessions.length} scheduled`}
        </span>

        <span className="spacer" />

        {/* The zone is stated on the board itself, not only in a card hint: every time
            on this screen is a wall-clock time and the reader has to know whose. */}
        <span className="agenda-timezone">
          <IconClock size={14} />
          <span className="visually-hidden">Times are shown in </span>
          {zoneLabel}
        </span>

        {/* Wherever the rail cannot carry the selection — the Conflicts view has no rail, and
            a search that matches nothing leaves no group control to put Clear beside — the
            bar carries it instead. Exactly one of the two is ever on screen, so there are
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

        <button
          type="button"
          className="secondary small"
          onClick={() => setResourcesOpen(true)}
          aria-haspopup="dialog"
        >
          <IconSliders size={16} />
          Rooms and times
        </button>
      </div>

      {feedback.node}

      {publicationPreflightAvailable && withheldSessions.length ? (
        <Notice
          tone="warn"
          role="status"
          title={`${withheldSessions.length} scheduled session${withheldSessions.length === 1 ? " will" : "s will"} not appear publicly`}
          action={
            <a className="btn secondary small" href={sessionsHref}>
              Review sessions
            </a>
          }
        >
          Scheduling sets the room and time; it does not publish session content. Publish these
          first: {withheldSessions.map(({ title }) => title).join(", ")}.
        </Notice>
      ) : null}

      {carry?.viaKeyboard ? (
        <div className="agenda-carry">
          <IconGrip size={16} />
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

      {/*
       * One line, and a way to the inventory.
       *
       * Twenty conflicts used to render twenty sentences above the grid, inside a `role="alert"`
       * that re-announced the whole list after every drop — so the more there was to fix, the
       * further the board was pushed down the page and the longer a screen reader spent reading
       * the same inventory back. The Conflicts view is where the inventory belongs, and it is one
       * press away with its own count on the tab.
       */}
      {draft.conflicts.length ? (
        <div id="agenda-conflict-summary">
          <Notice
            tone="warn"
            role="status"
            action={
              <button type="button" className="link" onClick={() => selectView("conflicts")}>
                Open the Conflicts view
              </button>
            }
          >
            {conflictPublicationSummary(draft.conflicts.length)}.
          </Notice>
        </div>
      ) : null}

      {/* Room and track views keep the rail visible even when it is empty. The rail is the
          discoverable source and destination for drag-and-drop; removing it after the last
          placement made it impossible to learn how to move a session back out of the grid. */}
      <div className="agenda-layout" data-rail={view !== "conflicts" && view !== "list"}>
        <div
          className="agenda-panel"
          id={`panel-${view}`}
          role="tabpanel"
          aria-labelledby={`tab-${view}`}
          tabIndex={-1}
        >
          {renderView()}
        </div>

        {view === "conflicts" ? null : (
          <UnscheduledRail
            sessions={unscheduled}
            selection={selection}
            unplaced={unplaced}
            heldSessionId={carry?.placementId === null ? carry.sessionId : null}
            busy={busy}
            tracks={tracks}
            trackId={newTrackId}
            onTrackChange={setTrackForNew}
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

      {confirmingPublish ? (
        <Drawer
          open
          title="Publish the schedule"
          busy={busy}
          onClose={() => setConfirmingPublish(false)}
          footer={
            <>
              <button type="button" className="primary" disabled={busy} onClick={publish}>
                Publish schedule
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setConfirmingPublish(false)}
              >
                Keep it private
              </button>
            </>
          }
        >
          <p>{publishPreview}</p>
        </Drawer>
      ) : null}

      {resourcesOpen ? (
        <Drawer
          open
          title="Rooms, tracks and times"
          description={`Times are entered on the event's clock: ${zoneLabel}.`}
          busy={busy}
          onClose={() => setResourcesOpen(false)}
          footer={
            <button type="button" className="secondary" onClick={() => setResourcesOpen(false)}>
              Done
            </button>
          }
        >
          <div className="agenda-resources">
            <section aria-labelledby="agenda-rooms-heading">
              <h3 id="agenda-rooms-heading">Rooms</h3>
              {draft.rooms.map((room) => {
                const note = inUseNote(
                  draft.placements.filter((placement) => placement.roomId === room.id).length,
                  "room",
                );
                const error = rowErrors[room.id];
                const typed = nameForms[room.id] ?? room.name;
                return (
                  <form
                    className="resource-row"
                    key={room.id}
                    aria-label={`Room ${room.name}`}
                    onSubmit={(submitted) => {
                      submitted.preventDefault();
                      const name = typed.trim();
                      if (!name || name === room.name) return;
                      setNameForms((current) => {
                        const { [room.id]: _dropped, ...rest } = current;
                        return rest;
                      });
                      // ERROR-INTENT: handlers cannot await; saveResources renders failures.
                      void saveResources(
                        {
                          rooms: draft.rooms.map((item) =>
                            item.id === room.id ? { ...item, name } : item,
                          ),
                          tracks: draft.tracks,
                          slots: draft.slots,
                        },
                        "Room renamed.",
                        room.id,
                      );
                    }}
                  >
                    {/* Editing in place, committed with Enter and reverted with Escape. The
                        rename used to be `window.prompt()` — browser chrome the design language
                        forbids, unstyleable, unlabelled, and impossible to report an error in. */}
                    <input
                      className="control is-sm"
                      aria-label={`Name of ${room.name}`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `agenda-room-error-${room.id}` : undefined}
                      value={typed}
                      disabled={busy}
                      onChange={(changed) => {
                        clearRowError(room.id);
                        setNameForms((current) => ({
                          ...current,
                          [room.id]: changed.target.value,
                        }));
                      }}
                      onKeyDown={(pressed) => {
                        if (pressed.key !== "Escape") return;
                        pressed.preventDefault();
                        setNameForms((current) => {
                          const { [room.id]: _dropped, ...rest } = current;
                          return rest;
                        });
                      }}
                    />
                    <button
                      type="submit"
                      className="secondary small"
                      disabled={busy || typed.trim() === room.name || !typed.trim()}
                    >
                      Save<span className="visually-hidden"> {room.name}</span>
                    </button>
                    {/* The note says why this will be refused, but the button stays live: this
                        view can be a few seconds old, and only the API knows what is placed
                        right now. Its refusal lands under the bar and in this row. */}
                    <button
                      type="button"
                      className="danger small"
                      disabled={busy}
                      aria-describedby={note ? `agenda-room-note-${room.id}` : undefined}
                      onClick={() =>
                        // ERROR-INTENT: handlers cannot await; saveResources renders failures.
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
                      Remove<span className="visually-hidden"> {room.name}</span>
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
                  </form>
                );
              })}
              {/* Named on creation. Adding a room used to mint "Room 3", so the only way to name
                  one was to create it wrong and then rename it through a prompt. */}
              <form
                className="resource-row resource-new"
                aria-label="Add a room"
                onSubmit={(submitted) => {
                  submitted.preventDefault();
                  const name = newRoomName.trim();
                  if (!name) return;
                  setNewRoomName("");
                  // ERROR-INTENT: handlers cannot await; saveResources renders failures.
                  void saveResources(
                    {
                      rooms: [...draft.rooms, { id: crypto.randomUUID(), name }],
                      tracks: draft.tracks,
                      slots: draft.slots,
                    },
                    "Room added.",
                  );
                }}
              >
                <input
                  className="control is-sm"
                  aria-label="New room name"
                  placeholder="Main stage"
                  value={newRoomName}
                  disabled={busy}
                  onChange={(changed) => setNewRoomName(changed.target.value)}
                />
                <button
                  type="submit"
                  className="secondary small"
                  disabled={busy || !newRoomName.trim()}
                >
                  <IconPlus size={14} />
                  Add room
                </button>
              </form>
            </section>

            <section aria-labelledby="agenda-tracks-heading">
              <h3 id="agenda-tracks-heading">Tracks</h3>
              {draft.tracks.map((track) => {
                const note = inUseNote(
                  draft.placements.filter((placement) => placement.trackId === track.id).length,
                  "track",
                );
                const error = rowErrors[track.id];
                const typed = nameForms[track.id] ?? track.name;
                const recolour = (color: string) =>
                  // ERROR-INTENT: handlers cannot await; saveResources renders failures.
                  void saveResources(
                    {
                      rooms: draft.rooms,
                      tracks: draft.tracks.map((item) =>
                        item.id === track.id ? { ...item, color } : item,
                      ),
                      slots: draft.slots,
                    },
                    `${track.name} is now ${trackColorName(color).toLowerCase()}.`,
                    track.id,
                  );
                return (
                  <form
                    className="resource-row track-row"
                    key={track.id}
                    aria-label={`Track ${track.name}`}
                    onSubmit={(submitted) => {
                      submitted.preventDefault();
                      const name = typed.trim();
                      if (!name || name === track.name) return;
                      setNameForms((current) => {
                        const { [track.id]: _dropped, ...rest } = current;
                        return rest;
                      });
                      // ERROR-INTENT: handlers cannot await; saveResources renders failures.
                      void saveResources(
                        {
                          rooms: draft.rooms,
                          tracks: draft.tracks.map((item) =>
                            item.id === track.id ? { ...item, name } : item,
                          ),
                          slots: draft.slots,
                        },
                        "Track renamed.",
                        track.id,
                      );
                    }}
                  >
                    <input
                      className="control is-sm"
                      aria-label={`Name of ${track.name}`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `agenda-track-error-${track.id}` : undefined}
                      value={typed}
                      disabled={busy}
                      onChange={(changed) => {
                        clearRowError(track.id);
                        setNameForms((current) => ({
                          ...current,
                          [track.id]: changed.target.value,
                        }));
                      }}
                      onKeyDown={(pressed) => {
                        if (pressed.key !== "Escape") return;
                        pressed.preventDefault();
                        setNameForms((current) => {
                          const { [track.id]: _dropped, ...rest } = current;
                          return rest;
                        });
                      }}
                    />
                    <button
                      type="submit"
                      className="secondary small"
                      disabled={busy || typed.trim() === track.name || !typed.trim()}
                    >
                      Save<span className="visually-hidden"> {track.name}</span>
                    </button>
                    <button
                      type="button"
                      className="danger small"
                      disabled={busy}
                      aria-describedby={note ? `agenda-track-note-${track.id}` : undefined}
                      onClick={() =>
                        // ERROR-INTENT: handlers cannot await; saveResources renders failures.
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
                      Remove<span className="visually-hidden"> {track.name}</span>
                    </button>
                    {/* The colour is the stripe every card on this track carries, so it is
                        chosen here rather than assigned once at creation and never again. */}
                    <div
                      className="track-swatches"
                      role="radiogroup"
                      aria-label={`Colour of ${track.name}`}
                    >
                      {TRACK_COLORS.map((swatch) => (
                        // biome-ignore lint/a11y/useSemanticElements: see the radiogroup above.
                        <button
                          key={swatch.value}
                          type="button"
                          role="radio"
                          className="track-swatch"
                          style={{ background: swatch.value }}
                          aria-checked={track.color.toLowerCase() === swatch.value}
                          aria-label={swatch.name}
                          tabIndex={track.color.toLowerCase() === swatch.value ? 0 : -1}
                          disabled={busy}
                          onClick={() => recolour(swatch.value)}
                        />
                      ))}
                    </div>
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
                  </form>
                );
              })}
              <form
                className="resource-row resource-new"
                aria-label="Add a track"
                onSubmit={(submitted) => {
                  submitted.preventDefault();
                  const name = newTrackName.trim();
                  if (!name) return;
                  setNewTrackName("");
                  // ERROR-INTENT: handlers cannot await; saveResources renders failures.
                  void saveResources(
                    {
                      rooms: draft.rooms,
                      tracks: [
                        ...draft.tracks,
                        {
                          id: crypto.randomUUID(),
                          name,
                          // Successive swatches, so a second track never looks like the first.
                          color: nextTrackColor(draft.tracks),
                        },
                      ],
                      slots: draft.slots,
                    },
                    "Track added.",
                  );
                }}
              >
                <input
                  className="control is-sm"
                  aria-label="New track name"
                  placeholder="Platform"
                  value={newTrackName}
                  disabled={busy}
                  onChange={(changed) => setNewTrackName(changed.target.value)}
                />
                <button
                  type="submit"
                  className="secondary small"
                  disabled={busy || !newTrackName.trim()}
                >
                  <IconPlus size={14} />
                  Add track
                </button>
              </form>
            </section>

            <section aria-labelledby="agenda-times-heading">
              <h3 id="agenda-times-heading">Time slots</h3>
              <SlotRunForms
                busy={busy}
                days={days}
                labelForDay={labelForDay}
                activeDay={activeDay}
                suggestedDay={newSlotForm.day}
                onGenerate={(planned) => {
                  const created = planned.flatMap((entry) => {
                    const times = readSlotForm("run", entry);
                    return times ? [{ id: crypto.randomUUID(), ...times }] : [];
                  });
                  if (!created.length) return;
                  // ERROR-INTENT: handlers cannot await; saveSlots renders both outcomes.
                  void saveSlots(
                    [...draft.slots, ...created],
                    `${created.length} time slot${created.length === 1 ? "" : "s"} added.`,
                    "run",
                    [...draft.slots.map(({ id }) => id), ...created.map(() => "run")],
                  );
                }}
                onCopy={(target) => {
                  const copied = daySlots.map((slot) => {
                    const source = slotInputs(slot);
                    const shifted = { ...source, day: target };
                    const times = readSlotForm("copy", shifted);
                    return times ? { id: crypto.randomUUID(), ...times } : null;
                  });
                  const created = copied.filter((slot) => slot !== null);
                  if (!created.length) return;
                  // ERROR-INTENT: handlers cannot await; saveSlots renders both outcomes.
                  void saveSlots(
                    [...draft.slots, ...created],
                    `${created.length} time slot${created.length === 1 ? "" : "s"} copied.`,
                    "copy",
                    [...draft.slots.map(({ id }) => id), ...created.map(() => "copy")],
                  );
                }}
                copyable={daySlots.length > 0}
                error={rowErrors.run ?? rowErrors.copy}
              />

              {allSlots.map((slot) => {
                const saved = slotInputs(slot);
                const form = slotForms[slot.id] ?? saved;
                const error = rowErrors[slot.id];
                const note = inUseNote(
                  draft.placements.filter((placement) => placement.slotId === slot.id).length,
                  "time slot",
                );
                const changed =
                  form.day !== saved.day || form.start !== saved.start || form.end !== saved.end;
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
                      // ERROR-INTENT: handlers cannot await; saveSlots renders both outcomes.
                      void saveSlots(
                        draft.slots.map((item) =>
                          item.id === slot.id ? { ...item, ...times } : item,
                        ),
                        "Timeslot updated.",
                        slot.id,
                      );
                    }}
                  >
                    <input
                      className="control is-sm"
                      type="date"
                      aria-label={`Day of ${belongsTo}`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `agenda-slot-error-${slot.id}` : undefined}
                      value={form.day}
                      disabled={busy}
                      onChange={(changedInput) =>
                        editSlotForm(slot.id, saved, { day: changedInput.target.value })
                      }
                    />
                    <input
                      className="control is-sm"
                      type="time"
                      aria-label={`Start of ${belongsTo}`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `agenda-slot-error-${slot.id}` : undefined}
                      value={form.start}
                      disabled={busy}
                      onChange={(changedInput) =>
                        editSlotForm(slot.id, saved, { start: changedInput.target.value })
                      }
                    />
                    <input
                      className="control is-sm"
                      type="time"
                      aria-label={`End of ${belongsTo}`}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `agenda-slot-error-${slot.id}` : undefined}
                      value={form.end}
                      disabled={busy}
                      onChange={(changedInput) =>
                        editSlotForm(slot.id, saved, { end: changedInput.target.value })
                      }
                    />
                    <button type="submit" className="secondary small" disabled={busy || !changed}>
                      Save<span className="visually-hidden"> {belongsTo}</span>
                    </button>
                    <button
                      type="button"
                      className="danger small"
                      disabled={busy}
                      aria-describedby={note ? `agenda-slot-note-${slot.id}` : undefined}
                      onClick={() =>
                        // ERROR-INTENT: handlers cannot await; saveSlots renders both outcomes.
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
                  // ERROR-INTENT: handlers cannot await; saveSlots renders both outcomes.
                  void saveSlots([...draft.slots, created], "Timeslot added.", NEW_SLOT, [
                    ...draft.slots.map(({ id }) => id),
                    NEW_SLOT,
                  ]);
                }}
              >
                <input
                  className="control is-sm"
                  type="date"
                  aria-label="New timeslot day"
                  aria-invalid={rowErrors[NEW_SLOT] ? true : undefined}
                  aria-describedby={rowErrors[NEW_SLOT] ? "agenda-new-slot-error" : undefined}
                  value={newSlotForm.day}
                  disabled={busy}
                  onChange={(changedInput) =>
                    editSlotForm(NEW_SLOT, suggestedSlot, { day: changedInput.target.value })
                  }
                />
                <input
                  className="control is-sm"
                  type="time"
                  aria-label="New timeslot start"
                  aria-invalid={rowErrors[NEW_SLOT] ? true : undefined}
                  aria-describedby={rowErrors[NEW_SLOT] ? "agenda-new-slot-error" : undefined}
                  value={newSlotForm.start}
                  disabled={busy}
                  onChange={(changedInput) =>
                    editSlotForm(NEW_SLOT, suggestedSlot, { start: changedInput.target.value })
                  }
                />
                <input
                  className="control is-sm"
                  type="time"
                  aria-label="New timeslot end"
                  aria-invalid={rowErrors[NEW_SLOT] ? true : undefined}
                  aria-describedby={rowErrors[NEW_SLOT] ? "agenda-new-slot-error" : undefined}
                  value={newSlotForm.end}
                  disabled={busy}
                  onChange={(changedInput) =>
                    editSlotForm(NEW_SLOT, suggestedSlot, { end: changedInput.target.value })
                  }
                />
                <button type="submit" className="secondary small" disabled={busy}>
                  <IconPlus size={14} />
                  Add timeslot
                </button>
                {rowErrors[NEW_SLOT] ? (
                  <p className="error-text" id="agenda-new-slot-error">
                    {rowErrors[NEW_SLOT]}
                  </p>
                ) : null}
              </form>
            </section>
          </div>
        </Drawer>
      ) : null}

      {/*
       * Generated arrangements, below the board rather than beside it: generating is a step an
       * organizer takes *about* the board, and the board is what they came here to look at.
       *
       * Rendered from inside this component rather than as a sibling in the workspace module so
       * that it announces through the board's live region. Its outcomes are board changes, and a
       * second announcer on this page would be one more thing for a screen reader to disambiguate
       * with no reader-visible benefit.
       */}
      {belowBoard?.(feedback.announce)}
    </div>
  );
}

/**
 * The two bulk ways to lay out a day, beside the one-at-a-time row.
 *
 * A three-day, eight-slot conference is 24 slots and used to be 48 hand-typed datetimes. It is
 * now one run and two copies. Local state, because a half-filled generator is not a fact about
 * the board and must not survive the drawer closing on it.
 */
function SlotRunForms({
  busy,
  days,
  labelForDay,
  activeDay,
  suggestedDay,
  copyable,
  error,
  onGenerate,
  onCopy,
}: {
  busy: boolean;
  days: readonly string[];
  labelForDay: (day: string) => string;
  activeDay: string | null;
  suggestedDay: string;
  /** Whether the day on screen has any slots worth copying. */
  copyable: boolean;
  error: string | undefined;
  onGenerate: (planned: readonly SlotForm[]) => void;
  onCopy: (day: string) => void;
}) {
  const [run, setRun] = useState<SlotRunForm>({
    day: suggestedDay,
    start: "09:00",
    end: "17:00",
    length: "45",
    gap: "15",
  });
  const [copyTo, setCopyTo] = useState("");
  const planned = planSlotRun(run);
  const patch = (change: Partial<SlotRunForm>) => setRun((current) => ({ ...current, ...change }));

  return (
    <div className="slot-bulk">
      <form
        className="resource-row slot-generate"
        aria-label="Generate slots"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          onGenerate(planned);
        }}
      >
        <input
          className="control is-sm"
          type="date"
          aria-label="Generate slots on"
          value={run.day}
          disabled={busy}
          onChange={(changed) => patch({ day: changed.target.value })}
        />
        <input
          className="control is-sm"
          type="time"
          aria-label="Generate slots from"
          value={run.start}
          disabled={busy}
          onChange={(changed) => patch({ start: changed.target.value })}
        />
        <input
          className="control is-sm"
          type="time"
          aria-label="Generate slots until"
          value={run.end}
          disabled={busy}
          onChange={(changed) => patch({ end: changed.target.value })}
        />
        <input
          className="control is-sm"
          type="number"
          min="5"
          max="600"
          aria-label="Slot length in minutes"
          value={run.length}
          disabled={busy}
          onChange={(changed) => patch({ length: changed.target.value })}
        />
        <input
          className="control is-sm"
          type="number"
          min="0"
          max="240"
          aria-label="Break between slots in minutes"
          value={run.gap}
          disabled={busy}
          onChange={(changed) => patch({ gap: changed.target.value })}
        />
        <button type="submit" className="secondary small" disabled={busy || !planned.length}>
          <IconPlus size={14} />
          Generate {planned.length} slot{planned.length === 1 ? "" : "s"}
        </button>
      </form>

      {copyable && days.length ? (
        <form
          className="resource-row slot-copy"
          aria-label="Copy this day's slots"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            if (copyTo) onCopy(copyTo);
          }}
        >
          <span className="slot-copy-label">
            Copy {activeDay ? labelForDay(activeDay) : "this day"} to
          </span>
          <input
            className="control is-sm"
            type="date"
            aria-label="Copy this day's slots to"
            value={copyTo}
            disabled={busy}
            onChange={(changed) => setCopyTo(changed.target.value)}
          />
          <button type="submit" className="secondary small" disabled={busy || !copyTo}>
            Copy slots
          </button>
        </form>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}
