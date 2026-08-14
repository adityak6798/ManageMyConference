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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CfpApiError, type CfpFormDto, loadCfp } from "../api/cfp";
import { getPublicEventSnapshot, PublicApiError } from "../api/publication";
import "../public-event.css";
import "../styles/public-pages.css";
import { useLoad } from "../ui/primitives";

import {
  Avatar,
  Empty,
  groupByField,
  Pill,
  ScheduleGroup,
  SessionCard,
  SpeakerCard,
  SpeakerHeadline,
  TimeRange,
} from "./cards";
import { itineraryCalendar, StarButton, useItinerary } from "./itinerary";
import {
  bySurname,
  CFP_AWARE_VIEWS,
  calendarDate,
  clockTime,
  countLabel,
  dayKey,
  dayLabel,
  duration,
  eventDates,
  fullTime,
  linkProps,
  type PublicSession,
  type PublicSpeaker,
  parseEmbedOptions,
  SCHEDULE_VIEWS,
  type ScheduleView,
  usePublicRoute,
  type View,
  zoneAbbreviation,
} from "./model";
import { PublicCfpView } from "./PublicCfpView";
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
  const [sessionQuery, setSessionQuery] = useState("");
  const [trackFilter, setTrackFilter] = useState("all");
  const [formatFilter, setFormatFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [speakerQuery, setSpeakerQuery] = useState("");
  // A grouping is a reading preference, not a filter: it survives a trip to a session
  // and back, and it never triggers a fetch.
  const [scheduleView, setScheduleView] = useState<ScheduleView>("day");
  const mainRef = useRef<HTMLElement>(null);
  /*
   * Embeds are configured by their own URL. Derived during render rather than memoised:
   * the value depends on `window.location`, which is not reactive, so a dependency array
   * could only ever be a guess at when it changed — and re-parsing four query parameters
   * costs less than being wrong about that.
   */
  const embedOptions = parseEmbedOptions(window.location.search);
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
    setSessionQuery("");
    setTrackFilter("all");
    setFormatFilter("all");
    setLocationFilter("all");
    setSpeakerQuery("");
  }

  /*
   * The live CFP read supplies submission fields, not display metadata. The title, description,
   * and status all stay on the active publishing version; below, the form is admitted only when
   * its CFP version is the same one recorded by that snapshot.
   */
  useEffect(() => {
    setLiveCfp(null);
    setCfpUnavailable(null);
    if (!projection || !CFP_AWARE_VIEWS.has(section)) return;
    let live = true;
    // ERROR-INTENT: React effects cannot await; both outcomes below are rendered.
    void loadCfp(projection.event.eventId, false)
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
    return () => {
      live = false;
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
      label: string;
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

  if (
    (detail && section === "sessions" && !session) ||
    (detail && section === "speakers" && !speaker) ||
    // Sections with no detail pages of their own. Without this, `/gallery/anything`
    // answered 200 with the gallery, so a mistyped or stale URL looked like a real page.
    (detail && (section === "gallery" || section === "itinerary" || section === "schedule"))
  )
    return (
      <main className="public-state">
        <h1>Page not found</h1>
        <p>The requested published item is unavailable.</p>
      </main>
    );

  /*
   * One answer about the call, used by every view that mentions it. The live form decides;
   * the snapshot only supplies wording until it arrives. "unknown" is a real state and is
   * rendered as one: no pill, and a link that promises reading rather than submitting.
   */
  // Display only facts from the active publication. The separately loaded form supplies
  // fields for submission, but may have advanced after this projection response was read.
  const cfpVersionMatches =
    liveCfp !== null &&
    liveCfp.version === snapshot?.publication?.provenance?.cfpVersion &&
    liveCfp.title === projection.cfp.title &&
    liveCfp.description === projection.cfp.description &&
    (liveCfp.status === "closed" ? "closed" : "open") === projection.cfp.status;
  const versionedCfp = cfpVersionMatches ? liveCfp : null;
  const cfpStatus: "open" | "closed" = projection.cfp.status;
  const cfpTitle = projection.cfp.title;
  const cfpDescription = projection.cfp.description;
  const cfpStatusLine =
    cfpStatus === "closed"
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
  const formats = [
    ...new Set(projection.sessions.map((item) => item.format).filter(Boolean)),
  ].sort();
  const locations = [
    ...new Set(projection.sessions.map((item) => item.room || "To be announced")),
  ].sort();
  const speakerNeedle = speakerQuery.trim().toLowerCase();
  const visibleSpeakers = model.bySurname.filter((item) =>
    speakerNeedle
      ? `${item.name} ${item.organization} ${item.bio}`.toLowerCase().includes(speakerNeedle)
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

  const navItems = [
    { href: `${base}/schedule`, label: "Schedule", view: "schedule" as View },
    { href: `${base}/sessions`, label: "Sessions", view: "sessions" as View },
    { href: `${base}/speakers`, label: "Speakers", view: "speakers" as View },
    { href: `${base}/gallery`, label: "Gallery", view: "gallery" as View },
    { href: `${base}/itinerary`, label: "My itinerary", view: "itinerary" as View },
    { href: `${base}/cfp`, label: "CFP", view: "cfp" as View },
  ];

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
      <main id="public-main" ref={mainRef} tabIndex={-1}>
        {section === "home" && (
          <>
            <div className="pub-hero">
              {/* A newly published event has no venue yet; the separator goes with it. */}
              <p className="kicker">
                {[model.dates, projection.event.venue].filter(Boolean).join(" · ")}
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
                <h2 id="home-cfp">{cfpTitle}</h2>
                <p>{cfpDescription}</p>
              </div>
              {/* The invitation and status come from the same active publication version as
                  every other fact on this page. */}
              <div className="pub-cta-side">
                <Pill tone={cfpStatus === "open" ? "ok" : "neutral"}>
                  {cfpStatus === "open" ? "Open" : "Closed"}
                </Pill>
                <a className="pub-button" {...linkProps(`${base}/cfp`)}>
                  {cfpStatus === "open" ? "Submit a proposal" : "Read the CFP"}
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
                      placeholder="Session or speaker"
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
                  <div className="pub-field">
                    <label htmlFor="pub-format-filter">Format</label>
                    <select
                      id="pub-format-filter"
                      value={formatFilter}
                      onChange={(changeEvent) => setFormatFilter(changeEvent.target.value)}
                    >
                      <option value="all">All formats</option>
                      {formats.map((format) => (
                        <option key={format} value={format}>
                          {format}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pub-field">
                    <label htmlFor="pub-location-filter">Location</label>
                    <select
                      id="pub-location-filter"
                      value={locationFilter}
                      onChange={(changeEvent) => setLocationFilter(changeEvent.target.value)}
                    >
                      <option value="all">All locations</option>
                      {locations.map((location) => (
                        <option key={location} value={location}>
                          {location}
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
                    Try a different search term or reset the track, format, and location filters.
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

        {/*
          The gallery and the list are two readings of one directory, not two directories.
          The list is for finding a name you already have; the gallery is for recognising a
          face you do not. Both sort by surname and both link the same detail page, so a
          session's speaker is in the same place whichever surface the visitor came from.
        */}
        {section === "gallery" && (
          <>
            <div className="pub-head">
              <p className="kicker">People</p>
              <h1>Speaker gallery</h1>
              <p className="pub-tz">
                {countLabel(projection.speakers.length, "speaker")}, by surname.
              </p>
            </div>
            {projection.speakers.length === 0 ? (
              <Empty level={2} title="No speakers published yet">
                Speaker profiles appear here once the organizers publish the program.
              </Empty>
            ) : (
              <section aria-labelledby="pub-gallery-list">
                <h2 className="pub-sr" id="pub-gallery-list">
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
              <p className="kicker">Yours</p>
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
              <Empty level={2} title="Nothing starred yet">
                Star a session from the <a {...linkProps(`${base}/sessions`)}>sessions list</a> or
                the <a {...linkProps(`${base}/schedule`)}>schedule</a> and it appears here.
              </Empty>
            ) : (
              <>
                <div className="pub-toolbar">
                  <p className="pub-count" role="status">
                    {countLabel(itinerarySessions.length, "session")} in your itinerary
                  </p>
                  <button type="button" className="pub-button" onClick={downloadCalendar}>
                    Download calendar (.ics)
                  </button>
                </div>
                {itinerary.shareUrl && (
                  <p className="pub-note">
                    Share or reopen on another device:{" "}
                    <a href={itinerary.shareUrl}>{itinerary.shareUrl}</a>
                  </p>
                )}
                <section aria-labelledby="pub-itinerary-list">
                  <h2 className="pub-sr" id="pub-itinerary-list">
                    Starred sessions
                  </h2>
                  {itineraryDays.map((day) => (
                    <ScheduleGroup key={day.key} id={`itinerary-${day.key}`} title={day.label}>
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
            title={cfpTitle}
            description={cfpDescription}
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
              <span className="pub-external" aria-hidden="true">
                ↗
              </span>
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
