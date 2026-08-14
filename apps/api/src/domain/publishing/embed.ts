/**
 * A named embed, and the five things a host page can be handed.
 *
 * Issue #192's residual embed-lifecycle epic. PR #214 shipped the embed *views*; what was missing
 * was that an embed had no identity — it could not be revisited, changed, or withdrawn. This
 * module is the definition and the renderers; `embed-service.ts` is the lifecycle around them.
 *
 * **Rendering is pure and takes the published projection.** Every output below is a function of a
 * projection the organizer has already published, so no renderer can reach draft material even by
 * accident: there is nothing else in scope. That is the same argument `composePublicSchedule`
 * makes, and it is why the filters narrow a list rather than widening a query.
 *
 * **Presentation is bounded.** An accent colour and a theme, and no stylesheet. An embed that
 * could carry arbitrary CSS could carry a `background-image` URL, which is a request to a third
 * party made from a frame the visitor believes is the conference's — a tracking pixel however it
 * was meant.
 *
 * @spec PRD-PUB-001
 */
import type { PublicEventProjection, PublicScheduleProjection } from "./publication";

export type EmbedView = "schedule" | "speakers" | "gallery" | "itinerary";
export type EmbedOutput = "styled-html" | "basic-html" | "json" | "xml" | "ical";
export type EmbedTheme = "light" | "dark" | "auto";

export const EMBED_VIEWS: readonly EmbedView[] = ["schedule", "speakers", "gallery", "itinerary"];
export const EMBED_OUTPUTS: readonly EmbedOutput[] = [
  "styled-html",
  "basic-html",
  "json",
  "xml",
  "ical",
];

/**
 * The optional fields a session card may print.
 *
 * `title` is deliberately absent: it is not optional, and offering it as a choice would let
 * somebody publish a schedule of blank rows. That is the same required-field rule per-field
 * access states, arrived at independently and for the same reason.
 */
export const EMBED_FIELDS: readonly string[] = [
  "time",
  "room",
  "track",
  "format",
  "abstract",
  "speakers",
];

export interface EmbedFilters {
  readonly track?: string | undefined;
  readonly format?: string | undefined;
  /** An ISO date; the embed shows only sessions starting on it. */
  readonly day?: string | undefined;
}

export interface PublicationEmbed {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly view: EmbedView;
  /** Immutable after creation. Changing it is `duplicate`; see `1805_publication_embeds.sql`. */
  readonly output: EmbedOutput;
  readonly accent: string;
  readonly theme: EmbedTheme;
  readonly filters: EmbedFilters;
  /** Empty means every field, which is what a snippet issued before selection existed asks for. */
  readonly fields: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly revokedAt: string | null;
}

export function isEmbedAccent(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Which sessions this embed shows, in schedule order. Narrowing only — never widening. */
export function selectSessions(
  schedule: PublicScheduleProjection,
  filters: EmbedFilters,
): PublicScheduleProjection["sessions"] {
  return schedule.sessions.filter((session) => {
    if (filters.track && session.track !== filters.track) return false;
    if (filters.format && session.format !== filters.format) return false;
    // Compared on the date prefix rather than by parsing: the stored instant is already ISO, and
    // constructing a Date here would reinterpret it in the Worker's zone rather than the event's.
    if (filters.day && !session.startsAt.startsWith(filters.day)) return false;
    return true;
  });
}

const shows = (fields: readonly string[], field: string) =>
  fields.length === 0 || fields.includes(field);

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * What a host page receives, and what to say it is.
 *
 * The content type travels with the body because the transport must not guess it from the output
 * name — an `ical` served as `text/html` is a download a calendar refuses, and the failure looks
 * like the embed being broken rather than mislabelled.
 */
export interface RenderedEmbed {
  readonly contentType: string;
  readonly body: string;
}

/**
 * Render one embed over a published projection.
 *
 * `schedule` is null when the event has no published agenda; every output then renders its own
 * empty form rather than refusing, because an embed on somebody's site should say "nothing
 * scheduled yet" rather than break their page layout with an error.
 */
export function renderEmbed(
  embed: PublicationEmbed,
  projection: PublicEventProjection,
  schedule: PublicScheduleProjection | null,
): RenderedEmbed {
  const sessions = schedule ? selectSessions(schedule, embed.filters) : [];
  switch (embed.output) {
    case "json":
      return {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          // Versioned so a consumer that stored yesterday's response can tell what it holds —
          // the same reason the report JSON export carries one.
          schemaVersion: 1,
          event: { slug: projection.event.slug, name: projection.event.name },
          agenda: schedule
            ? { version: schedule.version, publishedAt: schedule.publishedAt }
            : null,
          sessions: sessions.map((session) => projectSession(session, embed.fields)),
        }),
      };
    case "xml":
      return {
        contentType: "application/xml; charset=utf-8",
        body: renderXml(embed, projection, sessions),
      };
    case "ical":
      return {
        contentType: "text/calendar; charset=utf-8",
        body: renderICal(projection, sessions),
      };
    default:
      return {
        contentType: "text/html; charset=utf-8",
        body: renderHtml(embed, projection, sessions),
      };
  }
}

/** One session, narrowed to the fields this embed prints. Absent rather than blank, as always. */
function projectSession(
  session: PublicScheduleProjection["sessions"][number],
  fields: readonly string[],
) {
  return {
    slug: session.slug,
    title: session.title,
    ...(shows(fields, "time") ? { startsAt: session.startsAt, endsAt: session.endsAt } : {}),
    ...(shows(fields, "room") && session.room ? { room: session.room } : {}),
    ...(shows(fields, "track") ? { track: session.track } : {}),
    ...(shows(fields, "format") ? { format: session.format } : {}),
    ...(shows(fields, "abstract") ? { abstract: session.abstract } : {}),
    ...(shows(fields, "speakers") ? { speakers: [...session.speakerSlugs] } : {}),
  };
}

function renderXml(
  embed: PublicationEmbed,
  projection: PublicEventProjection,
  sessions: PublicScheduleProjection["sessions"],
): string {
  const tag = (name: string, value: string) => `<${name}>${escapeHtml(value)}</${name}>`;
  const rows = sessions
    .map((session) => {
      const parts = [tag("slug", session.slug), tag("title", session.title)];
      if (shows(embed.fields, "time")) {
        parts.push(tag("startsAt", session.startsAt), tag("endsAt", session.endsAt));
      }
      if (shows(embed.fields, "room") && session.room) parts.push(tag("room", session.room));
      if (shows(embed.fields, "track")) parts.push(tag("track", session.track));
      if (shows(embed.fields, "format")) parts.push(tag("format", session.format));
      if (shows(embed.fields, "abstract")) parts.push(tag("abstract", session.abstract));
      if (shows(embed.fields, "speakers"))
        parts.push(
          `<speakers>${session.speakerSlugs.map((slug) => tag("speaker", slug)).join("")}</speakers>`,
        );
      return `<session>${parts.join("")}</session>`;
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<programme><event>${tag("slug", projection.event.slug)}${tag("name", projection.event.name)}</event>` +
    `<sessions>${rows}</sessions></programme>`
  );
}

/** RFC 5545 line folding: a content line carries at most 75 octets before its CRLF. */
const foldCalendarLine = (line: string): string => {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const folded: string[] = [];
  let current = "";
  let width = 0;
  for (const character of line) {
    const size = new TextEncoder().encode(character).length;
    // 74 on continuation lines, because the leading space counts toward the 75.
    if (width + size > (folded.length === 0 ? 75 : 74)) {
      folded.push(current);
      current = "";
      width = 0;
    }
    current += character;
    width += size;
  }
  folded.push(current);
  return folded.join("\r\n ");
};

const escapeCalendarText = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");

/** `2026-08-14T09:00:00.000Z` → `20260814T090000Z`, or null when it is not an instant. */
const calendarDateTime = (value: string): string | null => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().replaceAll(/[-:]/g, "").split(".")[0]}Z`;
};

function renderICal(
  projection: PublicEventProjection,
  sessions: PublicScheduleProjection["sessions"],
): string {
  const stamp = calendarDateTime(new Date(0).toISOString()) ?? "19700101T000000Z";
  const events = sessions.flatMap((session) => {
    const startsAt = calendarDateTime(session.startsAt);
    // A stored start that is not an instant cannot be expressed as a DATE-TIME. Such a session is
    // left out rather than written as a malformed VEVENT, which would cost the subscriber every
    // other session in the file — the same rule the speaker calendar already follows.
    if (!startsAt) return [];
    const endsAt = calendarDateTime(session.endsAt);
    return [
      "BEGIN:VEVENT",
      `UID:${escapeCalendarText(session.slug)}@${escapeCalendarText(projection.event.slug)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${startsAt}`,
      ...(endsAt && endsAt > startsAt ? [`DTEND:${endsAt}`] : []),
      `SUMMARY:${escapeCalendarText(session.title)}`,
      ...(session.room ? [`LOCATION:${escapeCalendarText(session.room)}`] : []),
      "END:VEVENT",
    ];
  });
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Greenroom//Public programme//EN",
    `X-WR-CALNAME:${escapeCalendarText(projection.event.name)}`,
    ...events,
    "END:VCALENDAR",
  ]
    .map(foldCalendarLine)
    .join("\r\n");
}

/**
 * The HTML outputs.
 *
 * `basic-html` is an unstyled fragment for a host page that has its own design system;
 * `styled-html` is a whole document carrying one inline stylesheet built from the embed's own
 * accent and theme. Inline rather than linked because an embed is served cross-origin into an
 * iframe: a linked stylesheet would be a second request the host's CSP has to allow, and an
 * embed that needs the host to change their CSP is an embed nobody installs.
 */
function renderHtml(
  embed: PublicationEmbed,
  projection: PublicEventProjection,
  sessions: PublicScheduleProjection["sessions"],
): string {
  const cards = sessions
    .map((session) => {
      const lines: string[] = [`<h3>${escapeHtml(session.title)}</h3>`];
      if (shows(embed.fields, "time"))
        lines.push(
          `<p class="when"><time datetime="${escapeHtml(session.startsAt)}">${escapeHtml(
            session.startsAt,
          )}</time></p>`,
        );
      if (shows(embed.fields, "room") && session.room)
        lines.push(`<p class="where">${escapeHtml(session.room)}</p>`);
      const tags = [
        ...(shows(embed.fields, "track") && session.track ? [session.track] : []),
        ...(shows(embed.fields, "format") && session.format ? [session.format] : []),
      ];
      if (tags.length > 0)
        lines.push(
          `<p class="tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</p>`,
        );
      if (shows(embed.fields, "abstract") && session.abstract)
        lines.push(`<p class="abstract">${escapeHtml(session.abstract)}</p>`);
      if (shows(embed.fields, "speakers") && session.speakerSlugs.length > 0)
        lines.push(`<p class="speakers">${session.speakerSlugs.map(escapeHtml).join(", ")}</p>`);
      return `<article class="session">${lines.join("")}</article>`;
    })
    .join("");
  const empty = sessions.length === 0 ? '<p class="empty">Nothing scheduled yet.</p>' : "";
  const fragment = `<div class="greenroom-embed" data-view="${escapeHtml(embed.view)}">${cards}${empty}</div>`;
  if (embed.output === "basic-html") return fragment;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(projection.event.name)}</title>`,
    `<style>${embedStylesheet(embed)}</style>`,
    "</head><body>",
    fragment,
    "</body></html>",
  ].join("");
}

/**
 * One inline stylesheet, built from bounded inputs.
 *
 * The accent is the only caller-supplied value that reaches it, and it has already been matched
 * against a six-digit hex pattern by the service *and* by the table — which is what makes
 * interpolating it here safe rather than an injection point. Nothing else about this is
 * configurable, which is the trade the module comment states.
 */
function embedStylesheet(embed: PublicationEmbed): string {
  const scheme = embed.theme === "auto" ? "light dark" : embed.theme;
  return [
    `:root{color-scheme:${scheme};--accent:${embed.accent};`,
    "font:16px/1.5 system-ui,sans-serif}",
    "body{margin:0;padding:1rem}",
    ".session{border-left:3px solid var(--accent);margin:0 0 1rem;padding:0 0 0 .75rem}",
    ".session h3{font-size:1rem;margin:0 0 .25rem}",
    ".when,.where,.tags,.speakers{color:#666;font-size:.875rem;margin:.125rem 0}",
    ".tags span{background:color-mix(in srgb,var(--accent) 15%,transparent);",
    "border-radius:999px;display:inline-block;margin-right:.25rem;padding:0 .5rem}",
    ".abstract{margin:.5rem 0 0}",
    ".empty{color:#666}",
  ].join("");
}
