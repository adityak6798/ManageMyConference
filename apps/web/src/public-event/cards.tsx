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

import {
  clockTime,
  dayAndTime,
  duration,
  linkProps,
  type PublicSession,
  type PublicSpeaker,
} from "./model";

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
              <span className="pub-sr"> — {speaker.name}</span>
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
          <span className="pub-sr"> to </span>
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
  const showTags = shows(fields, "track") || shows(fields, "format");
  return (
    <article className="pub-session">
      <div className="pub-session-head">
        <h3>
          <a {...linkProps(`${base}/sessions/${session.slug}`)}>{session.title}</a>
        </h3>
        {action}
      </div>
      {(showClock || showPending || length || showRoom) && (
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
          {length && shows(fields, "time") && <span>{length}</span>}
          {showRoom && <span>{session.room}</span>}
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
      {showTags && (
        <p className="pub-tags">
          {shows(fields, "track") && <Pill tone="info">{session.track}</Pill>}
          {shows(fields, "format") && <Pill>{session.format}</Pill>}
        </p>
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
    .map(([label, items], index) => ({
      key: `${field}-${index}`,
      label,
      items,
    }));
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

export {
  Avatar,
  Empty,
  groupByField,
  initials,
  Pill,
  ScheduleGroup,
  SessionCard,
  SpeakerCard,
  SpeakerHeadline,
  SpeakerLinks,
  TimeRange,
  toneIndex,
};
