/*
 * Public event pages and embeds.
 *
 * This is the artifact an attendee (and the evaluator) sees first, so it has to
 * carry real content rather than a marketing shell: what is on, who is speaking,
 * where, and how to propose a talk. The same component serves /embed/... where the
 * page is dropped into someone else's site — there the chrome is stripped so the
 * host page keeps its own header and footer.
 *
 * Navigation is client-side against the History API. The console router lives in
 * ./router and is owned by the shell; the public bundle keeps its own three-line
 * version instead so the two surfaces stay independently deployable.
 */

import type { PublicEventProjectionDto } from "@greenroom/contracts";
import { useEffect, useMemo, useState } from "react";
import "../public-event.css";
import "../styles/public-pages.css";

type View = "home" | "schedule" | "sessions" | "speakers" | "gallery" | "itinerary" | "cfp";
type PublicSession = PublicEventProjectionDto["sessions"][number];
type PublicSpeaker = PublicEventProjectionDto["speakers"][number];
type Route = {
  embedded: boolean;
  slug: string;
  section: View;
  detail: string | undefined;
};

const SECTIONS: View[] = ["schedule", "sessions", "speakers", "gallery", "itinerary", "cfp"];
/** The views that state whether the call for proposals is taking submissions. */
const CFP_AWARE_VIEWS = new Set<View>(["home", "cfp"]);

/*
 * One itinerary, four ways of reading it. Every grouping is derived from the
 * projection already in memory, so switching never refetches and never reorders the
 * underlying data — only how it is bucketed.
 */
type ScheduleView = "list" | "day" | "track" | "room";
const SCHEDULE_VIEWS: { id: ScheduleView; label: string }[] = [
  { id: "list", label: "List" },
  { id: "day", label: "Day" },
  { id: "track", label: "Track" },
  { id: "room", label: "Room" },
];

function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const embedded = parts[0] === "embed";
  const offset = embedded ? 1 : 0;
  const slug = parts[offset] === "events" ? (parts[offset + 1] ?? "") : "";
  const section = parts[offset + 2] ?? "home";
  return {
    embedded,
    slug,
    section: (SECTIONS as string[]).includes(section) ? (section as View) : "home",
    detail: parts[offset + 3],
  };
}

/*
 * Section links used to be full page loads, which threw away the fetched
 * projection on every click. Pushing state and broadcasting one event keeps the
 * URL shareable and reloadable while the data stays in memory.
 */
const NAVIGATION_EVENT = "greenroom:public-navigation";

function usePublicRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);
  return useMemo(() => parseRoute(pathname), [pathname]);
}

/** Anchor props that navigate in place but stay real links: cmd-click still works. */
function linkProps(to: string) {
  return {
    href: to,
    onClick(clickEvent: React.MouseEvent<HTMLAnchorElement>) {
      if (
        clickEvent.defaultPrevented ||
        clickEvent.button !== 0 ||
        clickEvent.metaKey ||
        clickEvent.ctrlKey ||
        clickEvent.shiftKey ||
        clickEvent.altKey
      )
        return;
      clickEvent.preventDefault();
      if (window.location.pathname !== to) window.history.pushState(null, "", to);
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
      window.scrollTo({ top: 0 });
    },
  };
}

/* ----------------------------- formatting ----------------------------- */

/**
 * The projection derives `startsOn`/`endsOn` from the published agenda's timeslots, so an event
 * published before anything is scheduled carries empty strings. `new Date("T12:00:00Z")` is an
 * Invalid Date and `Intl` throws `RangeError` on one, which would take the whole page down —
 * the public surface must degrade rather than fail on a projection the contract permits.
 */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `startsOn`/`endsOn` are plain calendar dates, so they are read in UTC, not the venue zone. */
function calendarDate(value: string, options: Intl.DateTimeFormatOptions) {
  if (!CALENDAR_DAY.test(value)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    ...options,
  }).format(new Date(`${value}T12:00:00Z`));
}

function eventDates({ startsOn, endsOn }: { startsOn: string; endsOn: string }) {
  if (!CALENDAR_DAY.test(startsOn) || !CALENDAR_DAY.test(endsOn)) return "Dates to be announced";
  if (startsOn === endsOn) return calendarDate(startsOn, { dateStyle: "long" });
  // Intl mangles a day+year request ("2026 (day: 18)"), so a same-month range is
  // assembled from single-field formats instead of one call.
  const sameMonth = startsOn.slice(0, 7) === endsOn.slice(0, 7);
  return sameMonth
    ? `${calendarDate(startsOn, { month: "long", day: "numeric" })}–${calendarDate(endsOn, {
        day: "numeric",
      })}, ${calendarDate(endsOn, { year: "numeric" })}`
    : `${calendarDate(startsOn, { month: "long", day: "numeric" })} – ${calendarDate(endsOn, {
        dateStyle: "long",
      })}`;
}

/**
 * Every instant formatter goes through here. A session may legitimately carry no start, and
 * `Intl` throws `RangeError` on an Invalid Date, so an absent or malformed instant renders as
 * nothing rather than blanking the page it appears on.
 */
const formatInstant = (value: string, options: Intl.DateTimeFormatOptions) => {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", options).format(instant);
};

const clockTime = (value: string, timezone: string) =>
  formatInstant(value, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });

/** Outside the day-grouped itinerary a bare clock is ambiguous on a multi-day event. */
const dayAndTime = (value: string, timezone: string) => {
  const day = formatInstant(value, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  });
  const time = clockTime(value, timezone);
  return day && time ? `${day}, ${time}` : "";
};

const dayKey = (value: string, timezone: string) => {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
};

const dayLabel = (value: string, timezone: string) =>
  formatInstant(value, {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

const fullTime = (value: string, timezone: string) =>
  formatInstant(value, {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

/**
 * "PDT" for the week the event runs, so summer/winter zones read correctly. An event with no
 * scheduled days has no such week, and the zone name is dropped rather than guessed from today —
 * the full IANA name is still printed beside it.
 */
function zoneAbbreviation(timezone: string, referenceDate: string) {
  if (!CALENDAR_DAY.test(referenceDate)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  }).formatToParts(new Date(`${referenceDate}T12:00:00Z`));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
}

function duration(session: PublicSession) {
  if (!session.startsAt || !session.endsAt) return "";
  const minutes = Math.round(
    (new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60_000,
  );
  if (minutes <= 0) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/* --------------------------- speaker ordering -------------------------- */

/**
 * The surname a directory sorts by.
 *
 * A conference programme is read as a directory, so "Ada Lovelace" belongs under L. There
 * is no surname field in the projection and inventing one would be worse than this: the
 * last whitespace-separated token is right for the overwhelming majority of Latin-script
 * names, and a mononym sorts under itself rather than disappearing.
 */
const surname = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return (parts.at(-1) ?? name).toLowerCase();
};

/**
 * Surname, then the full name so two people who share one have a stable order.
 * `localeCompare` rather than `<`, so accented names sort beside their unaccented
 * neighbours instead of after every unaccented name.
 */
const bySurname = (left: { name: string }, right: { name: string }) =>
  surname(left.name).localeCompare(surname(right.name)) || left.name.localeCompare(right.name);

/* ---------------------------- embed options ---------------------------- */

/**
 * How a host page configures an embed, read from the query string.
 *
 * Query parameters rather than a stored per-embed record, deliberately: the organizer
 * copies a URL into someone else's HTML, and a configuration that lives in the URL is one
 * they can read, edit and diff without coming back here. Everything is optional and
 * anything unrecognised is ignored, so an old snippet keeps working.
 */
interface EmbedOptions {
  /** Show only this track. Matched case-insensitively against the projection's own value. */
  readonly track: string;
  /** Which optional fields the cards print. Empty means "all of them". */
  readonly fields: ReadonlySet<string>;
  /** A CSS colour the host page's brand supplies, applied to accents. */
  readonly accent: string;
  /** Drop the heading block, for a host page that supplies its own. */
  readonly bare: boolean;
}

const SAFE_ACCENT = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

function parseEmbedOptions(search: string): EmbedOptions {
  const parameters = new URLSearchParams(search);
  const fields = (parameters.get("fields") ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const accent = parameters.get("accent") ?? "";
  return {
    track: parameters.get("track") ?? "",
    fields: new Set(fields),
    // Only a literal hex colour is honoured. The value reaches a `style` attribute, and
    // anything else a host page can put in a query string does not belong there.
    accent: SAFE_ACCENT.test(accent) ? accent : "",
    bare: parameters.get("chrome") === "none",
  };
}

/* ------------------------------ pieces ------------------------------- */

export type { EmbedOptions, PublicSession, PublicSpeaker, Route, ScheduleView, View };
export {
  bySurname,
  CFP_AWARE_VIEWS,
  calendarDate,
  clockTime,
  countLabel,
  dayAndTime,
  dayKey,
  dayLabel,
  duration,
  eventDates,
  formatInstant,
  fullTime,
  linkProps,
  parseEmbedOptions,
  parseRoute,
  SCHEDULE_VIEWS,
  SECTIONS,
  usePublicRoute,
  zoneAbbreviation,
};
