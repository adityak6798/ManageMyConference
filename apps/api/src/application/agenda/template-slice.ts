/**
 * Agenda's contribution to a reusable event template.
 *
 * The shape of the board travels; what is on it does not. Rooms and tracks are copied verbatim
 * and time slots are copied onto the destination's own days, while sessions and placements stay
 * behind: a placement names a session that exists only in the source event, and `conflictsFor`
 * would report every one of them as `MISSING_SESSION` the moment the destination was read.
 *
 * Slots are the one thing any slice carries as absolute instants, which is what `DateRemap` is
 * for. The agenda anchors on its own earliest slot day — its business, not events' — and moves
 * day N of the source to day N of the destination while keeping the time of day the organizer
 * actually chose. Issue #85 established that a slot reads in the *event's* timezone rather than
 * in UTC, so a clone that shifted the hours by the difference between two offsets would undo
 * exactly what that fixed: 09:00 in Los Angeles has to arrive as 09:00 in Berlin.
 *
 * @spec PRD-AGD-001 PRD-EVT-002 ARC-DOM-001 ARC-FLOW-006
 */
import type {
  AgendaDraft,
  AgendaRoom,
  AgendaSlot,
  AgendaTrack,
  Placement,
} from "../../domain/agenda/agenda";
import {
  type DateRemap,
  type EventConfigurationSlice,
  type SliceEntry,
  type SlicePreview,
  SliceRefusalError,
  type SliceResult,
} from "../events/public";
import type { Actor } from "../identity/actor";
import {
  AgendaNotFoundError,
  AgendaResourceInUseError,
  type AgendaService,
} from "./agenda-service";

export const AGENDA_TEMPLATE_SLICE_KEY = "agenda";

interface AgendaTemplatePayload {
  readonly rooms: readonly AgendaRoom[];
  readonly tracks: readonly AgendaTrack[];
  readonly slots: readonly AgendaSlot[];
}

/** The three lists `AgendaService.configure` replaces, and the only thing this slice writes. */
type AgendaResources = Pick<AgendaDraft, "rooms" | "tracks" | "slots">;

/** One of those three lists, asked about on its own rather than as part of the board. */
type AgendaDimension = keyof AgendaResources;

/** In the order an organizer reads them, with the words the reasons below are built from. */
const DIMENSIONS = ["rooms", "tracks", "slots"] as const satisfies readonly AgendaDimension[];

const DIMENSION_LABEL: Record<AgendaDimension, string> = {
  rooms: "rooms",
  tracks: "tracks",
  slots: "time slots",
};

/** The destination as it stands: what to compare against, and what a rewrite would strand. */
type AgendaBoard = AgendaResources & Pick<AgendaDraft, "placements">;

type AgendaTemplateCommands = Pick<AgendaService, "configure" | "draft">;

/**
 * The programme itself is named here rather than merely omitted — the preview promises to list
 * every excluded category, and a category nobody can see was excluded reads as one that was
 * copied. An organizer who expects their sessions to arrive with the board should be told they
 * will not before they press the button, not left to discover an empty schedule afterwards.
 */
const EXCLUDED: readonly SliceEntry[] = [
  { id: "sessions", label: "Sessions on the source event's board" },
  { id: "placements", label: "Where the source event placed each session" },
];

/**
 * Replacing the board's resources would leave the destination's own placements pointing at
 * rooms, tracks or slots that no longer exist, which is the one thing `configure` refuses.
 */
const STRANDED =
  "The destination already places sessions in rooms, tracks or time slots this template does " +
  "not carry. Remove those placements first, then apply the template again.";

/**
 * A template that carries nothing is answered rather than applied.
 *
 * The rule below leaves every unmentioned dimension standing, so an all-empty payload can no
 * longer take a configured board down with it. Two things still make this its own answer: a
 * destination with no agenda at all would otherwise have an empty one *created* for it, and
 * "applied" is the wrong word for a template that contributed nothing. `export` refuses to
 * capture an empty board, which leaves a hand-written or edited row as the only way one arrives,
 * and an untrusted payload is what this slice reads at apply time.
 */
const NOTHING_TO_COPY =
  "This template carries no rooms, tracks or time slots. There is nothing to copy, and a " +
  "template is never the thing that would clear the destination's own board, so this category " +
  "is left alone.";

/*
 * A dimension the template says nothing about is left standing, not emptied.
 *
 * `configure` replaces rooms, tracks and slots together, so a payload carrying one non-empty
 * list writes two empty ones over whatever the destination had — and `export` produces exactly
 * that payload, because it captures the whole board as soon as any one list has something in it.
 * A source event with rooms but no tracks yet is an ordinary state, and applying it deleted the
 * destination's tracks. `stranded` does not catch that: a board that was set up but never
 * dragged onto has no placements to strand, so the deletion goes through perfectly cleanly and
 * is reported as a copy.
 *
 * Refusing instead — `incompatible` whenever the write would remove a destination entry the
 * payload does not carry — was the other candidate, and it is too blunt to be right: replacing
 * the rooms an event already has is what applying a template *means*, so that rule would refuse
 * nearly every application onto a destination anyone had begun to configure, and the one
 * legitimate use of this feature would become the one it turned away. Per dimension is the line
 * that keeps "replaces what it speaks about" without "deletes what it does not".
 *
 * The cost is that an empty list is not expressible. A template meaning "this event has no
 * tracks" is byte-identical to one that never mentioned tracks, and this reads both as silence.
 * Nothing in the payload distinguishes them and no `export` can currently produce a payload that
 * would; an organizer who wants the destination's tracks gone deletes them on the destination's
 * own board, where the agenda can tell them which placements that would strand.
 */

/*
 * Emptiness is read off the *stored* lists rather than the remapped ones, and the obvious worry
 * about that is unreachable rather than unhandled.
 *
 * A payload carrying only slots, every one of which the destination's dates refuse, would reach
 * `configure` with an empty slot list it did not mean to be empty — but no such payload exists.
 * `remapSlots` anchors on the earliest day any slot *starts* on, so that slot's offset is zero by
 * construction and it lands on `destination.startsOn`, which is inside every range this service
 * accepts. At least one slot therefore always survives, and refusals are always a strict subset.
 */

export function agendaTemplateSlice(service: AgendaTemplateCommands): EventConfigurationSlice {
  return {
    key: AGENDA_TEMPLATE_SLICE_KEY,
    label: "Agenda rooms, tracks and time slots",

    async export(actor: Actor | null, eventId: string): Promise<unknown | null> {
      const board = await readBoard(service, actor, eventId);
      if (!board) return null;
      /*
       * A board with no resources at all is nothing to copy, and a version that stored one would
       * be a category every preview listed and every apply skipped. Captured as null it is absent
       * from the template instead, which is what it is.
       */
      if (!board.rooms.length && !board.tracks.length && !board.slots.length) return null;
      const payload: AgendaTemplatePayload = {
        rooms: board.rooms,
        tracks: board.tracks,
        slots: board.slots,
      };
      return payload;
    },

    async preview(
      actor: Actor | null,
      eventId: string,
      raw: unknown,
      remap: DateRemap,
    ): Promise<SlicePreview> {
      const { empty, resources, copies, refused, carried, kept, current } = await plan(
        service,
        actor,
        eventId,
        raw,
        remap,
      );
      // The same three questions `apply` asks, in the same order, so a preview cannot promise an
      // outcome the write would then refuse.
      if (empty)
        return {
          outcome: "skipped",
          reason: NOTHING_TO_COPY,
          copies: [],
          excludes: [],
          incompatible: [],
        };
      if (current && matches(current, resources))
        return {
          outcome: "copies",
          reason: "The destination's board already matches this template; applying writes nothing.",
          copies,
          excludes: EXCLUDED,
          incompatible: refused,
        };
      if (current && stranded(current, resources))
        return {
          outcome: "incompatible",
          reason: STRANDED,
          copies: [],
          excludes: EXCLUDED,
          incompatible: [...copies, ...refused],
        };
      return {
        outcome: "copies",
        reason: current
          ? `Replaces the destination's ${nameList(carried)}.${keptClause(kept, "stay as they are")} Sessions stay where they are.`
          : `Creates the destination's ${nameList(carried)}.`,
        copies,
        excludes: EXCLUDED,
        incompatible: refused,
      };
    },

    async apply(
      actor: Actor | null,
      eventId: string,
      raw: unknown,
      remap: DateRemap,
    ): Promise<SliceResult> {
      const { empty, resources, copies, refused, carried, kept, current } = await plan(
        service,
        actor,
        eventId,
        raw,
        remap,
      );
      // Asked before the destination is compared against at all, because the answer does not
      // depend on it: an empty template has nothing to write onto a board in any state.
      if (empty)
        return { outcome: "skipped", reason: NOTHING_TO_COPY, applied: [], incompatible: [] };
      /*
       * Re-applying converges *and* writes nothing.
       *
       * `configure` replaces all three lists on every call, so the second application of one
       * template would rewrite the draft — and stamp whatever the store stamps — for no change
       * in configuration. Comparing first is what makes "apply twice, then compare" a meaningful
       * assertion instead of one that has to make an exception for a revision counter.
       */
      if (current && matches(current, resources))
        return {
          outcome: "applied",
          reason: "Already identical to the template; nothing needed to be written.",
          applied: copies,
          incompatible: refused,
        };
      if (current && stranded(current, resources))
        return {
          outcome: "incompatible",
          reason: STRANDED,
          applied: [],
          incompatible: [...copies, ...refused],
        };
      try {
        await service.configure(actor, eventId, resources);
      } catch (error) {
        // ERROR-INTENT: a destination whose placements depend on resources this template does
        // not carry is the issue's "incompatible" category, not a fault. `stranded` catches it
        // before the call, so reaching here means the board moved underneath us — reported with
        // the agenda's own message rather than raised as a 500.
        if (error instanceof AgendaResourceInUseError)
          return {
            outcome: "incompatible",
            reason: error.message,
            applied: [],
            incompatible: [...copies, ...refused],
          };
        throw error;
      }
      return {
        outcome: "applied",
        reason: [
          // "onto the destination's dates" is the remap talking, so it is said only when there
          // were slots to remap: a template of rooms alone moved nothing onto any date.
          carried.includes("slots")
            ? `Copied the ${nameList(carried)} onto the destination's dates.`
            : `Copied the ${nameList(carried)}.`,
          keptClause(kept, "were left as they were"),
          refused.length ? " Slots falling past its last day were left out." : "",
        ].join(""),
        applied: copies,
        incompatible: refused,
      };
    },
  };
}

/**
 * Everything both `preview` and `apply` need, computed the same way for each.
 *
 * The payload is read before the agenda is touched, so a stored configuration nobody can parse
 * is reported as exactly that rather than as something that went wrong at the destination. The
 * capability refusal `AgendaService.draft` raises is caught nowhere below: an actor who may not
 * manage the destination's agenda is `unauthorized`, and saying so is the orchestrator's job.
 */
async function plan(
  service: AgendaTemplateCommands,
  actor: Actor | null,
  eventId: string,
  raw: unknown,
  remap: DateRemap,
): Promise<{
  empty: boolean;
  resources: AgendaResources;
  copies: readonly SliceEntry[];
  refused: readonly SliceEntry[];
  /** The dimensions this payload speaks about, and therefore the ones the write replaces. */
  carried: readonly AgendaDimension[];
  /** The dimensions it is silent about that the destination has something in, left standing. */
  kept: readonly AgendaDimension[];
  current: AgendaBoard | null;
}> {
  const payload = readPayload(raw);
  const { slots, copied, refused } = remapSlots(payload.slots, remap);
  const current = await readBoard(service, actor, eventId);
  // A template whose slots the destination's dates all refuse still carried them, so a stored
  // list is what decides whether this template speaks about a dimension — the remapped one would
  // make a refusal read as silence and hand the destination's slots back to itself.
  const carries = (dimension: AgendaDimension) => payload[dimension].length > 0;
  const held = (dimension: AgendaDimension) => (current?.[dimension].length ?? 0) > 0;
  return {
    empty: !DIMENSIONS.some(carries),
    resources: {
      rooms: carries("rooms") ? payload.rooms : (current?.rooms ?? []),
      tracks: carries("tracks") ? payload.tracks : (current?.tracks ?? []),
      slots: carries("slots") ? slots : (current?.slots ?? []),
    },
    copies: [
      ...payload.rooms.map((room) => ({ id: room.id, label: `Room: ${room.name}` })),
      ...payload.tracks.map((track) => ({ id: track.id, label: `Track: ${track.name}` })),
      ...copied,
    ],
    refused,
    carried: DIMENSIONS.filter(carries),
    kept: DIMENSIONS.filter((dimension) => !carries(dimension) && held(dimension)),
    current,
  };
}

/** "rooms", "rooms and time slots", "rooms, tracks and time slots". */
function nameList(dimensions: readonly AgendaDimension[]): string {
  const words = dimensions.map((dimension) => DIMENSION_LABEL[dimension]);
  const last = words.at(-1) ?? "";
  return words.length < 2 ? last : `${words.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * What the write leaves standing, said out loud rather than left to be discovered.
 *
 * The reason an organizer reads has to match what the write did: naming all three categories
 * while replacing one was a false statement in a product surface, and the same sentence read as
 * a promise that the tracks they set up had been overwritten when they had not.
 */
function keptClause(kept: readonly AgendaDimension[], verb: string): string {
  return kept.length ? ` Its ${nameList(kept)} are not in this template and ${verb}.` : "";
}

/**
 * The event's board as it stands, or null when it has no agenda at all.
 *
 * A destination that was never configured is the ordinary case for a fresh event, and
 * `AgendaService.draft` says so by throwing. That is not a refusal and not a fault: there is
 * nothing to compare against, and `configure` will create the draft.
 */
async function readBoard(
  service: AgendaTemplateCommands,
  actor: Actor | null,
  eventId: string,
): Promise<AgendaBoard | null> {
  try {
    const { rooms, tracks, slots, placements } = await service.draft(actor, eventId);
    return { rooms, tracks, slots, placements };
  } catch (error) {
    // ERROR-INTENT: "this event has no agenda yet" is an answer rather than a failure, and it is
    // the shape every never-configured destination has. Nothing else is caught: the capability
    // refusal this very call makes still propagates, and the orchestrator reports it.
    if (error instanceof AgendaNotFoundError) return null;
    throw error;
  }
}

/**
 * Would replacing the destination's resources leave a placement pointing at nothing?
 *
 * The same rule `AgendaRepository.saveResources` enforces, asked before the write rather than
 * after it, so a preview can state what an apply would refuse. Re-applying a template the
 * destination was configured from does not trip it: ids travel with the template, so placements
 * made against those rooms, tracks and slots still find them.
 */
function stranded(current: AgendaBoard, resources: AgendaResources): boolean {
  const holds = (available: readonly { readonly id: string }[], id: string) =>
    available.some((item) => item.id === id);
  return current.placements.some(
    (placement: Placement) =>
      !holds(resources.rooms, placement.roomId) ||
      !holds(resources.tracks, placement.trackId) ||
      !holds(resources.slots, placement.slotId),
  );
}

/**
 * Is the destination already configured exactly as this template would configure it?
 *
 * Slots are compared as instants rather than as strings, because two spellings of one instant
 * are one instant — the same reading `conflictsFor` takes of a slot — and rewriting the board
 * to change `…:00Z` into `…:00.000Z` would be a write with no change in it.
 */
function matches(current: AgendaResources, resources: AgendaResources): boolean {
  const shape = ({ rooms, tracks, slots }: AgendaResources) =>
    JSON.stringify({
      rooms: rooms.map(({ id, name }) => [id, name]),
      tracks: tracks.map(({ id, name, color }) => [id, name, color]),
      slots: slots.map(({ id, startsAt, endsAt }) => [
        id,
        Date.parse(startsAt),
        Date.parse(endsAt),
      ]),
    });
  return shape(current) === shape(resources);
}

interface RemappedSlots {
  readonly slots: readonly AgendaSlot[];
  readonly copied: readonly SliceEntry[];
  readonly refused: readonly SliceEntry[];
}

/**
 * Move each slot from the source's days onto the destination's, keeping its wall-clock hours.
 *
 * The agenda has no default slot pattern to fall back on and invents none: every slot here is
 * one an organizer placed on the source's board, and all this does is decide which destination
 * day it lands on. A slot whose day falls past the destination's last one is refused by name —
 * a shorter destination event is a real answer, and clamping it onto the final day would put a
 * session at an hour nobody chose.
 */
function remapSlots(slots: readonly AgendaSlot[], remap: DateRemap): RemappedSlots {
  const [head] = slots;
  // No slots is no remap, and a board with no times in it must not fail on a timezone the
  // runtime cannot read: the clocks below exist only when there is something to move.
  if (!head) return { slots: [], copied: [], refused: [] };
  const source = zoneClock(remap.source.timezone);
  const destination = zoneClock(remap.destination.timezone);
  const readings = slots.map((slot) => {
    const startsAt = Date.parse(slot.startsAt);
    const endsAt = Date.parse(slot.endsAt);
    return {
      slot,
      startsAt,
      endsAt,
      start: source.wallClockAt(startsAt),
      end: source.wallClockAt(endsAt),
    };
  });
  /*
   * The anchor: the earliest day any slot *starts* on, read on the source event's clock.
   *
   * Read in the source's zone because that is the day the organizer saw. A 09:00 slot in Los
   * Angeles is 16:00 UTC on the same date, but a 20:00 one is 03:00 UTC on the *next* date, so
   * anchoring in UTC would split one conference day across two and push the evening's sessions
   * onto the destination's following morning.
   */
  const anchor = readings.reduce(
    (earliest, { start }) => (start.day < earliest ? start.day : earliest),
    source.wallClockAt(Date.parse(head.startsAt)).day,
  );
  const moved: AgendaSlot[] = [];
  const copied: SliceEntry[] = [];
  const refused: SliceEntry[] = [];
  for (const { slot, startsAt, endsAt, start, end } of readings) {
    const index = daysBetween(anchor, start.day);
    const day = addDays(remap.destination.startsOn, index);
    const hours = `${start.time.slice(0, 5)}–${end.time.slice(0, 5)}`;
    if (day > remap.destination.endsOn) {
      refused.push({
        id: slot.id,
        label: `Time slot on day ${index + 1} at ${hours}, past the destination event's last day`,
      });
      continue;
    }
    // A slot that runs past midnight keeps that shape: its end moves by the same number of days
    // as its start, so a source evening that ended the next morning still does.
    const endDay = addDays(day, daysBetween(start.day, end.day));
    moved.push({
      id: slot.id,
      startsAt: movedInstant(destination, day, start.time, startsAt),
      endsAt: movedInstant(destination, endDay, end.time, endsAt),
    });
    copied.push({ id: slot.id, label: `Time slot: ${day}, ${hours}` });
  }
  return { slots: moved, copied, refused };
}

/**
 * One remapped instant, keeping whatever the source carried below a second.
 *
 * `Intl` reads a clock to the second and every IANA offset in the modern era is a whole number
 * of minutes, so anything under a second belongs to the reading rather than to the zone and
 * survives the move untouched. Slots in this product are whole minutes; a stored payload is
 * untrusted input, and silently rounding one would move an instant for no reason an organizer
 * could see.
 */
function movedInstant(clock: ZoneClock, day: string, time: string, source: number): string {
  return new Date(
    clock.instantAt(day, time) + source - Math.floor(source / 1000) * 1000,
  ).toISOString();
}

const DAY = 86_400_000;

/**
 * Whole calendar days between two `YYYY-MM-DD` days, counted in UTC.
 *
 * Deliberately counted nowhere else: a day on which the clocks change is 23 or 25 hours long,
 * so counting in either event's zone would occasionally land a day out. Every UTC day is exactly
 * 24 hours, and a day *label* carries no offset to be wrong about.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

/** What a clock in one zone shows: a calendar day, and a time of day on a 24-hour dial. */
interface WallClock {
  readonly day: string;
  readonly time: string;
}

interface ZoneClock {
  wallClockAt(instant: number): WallClock;
  /** The instant at which this zone's clock reads `time` on `day`. */
  instantAt(day: string, time: string): number;
}

/** A wall-clock reading as the instant it would name if the zone were UTC. */
const asNaive = (day: string, time: string) => Date.parse(`${day}T${time}Z`);

/**
 * A wall clock for one IANA zone, and its inverse.
 *
 * Hand-written because the application layer imports no packages, and deliberately no larger
 * than the remap needs: an instant to a day and a time of day in a named zone, and back again.
 * What it does *not* do is settle the readings a changeover makes ambiguous or impossible, and
 * it says so here rather than implying the conversion is always exact:
 *
 *  - When the clocks go back, one reading names two instants. This returns one of them, and
 *    which one follows from the zone's offsets either side of the change rather than from a rule
 *    of preference: Los Angeles yields the reading before the change, Berlin the one after.
 *  - When the clocks go forward, the readings inside the skipped hour name no instant at all.
 *    This returns one an hour to their side — 02:30 arrives as 01:30 in Los Angeles and as 03:30
 *    in Berlin — rather than refusing a slot for a calendar the organizer did not choose.
 *
 * Both are facts about the destination's calendar rather than about this code: no arithmetic can
 * produce an instant a zone does not have. They cost at most an hour, on at most one day of a
 * conference, and only for a slot scheduled inside the changeover itself.
 */
function zoneClock(timezone: string): ZoneClock {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (error) {
    // `Intl` throws a `RangeError` for a zone it does not recognise, and an event can genuinely
    // hold one: `createEventInputSchema` accepts any non-empty string where the update schema
    // refines against `Intl`. A stored zone is the same on every attempt, so this is the
    // organizer's refusal — naming the zone to correct — and not an operator's incident. The
    // `RangeError` rides along as the cause for whoever reads the throw itself.
    throw new SliceRefusalError(`“${timezone}” is not a timezone this system can read.`, {
      cause: error,
    });
  }
  const wallClockAt = (instant: number): WallClock => {
    const parts = new Map(
      formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
    );
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? "00";
    return {
      day: `${part("year")}-${part("month")}-${part("day")}`,
      time: `${part("hour")}:${part("minute")}:${part("second")}`,
    };
  };
  /** The zone's offset from UTC at an instant: what its clock reads there, minus the instant. */
  const offsetAt = (instant: number) => {
    const { day, time } = wallClockAt(instant);
    return asNaive(day, time) - instant;
  };
  return {
    wallClockAt,
    instantAt: (day, time) => {
      /*
       * Two passes, because a zone's offset is itself a function of the instant. The first uses
       * the offset in force where the reading-read-as-UTC falls, which is never more than a day
       * from the answer; the second uses the offset that actually applies where that guess
       * landed. Without it, every reading on the far side of a changeover from that guess is an
       * hour out, and a template applied months away from its source crosses one routinely.
       */
      const naive = asNaive(day, time);
      return naive - offsetAt(naive - offsetAt(naive));
    },
  };
}

/**
 * A stored template payload is untrusted input by the time it is applied.
 *
 * It was serialized by this slice, but it has since been at rest in a table an operator can
 * write to, and it reaches `AgendaService.configure` without passing the Zod schema that guards
 * the agenda's HTTP surface. So it is validated here instead of trusted here.
 */
function readPayload(raw: unknown): AgendaTemplatePayload {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    !Array.isArray(candidate.rooms) ||
    !Array.isArray(candidate.tracks) ||
    !Array.isArray(candidate.slots)
  )
    throw unreadable();
  return {
    rooms: candidate.rooms.map(readRoom),
    tracks: candidate.tracks.map(readTrack),
    slots: candidate.slots.map(readSlot),
  };
}

function readRoom(raw: unknown): AgendaRoom {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") throw unreadable();
  return { id: candidate.id, name: candidate.name };
}

function readTrack(raw: unknown): AgendaTrack {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.color !== "string"
  )
    throw unreadable();
  return { id: candidate.id, name: candidate.name, color: candidate.color };
}

function readSlot(raw: unknown): AgendaSlot {
  if (typeof raw !== "object" || raw === null) throw unreadable();
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !isInstant(candidate.startsAt) ||
    !isInstant(candidate.endsAt)
  )
    throw unreadable();
  return { id: candidate.id, startsAt: candidate.startsAt, endsAt: candidate.endsAt };
}

/**
 * An ISO instant carrying its own offset, never a bare local reading.
 *
 * `Date.parse("2027-05-10T09:00:00")` is resolved against whatever zone the *server* runs in, so
 * accepting one would make the remap depend on a machine instead of on the two events'
 * timezones. A slot without an offset is not an instant, and this refuses to guess one for it.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * A refusal, not a fault: what this reader turns down is a fixed property of bytes already at
 * rest, so the orchestrator's generic "apply this version again" would be false advice and an
 * operator paged for it would find nothing broken. The organizer is told which category of which
 * version to recapture instead, which is the only act that changes the answer.
 */
function unreadable(): SliceRefusalError {
  return new SliceRefusalError("This template's stored agenda configuration could not be read.");
}
