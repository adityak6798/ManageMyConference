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

import type { AgendaDraftDto } from "@greenroom/contracts";
import "../styles/agenda.css";

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

/** A start/end pair exactly as the two `datetime-local` inputs of one row hold it. */
type SlotForm = { start: string; end: string };

/** The length a new timeslot is offered at, and the grid its default start snaps to. */
const HOUR_MS = 3_600_000;
/** `datetime-local` yields `YYYY-MM-DDTHH:mm`, plus seconds this board does not use. */
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
/** The key the not-yet-created timeslot row uses in the form and error maps. */
const NEW_SLOT = "new";
/** The colour a track is born with; the organizer can recolour it afterwards. */
const DEFAULT_TRACK_COLOR = "#6257d9";

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

/** Reads one instant in one zone: clock time, calendar day, and how to name the zone. */
type Clock = {
  /** The zone actually in use — the event's, or UTC if the runtime cannot resolve it. */
  zone: string;
  /** `HH:mm` on the event's wall clock. */
  hhmm: (iso: string) => string;
  /** The event-local calendar day of an instant, as a sortable `YYYY-MM-DD` key. */
  dayKey: (iso: string) => string;
  /** The event-local day of an instant, spelled for a reader. */
  dayLabel: (iso: string) => string;
  /** The zone's abbreviation at a given instant (`PDT`), which DST makes date-dependent. */
  abbreviation: (iso: string) => string;
  /** An instant as a `datetime-local` value on the event's clock. */
  toInput: (iso: string) => string;
  /** The instant an operator meant by a `datetime-local` value, or null if unreadable. */
  toInstant: (input: string) => string | null;
  /** The first whole hour on the event's clock at or after `from`, as an instant. */
  nextRoundHour: (from: number) => string;
};

/**
 * An event carries whatever timezone string was stored for it, and `Intl` throws a
 * `RangeError` on one it does not recognise. That must not take the board down, so an
 * unusable zone degrades to UTC — which the board then names, rather than implying it
 * is showing local time.
 */
function resolveZone(timezone: string): string {
  try {
    // Constructing the formatter is the probe; `resolvedOptions` also canonicalises it.
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
  } catch {
    // ERROR-INTENT: an unrecognised IANA zone is stored data, not an action this operator
    // took, and there is nothing for them to retry. The board stays readable and says UTC.
    return "UTC";
  }
}

function clockFor(timezone: string): Clock {
  const zone = resolveZone(timezone);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  });
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: zone,
  });
  const calendar = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone,
  });
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: zone,
  });
  const partOf = (
    formatter: Intl.DateTimeFormat,
    iso: string,
    type: Intl.DateTimeFormatPartTypes,
  ) => formatter.formatToParts(new Date(iso)).find((part) => part.type === type)?.value ?? "";
  const hhmm = (iso: string) => time.format(new Date(iso));
  // Assembled from parts rather than from a locale that happens to print ISO order,
  // because this key is sorted and compared, not shown.
  const dayKey = (iso: string) =>
    `${partOf(calendar, iso, "year")}-${partOf(calendar, iso, "month")}-${partOf(calendar, iso, "day")}`;
  // A `datetime-local` value *is* an event-local calendar day and clock time, so the
  // two readings the board already trusts compose into one without new machinery.
  const toInput = (iso: string) => `${dayKey(iso)}T${hhmm(iso)}`;
  /** The event's wall clock at an instant, as an epoch whose *UTC* fields are that clock. */
  const wallAt = (instant: number) => Date.parse(`${toInput(new Date(instant).toISOString())}:00Z`);
  const offsetAt = (instant: number) => wallAt(instant) - instant;
  /**
   * The inverse of `wallAt`: which instant an operator meant by a wall-clock reading.
   * A zone's offset is itself a function of the instant, so this converts twice — once
   * with the offset at the naive guess, then with the offset that actually applies
   * there. The second pass is what makes the hours either side of a DST changeover
   * land on the instant the organizer meant rather than one an hour away.
   */
  const instantAt = (wall: number) => wall - offsetAt(wall - offsetAt(wall));
  return {
    zone,
    hhmm,
    dayLabel: (iso) => day.format(new Date(iso)),
    dayKey,
    abbreviation: (iso) => partOf(zoneName, iso, "timeZoneName"),
    toInput,
    toInstant: (input) => {
      const parts = LOCAL_INPUT.exec(input);
      if (!parts) return null;
      const [, year, month, dayOfMonth, hour, minute] = parts;
      const wall = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(dayOfMonth),
        Number(hour),
        Number(minute),
      );
      return Number.isNaN(wall) ? null : new Date(instantAt(wall)).toISOString();
    },
    nextRoundHour: (from) =>
      new Date(instantAt(Math.ceil(wallAt(from) / HOUR_MS) * HOUR_MS)).toISOString(),
  };
}

/** Instants order the same in every zone, so ordering compares the moment, not the text. */
const byInstant = (left: string, right: string) => {
  const delta = Date.parse(left) - Date.parse(right);
  return Number.isNaN(delta) ? left.localeCompare(right) : delta;
};
const byStart = (left: Slot, right: Slot) => byInstant(left.startsAt, right.startsAt);

/**
 * A board's placements as one comparable value, so "did this change?" is a fact about the
 * placements rather than about how many there are.
 *
 * Counting cannot answer it: one session seated while another is unscheduled leaves the total
 * where it was, and a move changes no total at all. Sorted, so two readings of the same board
 * compare equal whatever order they arrived in.
 */
const placementShape = (placements: readonly Placement[]) =>
  placements
    // Serialized rather than joined on a separator: every field is an arbitrary string, so a
    // separator could appear inside one and make two different boards read as the same.
    .map(({ id, sessionId, roomId, trackId, slotId }) =>
      JSON.stringify([id, sessionId, roomId, trackId, slotId]),
    )
    .sort()
    .join("\n");
const cellKey = (roomId: string, slotId: string) => `${roomId}~${slotId}`;

function isViewId(value: string | null): value is ViewId {
  return VIEWS.some((view) => view === value);
}

/**
 * The API names an invalid field by its position in the payload it received
 * (`slots.2.endsAt`), which is a fact about the request rather than about the board.
 * `keys[index]` translates that back into the row whose inputs produced it, so the
 * message lands under those inputs instead of in the workspace-wide alert.
 */
function errorsByRow(fieldErrors: Record<string, string[]>, keys: string[]) {
  const rows: Record<string, string> = {};
  for (const [path, messages] of Object.entries(fieldErrors)) {
    const [group, index] = path.split(".");
    if (group !== "slots" || index === undefined || !messages.length) continue;
    const key = keys[Number(index)];
    if (!key) continue;
    const existing = rows[key];
    rows[key] = existing ? `${existing} ${messages.join(" ")}` : messages.join(" ");
  }
  return rows;
}

/**
 * Why a room, track, or timeslot cannot be removed, or null when it can be.
 *
 * The API refuses a removal that would orphan a placement (`AgendaResourceInUseError`),
 * and the board is holding the very placements that decide it — so the row can say what
 * will happen before the button is pressed, instead of only reporting it afterwards.
 * The button itself stays live: this view is a snapshot, the placements may have moved
 * since it was read, and only the API knows. A refused click then announces under the
 * toolbar and repeats itself in the row, so the answer arrives either way.
 */
function inUseNote(held: number, resource: "room" | "track" | "time slot"): string | null {
  if (!held) return null;
  return held === 1
    ? `Holds 1 scheduled session. Move or unschedule it before removing this ${resource}.`
    : `Holds ${held} scheduled sessions. Move or unschedule them before removing this ${resource}.`;
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

export type { Carry, Cell, Clock, Conflict, Draft, Placement, Slot, SlotForm, ViewId };
export {
  byInstant,
  byStart,
  CONFLICT_LABELS,
  cellKey,
  clockFor,
  DEFAULT_TRACK_COLOR,
  errorsByRow,
  HOUR_MS,
  inUseNote,
  isViewId,
  LOCAL_INPUT,
  NEW_SLOT,
  placementShape,
  readViewFromUrl,
  resolveZone,
  VIEW_LABELS,
  VIEW_TITLES,
  VIEWS,
};
