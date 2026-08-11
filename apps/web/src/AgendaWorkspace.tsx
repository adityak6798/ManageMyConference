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
 * Times render in UTC: the draft carries no timezone, so every surface has to agree on
 * one, and UTC is what the stored slots are in.
 */

import type { AgendaDraftDto } from "@greenroom/contracts";
import { useEffect, useRef, useState } from "react";
import {
  AgendaApiError,
  getAgenda,
  publishAgenda,
  removePlacement,
  saveAgendaResources,
  savePlacement,
} from "./api/agenda";
import "./styles/agenda.css";
import { IconCalendar, IconCheck, IconGrip, IconPlus, IconWarning } from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Tabs, useActionFeedback } from "./ui/primitives";

type Draft = AgendaDraftDto;
type Placement = Draft["placements"][number];
type Conflict = Draft["conflicts"][number];
type Slot = Draft["slots"][number];

/** What the operator is currently holding, whether by pointer or by keyboard. */
type Carry = {
  sessionId: string;
  title: string;
  trackId: string;
  placementId: string | null;
  viaKeyboard: boolean;
};

type Cell = { key: string; roomId: string; slotId: string };

const VIEWS = ["list", "day", "week", "room", "track", "conflicts"] as const;
type ViewId = (typeof VIEWS)[number];

const VIEW_LABELS: Record<ViewId, string> = {
  list: "List",
  day: "Day",
  week: "Week",
  room: "Room",
  track: "Track",
  conflicts: "Conflicts",
};

const VIEW_TITLES: Record<ViewId, string> = {
  list: "Every placement, earliest first",
  day: "One column per time slot",
  week: "Days across, time down",
  room: "Rooms across, time down",
  track: "Grouped by track",
  conflicts: "Everything blocking publication",
};

const CONFLICT_LABELS: Record<Conflict["kind"], string> = {
  ROOM_OVERLAP: "Room double-booked",
  SPEAKER_OVERLAP: "Speaker double-booked",
  SESSION_OVERLAP: "Session placed twice",
  MISSING_SESSION: "Session no longer exists",
};

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const hhmm = (iso: string) => timeFormat.format(new Date(iso));
const slotRange = (slot: Slot) => `${hhmm(slot.startsAt)}–${hhmm(slot.endsAt)}`;
const dayOf = (iso: string) => iso.slice(0, 10);
const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T12:00:00.000Z`));
const byStart = (left: Slot, right: Slot) => left.startsAt.localeCompare(right.startsAt);
const cellKey = (roomId: string, slotId: string) => `${roomId}~${slotId}`;

function isViewId(value: string | null): value is ViewId {
  return VIEWS.some((view) => view === value);
}

/**
 * The view lives in the query string so a board link is shareable and survives reload.
 * The History API is used directly rather than the router module: the router owns
 * navigation between workspaces, while this only rewrites one parameter of this URL.
 */
function readViewFromUrl(): ViewId {
  const requested = new URLSearchParams(window.location.search).get("view");
  return isViewId(requested) ? requested : "room";
}

export function AgendaWorkspace({
  eventId,
  onError,
}: {
  eventId: string;
  onError: (message: string) => void;
}) {
  const [agenda, setAgenda] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewId>(readViewFromUrl);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [trackForNew, setTrackForNew] = useState<string | null>(null);
  const [carry, setCarryState] = useState<Carry | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
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
    // ERROR-INTENT: React effects cannot await; failures are rendered by the parent boundary.
    void getAgenda(eventId)
      .then((loaded) => {
        if (active) setAgenda(loaded);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof AgendaApiError && error.envelope.error.code === "NOT_FOUND") {
          // ERROR-INTENT: The initialization promise updates this workspace or its visible error.
          void saveAgendaResources(eventId, {
            rooms: [{ id: crypto.randomUUID(), name: "Main room" }],
            tracks: [{ id: crypto.randomUUID(), name: "General", color: "#6257d9" }],
            slots: [],
          })
            .then((loaded) => {
              if (active) setAgenda(loaded);
            })
            .catch(
              (reason: unknown) =>
                active &&
                onError(reason instanceof Error ? reason.message : "Agenda initialization failed."),
            );
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

  // Focus follows the operator across a re-render: after a drop the card that moved
  // takes focus, and after a cancel the card that was picked up takes it back.
  useEffect(() => {
    if (!pendingFocus) return;
    document.getElementById(pendingFocus)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

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
  const allSlots = [...draft.slots].sort(byStart);
  const days = [...new Set(allSlots.map((slot) => dayOf(slot.startsAt)))].sort();
  const activeDay = selectedDay && days.includes(selectedDay) ? selectedDay : (days[0] ?? null);
  const daySlots = allSlots.filter((slot) => dayOf(slot.startsAt) === activeDay);
  const newTrackId = trackForNew ?? tracks[0]?.id ?? "";

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

  const placedSessionIds = new Set(draft.placements.map(({ sessionId }) => sessionId));
  const needle = query.trim().toLowerCase();
  const unscheduled = draft.sessions.filter(
    (session) =>
      !placedSessionIds.has(session.id) &&
      (!needle || session.title.toLowerCase().includes(needle)),
  );
  const sortedPlacements = [...draft.placements].sort((left, right) => {
    const leftSlot = slotOf(left.slotId);
    const rightSlot = slotOf(right.slotId);
    if (!leftSlot || !rightSlot) return leftSlot ? -1 : 1;
    return (
      leftSlot.startsAt.localeCompare(rightSlot.startsAt) ||
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
    const when = slot ? `${dayLabel(dayOf(slot.startsAt))} ${slotRange(slot)}` : "an unknown time";
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

  /**
   * `focusId` is applied only once the new draft is on screen: the element it names
   * (the card that just moved) does not exist until then.
   */
  async function act(
    action: () => Promise<Draft>,
    describe: (updated: Draft) => string,
    focusId?: string,
  ) {
    setBusy(true);
    try {
      const updated = await action();
      if (!mounted.current) return;
      setAgenda(updated);
      feedback.announce("success", describe(updated));
      if (focusId) setPendingFocus(focusId);
    } catch (error) {
      // ERROR-INTENT: The workspace renders this expected API failure through its parent alert.
      if (mounted.current)
        onError(error instanceof Error ? error.message : "Agenda update failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const saveResources = (resources: Pick<Draft, "rooms" | "tracks" | "slots">, done: string) =>
    act(
      () => saveAgendaResources(eventId, resources),
      () => done,
    );

  function pickUp(source: Carry, from?: Placement) {
    setCarry(source);
    if (source.viaKeyboard) {
      const slot = from ? slotOf(from.slotId) : undefined;
      if (slot) setSelectedDay(dayOf(slot.startsAt));
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
      if (target) setPendingFocus(`agenda-cell-${target}`);
    }
    feedback.announce(
      "success",
      `Holding “${source.title}”. Choose a slot and press Enter to place it.`,
    );
  }

  function cancelCarry() {
    if (!carry) return;
    setPendingFocus(
      carry.placementId
        ? `agenda-placement-${carry.placementId}`
        : `agenda-session-${carry.sessionId}`,
    );
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
      `agenda-placement-${id}`,
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
      `agenda-session-${placement.sessionId}`,
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
              Conflict
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
          {carry ? (
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
            {activeDay ? dayLabel(activeDay) : "the event"}.
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
            One column per time slot on {activeDay ? dayLabel(activeDay) : "the selected day"}.
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
            Days across the top, time slots down the side.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {days.map((day) => (
                <th scope="col" key={day}>
                  {dayLabel(day)}
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
                    .filter((slot) => dayOf(slot.startsAt) === day && slotRange(slot) === range)
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
                  <td>{slot ? dayLabel(dayOf(slot.startsAt)) : "—"}</td>
                  <td>
                    <select
                      aria-label={`Time assignment ${placement.id}`}
                      value={placement.slotId}
                      disabled={busy}
                      onChange={(event) => {
                        // ERROR-INTENT: React event handlers cannot await; act renders failures.
                        void act(
                          () =>
                            savePlacement(eventId, { ...placement, slotId: event.target.value }),
                          () => `“${sessionTitle(placement.sessionId)}” moved to a new time.`,
                        );
                      }}
                    >
                      {allSlots.map((option) => (
                        <option key={option.id} value={option.id}>
                          {dayLabel(dayOf(option.startsAt))} · {slotRange(option)}
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
                            savePlacement(eventId, { ...placement, roomId: event.target.value }),
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
                            savePlacement(eventId, { ...placement, trackId: event.target.value }),
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
    ? "Drag a session onto a cell, or press Enter on a session to pick it up and place it with the arrow keys. Times are UTC."
    : "Times are shown in UTC.";

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
                  {dayLabel(day)}
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
        <span className="agenda-count">
          {placedSessionIds.size} of {draft.sessions.length} scheduled
        </span>
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
                if (mounted.current)
                  onError(error instanceof Error ? error.message : "Publication failed.");
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

      {carry ? (
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
          <strong>
            {draft.conflicts.length} conflict{draft.conflicts.length === 1 ? "" : "s"} block
            publication
          </strong>
          <ul>
            {draft.conflicts.map((conflict) => (
              <li
                key={`${conflict.kind}-${conflict.placementId}-${conflict.conflictingPlacementId}-${conflict.resourceId}`}
              >
                {conflict.kind.replaceAll("_", " ").toLowerCase()} — {explain(conflict)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Notice tone="success">No conflicts. This draft is ready to publish.</Notice>
      )}

      {/* The conflict table needs the whole column; the rail is a drop target for the
          board views, where it earns its space. */}
      <div className="agenda-layout" data-rail={view === "conflicts" ? "false" : "true"}>
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

        {view === "conflicts" ? null : (
          <aside
            className="agenda-rail"
            data-over={overCell === "rail" ? "true" : undefined}
            onDragOver={(event) => {
              if (!carried.current?.placementId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOverCell("rail");
            }}
            onDragLeave={() => setOverCell((current) => (current === "rail" ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              const held = carried.current?.placementId;
              const placement = held ? placementOf(held) : undefined;
              if (placement) unschedule(placement);
            }}
          >
            <Card
              labelledBy="agenda-unscheduled"
              title="Unscheduled"
              hint={`${unscheduled.length} session${unscheduled.length === 1 ? "" : "s"} without a slot`}
              tight
            >
              {unscheduled.length ? (
                <div className="agenda-rail-list">
                  {unscheduled.map((session) => {
                    const held = carry?.placementId === null && carry.sessionId === session.id;
                    const source: Carry = {
                      sessionId: session.id,
                      title: session.title,
                      trackId: newTrackId,
                      placementId: null,
                      viaKeyboard: true,
                    };
                    return (
                      <button
                        key={session.id}
                        id={`agenda-session-${session.id}`}
                        type="button"
                        className="sched-card"
                        draggable={!busy}
                        disabled={busy || !newTrackId}
                        data-carrying={held ? "true" : undefined}
                        aria-label={`${session.title}. Not scheduled. ${
                          held ? "Press Enter to cancel." : "Press Enter to pick this session up."
                        }`}
                        onDragStart={(event) => startDrag(event, { ...source, viaKeyboard: false })}
                        onDragEnd={() => {
                          setCarry(null);
                          setOverCell(null);
                        }}
                        onKeyDown={onSourceKeys}
                        onClick={() => (held ? cancelCarry() : pickUp(source))}
                      >
                        <span className="sched-title">{session.title}</span>
                        <span className="sched-meta">
                          <IconGrip size={12} />
                          Drag, or press Enter to place
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState title="Everything is scheduled" icon={<IconCheck size={20} />}>
                  {query
                    ? "No unscheduled session matches your search."
                    : "Every accepted session has a room and a time slot."}
                </EmptyState>
              )}
            </Card>
          </aside>
        )}
      </div>

      <details className="agenda-resources">
        <summary>Manage rooms, tracks, and times</summary>
        <h3>Rooms</h3>
        {draft.rooms.map((room) => (
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
                  );
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                void saveResources(
                  {
                    rooms: draft.rooms.filter(({ id }) => id !== room.id),
                    tracks: draft.tracks,
                    slots: draft.slots,
                  },
                  "Room removed.",
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary small"
          onClick={() =>
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources(
              {
                rooms: [
                  ...draft.rooms,
                  { id: crypto.randomUUID(), name: `Room ${draft.rooms.length + 1}` },
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
        {draft.tracks.map((track) => (
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
                  );
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                void saveResources(
                  {
                    rooms: draft.rooms,
                    tracks: draft.tracks.filter(({ id }) => id !== track.id),
                    slots: draft.slots,
                  },
                  "Track removed.",
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
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
                    color: "#6257d9",
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
        {draft.slots.map((slot) => (
          <div className="resource-row" key={slot.id}>
            <span className="name">
              {dayLabel(dayOf(slot.startsAt))} · {slotRange(slot)}
            </span>
            <span />
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
                void saveResources(
                  {
                    rooms: draft.rooms,
                    tracks: draft.tracks,
                    slots: draft.slots.filter(({ id }) => id !== slot.id),
                  },
                  "Timeslot removed.",
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary small"
          onClick={() => {
            const start = new Date(draft.slots.at(-1)?.endsAt ?? "2026-09-01T16:00:00.000Z");
            // ERROR-INTENT: React event handlers cannot await; saveResources renders failures.
            void saveResources(
              {
                rooms: draft.rooms,
                tracks: draft.tracks,
                slots: [
                  ...draft.slots,
                  {
                    id: crypto.randomUUID(),
                    startsAt: start.toISOString(),
                    endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
                  },
                ],
              },
              "Timeslot added.",
            );
          }}
        >
          <IconPlus size={13} />
          Add next timeslot
        </button>
      </details>
    </div>
  );
}
