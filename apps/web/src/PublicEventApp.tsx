import type { PublicEventProjectionDto } from "@greenroom/contracts";
import { useEffect, useState } from "react";
import { getPublicEvent, PublicApiError } from "./api/publication";
import "./public-event.css";

type View = "home" | "schedule" | "sessions" | "speakers" | "cfp";
const route = () => {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const embedded = parts[0] === "embed";
  const offset = embedded ? 1 : 0;
  const slug = parts[offset] === "events" ? (parts[offset + 1] ?? "") : "";
  const section = parts[offset + 2] ?? "home";
  return {
    embedded,
    slug,
    section: (["schedule", "sessions", "speakers", "cfp"].includes(section)
      ? section
      : "home") as View,
    detail: parts[offset + 3],
  };
};

const dates = (projection: PublicEventProjectionDto) =>
  `${projection.event.startsOn}–${projection.event.endsOn}`;
const eventTime = (value: string, timezone: string, dateStyle: "medium" | "long" | "full") =>
  `${new Date(value).toLocaleString("en-US", {
    dateStyle,
    timeStyle: "short",
    timeZone: timezone,
  })} ${timezone}`;

// @spec PRD-PUB-001
export function PublicEventApp() {
  const [{ embedded, slug, section, detail }] = useState(route);
  const [projection, setProjection] = useState<PublicEventProjectionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  if (error)
    return (
      <main className="public-state">
        <h1>Event unavailable</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (!projection)
    return (
      <main className="public-state">
        <p role="status">Loading published event…</p>
      </main>
    );
  const base = `${embedded ? "/embed" : ""}/events/${slug}`;
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
    (detail && section === "speakers" && !speaker)
  )
    return (
      <main className="public-state">
        <h1>Page not found</h1>
        <p>The requested published item is unavailable.</p>
      </main>
    );
  return (
    <div className={embedded ? "public-shell embed" : "public-shell"}>
      <header>
        <a className="brand" href={base}>
          {projection.event.name}
        </a>
        {!embedded && (
          <nav aria-label="Event navigation">
            <a href={`${base}/schedule`}>Schedule</a>
            <a href={`${base}/sessions`}>Sessions</a>
            <a href={`${base}/speakers`}>Speakers</a>
            <a href={`${base}/cfp`}>CFP</a>
          </nav>
        )}
      </header>
      <main>
        {section === "home" && (
          <>
            <p className="kicker">
              {dates(projection)} · {projection.event.venue}
            </p>
            <h1>{projection.event.name}</h1>
            <p className="lede">{projection.event.summary}</p>
            <div className="actions">
              <a href={`${base}/schedule`}>Explore the schedule</a>
              <a href={`${base}/cfp`}>Call for proposals</a>
            </div>
          </>
        )}
        {section === "schedule" && (
          <>
            <p className="kicker">Published schedule</p>
            <h1>Plan your time</h1>
            <p>All times are shown in {projection.event.timezone}.</p>
            {projection.sessions.every(({ startsAt }) => !startsAt) && (
              <p className="empty">The published schedule does not have timed sessions yet.</p>
            )}
            <div className="cards">
              {projection.sessions
                .filter(({ startsAt }) => startsAt)
                .map((item) => (
                  <article key={item.slug}>
                    <time dateTime={item.startsAt}>
                      {eventTime(item.startsAt ?? "", projection.event.timezone, "medium")}
                    </time>
                    <h2>
                      <a href={`${base}/sessions/${item.slug}`}>{item.title}</a>
                    </h2>
                    <p>
                      {item.room ? `${item.room} · ` : ""}
                      {item.track}
                    </p>
                  </article>
                ))}
            </div>
          </>
        )}
        {section === "sessions" && !session && (
          <>
            <p className="kicker">Program</p>
            <h1>Sessions</h1>
            {projection.sessions.length === 0 && (
              <p className="empty">No sessions have been published yet.</p>
            )}
            <div className="cards">
              {projection.sessions.map((item) => (
                <article key={item.slug}>
                  <p>
                    {item.format} · {item.track}
                  </p>
                  <h2>
                    <a href={`${base}/sessions/${item.slug}`}>{item.title}</a>
                  </h2>
                  <p>{item.abstract}</p>
                </article>
              ))}
            </div>
          </>
        )}
        {session && (
          <article className="detail">
            <p className="kicker">
              {session.format} · {session.track}
            </p>
            <h1>{session.title}</h1>
            <p className="lede">{session.abstract}</p>
            {session.startsAt && (
              <p>
                <time dateTime={session.startsAt}>
                  {eventTime(session.startsAt, projection.event.timezone, "full")}
                </time>
                {session.room ? ` · ${session.room}` : ""}
              </p>
            )}
            <h2>Speakers</h2>
            {session.speakerSlugs.map((speakerSlug) => {
              const item = projection.speakers.find(({ slug: value }) => value === speakerSlug);
              return item ? (
                <p key={item.slug}>
                  <a href={`${base}/speakers/${item.slug}`}>{item.name}</a>
                </p>
              ) : null;
            })}
          </article>
        )}
        {section === "speakers" && !speaker && (
          <>
            <p className="kicker">People</p>
            <h1>Speakers</h1>
            {projection.speakers.length === 0 && (
              <p className="empty">No speakers have been published yet.</p>
            )}
            <div className="cards speaker-grid">
              {projection.speakers.map((item) => (
                <article key={item.slug}>
                  <h2>
                    <a href={`${base}/speakers/${item.slug}`}>{item.name}</a>
                  </h2>
                  <p>{item.headline}</p>
                </article>
              ))}
            </div>
          </>
        )}
        {speaker && (
          <article className="detail">
            <p className="kicker">Speaker</p>
            <h1>{speaker.name}</h1>
            <p className="lede">{speaker.headline}</p>
            <p>{speaker.bio}</p>
          </article>
        )}
        {section === "cfp" && (
          <article className="detail">
            <p className="kicker">Call for proposals</p>
            <h1>{projection.cfp.title}</h1>
            <p className="lede">{projection.cfp.description}</p>
            <p>
              {projection.cfp.status === "open" ? "Open for submissions." : "Submissions closed."}
            </p>
            {projection.cfp.status === "open" && (
              <a className="primary" href={projection.cfp.submissionUrl}>
                Submit a proposal
              </a>
            )}
          </article>
        )}
      </main>
      <footer>
        <p>Published by Project Greenroom</p>
      </footer>
    </div>
  );
}
