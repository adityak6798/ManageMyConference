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

import { type ReactNode, useState } from "react";
import "../public-event.css";
import "../styles/public-pages.css";

import { IconExternal } from "../ui/icons";
import {
  clockTime,
  dayAndTime,
  duration,
  linkProps,
  type PublicSession,
  type PublicSpeaker,
} from "./model";

/**
 * State, and nothing else.
 *
 * The public pages used to carry their own `.pub-pill`, and used it for four different kinds of
 * thing: whether a call is open, what a proposal's decision is, which track a session is on, and
 * what format it takes. The last two are metadata — they answer "which one is this", not "what is
 * happening to it" — and a coloured chip gave them the weight of an alert. They read as plain
 * text beside the session now, and this is the shared pill, for state.
 */
function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "info" | "warn" | "danger";
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** The mark on anything that leaves the product, or leaves an embed's frame. */
function ExternalMark() {
  return (
    <span className="pub-external">
      <IconExternal size={14} />
    </span>
  );
}

/**
 * The shape of the page that is coming.
 *
 * A public page is often somebody's first request against a cold worker, so the wait is real
 * and "Loading…" is the least useful thing to put in it. One status region carries the whole
 * announcement; the bars are decoration and are hidden from it.
 */
function PageSkeleton({ label }: { label: string }) {
  return (
    <div className="pub-skeleton" role="status" aria-label={label}>
      <span className="pub-skeleton-bar is-title" aria-hidden="true" />
      <span className="pub-skeleton-bar is-short" aria-hidden="true" />
      <span className="pub-skeleton-bar" aria-hidden="true" />
      <span className="pub-skeleton-bar" aria-hidden="true" />
      <span className="pub-skeleton-bar is-short" aria-hidden="true" />
    </div>
  );
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
 *
 * The tile is the same one for everybody. It used to hash the slug into one of five `tone-*`
 * grounds, four of which were the product's *status* pairs — so a gallery put one speaker on the
 * warn ground, cream with brown initials, and another on the accent's green, off a palette where
 * those two colours mean "something is wrong" and "this is the primary action". Identity is not a
 * status, and the name is written directly underneath.
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
    <span className={className} aria-hidden="true">
      {initials(speaker.name)}
    </span>
  );
}

function SpeakerHeadline({ speaker }: { speaker: PublicSpeaker }) {
  const title = speaker.jobTitle?.trim() ?? "";
  const company = speaker.organization.trim();
  if (!title && !company) return null;
  return (
    <p className="pub-speaker-headline">
      <span className="visually-hidden">Professional headline: </span>
      {title && company ? `${title} at ${company}` : title || company}
    </p>
  );
}

/**
 * The order links are shown in, and the name each one is announced by.
 *
 * Fixed rather than derived from the stored object's key order, so two speakers' links read in
 * the same sequence and a re-save that happened to reorder the JSON cannot reorder the page.
 * A platform the projection carries but this list does not know is still rendered, under its
 * own key — dropping it would hide something the speaker deliberately published.
 */
const SOCIAL_LABELS: Readonly<Record<string, string>> = {
  website: "Website",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  github: "GitHub",
  x: "X",
  youtube: "YouTube",
};

/**
 * Is this something we are willing to put in an `href`?
 *
 * The server already refuses anything but `http:` and `https:` when the link is *written*
 * (`socialLinkSchema`), so on the shipping path this is redundant — and it is here anyway,
 * because the cost of being wrong is unusually asymmetric. This component renders a value that
 * originated with a speaker, on a public page, into an attribute where `javascript:` executes;
 * the write-time rule is one validator away from every row that predates it, from a restored
 * revision, and from anything that reaches the projection without passing through that schema.
 * A link this refuses is dropped rather than rendered inert, because a dead link an organizer can
 * see is a bug report and an inert one is a mystery.
 */
function isRenderableLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    // ERROR-INTENT: `URL` reports "not a URL at all" by throwing, and a value that cannot be
    // parsed is exactly one this must not put in an `href`. Refusing is the answer, not a crash.
    return false;
  }
}

/*
 * A speaker's own links.
 *
 * `rel="noreferrer noopener"` on every one: these are speaker-supplied destinations, and a page
 * opened from here must not be handed a reference to the programme's window. The link text is
 * the platform rather than the URL, and the speaker's name is in the accessible name too — a
 * gallery of "Website, Website, Website" tells a screen-reader user nothing about whose it is.
 */
function SpeakerLinks({ speaker }: { speaker: PublicSpeaker }) {
  const links = Object.entries(speaker.socialLinks ?? {}).filter(
    ([, url]) => Boolean(url) && isRenderableLink(url),
  );
  if (links.length === 0) return null;
  const ordered = links.toSorted(([left], [right]) => {
    const keys = Object.keys(SOCIAL_LABELS);
    const rank = (key: string) => (keys.includes(key) ? keys.indexOf(key) : keys.length);
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  return (
    <nav className="pub-speaker-links" aria-label={`Links for ${speaker.name}`}>
      <ul>
        {ordered.map(([platform, url]) => (
          <li key={platform}>
            <a href={url} rel="noreferrer noopener" target="_blank">
              {SOCIAL_LABELS[platform] ?? platform}
              <span className="visually-hidden"> — {speaker.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
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
          <span className="visually-hidden"> to </span>
          <time dateTime={endsAt}>{clockTime(endsAt, timezone)}</time>
        </>
      )}
    </span>
  );
}

/**
 * Which optional parts of a card an embed asked for.
 *
 * An empty set means "everything", so a snippet with no `fields=` parameter — every
 * snippet issued before the option existed — keeps rendering exactly as it did.
 */
const shows = (fields: ReadonlySet<string> | undefined, field: string) =>
  !fields || fields.size === 0 || fields.has(field);

function SessionCard({
  session,
  base,
  timezone,
  speakers,
  showTime,
  action,
  fields,
}: {
  session: PublicSession;
  base: string;
  timezone: string;
  speakers: PublicSpeaker[];
  showTime?: boolean;
  /** The itinerary star, when the surface offers one. */
  action?: ReactNode;
  fields?: ReadonlySet<string>;
}) {
  const length = duration(session);
  // Every meta entry is its own element so the CSS separator lands between all of
  // them; a bare text node would silently skip the first dot.
  const showClock = Boolean(showTime && session.startsAt && shows(fields, "time"));
  // Outside the day-grouped view an unplaced session would otherwise look identical to
  // a placed one whose time simply was not rendered.
  const showPending = Boolean(showTime && !session.startsAt && shows(fields, "time"));
  const showRoom = Boolean(session.room && shows(fields, "room"));
  const showTrack = Boolean(session.track && shows(fields, "track"));
  const showFormat = Boolean(session.format && shows(fields, "format"));
  const hasMeta = showClock || showPending || length || showRoom || showTrack || showFormat;
  return (
    <article className="pub-session">
      <div className="pub-session-head">
        <h3>
          <a {...linkProps(`${base}/sessions/${session.slug}`)}>{session.title}</a>
        </h3>
        {action}
      </div>
      {/*
        One metadata line for every fact about the card: when, how long, where, which track,
        which format. They used to be split between a text line and a row of coloured chips,
        which said that two of the five mattered more. They do not.
      */}
      {hasMeta && (
        <p className="pub-meta">
          {showClock && (
            <span className="figure">
              <TimeRange
                startsAt={session.startsAt ?? ""}
                endsAt={session.endsAt}
                timezone={timezone}
                withDay
              />
            </span>
          )}
          {showPending && <span>Time to be announced</span>}
          {length && shows(fields, "time") && <span className="figure">{length}</span>}
          {showRoom && <span>{session.room}</span>}
          {showTrack && <span>{session.track}</span>}
          {showFormat && <span>{session.format}</span>}
        </p>
      )}
      {shows(fields, "abstract") && <p className="pub-session-abstract">{session.abstract}</p>}
      {speakers.length > 0 && shows(fields, "speakers") && (
        <ul className="pub-session-speakers">
          {speakers.map((speaker) => (
            <li key={speaker.slug}>
              <Avatar speaker={speaker} />
              <a {...linkProps(`${base}/speakers/${speaker.slug}`)}>{speaker.name}</a>
            </li>
          ))}
        </ul>
      )}
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
 *
 * The glyph names what is missing rather than standing for emptiness in general — one tray
 * icon used to appear over the schedule, the gallery, the search results and the itinerary,
 * which taught a reader nothing about which of them they were looking at.
 */
function Empty({
  title,
  icon,
  level = 3,
  children,
}: {
  title: string;
  icon: ReactNode;
  level?: 2 | 3;
  children?: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="pub-empty">
      <span className="glyph" aria-hidden="true">
        {icon}
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
    .map(([label, items], index) => ({
      key: `${field}-${index}`,
      label,
      items,
    }));
}

/**
 * One group of the schedule: a sticky heading plus whatever the view puts under it.
 *
 * `measure` is the figure the group is about, and it sits in the same column as the times of
 * the rows beneath it, so the heading and its blocks read as one ruled column. A group with no
 * figure — a track, a room, "every session in start order" — passes nothing and leaves the
 * column empty, because a measure column that starts carrying ornaments is no longer a measure.
 */
function ScheduleGroup({
  id,
  title,
  measure,
  label,
  children,
}: {
  id: string;
  title: string;
  /** The group's own figure, shown in the measure column. Omitted when it has none. */
  measure?: string;
  /**
   * What the group is called when the two halves cannot be read together. The visible heading
   * is split across two columns, and "Thursday" on its own would name two different days of a
   * fortnight-long programme identically.
   */
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className="pub-day" aria-labelledby={id}>
      <h2 id={id}>
        <span className="visually-hidden">{label ?? title}</span>
        <span className="figure" aria-hidden="true">
          {measure ?? ""}
        </span>
        <span aria-hidden="true">{title}</span>
      </h2>
      {children}
    </section>
  );
}

/* ------------------------------- app --------------------------------- */

export {
  Avatar,
  Empty,
  ExternalMark,
  groupByField,
  initials,
  PageSkeleton,
  Pill,
  ScheduleGroup,
  SessionCard,
  SpeakerCard,
  SpeakerHeadline,
  SpeakerLinks,
  TimeRange,
};
