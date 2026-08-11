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
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CfpApiError, type CfpFormDto, loadCfp, submitProposal } from "./api/cfp";
import { getPublicEvent, PublicApiError } from "./api/publication";
import "./public-event.css";
import "./styles/public-pages.css";

type View = "home" | "schedule" | "sessions" | "speakers" | "cfp";
type PublicSession = PublicEventProjectionDto["sessions"][number];
type PublicSpeaker = PublicEventProjectionDto["speakers"][number];
type Route = { embedded: boolean; slug: string; section: View; detail: string | undefined };

const SECTIONS: View[] = ["schedule", "sessions", "speakers", "cfp"];

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

/** `startsOn`/`endsOn` are plain calendar dates, so they are read in UTC, not the venue zone. */
function calendarDate(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(
    new Date(`${value}T12:00:00Z`),
  );
}

function eventDates({ startsOn, endsOn }: { startsOn: string; endsOn: string }) {
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

const clockTime = (value: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

/** Outside the day-grouped itinerary a bare clock is ambiguous on a multi-day event. */
const dayAndTime = (value: string, timezone: string) =>
  `${new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
  }).format(new Date(value))}, ${clockTime(value, timezone)}`;

const dayKey = (value: string, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));

const dayLabel = (value: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(value));

const fullTime = (value: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(value));

/** "PDT" for the week the event runs, so summer/winter zones read correctly. */
function zoneAbbreviation(timezone: string, referenceDate: string) {
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

/* ------------------------------ pieces ------------------------------- */

function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "info" | "warn";
  children: ReactNode;
}) {
  return <span className={`pub-pill ${tone}`}>{children}</span>;
}

const AVATAR_TONES = 5;

/** Stable per-speaker tile colour so a gallery does not reshuffle between loads. */
function toneIndex(seed: string) {
  let hash = 7;
  for (const character of seed) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 9973;
  return hash % AVATAR_TONES;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/*
 * A headshot when the projection has one, a monogram tile when it does not — and a
 * monogram again when the photo fails to load. The URL is composed server-side and the
 * gallery cannot know whether it resolves, so a 404 must degrade to the tile rather
 * than leave a browser's broken-image glyph in a row of faces.
 *
 * The image is decorative (`alt=""`): every avatar sits next to the speaker's name, so
 * a description would only make screen readers say the name twice.
 */
function Avatar({ speaker, large }: { speaker: PublicSpeaker; large?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const className = large ? "pub-avatar is-large" : "pub-avatar";
  const photoUrl =
    speaker.photoUrl && speaker.photoUrl !== failedUrl ? speaker.photoUrl : undefined;
  if (photoUrl)
    return (
      <img
        className={className}
        src={photoUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(photoUrl)}
      />
    );
  return (
    <span className={`${className} tone-${toneIndex(speaker.slug)}`} aria-hidden="true">
      {initials(speaker.name)}
    </span>
  );
}

/*
 * The projection field this renders is now named `organization`, because that is what the
 * speaker profile stores and what it always held: an employer, never a job title. The
 * visible line and its screen-reader label say "affiliation" for the same reason.
 */
function SpeakerHeadline({ speaker }: { speaker: PublicSpeaker }) {
  if (!speaker.organization.trim()) return null;
  return (
    <p className="pub-speaker-headline">
      <span className="pub-sr">Affiliation: </span>
      {speaker.organization}
    </p>
  );
}

/** Start–end in the event's zone; the zone itself is stated once per page, not per row. */
function TimeRange({
  startsAt,
  endsAt,
  timezone,
  withDay,
}: {
  startsAt: string;
  endsAt: string | undefined;
  timezone: string;
  withDay?: boolean;
}) {
  return (
    <span className="pub-when">
      <time dateTime={startsAt}>
        {withDay ? dayAndTime(startsAt, timezone) : clockTime(startsAt, timezone)}
      </time>
      {endsAt && (
        <>
          {/* The dash is punctuation for the eye; the screen reader gets a word. */}
          <span aria-hidden="true">–</span>
          <span className="pub-sr"> to </span>
          <time dateTime={endsAt}>{clockTime(endsAt, timezone)}</time>
        </>
      )}
    </span>
  );
}

function SessionCard({
  session,
  base,
  timezone,
  speakers,
  showTime,
}: {
  session: PublicSession;
  base: string;
  timezone: string;
  speakers: PublicSpeaker[];
  showTime?: boolean;
}) {
  const length = duration(session);
  // Every meta entry is its own element so the CSS separator lands between all of
  // them; a bare text node would silently skip the first dot.
  const showClock = Boolean(showTime && session.startsAt);
  // Outside the day-grouped view an unplaced session would otherwise look identical to
  // a placed one whose time simply was not rendered.
  const showPending = Boolean(showTime && !session.startsAt);
  return (
    <article className="pub-session">
      <h3>
        <a {...linkProps(`${base}/sessions/${session.slug}`)}>{session.title}</a>
      </h3>
      {(showClock || showPending || length || session.room) && (
        <p className="pub-session-meta">
          {showClock && (
            <TimeRange
              startsAt={session.startsAt ?? ""}
              endsAt={session.endsAt}
              timezone={timezone}
              withDay
            />
          )}
          {showPending && <span>Time to be announced</span>}
          {length && <span>{length}</span>}
          {session.room && <span>{session.room}</span>}
        </p>
      )}
      <p className="pub-session-abstract">{session.abstract}</p>
      {speakers.length > 0 && (
        <ul className="pub-session-speakers">
          {speakers.map((speaker) => (
            <li key={speaker.slug}>
              <Avatar speaker={speaker} />
              <a {...linkProps(`${base}/speakers/${speaker.slug}`)}>{speaker.name}</a>
            </li>
          ))}
        </ul>
      )}
      <p className="pub-tags">
        <Pill tone="info">{session.track}</Pill>
        <Pill>{session.format}</Pill>
      </p>
    </article>
  );
}

function SpeakerCard({
  speaker,
  base,
  sessions,
}: {
  speaker: PublicSpeaker;
  base: string;
  sessions: PublicSession[];
}) {
  return (
    <article className="pub-speaker">
      <Avatar speaker={speaker} large />
      <h3>
        <a {...linkProps(`${base}/speakers/${speaker.slug}`)}>{speaker.name}</a>
      </h3>
      <SpeakerHeadline speaker={speaker} />
      {sessions.length > 0 ? (
        <ul className="pub-speaker-sessions">
          {sessions.map((session) => (
            <li key={session.slug}>
              <a {...linkProps(`${base}/sessions/${session.slug}`)}>{session.title}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pub-speaker-sessions is-empty">Session to be announced</p>
      )}
    </article>
  );
}

/*
 * The empty state carries a heading, so it has to slot into the outline of whatever
 * placed it: level 2 when it stands directly under the page's h1, level 3 inside a
 * section that already has an h2. A fixed h3 skipped a level on the section pages.
 */
function Empty({
  title,
  level = 3,
  children,
}: {
  title: string;
  level?: 2 | 3;
  children?: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="pub-empty">
      <span className="glyph" aria-hidden="true">
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative glyph; the wrapper is aria-hidden and the heading carries the meaning. */}
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 13.5 5.6 5.2A2 2 0 0 1 7.5 4h9a2 2 0 0 1 1.9 1.2L21 13.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M3 13.5h5l1.2 2.3h5.6L16 13.5h5" />
        </svg>
      </span>
      <Heading>{title}</Heading>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/*
 * Track and room buckets for the schedule switcher. The input is already sorted by
 * start time, so each bucket keeps that order. A session with no track or no room is
 * not dropped: it lands in a named "to be announced" bucket that sorts last.
 */
function groupByField(sessions: PublicSession[], field: "track" | "room") {
  const fallback = field === "track" ? "Track to be announced" : "Room to be announced";
  const buckets = new Map<string, PublicSession[]>();
  for (const item of sessions) {
    const value = (field === "track" ? item.track : item.room)?.trim();
    const label = value || fallback;
    buckets.set(label, [...(buckets.get(label) ?? []), item]);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === fallback) return 1;
      if (right === fallback) return -1;
      return left.localeCompare(right);
    })
    .map(([label, items], index) => ({ key: `${field}-${index}`, label, items }));
}

/** One group of the schedule: a sticky heading plus whatever the view puts under it. */
function ScheduleGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="pub-day" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/* ------------------------------- app --------------------------------- */

// @spec PRD-PUB-001
export function PublicEventApp() {
  const { embedded, slug, section, detail } = usePublicRoute();
  const [projection, setProjection] = useState<PublicEventProjectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  // A failed submit and a confirmed one used to share one string, so a rejection
  // rendered in the success colours. The tone travels with the text instead.
  const [submissionNotice, setSubmissionNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [liveCfp, setLiveCfp] = useState<CfpFormDto | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [trackFilter, setTrackFilter] = useState("all");
  const [speakerQuery, setSpeakerQuery] = useState("");
  // A grouping is a reading preference, not a filter: it survives a trip to a session
  // and back, and it never triggers a fetch.
  const [scheduleView, setScheduleView] = useState<ScheduleView>("day");
  const mainRef = useRef<HTMLElement>(null);
  const viewKey = `${section}/${detail ?? ""}`;
  const landedOn = useRef(viewKey);
  const [filteredView, setFilteredView] = useState(section);

  // Filters belong to the view that owns them; carrying them across a section
  // change made a visitor return to a list that was silently still filtered.
  // Resetting during render (rather than in an effect) avoids a flash of the
  // previous view's filtered result set.
  if (filteredView !== section) {
    setFilteredView(section);
    setSessionQuery("");
    setTrackFilter("all");
    setSpeakerQuery("");
  }

  useEffect(() => {
    // ERROR-INTENT: React effects cannot await; handlers render loading/error outcomes.
    void getPublicEvent(slug)
      .then(setProjection)
      .catch((reason: unknown) =>
        setError(
          reason instanceof PublicApiError ? reason.message : "The event could not be loaded.",
        ),
      );
  }, [slug]);

  useEffect(() => {
    if (!projection || section !== "cfp") return;
    // ERROR-INTENT: React effects cannot await; the CFP view renders load failures.
    void loadCfp(projection.event.eventId, false)
      .then(setLiveCfp)
      .catch((reason: unknown) =>
        setSubmissionNotice({
          tone: "error",
          text: reason instanceof CfpApiError ? reason.message : "The CFP could not be loaded.",
        }),
      );
  }, [projection, section]);

  // Client-side navigation moves nothing for a screen reader on its own, so the
  // new view takes focus the way a real page load would. The first paint is a
  // real load already, so it is left alone.
  useEffect(() => {
    if (landedOn.current === viewKey) return;
    landedOn.current = viewKey;
    mainRef.current?.focus();
  }, [viewKey]);

  useEffect(() => {
    if (!projection) return;
    const originalTitle = document.title;
    const existingDescription = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const description = existingDescription ?? document.createElement("meta");
    const originalDescription = existingDescription?.content;
    if (!existingDescription) {
      description.name = "description";
      document.head.append(description);
    }
    const session =
      section === "sessions" && detail
        ? projection.sessions.find((item) => item.slug === detail)
        : undefined;
    const speaker =
      section === "speakers" && detail
        ? projection.speakers.find((item) => item.slug === detail)
        : undefined;
    const titles = {
      home: projection.event.name,
      schedule: `Schedule · ${projection.event.name}`,
      sessions: session
        ? `${session.title} · ${projection.event.name}`
        : `Sessions · ${projection.event.name}`,
      speakers: speaker
        ? `${speaker.name} · ${projection.event.name}`
        : `Speakers · ${projection.event.name}`,
      cfp: `${projection.cfp.title} · ${projection.event.name}`,
    };
    document.title = titles[section];
    description.content =
      session?.abstract ??
      speaker?.bio ??
      (section === "cfp" ? projection.cfp.description : projection.event.summary);
    return () => {
      document.title = originalTitle;
      if (existingDescription) description.content = originalDescription ?? "";
      else description.remove();
    };
  }, [detail, projection, section]);

  const model = useMemo(() => {
    if (!projection) return null;
    const timezone = projection.event.timezone;
    const ordered = [...projection.sessions].sort((left, right) =>
      (left.startsAt ?? "9999").localeCompare(right.startsAt ?? "9999"),
    );
    const timed = ordered.filter((item) => item.startsAt);
    const untimed = ordered.filter((item) => !item.startsAt);
    const days: {
      key: string;
      label: string;
      slots: { time: string; endsAt: string | undefined; items: PublicSession[] }[];
    }[] = [];
    for (const item of timed) {
      const startsAt = item.startsAt ?? "";
      const key = dayKey(startsAt, timezone);
      let day = days.find((entry) => entry.key === key);
      if (!day) {
        day = { key, label: dayLabel(startsAt, timezone), slots: [] };
        days.push(day);
      }
      let slot = day.slots.find((entry) => entry.time === startsAt);
      if (!slot) {
        slot = { time: startsAt, endsAt: item.endsAt, items: [] };
        day.slots.push(slot);
      } else if (!item.endsAt) {
        // One open-ended session in the block means the block has no honest end time.
        slot.endsAt = undefined;
      } else if (slot.endsAt && Date.parse(item.endsAt) > Date.parse(slot.endsAt)) {
        // Concurrent sessions can run different lengths; the rail describes the block,
        // so it spans to the last one to finish. Each card still carries its own length.
        slot.endsAt = item.endsAt;
      }
      slot.items.push(item);
    }
    const sessionsBySpeaker = new Map<string, PublicSession[]>();
    for (const item of ordered)
      for (const speakerSlug of item.speakerSlugs)
        sessionsBySpeaker.set(speakerSlug, [...(sessionsBySpeaker.get(speakerSlug) ?? []), item]);
    return {
      timezone,
      zone: zoneAbbreviation(timezone, projection.event.startsOn),
      dates: eventDates(projection.event),
      ordered,
      timed,
      untimed,
      days,
      tracks: [...new Set(projection.sessions.map((item) => item.track).filter(Boolean))].sort(),
      sessionsBySpeaker,
      speakersOf: (item: PublicSession) =>
        item.speakerSlugs
          .map((speakerSlug) => projection.speakers.find((entry) => entry.slug === speakerSlug))
          .filter((entry): entry is PublicSpeaker => Boolean(entry)),
    };
  }, [projection]);

  if (error)
    return (
      <main className="public-state">
        <h1>Event unavailable</h1>
        <p role="alert">{error}</p>
      </main>
    );

  if (!projection || !model)
    return (
      <main className="public-state">
        <p role="status">Loading published event…</p>
      </main>
    );

  const base = `${embedded ? "/embed" : ""}/events/${slug}`;
  const site = `/events/${slug}`;
  const session =
    section === "sessions" && detail
      ? projection.sessions.find((item) => item.slug === detail)
      : undefined;
  const speaker =
    section === "speakers" && detail
      ? projection.speakers.find((item) => item.slug === detail)
      : undefined;

  const submitCfp = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setSubmissionNotice(null);
    setFieldErrors({});
    try {
      const confirmation = await submitProposal(projection.event.eventId, answers, submissionKey);
      setSubmissionNotice({
        tone: "ok",
        text: `Proposal received. Confirmation: ${confirmation.confirmationId}`,
      });
      setSubmissionKey(crypto.randomUUID());
      setAnswers({});
    } catch (reason) {
      // ERROR-INTENT: The public form renders submission failures for the applicant.
      if (reason instanceof CfpApiError) setFieldErrors(reason.envelope.error.fieldErrors ?? {});
      setSubmissionNotice({
        tone: "error",
        text:
          reason instanceof CfpApiError ? reason.message : "The proposal could not be submitted.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (
    (detail && section === "sessions" && !session) ||
    (detail && section === "speakers" && !speaker)
  )
    return (
      <main className="public-state">
        <h1>Page not found</h1>
        <p>The requested published item is unavailable.</p>
      </main>
    );

  const cfpStatus = liveCfp?.status ?? projection.cfp.status;
  const needle = sessionQuery.trim().toLowerCase();
  const visibleSessions = model.ordered.filter((item) => {
    if (trackFilter !== "all" && item.track !== trackFilter) return false;
    if (!needle) return true;
    return `${item.title} ${item.abstract} ${item.track} ${item.format}`
      .toLowerCase()
      .includes(needle);
  });
  const speakerNeedle = speakerQuery.trim().toLowerCase();
  const visibleSpeakers = projection.speakers.filter((item) =>
    speakerNeedle
      ? `${item.name} ${item.organization} ${item.bio}`.toLowerCase().includes(speakerNeedle)
      : true,
  );
  const zoneLine = `All times in ${model.timezone}${model.zone ? ` (${model.zone})` : ""}.`;
  // Regrouping changes the page under a screen-reader user without moving focus, so the
  // new shape is announced. Visually hidden: the buttons already show it. The day view
  // buckets only *placed* sessions into days, so it counts what those days hold and
  // reports the unplaced ones separately — the same split the visible header states.
  const scheduleLabel = SCHEDULE_VIEWS.find((view) => view.id === scheduleView)?.label ?? "Day";
  const scheduleSummary =
    scheduleView === "day"
      ? `${scheduleLabel} view. ${countLabel(model.timed.length, "session")} across ${countLabel(
          model.days.length,
          "day",
        )}${
          model.untimed.length > 0
            ? `, and ${countLabel(model.untimed.length, "session")} still awaiting a time`
            : ""
        }.`
      : `${scheduleLabel} view. ${countLabel(projection.sessions.length, "session")}.`;

  const navItems = [
    { href: `${base}/schedule`, label: "Schedule", view: "schedule" as View },
    { href: `${base}/sessions`, label: "Sessions", view: "sessions" as View },
    { href: `${base}/speakers`, label: "Speakers", view: "speakers" as View },
    { href: `${base}/cfp`, label: "CFP", view: "cfp" as View },
  ];

  return (
    <div className={embedded ? "public-shell embed" : "public-shell"}>
      <header>
        {embedded ? (
          // Inside an iframe the wordmark is the one way back to the real site, so
          // it escapes the frame rather than navigating the host's embedded panel.
          <a className="brand" href={site} target="_blank" rel="noreferrer">
            {projection.event.name}
            <span className="pub-external" aria-hidden="true">
              ↗
            </span>
            <span className="pub-sr">(opens the full event site in a new tab)</span>
          </a>
        ) : (
          <a className="brand" {...linkProps(base)}>
            {projection.event.name}
          </a>
        )}
        {!embedded && (
          <nav aria-label="Event navigation">
            {navItems.map((item) => (
              <a
                key={item.view}
                {...linkProps(item.href)}
                aria-current={section === item.view ? "page" : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}
      </header>

      {/* tabIndex={-1} is a focus target for client-side navigation, not a tab stop. */}
      <main ref={mainRef} tabIndex={-1}>
        {section === "home" && (
          <>
            <div className="pub-hero">
              <p className="kicker">
                {model.dates} · {projection.event.venue}
              </p>
              <h1>{projection.event.name}</h1>
              <p className="lede">{projection.event.summary}</p>
              <div className="actions">
                <a {...linkProps(`${base}/schedule`)}>Explore the schedule</a>
                <a className="secondary" {...linkProps(`${base}/speakers`)}>
                  Meet the speakers
                </a>
              </div>
            </div>

            <dl className="pub-facts">
              <div>
                <dt>Dates</dt>
                <dd>{model.dates}</dd>
              </div>
              <div>
                <dt>Venue</dt>
                <dd>{projection.event.venue}</dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>
                  {model.timezone}
                  {model.zone ? ` (${model.zone})` : ""}
                </dd>
              </div>
              <div>
                <dt>Program</dt>
                <dd>
                  {countLabel(projection.sessions.length, "session")} ·{" "}
                  {countLabel(projection.speakers.length, "speaker")}
                </dd>
              </div>
            </dl>

            <section className="pub-section" aria-labelledby="home-schedule">
              <div className="pub-section-head">
                <h2 id="home-schedule">Schedule at a glance</h2>
                <a {...linkProps(`${base}/schedule`)}>Full schedule</a>
              </div>
              {model.timed.length === 0 ? (
                <Empty title="The schedule is not published yet">
                  Session times appear here as soon as the organizers publish the agenda.
                </Empty>
              ) : (
                <>
                  <p className="pub-tz">{zoneLine}</p>
                  <ol className="pub-glance">
                    {model.timed.slice(0, 4).map((item) => (
                      <li key={item.slug}>
                        <div className="pub-glance-when">
                          <span className="day">
                            {calendarDate(dayKey(item.startsAt ?? "", model.timezone), {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                          <time dateTime={item.startsAt}>
                            {clockTime(item.startsAt ?? "", model.timezone)}
                          </time>
                        </div>
                        <div className="pub-glance-what">
                          <a {...linkProps(`${base}/sessions/${item.slug}`)}>{item.title}</a>
                          <p>{[item.room, item.track].filter(Boolean).join(" · ")}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </section>

            <section className="pub-section" aria-labelledby="home-speakers">
              <div className="pub-section-head">
                <h2 id="home-speakers">Speakers</h2>
                {projection.speakers.length > 0 && (
                  <a {...linkProps(`${base}/speakers`)}>
                    All {countLabel(projection.speakers.length, "speaker")}
                  </a>
                )}
              </div>
              {projection.speakers.length === 0 ? (
                <Empty title="Speakers are still being confirmed">
                  The gallery fills in as accepted speakers complete their profiles.
                </Empty>
              ) : (
                <div className="pub-gallery">
                  {projection.speakers.slice(0, 6).map((item) => (
                    <SpeakerCard
                      key={item.slug}
                      speaker={item}
                      base={base}
                      sessions={model.sessionsBySpeaker.get(item.slug) ?? []}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="pub-cta" aria-labelledby="home-cfp">
              <div>
                <p className="kicker">Call for proposals</p>
                <h2 id="home-cfp">{projection.cfp.title}</h2>
                <p>{projection.cfp.description}</p>
              </div>
              <div className="pub-cta-side">
                <Pill tone={projection.cfp.status === "open" ? "ok" : "neutral"}>
                  {projection.cfp.status === "open" ? "Open" : "Closed"}
                </Pill>
                <a className="pub-button" {...linkProps(`${base}/cfp`)}>
                  {projection.cfp.status === "open" ? "Submit a proposal" : "Read the CFP"}
                </a>
              </div>
            </section>
          </>
        )}

        {section === "schedule" && (
          <>
            <div className="pub-head">
              <p className="kicker">Published schedule</p>
              <h1>Plan your time</h1>
              {/* The zone belongs to the whole itinerary, so it is stated here and
                  nowhere else — the cards below carry bare clock times. */}
              <p className="pub-tz">
                {zoneLine} {countLabel(model.timed.length, "session")} across{" "}
                {countLabel(model.days.length, "day")}.
                {model.untimed.length > 0
                  ? ` ${countLabel(model.untimed.length, "session")} still awaiting a time.`
                  : ""}
              </p>
            </div>
            {projection.sessions.length === 0 ? (
              <Empty level={2} title="No sessions published yet">
                The published schedule does not have sessions yet. Check back once the organizers
                place the agenda.
              </Empty>
            ) : (
              <>
                {/*
                 * A native fieldset for the group and plain buttons inside it: they are
                 * in the tab order, fire on Enter and Space for free, and carry their
                 * own pressed state. The legend names the group for a screen reader;
                 * sighted users read the pressed button. Every grouping is computed from
                 * the projection already in state — no refetch.
                 */}
                <fieldset className="pub-viewswitch">
                  <legend className="pub-sr">Group the schedule by</legend>
                  {SCHEDULE_VIEWS.map((view) => (
                    <button
                      key={view.id}
                      type="button"
                      aria-pressed={scheduleView === view.id}
                      onClick={() => setScheduleView(view.id)}
                    >
                      {view.label}
                    </button>
                  ))}
                </fieldset>
                <p className="pub-sr" role="status">
                  {scheduleSummary}
                </p>

                {scheduleView === "day" && (
                  <>
                    {model.days.map((day) => (
                      <ScheduleGroup key={day.key} id={`day-${day.key}`} title={day.label}>
                        <ol className="pub-slots">
                          {day.slots.map((slot) => (
                            <li className="pub-slot" key={slot.time}>
                              <p className="pub-slot-time">
                                <TimeRange
                                  startsAt={slot.time}
                                  endsAt={slot.endsAt}
                                  timezone={model.timezone}
                                />
                              </p>
                              <div className="pub-slot-items">
                                {slot.items.map((item) => (
                                  <SessionCard
                                    key={item.slug}
                                    session={item}
                                    base={base}
                                    timezone={model.timezone}
                                    speakers={model.speakersOf(item)}
                                  />
                                ))}
                              </div>
                            </li>
                          ))}
                        </ol>
                      </ScheduleGroup>
                    ))}
                    {model.untimed.length > 0 && (
                      <ScheduleGroup id="day-unscheduled" title="Time to be announced">
                        <div className="pub-grid">
                          {model.untimed.map((item) => (
                            <SessionCard
                              key={item.slug}
                              session={item}
                              base={base}
                              timezone={model.timezone}
                              speakers={model.speakersOf(item)}
                            />
                          ))}
                        </div>
                      </ScheduleGroup>
                    )}
                  </>
                )}

                {/* The flat view keeps the same order the day view walks, so an
                    unplaced session sits at the end rather than vanishing. */}
                {scheduleView === "list" && (
                  <ScheduleGroup id="schedule-list" title="Every session in start order">
                    <div className="pub-grid">
                      {model.ordered.map((item) => (
                        <SessionCard
                          key={item.slug}
                          session={item}
                          base={base}
                          timezone={model.timezone}
                          speakers={model.speakersOf(item)}
                          showTime
                        />
                      ))}
                    </div>
                  </ScheduleGroup>
                )}

                {(scheduleView === "track" || scheduleView === "room") &&
                  groupByField(model.ordered, scheduleView).map((group) => (
                    <ScheduleGroup key={group.key} id={`schedule-${group.key}`} title={group.label}>
                      <div className="pub-grid">
                        {group.items.map((item) => (
                          <SessionCard
                            key={item.slug}
                            session={item}
                            base={base}
                            timezone={model.timezone}
                            speakers={model.speakersOf(item)}
                            showTime
                          />
                        ))}
                      </div>
                    </ScheduleGroup>
                  ))}
              </>
            )}
          </>
        )}

        {section === "sessions" && !session && (
          <>
            <div className="pub-head">
              <p className="kicker">Program</p>
              <h1>Sessions</h1>
              <p className="pub-tz">{zoneLine}</p>
            </div>
            {projection.sessions.length === 0 ? (
              <Empty level={2} title="No sessions published yet">
                Accepted sessions appear here once the organizers publish the program.
              </Empty>
            ) : (
              <>
                <div className="pub-toolbar">
                  <div className="pub-field">
                    <label htmlFor="pub-session-search">Search sessions</label>
                    <input
                      id="pub-session-search"
                      type="search"
                      value={sessionQuery}
                      placeholder="Title, topic, or format"
                      onChange={(changeEvent) => setSessionQuery(changeEvent.target.value)}
                    />
                  </div>
                  <div className="pub-field">
                    <label htmlFor="pub-track-filter">Track</label>
                    <select
                      id="pub-track-filter"
                      value={trackFilter}
                      onChange={(changeEvent) => setTrackFilter(changeEvent.target.value)}
                    >
                      <option value="all">All tracks</option>
                      {model.tracks.map((track) => (
                        <option key={track} value={track}>
                          {track}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="pub-count" role="status">
                    Showing {visibleSessions.length} of{" "}
                    {countLabel(projection.sessions.length, "session")}
                  </p>
                </div>
                {visibleSessions.length === 0 ? (
                  <Empty level={2} title="No sessions match that filter">
                    Try a different search term or choose “All tracks”.
                  </Empty>
                ) : (
                  // The card titles are h3s, so the flat grid needs an h2 above them or
                  // the page outline jumps a level. It says nothing the toolbar has not
                  // already shown, so it is for screen readers only.
                  <section aria-labelledby="pub-session-list">
                    <h2 className="pub-sr" id="pub-session-list">
                      Session list
                    </h2>
                    <div className="pub-grid">
                      {visibleSessions.map((item) => (
                        <SessionCard
                          key={item.slug}
                          session={item}
                          base={base}
                          timezone={model.timezone}
                          speakers={model.speakersOf(item)}
                          showTime
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}

        {session && (
          <article className="pub-detail">
            <p className="pub-back">
              <a {...linkProps(`${base}/sessions`)}>← All sessions</a>
            </p>
            <div className="pub-head">
              <p className="pub-tags">
                <Pill tone="info">{session.track}</Pill>
                <Pill>{session.format}</Pill>
              </p>
              <h1>{session.title}</h1>
              {session.startsAt && (
                <p className="pub-tz">
                  <time dateTime={session.startsAt}>
                    {fullTime(session.startsAt, model.timezone)}
                  </time>
                  {model.zone ? ` ${model.zone}` : ""}
                  {duration(session) ? ` · ${duration(session)}` : ""}
                  {session.room ? ` · ${session.room}` : ""}
                </p>
              )}
            </div>
            <p className="lede">{session.abstract}</p>
            {model.speakersOf(session).length > 0 && (
              <section aria-labelledby="session-speakers" className="pub-section">
                <div className="pub-section-head">
                  <h2 id="session-speakers">Speakers</h2>
                </div>
                <div className="pub-gallery">
                  {model.speakersOf(session).map((item) => (
                    <SpeakerCard
                      key={item.slug}
                      speaker={item}
                      base={base}
                      sessions={model.sessionsBySpeaker.get(item.slug) ?? []}
                    />
                  ))}
                </div>
              </section>
            )}
          </article>
        )}

        {section === "speakers" && !speaker && (
          <>
            <div className="pub-head">
              <p className="kicker">People</p>
              <h1>Speakers</h1>
              <p className="pub-tz">
                {countLabel(projection.speakers.length, "speaker")} presenting{" "}
                {countLabel(projection.sessions.length, "session")}.
              </p>
            </div>
            {projection.speakers.length === 0 ? (
              <Empty level={2} title="No speakers published yet">
                Speaker profiles appear here once the organizers publish the program.
              </Empty>
            ) : (
              <>
                <div className="pub-toolbar">
                  <div className="pub-field">
                    <label htmlFor="pub-speaker-search">Search speakers</label>
                    <input
                      id="pub-speaker-search"
                      type="search"
                      value={speakerQuery}
                      placeholder="Name or expertise"
                      onChange={(changeEvent) => setSpeakerQuery(changeEvent.target.value)}
                    />
                  </div>
                  <p className="pub-count" role="status">
                    Showing {visibleSpeakers.length} of{" "}
                    {countLabel(projection.speakers.length, "speaker")}
                  </p>
                </div>
                {visibleSpeakers.length === 0 ? (
                  <Empty level={2} title="No speakers match that search">
                    Clear the search box to see the whole gallery.
                  </Empty>
                ) : (
                  // Same reason as the session grid: an h2 keeps the outline unbroken
                  // above the h3 on every speaker card.
                  <section aria-labelledby="pub-speaker-list">
                    <h2 className="pub-sr" id="pub-speaker-list">
                      Speaker list
                    </h2>
                    <div className="pub-gallery">
                      {visibleSpeakers.map((item) => (
                        <SpeakerCard
                          key={item.slug}
                          speaker={item}
                          base={base}
                          sessions={model.sessionsBySpeaker.get(item.slug) ?? []}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}

        {speaker && (
          <article className="pub-detail">
            <p className="pub-back">
              <a {...linkProps(`${base}/speakers`)}>← All speakers</a>
            </p>
            <div className="pub-profile">
              <Avatar speaker={speaker} large />
              <div className="pub-head">
                <p className="kicker">Speaker</p>
                <h1>{speaker.name}</h1>
                <SpeakerHeadline speaker={speaker} />
              </div>
            </div>
            <p className="lede">{speaker.bio}</p>
            {(model.sessionsBySpeaker.get(speaker.slug) ?? []).length > 0 && (
              <section aria-labelledby="speaker-sessions" className="pub-section">
                <div className="pub-section-head">
                  <h2 id="speaker-sessions">Sessions</h2>
                </div>
                <div className="pub-grid">
                  {(model.sessionsBySpeaker.get(speaker.slug) ?? []).map((item) => (
                    <SessionCard
                      key={item.slug}
                      session={item}
                      base={base}
                      timezone={model.timezone}
                      speakers={model.speakersOf(item)}
                      showTime
                    />
                  ))}
                </div>
              </section>
            )}
          </article>
        )}

        {section === "cfp" && (
          <article className="pub-detail">
            <div className="pub-head">
              <p className="kicker">Call for proposals</p>
              <h1>{liveCfp?.title ?? projection.cfp.title}</h1>
              <p className="pub-tz">
                <Pill tone={cfpStatus === "open" ? "ok" : "neutral"}>
                  {cfpStatus === "open" ? "Open" : "Closed"}
                </Pill>
                {cfpStatus === "open" ? "Open for submissions." : "Submissions closed."}
              </p>
            </div>
            <p className="lede">{liveCfp?.description ?? projection.cfp.description}</p>
            {liveCfp?.status === "open" && (
              <form className="pub-form" onSubmit={submitCfp}>
                {liveCfp.fields.map((field) => {
                  const errors = fieldErrors[`answers.${field.id}`] ?? [];
                  const errorId = `public-cfp-${field.id}-error`;
                  return (
                    <div className="pub-cfp-field" key={field.id}>
                      <label htmlFor={`public-cfp-${field.id}`}>
                        {field.label}
                        {field.required ? " *" : ""}
                      </label>
                      {field.guidance && <small>{field.guidance}</small>}
                      {field.type === "long_text" ? (
                        <textarea
                          id={`public-cfp-${field.id}`}
                          required={field.required}
                          aria-invalid={errors.length > 0}
                          aria-describedby={errors.length ? errorId : undefined}
                          value={answers[field.id] ?? ""}
                          onChange={(event) =>
                            setAnswers({ ...answers, [field.id]: event.target.value })
                          }
                        />
                      ) : field.type === "select" ? (
                        <select
                          id={`public-cfp-${field.id}`}
                          required={field.required}
                          aria-invalid={errors.length > 0}
                          aria-describedby={errors.length ? errorId : undefined}
                          value={answers[field.id] ?? ""}
                          onChange={(event) =>
                            setAnswers({ ...answers, [field.id]: event.target.value })
                          }
                        >
                          <option value="">Choose an option</option>
                          {field.options.map((option) => (
                            <option key={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`public-cfp-${field.id}`}
                          type={field.type === "email" ? "email" : "text"}
                          required={field.required}
                          aria-invalid={errors.length > 0}
                          aria-describedby={errors.length ? errorId : undefined}
                          value={answers[field.id] ?? ""}
                          onChange={(event) =>
                            setAnswers({ ...answers, [field.id]: event.target.value })
                          }
                        />
                      )}
                      {errors.length > 0 && (
                        <ul id={errorId} className="pub-field-errors">
                          {errors.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
                <button className="primary" type="submit" disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit proposal"}
                </button>
              </form>
            )}
            {submissionNotice ? (
              <p
                className={submissionNotice.tone === "error" ? "pub-notice is-error" : "pub-notice"}
                role={submissionNotice.tone === "error" ? "alert" : "status"}
              >
                {/* The tone is never carried by colour alone. */}
                {submissionNotice.tone === "error" ? "Not submitted — " : ""}
                {submissionNotice.text}
              </p>
            ) : (
              // A permanently mounted live region announces the outcome reliably; one
              // that appears at the same moment as its text is often missed. Same
              // reasoning as useActionFeedback in the console shell.
              <span className="pub-sr" role="status" aria-live="polite" />
            )}
          </article>
        )}

        {embedded && (
          <p className="pub-embed-cta">
            <a
              href={`${site}/${section === "home" ? "" : section}`}
              target="_blank"
              rel="noreferrer"
            >
              Open the full event site
              <span className="pub-external" aria-hidden="true">
                ↗
              </span>
            </a>
          </p>
        )}
      </main>

      <footer>
        <p>Published by Project Greenroom</p>
      </footer>
    </div>
  );
}
