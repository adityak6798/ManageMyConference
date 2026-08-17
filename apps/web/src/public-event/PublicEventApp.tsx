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

// @spec PRD-PUB-001

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CfpApiError, type CfpFormDto, loadCfp } from "../api/cfp";
import { getPublicEventSnapshot, PublicApiError } from "../api/publication";
import "../public-event.css";
import "../styles/public-pages.css";
import { useLoad } from "../ui/primitives";

import { Field, Select } from "../ui/fields";
import { IconCalendar, IconSearch, IconSessions, IconSpeakers, IconStar } from "../ui/icons";
import {
  Avatar,
  Empty,
  ExternalMark,
  groupByField,
  PageSkeleton,
  Pill,
  ScheduleGroup,
  SessionCard,
  SpeakerCard,
  SpeakerHeadline,
  SpeakerLinks,
  TimeRange,
} from "./cards";
import { itineraryCalendar, StarButton, useItinerary } from "./itinerary";
import {
  bySurname,
  CFP_AWARE_VIEWS,
  clockTime,
  countLabel,
  dayKey,
  dayLabel,
  duration,
  eventDates,
  FILTER_DEFAULTS,
  fullTime,
  linkProps,
  type PublicSession,
  type PublicSpeaker,
  parseEmbedOptions,
  readFilters,
  SCHEDULE_VIEWS,
  type ScheduleView,
  shortDate,
  usePublicRoute,
  type View,
  weekdayLabel,
  writeFilters,
  zoneAbbreviation,
} from "./model";
import { PublicCfpView } from "./PublicCfpView";

/**
 * A page that has no event to show: the projection failed, or the address names nothing.
 *
 * It still wears the shell, so the reader is somewhere rather than nowhere. There is no event
 * name to put in the header — that is exactly what could not be read — so the product's own
 * name stands in it, and the body carries the way on.
 */
function StatePage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="public-shell">
      <header>
        <a className="brand" href="/">
          Greenroom
        </a>
      </header>
      <main className="pub-state">
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

// This routed state owner intentionally exceeds 400 lines: all route branches read one immutable
// projection and share navigation, filtering, CFP answers, focus, and scroll restoration. Each
// branch is used once, so extracting it would violate issue #70's higher-priority rule against
// presentational fragments. Reused cards, formatting, and routing live in cards.tsx/model.tsx.
export function PublicEventApp() {
  const { embedded, slug, section, detail } = usePublicRoute();
  const fetchProjection = useCallback((eventSlug: string) => getPublicEventSnapshot(eventSlug), []);
  const describeProjectionFailure = useCallback(
    (reason: unknown) =>
      reason instanceof PublicApiError ? reason.message : "The event could not be loaded.",
    [],
  );
  const { data: snapshot, error } = useLoad(slug, fetchProjection, describeProjectionFailure);
  const projection = snapshot?.projection;
  const [liveCfp, setLiveCfp] = useState<CfpFormDto | null>(null);
  // Kept apart from `submissionNotice`: "we could not read the call" is not "your
  // proposal was not submitted", and it can now happen on a page that has no form.
  const [cfpUnavailable, setCfpUnavailable] = useState<string | null>(null);
  /*
   * Seeded from the address bar, which is what makes a filtered programme shareable and
   * survive a reload. `parseRoute` has already told us whether this is an embed, where the
   * query string belongs to the host page instead.
   */
  const seeded = useRef(readFilters(embedded));
  const [sessionQuery, setSessionQuery] = useState(seeded.current.q);
  const [trackFilter, setTrackFilter] = useState(seeded.current.track);
  const [formatFilter, setFormatFilter] = useState(seeded.current.format);
  const [locationFilter, setLocationFilter] = useState(seeded.current.room);
  const [speakerQuery, setSpeakerQuery] = useState(seeded.current.q);
  // A grouping is a reading preference, not a filter: it survives a trip to a session
  // and back, and it never triggers a fetch.
  const [scheduleView, setScheduleView] = useState<ScheduleView>(seeded.current.view);
  const mainRef = useRef<HTMLElement>(null);
  /*
   * Embeds are configured by their own URL. Derived during render rather than memoised:
   * the value depends on `window.location`, which is not reactive, so a dependency array
   * could only ever be a guess at when it changed — and re-parsing four query parameters
   * costs less than being wrong about that.
   */
  /*
   * Read on an embed and only on an embed. These four parameters are how a *host page*
   * configures a snippet it pasted into its own HTML, and they were being honoured on the real
   * site too — where `?track=` silently scoped the whole programme, counts included, through a
   * knob no visitor was ever shown. That was harmless while nothing else used the query string;
   * it stops being harmless the moment the visitor's own filters live there, because one `track`
   * key cannot mean "the host chose this" and "I picked this from the Track menu" at once.
   */
  const embedOptions = parseEmbedOptions(embedded ? window.location.search : "");
  const embedTrack = embedOptions.track;
  /*
   * Starring is offered on the real site only. Inside an embed the frame is third-party,
   * so `localStorage` may be partitioned away or blocked outright, and an itinerary that
   * silently fails to persist is worse than one the surface never offered.
   */
  // Keyed on the event id, which a slug change cannot move; the slug is still needed for the
  // routable share URL and the mint call. Idle until the projection supplies the id.
  const itinerary = useItinerary(
    slug,
    projection?.event.eventId ?? "",
    !embedded || section === "itinerary",
  );
  const viewKey = `${section}/${detail ?? ""}`;
  const landedOn = useRef(viewKey);
  const [filteredView, setFilteredView] = useState(section);

  // Filters belong to the view that owns them; carrying them across a section
  // change made a visitor return to a list that was silently still filtered.
  // Resetting during render (rather than in an effect) avoids a flash of the
  // previous view's filtered result set.
  if (filteredView !== section) {
    setFilteredView(section);
    setSessionQuery(FILTER_DEFAULTS.q);
    setTrackFilter(FILTER_DEFAULTS.track);
    setFormatFilter(FILTER_DEFAULTS.format);
    setLocationFilter(FILTER_DEFAULTS.room);
    setSpeakerQuery(FILTER_DEFAULTS.q);
  }

  /*
   * The address bar follows the controls, so the filtered list is the thing that gets shared.
   * `replaceState` rather than `pushState`: a keystroke in the search box is not somewhere the
   * back button should return to. Inside an embed nothing is written at all — that query string
   * is the host page's own configuration.
   */
  useEffect(() => {
    if (embedded) return;
    writeFilters({
      q: section === "speakers" ? speakerQuery : sessionQuery,
      track: trackFilter,
      format: formatFilter,
      room: locationFilter,
      view: scheduleView,
    });
  }, [
    embedded,
    formatFilter,
    locationFilter,
    scheduleView,
    section,
    sessionQuery,
    speakerQuery,
    trackFilter,
  ]);

  /*
   * The live CFP read supplies submission fields, not display metadata. The title, description,
   * and status all stay on the active publishing version; below, the form is admitted only when
   * its CFP version is the same one recorded by that snapshot.
   */
  useEffect(() => {
    setLiveCfp(null);
    setCfpUnavailable(null);
    if (!projection || !CFP_AWARE_VIEWS.has(section)) return;
    const eventId = projection.event.eventId;
    let live = true;
    const read = () =>
      // ERROR-INTENT: React effects cannot await; both outcomes below are rendered.
      void loadCfp(eventId, false)
        .then((form) => {
          if (!live) return;
          setLiveCfp(form);
          setCfpUnavailable(null);
        })
        .catch((reason: unknown) => {
          if (!live) return;
          setLiveCfp(null);
          setCfpUnavailable(
            reason instanceof CfpApiError
              ? reason.message
              : "The call for proposals could not be loaded.",
          );
        });
    read();
    /*
     * Read again when this tab comes back to the front (issue #222).
     *
     * `effectiveStatus` is the server's answer to "may somebody submit right now", and a
     * scheduled window changes it **with no republish** — so a page that read it once and kept
     * the answer goes stale the moment an organizer moves a deadline, and keeps offering a form
     * the server will refuse. The evaluator found exactly that: the deadline was enforced, and
     * the public warning still said the call was open until somebody reloaded by hand.
     *
     * Visibility rather than an interval, and this is the trade being made. It converges the case
     * that actually happens — the deadline is changed in one tab and the public page is in
     * another — at the cost of one read when a visitor returns to the tab, and it adds no polling
     * to a page that may be open on a conference screen all day. A page left in the foreground
     * across a deadline still shows the previous answer until the visitor acts; the server refuses
     * the submission either way, so what is at stake is the wording rather than the enforcement.
     */
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
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
      gallery: `Speaker gallery · ${projection.event.name}`,
      itinerary: `My itinerary · ${projection.event.name}`,
      cfp: `${projection.cfp.title} · ${projection.event.name}`,
    } satisfies Record<View, string>;
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
    /*
     * An embed's `track=` narrows the programme itself, before anything is grouped or
     * counted. Applying it further downstream is what made it a lie on three of the four
     * widgets: only the sessions list read the filtered array, so a host page that pasted
     * the *schedule* snippet with a track chosen got the whole programme back.
     *
     * Unlike the visitor's own track filter this cannot be cleared from inside the frame —
     * the host page chose it, and the embed has no navigation to change it with.
     */
    const scoped = embedTrack
      ? projection.sessions.filter((item) => item.track.toLowerCase() === embedTrack.toLowerCase())
      : projection.sessions;
    const ordered = [...scoped].sort((left, right) =>
      (left.startsAt ?? "9999").localeCompare(right.startsAt ?? "9999"),
    );
    const timed = ordered.filter((item) => item.startsAt);
    const untimed = ordered.filter((item) => !item.startsAt);
    const days: {
      key: string;
      /** The whole day, for anything that has to name it in one string. */
      label: string;
      /** The day's name, which is the heading. */
      weekday: string;
      /** The day's date, which is its measure. */
      short: string;
      slots: {
        time: string;
        endsAt: string | undefined;
        items: PublicSession[];
      }[];
    }[] = [];
    for (const item of timed) {
      const startsAt = item.startsAt ?? "";
      const key = dayKey(startsAt, timezone);
      let day = days.find((entry) => entry.key === key);
      if (!day) {
        day = {
          key,
          label: dayLabel(startsAt, timezone),
          weekday: weekdayLabel(startsAt, timezone),
          short: shortDate(startsAt, timezone),
          slots: [],
        };
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
      tracks: [...new Set(ordered.map((item) => item.track).filter(Boolean))].sort(),
      // Surname order, because a speaker directory is read as one. The gallery and the
      // list share it so the same person is in the same place on both.
      bySurname: [...projection.speakers].sort(bySurname),
      sessionsBySpeaker,
      speakersOf: (item: PublicSession) =>
        item.speakerSlugs
          .map((speakerSlug) => projection.speakers.find((entry) => entry.slug === speakerSlug))
          .filter((entry): entry is PublicSpeaker => Boolean(entry)),
    };
  }, [embedTrack, projection]);

  /*
   * A dead end is still a page: the shell, a sentence that says what happened, and something
   * to press. Both of these used to be two lines of text on a bare ground, leaving the
   * browser's Back button as the only way on.
   */
  if (error)
    return (
      <StatePage title="This event page is unavailable">
        <p className="pub-note" role="alert">
          {error}
        </p>
        <div className="actions">
          <a className="primary" href={`/events/${slug}`}>
            Try again
          </a>
        </div>
      </StatePage>
    );

  if (!projection || !model)
    return (
      <div className="public-shell">
        <header>
          <span className="brand">Greenroom</span>
        </header>
        <main className="pub-state">
          <PageSkeleton label="Loading the event programme" />
        </main>
      </div>
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

  const navItems = [
    { href: `${base}/schedule`, label: "Schedule", view: "schedule" as View },
    { href: `${base}/sessions`, label: "Sessions", view: "sessions" as View },
    { href: `${base}/speakers`, label: "Speakers", view: "speakers" as View },
    { href: `${base}/gallery`, label: "Gallery", view: "gallery" as View },
    { href: `${base}/itinerary`, label: "My itinerary", view: "itinerary" as View },
    // Not "CFP". An attendee reading a conference site has no reason to know the acronym, and
    // this is the one destination the site is asking them to act on.
    { href: `${base}/cfp`, label: "Call for proposals", view: "cfp" as View },
  ];

  const chrome = (
    <header>
      {embedded ? (
        // Inside an iframe the wordmark is the one way back to the real site, so
        // it escapes the frame rather than navigating the host's embedded panel.
        <a className="brand" href={site} target="_blank" rel="noreferrer">
          {projection.event.name}
          <ExternalMark />
          <span className="visually-hidden">(opens the full event site in a new tab)</span>
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
  );

  if (
    (detail && section === "sessions" && !session) ||
    (detail && section === "speakers" && !speaker) ||
    // Sections with no detail pages of their own. Without this, `/gallery/anything`
    // answered 200 with the gallery, so a mistyped or stale URL looked like a real page.
    (detail && (section === "gallery" || section === "itinerary" || section === "schedule"))
  )
    return (
      // The projection is in hand here, so a mistyped address keeps the event's own header and
      // every destination on it, rather than stranding the reader on an unbranded sentence.
      <div className={embedded ? "public-shell embed" : "public-shell"}>
        {chrome}
        <main className="pub-state">
          <h1>That page is not here</h1>
          <p className="pub-note">
            The address you followed does not name anything in this programme. It may have been
            renamed since the link was written.
          </p>
          <div className="actions">
            <a {...linkProps(`${base}/schedule`)}>Browse the schedule</a>
            <a className="secondary" {...linkProps(base)}>
              {projection.event.name}
            </a>
          </div>
        </main>
      </div>
    );

  /*
   * One answer about the call, used by every view that mentions it.
   *
   * Display only facts from the active publication. The separately loaded form supplies fields for
   * submission, but may have advanced after this projection response was read, so a form of a
   * different version is not allowed to speak for the call this page is showing.
   *
   * Note what this rule does once a deadline exists: the projection reports the call's *effective*
   * status, so a call whose deadline has passed reads `closed` there while the live form's own
   * published flag is still `open` — and the last clause below therefore fails **by construction**
   * on exactly the calls this lane is about. That is correct for form content and wrong for the
   * window, which is why the schedule is passed to `PublicCfpView` separately, from `liveCfp`.
   *
   * Where the schedule does decide the status it is `effectiveStatus`, which the server computes,
   * rather than `status` plus the two window timestamps: deriving it here would put the visitor's
   * own clock in charge of whether a deadline has passed, and a skewed laptop would offer a form
   * the server refuses.
   */
  const cfpVersionMatches =
    liveCfp !== null &&
    liveCfp.version === snapshot?.publication?.provenance?.cfpVersion &&
    liveCfp.title === projection.cfp.title &&
    liveCfp.description === projection.cfp.description &&
    (liveCfp.status === "closed" ? "closed" : "open") === projection.cfp.status;
  const versionedCfp = cfpVersionMatches ? liveCfp : null;
  const cfpTitle = projection.cfp.title;
  const cfpDescription = projection.cfp.description;
  /*
   * The publication decides the status; the schedule is the one thing it cannot express.
   *
   * Two rules meet here and both are kept. The publication is authoritative for what this page
   * *says* — a live form that has advanced past this snapshot is not an authority on the call this
   * page is showing, so a mismatch still reads as the published state and the CFP page explains
   * separately that its form cannot be used. But a scheduled window opens and closes a call with
   * **no republish at all**, so `projection.cfp.status` only ever reports what was true when the
   * snapshot was written: it has no way to say "opens on the 3rd" or "the deadline passed an hour
   * ago". `effectiveStatus` is computed server-side on the live read and is the only source for
   * those two.
   *
   * So the schedule overlays the published status, and only from a form of the same version — a
   * call the snapshot calls open reads as `scheduled` or `closed` when its own window says so, and
   * everything else falls back to what was published.
   */
  const scheduleState = versionedCfp?.effectiveStatus;
  const cfpStatus: "open" | "scheduled" | "closed" =
    scheduleState === "scheduled" || scheduleState === "closed"
      ? scheduleState
      : projection.cfp.status;
  const cfpStatusLine =
    cfpStatus === "scheduled"
      ? "Not open yet."
      : cfpStatus === "closed"
        ? "Submissions closed."
        : versionedCfp?.status === "open"
          ? "Open for submissions."
          : cfpUnavailable || liveCfp
            ? "Submission form unavailable."
            : "Checking submission availability…";
  const needle = sessionQuery.trim().toLowerCase();
  const visibleSessions = model.ordered.filter((item) => {
    if (trackFilter !== "all" && item.track !== trackFilter) return false;
    if (formatFilter !== "all" && item.format !== formatFilter) return false;
    if (locationFilter !== "all" && (item.room || "To be announced") !== locationFilter)
      return false;
    if (!needle) return true;
    const speakerNames = model
      .speakersOf(item)
      .map((speakerItem) => speakerItem.name)
      .join(" ");
    return `${item.title} ${item.abstract} ${item.track} ${item.format} ${item.room} ${speakerNames}`
      .toLowerCase()
      .includes(needle);
  });
  /** Whether anything is narrowing the list, and therefore whether there is anything to clear. */
  const sessionsFiltered =
    sessionQuery.trim() !== "" ||
    trackFilter !== FILTER_DEFAULTS.track ||
    formatFilter !== FILTER_DEFAULTS.format ||
    locationFilter !== FILTER_DEFAULTS.room;
  const clearFilters = () => {
    setSessionQuery(FILTER_DEFAULTS.q);
    setSpeakerQuery(FILTER_DEFAULTS.q);
    setTrackFilter(FILTER_DEFAULTS.track);
    setFormatFilter(FILTER_DEFAULTS.format);
    setLocationFilter(FILTER_DEFAULTS.room);
  };
  const formats = [
    ...new Set(projection.sessions.map((item) => item.format).filter(Boolean)),
  ].sort();
  const locations = [
    ...new Set(projection.sessions.map((item) => item.room || "To be announced")),
  ].sort();
  const speakerNeedle = speakerQuery.trim().toLowerCase();
  const visibleSpeakers = model.bySurname.filter((item) =>
    speakerNeedle
      ? `${item.name} ${item.jobTitle ?? ""} ${item.organization} ${item.bio}`
          .toLowerCase()
          .includes(speakerNeedle)
      : true,
  );
  /*
   * The itinerary's own sessions, in programme order rather than the order they were
   * starred. `model.ordered` is already sorted by start time, so filtering it preserves
   * that — which is what makes the page readable as a day plan.
   */
  const itinerarySessions = model.ordered.filter((item) => itinerary.has(item.slug));
  const itineraryDays = model.days
    .map((day) => ({
      ...day,
      slots: day.slots
        .map((slot) => ({
          ...slot,
          items: slot.items.filter((item) => itinerary.has(item.slug)),
        }))
        .filter((slot) => slot.items.length > 0),
    }))
    .filter((day) => day.slots.length > 0);
  const untimedItinerary = model.untimed.filter((item) => itinerary.has(item.slug));
  const downloadCalendar = () => {
    const calendar = itineraryCalendar(
      projection.event.name,
      slug,
      itinerarySessions,
      new Date().toISOString(),
    );
    const url = URL.createObjectURL(new Blob([calendar], { type: "text/calendar;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-itinerary.ics`;
    anchor.click();
    // Revoked on the next frame rather than immediately: Safari has not finished reading
    // the blob when `click()` returns, and revoking synchronously yields an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
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

  return (
    <div
      className={embedded ? "public-shell embed" : "public-shell"}
      // The host page's brand colour, when its snippet supplied one. Set as a custom
      // property rather than on individual rules so one value reaches every accent, and
      // only ever a literal hex colour — `parseEmbedOptions` rejects anything else before
      // it can reach a style attribute.
      {...(embedOptions.accent
        ? { style: { "--accent": embedOptions.accent } as React.CSSProperties }
        : {})}
    >
      {!embedded ? (
        <a className="pub-skip-link" href="#public-main">
          Skip to main content
        </a>
      ) : null}
      {chrome}

      {/* tabIndex={-1} is a focus target for client-side navigation, not a tab stop. */}
      <main id="public-main" ref={mainRef} tabIndex={-1}>
        {section === "home" && (
          <>
            <div className="pub-hero">
              <h1>{projection.event.name}</h1>
              {/*
                When and where, as the measure it is. It used to be a `kicker` above the title —
                12px, quiet, decorative — which is the wrong treatment for the two facts a
                visitor came to check. A newly published event has neither yet, and the
                separator goes with whichever is missing.
              */}
              <p className="pub-hero-when">
                <span className="figure">{model.dates}</span>
                {projection.event.venue ? <span>{projection.event.venue}</span> : null}
              </p>
              {/* An event published before anybody wrote a summary has an empty one, and an
                  empty paragraph reserved a line of hero-sized space. */}
              {projection.event.summary ? <p className="lede">{projection.event.summary}</p> : null}
              <div className="actions">
                <a {...linkProps(`${base}/schedule`)}>Explore the schedule</a>
                <a className="secondary" {...linkProps(`${base}/speakers`)}>
                  Meet the speakers
                </a>
              </div>
            </div>

            {/*
              What the hero has not already said. Dates and venue were repeated here verbatim,
              two inches below themselves, which is what four bordered boxes were being used to
              disguise.
            */}
            <dl className="pub-facts">
              <div>
                <dt>Time zone</dt>
                <dd>
                  {model.timezone}
                  {model.zone ? ` (${model.zone})` : ""}
                </dd>
              </div>
              <div>
                <dt>Sessions</dt>
                <dd className="figure">{projection.sessions.length}</dd>
              </div>
              <div>
                <dt>Speakers</dt>
                <dd className="figure">{projection.speakers.length}</dd>
              </div>
            </dl>

            <section className="pub-section" aria-labelledby="home-schedule">
              <div className="pub-section-head">
                <h2 id="home-schedule">How each day opens</h2>
                <a {...linkProps(`${base}/schedule`)}>Full schedule</a>
              </div>
              {model.days.length === 0 ? (
                <Empty title="The schedule is not published yet" icon={<IconCalendar />}>
                  Session times appear here as soon as the organizers publish the agenda.
                </Empty>
              ) : (
                <>
                  <p className="pub-tz">{zoneLine}</p>
                  {/*
                    One session per day, which is what "at a glance" means on a programme.
                    The first four in start order showed a visitor four sessions of Thursday
                    morning and told them nothing at all about the rest of the conference.
                  */}
                  <ol className="pub-glance">
                    {model.days.map((day) => {
                      const first = day.slots[0]?.items[0];
                      if (!first) return null;
                      return (
                        <li key={day.key}>
                          <div className="pub-glance-when">
                            <span className="figure">
                              {shortDate(first.startsAt ?? "", model.timezone)}
                            </span>
                            <time className="figure" dateTime={first.startsAt}>
                              {clockTime(first.startsAt ?? "", model.timezone)}
                            </time>
                          </div>
                          <div className="pub-glance-what">
                            <a {...linkProps(`${base}/sessions/${first.slug}`)}>{first.title}</a>
                            <p>{[first.room, first.track].filter(Boolean).join(" · ")}</p>
                          </div>
                        </li>
                      );
                    })}
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
                <Empty title="Speakers are still being confirmed" icon={<IconSpeakers />}>
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
                <h2 id="home-cfp">{cfpTitle}</h2>
                <p>{cfpDescription}</p>
              </div>
              {/* The invitation and status come from the same active publication version as
                  every other fact on this page. */}
              <div className="pub-cta-side">
                {/*
                  Four states, four labels. `cfpStatus` gained `scheduled` when the submission
                  window shipped, and a two-way `open ? "Open" : "Closed"` collapsed it into
                  "Closed" — so a visitor landing here a month before a call opens read that it
                  had ended, one click away from a page saying "Opening soon" with the date. "Opens
                  on the 3rd" and "you have missed it" are opposite messages, which is the rule the
                  CFP page states and this pill was breaking.

                  There is no "unknown" arm any more: the publication always supplies a status, and
                  a live form that cannot be read or has advanced no longer blanks this — it falls
                  back to what was published, which the CFP page explains separately.
                */}
                <Pill tone={cfpStatus === "open" ? "ok" : "neutral"}>
                  {cfpStatus === "open"
                    ? "Open"
                    : cfpStatus === "scheduled"
                      ? "Opening soon"
                      : "Closed"}
                </Pill>
                <a className="pub-button" {...linkProps(`${base}/cfp`)}>
                  {cfpStatus === "open" ? "Submit a proposal" : "Read the call"}
                </a>
              </div>
            </section>
          </>
        )}

        {section === "schedule" && (
          <>
            <div className="pub-head">
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
              <Empty level={2} title="No sessions published yet" icon={<IconCalendar />}>
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
                  <legend className="visually-hidden">Group the schedule by</legend>
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
                <p className="visually-hidden" role="status">
                  {scheduleSummary}
                </p>

                {scheduleView === "day" && (
                  <>
                    {model.days.map((day) => (
                      <ScheduleGroup
                        key={day.key}
                        id={`day-${day.key}`}
                        // The date is the day's measure and sits in the rail; the heading is the
                        // day's name. Together they are what `dayLabel` used to say twice.
                        measure={day.short}
                        title={day.weekday}
                        label={day.label}
                      >
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
                                    fields={embedOptions.fields}
                                    action={
                                      embedded ? undefined : (
                                        <StarButton session={item} itinerary={itinerary} />
                                      )
                                    }
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
                              fields={embedOptions.fields}
                              action={
                                embedded ? undefined : (
                                  <StarButton session={item} itinerary={itinerary} />
                                )
                              }
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
                          fields={embedOptions.fields}
                          action={
                            embedded ? undefined : (
                              <StarButton session={item} itinerary={itinerary} />
                            )
                          }
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
                            fields={embedOptions.fields}
                            action={
                              embedded ? undefined : (
                                <StarButton session={item} itinerary={itinerary} />
                              )
                            }
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
              <h1>Sessions</h1>
              <p className="pub-tz">{zoneLine}</p>
            </div>
            {projection.sessions.length === 0 ? (
              <Empty level={2} title="No sessions published yet" icon={<IconSessions />}>
                Accepted sessions appear here once the organizers publish the program.
              </Empty>
            ) : (
              <>
                <div className="pub-toolbar">
                  <div className="pub-field">
                    <Field label="Search sessions" id="pub-session-search">
                      {(control) => (
                        <input
                          {...control}
                          className="control"
                          type="search"
                          value={sessionQuery}
                          placeholder="Session or speaker"
                          onChange={(changeEvent) => setSessionQuery(changeEvent.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                  <div className="pub-field">
                    <Select
                      id="pub-track-filter"
                      label="Track"
                      value={trackFilter}
                      onChange={setTrackFilter}
                      options={[
                        { value: "all", label: "All tracks" },
                        ...model.tracks.map((track) => ({ value: track, label: track })),
                      ]}
                    />
                  </div>
                  <div className="pub-field">
                    <Select
                      id="pub-format-filter"
                      label="Format"
                      value={formatFilter}
                      onChange={setFormatFilter}
                      options={[
                        { value: "all", label: "All formats" },
                        ...formats.map((format) => ({ value: format, label: format })),
                      ]}
                    />
                  </div>
                  <div className="pub-field">
                    <Select
                      id="pub-location-filter"
                      label="Location"
                      value={locationFilter}
                      onChange={setLocationFilter}
                      options={[
                        { value: "all", label: "All locations" },
                        ...locations.map((location) => ({ value: location, label: location })),
                      ]}
                    />
                  </div>
                  <div className="pub-toolbar-end">
                    <p className="pub-count" role="status">
                      Showing {visibleSessions.length} of{" "}
                      {countLabel(projection.sessions.length, "session")}
                    </p>
                    {/*
                      Offered only while there is something to clear. The empty state below used
                      to tell a visitor to "reset the track, format and location filters" using a
                      control that did not exist anywhere on the page.
                    */}
                    {sessionsFiltered ? (
                      <button type="button" className="pub-button is-sm" onClick={clearFilters}>
                        Clear filters
                      </button>
                    ) : null}
                  </div>
                </div>
                {visibleSessions.length === 0 ? (
                  <Empty level={2} title="No sessions match that filter" icon={<IconSearch />}>
                    Nothing in the programme matches every filter at once. Clear them and start from
                    the whole schedule.
                  </Empty>
                ) : (
                  // The card titles are h3s, so the flat grid needs an h2 above them or
                  // the page outline jumps a level. It says nothing the toolbar has not
                  // already shown, so it is for screen readers only.
                  <section aria-labelledby="pub-session-list">
                    <h2 className="visually-hidden" id="pub-session-list">
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
                          fields={embedOptions.fields}
                          action={
                            embedded ? undefined : (
                              <StarButton session={item} itinerary={itinerary} />
                            )
                          }
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
              <h1>{session.title}</h1>
              {/* When, how long, where, which track, which format: one metadata line, in the
                  order somebody planning a day reads them. Track and format were coloured
                  chips above the title, which gave two labels the weight of a status. */}
              <p className="pub-meta">
                {session.startsAt ? (
                  <span className="figure">
                    <time dateTime={session.startsAt}>
                      {fullTime(session.startsAt, model.timezone)}
                    </time>
                    {model.zone ? ` ${model.zone}` : ""}
                  </span>
                ) : (
                  <span>Time to be announced</span>
                )}
                {duration(session) ? <span className="figure">{duration(session)}</span> : null}
                {session.room ? <span>{session.room}</span> : null}
                {session.track ? <span>{session.track}</span> : null}
                {session.format ? <span>{session.format}</span> : null}
              </p>
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
              <h1>Speakers</h1>
              <p className="pub-tz">
                {countLabel(projection.speakers.length, "speaker")} presenting{" "}
                {countLabel(projection.sessions.length, "session")}.
              </p>
            </div>
            {projection.speakers.length === 0 ? (
              <Empty level={2} title="No speakers published yet" icon={<IconSpeakers />}>
                Speaker profiles appear here once the organizers publish the program.
              </Empty>
            ) : (
              <>
                <div className="pub-toolbar">
                  <div className="pub-field">
                    <Field label="Search speakers" id="pub-speaker-search">
                      {(control) => (
                        <input
                          {...control}
                          className="control"
                          type="search"
                          value={speakerQuery}
                          placeholder="Name or expertise"
                          onChange={(changeEvent) => setSpeakerQuery(changeEvent.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                  <div className="pub-toolbar-end">
                    <p className="pub-count" role="status">
                      Showing {visibleSpeakers.length} of{" "}
                      {countLabel(projection.speakers.length, "speaker")}
                    </p>
                    {speakerQuery.trim() ? (
                      <button type="button" className="pub-button is-sm" onClick={clearFilters}>
                        Clear search
                      </button>
                    ) : null}
                  </div>
                </div>
                {visibleSpeakers.length === 0 ? (
                  <Empty level={2} title="No speakers match that search" icon={<IconSearch />}>
                    Clear the search to see the whole directory.
                  </Empty>
                ) : (
                  // Same reason as the session grid: an h2 keeps the outline unbroken
                  // above the h3 on every speaker card.
                  <section aria-labelledby="pub-speaker-list">
                    <h2 className="visually-hidden" id="pub-speaker-list">
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
                <h1>{speaker.name}</h1>
                <SpeakerHeadline speaker={speaker} />
              </div>
            </div>
            <p className="lede">{speaker.bio}</p>
            <SpeakerLinks speaker={speaker} />
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

        {/*
          The gallery and the list are two readings of one directory, not two directories.
          The list is for finding a name you already have; the gallery is for recognising a
          face you do not. Both sort by surname and both link the same detail page, so a
          session's speaker is in the same place whichever surface the visitor came from.
        */}
        {section === "gallery" && (
          <>
            <div className="pub-head">
              <h1>Speaker gallery</h1>
              <p className="pub-tz">
                {countLabel(projection.speakers.length, "speaker")}, by surname.
              </p>
            </div>
            {projection.speakers.length === 0 ? (
              <Empty level={2} title="No speakers published yet" icon={<IconSpeakers />}>
                Speaker profiles appear here once the organizers publish the program.
              </Empty>
            ) : (
              <section aria-labelledby="pub-gallery-list">
                <h2 className="visually-hidden" id="pub-gallery-list">
                  Speaker gallery
                </h2>
                <div className="pub-gallery">
                  {model.bySurname.map((item) => (
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

        {section === "itinerary" && (
          <>
            <div className="pub-head">
              <h1>My itinerary</h1>
              <p className="pub-tz">{zoneLine}</p>
            </div>
            {/*
              The itinerary is stored against an unguessable link rather than an account.
              Saying so is not legal boilerplate: it is the only way an attendee can know
              that clearing this browser's storage loses the plan, and that the share link
              hands the plan to whoever receives it.
            */}
            <p className="pub-note">
              Starred sessions are kept against a private link for this browser — no account, no
              email. Anyone with the link can see this itinerary.
            </p>
            {itinerary.failure && (
              <p className="pub-note is-warning" role="alert">
                {itinerary.failure}
              </p>
            )}
            {itinerarySessions.length === 0 ? (
              <Empty level={2} title="Nothing starred yet" icon={<IconStar />}>
                Star a session from the <a {...linkProps(`${base}/sessions`)}>sessions list</a> or
                the <a {...linkProps(`${base}/schedule`)}>schedule</a> and it appears here.
              </Empty>
            ) : (
              <>
                <div className="pub-toolbar">
                  <div className="pub-toolbar-end">
                    <p className="pub-count" role="status">
                      {countLabel(itinerarySessions.length, "session")} in your itinerary
                    </p>
                    <button type="button" className="pub-button" onClick={downloadCalendar}>
                      Download calendar (.ics)
                    </button>
                  </div>
                </div>
                {itinerary.shareUrl && (
                  <p className="pub-note">
                    Share or reopen on another device:{" "}
                    <a href={itinerary.shareUrl}>{itinerary.shareUrl}</a>
                  </p>
                )}
                <section aria-labelledby="pub-itinerary-list">
                  <h2 className="visually-hidden" id="pub-itinerary-list">
                    Starred sessions
                  </h2>
                  {itineraryDays.map((day) => (
                    <ScheduleGroup
                      key={day.key}
                      id={`itinerary-${day.key}`}
                      measure={day.short}
                      title={day.weekday}
                      label={day.label}
                    >
                      <div className="pub-grid">
                        {day.slots.flatMap((slot) =>
                          slot.items.map((item) => (
                            <SessionCard
                              key={item.slug}
                              session={item}
                              base={base}
                              timezone={model.timezone}
                              speakers={model.speakersOf(item)}
                              showTime
                              action={
                                embedded ? undefined : (
                                  <StarButton session={item} itinerary={itinerary} />
                                )
                              }
                            />
                          )),
                        )}
                      </div>
                    </ScheduleGroup>
                  ))}
                  {untimedItinerary.length > 0 && (
                    <ScheduleGroup id="itinerary-unscheduled" title="Time to be announced">
                      <div className="pub-grid">
                        {untimedItinerary.map((item) => (
                          <SessionCard
                            key={item.slug}
                            session={item}
                            base={base}
                            timezone={model.timezone}
                            speakers={model.speakersOf(item)}
                            showTime
                            action={
                              embedded ? undefined : (
                                <StarButton session={item} itinerary={itinerary} />
                              )
                            }
                          />
                        ))}
                      </div>
                    </ScheduleGroup>
                  )}
                </section>
              </>
            )}
          </>
        )}

        {section === "cfp" ? (
          <PublicCfpView
            key={projection.event.eventId}
            eventId={projection.event.eventId}
            liveCfp={versionedCfp}
            unavailable={
              cfpUnavailable ??
              (liveCfp && !cfpVersionMatches
                ? "The call changed while this programme loaded. Reload to use its latest form."
                : null)
            }
            status={cfpStatus}
            statusLine={cfpStatusLine}
            // From `liveCfp`, not `versionedCfp`: the window is live state that reaches applicants
            // without a republish, so it is stated even when the form itself is withheld.
            schedule={
              liveCfp
                ? {
                    opensAt: liveCfp.opensAt ?? null,
                    closesAt: liveCfp.closesAt ?? null,
                  }
                : null
            }
            title={cfpTitle}
            description={cfpDescription}
            timezone={model.timezone}
            // The call's own page states which event it belongs to, when that event runs and
            // where: an applicant usually arrives here from a link somebody sent them, not from
            // the programme, and the column beside the form said nothing about the conference.
            event={{
              name: projection.event.name,
              dates: model.dates,
              venue: projection.event.venue,
              zone: model.zone,
              href: base,
            }}
          />
        ) : null}

        {embedded && (
          <p className="pub-embed-cta">
            <a
              href={`${site}/${section === "home" ? "" : section}`}
              target="_blank"
              rel="noreferrer"
            >
              Open the full event site
              <ExternalMark />
            </a>
          </p>
        )}
      </main>

      <footer>
        <p>Published by Project Greenroom</p>
        {/*
          The freshness boundary, stated rather than left to be discovered. Every surface
          reads one active immutable version. Accepted source publications refresh that version;
          event/site draft fields still wait for an explicit site publish.
        */}
        <p className="pub-note">
          This page shows the current published programme. Draft changes remain private until their
          owning publication action succeeds.
        </p>
      </footer>
    </div>
  );
}
