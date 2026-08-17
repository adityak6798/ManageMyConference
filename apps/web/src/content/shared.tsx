/*
 * Sessions & speakers — one component, two audiences.
 *
 * Organizers get a two-pane operations view: the accepted-content table on the left
 * and the people who still owe work on the right. Speakers get a portal that leads
 * with the work assigned to them, because that is the only reason they sign in.
 *
 * Every mutation runs through `run`, which refetches the workspace and reports the
 * outcome through useActionFeedback so the confirmation lands next to the control
 * that caused it instead of at the bottom of the page.
 */

import type { ContentWorkspaceDto } from "@greenroom/contracts";
import "../styles/content.css";
import { IconClock } from "../ui/icons";
import { Pill } from "../ui/primitives";

interface Props {
  eventId: string;
  role: "organizer" | "speaker";
  /** Custom roles use the organizer layout but cannot administer anonymous share links. */
  canAdministerShares?: boolean;
}

type Workspace = ContentWorkspaceDto;
type ContentSession = Workspace["sessions"][number];
type SpeakerProfile = Workspace["speakers"][number];
type SpeakerAsset = Workspace["assets"][number];
/**
 * `NonNullable` because a custom role may hide `publicationState` (`PRD-IAM-002`), so the DTO
 * field is optional. The three states themselves are unchanged; what is optional is whether this
 * reader was sent one at all, which the render sites handle where they read it.
 */
type PublicationState = NonNullable<ContentSession["publicationState"]>;

/**
 * Only an image can be a headshot, which is the same rule the server enforces. Checking it
 * here decides whether the control is offered at all, so a speaker is not invited to nominate
 * their slide deck and then told off for it.
 */
function isImageAsset(asset: SpeakerAsset) {
  return asset.contentType.startsWith("image/");
}

/**
 * The one sentence that says what the public will and will not see.
 *
 * Choosing a headshot and publishing it are two decisions held by two people: the speaker
 * picks the picture, an organizer decides whether the file may leave the workspace. A photo
 * that is still private is shown here as chosen but withheld, so nobody believes a face is on
 * the programme when the programme is drawing their initials.
 */
function photoVisibility(asset: SpeakerAsset) {
  return asset.visibility === "publishable"
    ? "It is visible on the published programme."
    : "It is not public yet: the published programme shows initials until an organizer marks this file publishable.";
}

/**
 * The outcome of a mutation. The failure carries the rejection itself so a form can render the
 * server's field-level detail against the input that caused it, not only announce that it failed.
 */
type RunResult = { ok: true } | { ok: false; error: unknown };
type Run = (action: () => Promise<unknown>) => Promise<RunResult>;

/*
 * `withReference` used to live here: it glued "Reference: 01JD…" onto the end of a refusal, in
 * twenty-odd places, and the identifier arrived as the tail of a paragraph nobody can select it
 * out of. `describeApiFailure` answers with the sentence and the reference as two values, and
 * `useActionFeedback.announce`, `Notice` and `LoadFailure` all take the pair — so the reference
 * now sets as a copyable measure on its own line wherever this workspace reports a failure.
 */

/** One paragraph per message, tied to its control through aria-describedby. */
function FieldErrors({ id, messages }: { id: string; messages: readonly string[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <p className="error-text" id={id}>
      {messages.join(" ")}
    </p>
  );
}

/**
 * The display name for a stored actor id, or the id itself when nothing knows it.
 *
 * Audit surfaces print who did something, and an organizer reading "seed-organizer" learns
 * nothing (#154). Three sources, cheapest first: the staff directory the workspace carries, the
 * speakers it already lists, and the author names attached to comments. The raw id is the
 * deliberate fallback for an identity none of them holds — an actor who has since left the event,
 * or a system write — because inventing "Unknown" would hide a real, quotable value.
 */
function memberName(workspace: Workspace, actorId: string): string {
  const staff = workspace.actorDirectory?.find(({ id }) => id === actorId);
  if (staff) return staff.name;
  const speaker = workspace.speakers.find(({ userId }) => userId === actorId);
  if (speaker) return speaker.name;
  const comment = workspace.comments?.find(({ authorId }) => authorId === actorId);
  return comment?.authorName ?? actorId;
}

const PUBLICATION_TONE: Record<PublicationState, "neutral" | "info" | "ok"> = {
  draft: "neutral",
  ready: "info",
  published: "ok",
};

const PUBLICATION_LABEL: Record<PublicationState, string> = {
  draft: "Draft",
  ready: "Ready",
  published: "Published",
};

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function plural(count: number, singular: string, many = `${singular}s`) {
  return count === 1 ? singular : many;
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function daysUntil(iso: string, now: number) {
  return Math.round((new Date(iso).getTime() - now) / 86_400_000);
}

function dueLabel(days: number) {
  if (days < 0) return `${Math.abs(days)} ${plural(Math.abs(days), "day")} overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} ${plural(days, "day")}`;
}

function DueStatus({ days }: { days: number }) {
  if (days < 0) return <Pill tone="danger">Overdue</Pill>;
  if (days <= 3)
    return (
      <Pill tone="warn">
        <IconClock size={12} />
        Due soon
      </Pill>
    );
  return <Pill tone="info">Open</Pill>;
}

/* ========================= organizer: session editor ========================= */

type SessionDraft = {
  title: string;
  abstract: string;
  format: string;
  tags: string;
  tracks: string;
  speakerProfileIds: string[];
  publicationState: PublicationState;
};

/**
 * The editable copy of a session.
 *
 * A field this reader's role hides arrives absent, and the draft falls back to an empty value so
 * the form has something to bind to. Saving sends only fields whose values actually changed,
 * and the API independently refuses locked fields (`ContentService.updateSession` calls
 * `assertEditable`), so a presentation fallback can neither erase nor disclose a hidden value.
 */
function sessionDraft(session: ContentSession): SessionDraft {
  return {
    title: session.title,
    abstract: session.abstract ?? "",
    format: session.format ?? "",
    tags: (session.tags ?? []).join(", "),
    tracks: (session.tracks ?? []).join(", "),
    speakerProfileIds: session.speakerProfileIds,
    publicationState: session.publicationState ?? "draft",
  };
}

/**
 * What a field the reader's role hides looks like on screen.
 *
 * Named rather than blank, because a blank cell says "this speaker has no organization" while
 * this says "your role does not see this" — and only one of those is true. The projection has
 * already withheld the value, so there is nothing here to reveal: this renders an absence.
 */
export function HiddenField() {
  return (
    <span className="hint" title="Hidden by your role">
      Hidden
    </span>
  );
}

function commaList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The canonical API representation of controlled social-link inputs. */
function presentSocialLinks(links: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(links).filter(([, value]) => value.trim()));
}

/**
 * The platforms a speaker can record a link for, with the label each surface uses.
 *
 * The set is closed on the server too. Rendering it from one list here means the portal, the
 * organizer view and the public page all name a platform the same way rather than each
 * capitalizing a key on its own.
 */
const SOCIAL_PLATFORMS = [
  { key: "website", label: "Website" },
  { key: "mastodon", label: "Mastodon" },
  { key: "bluesky", label: "Bluesky" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "github", label: "GitHub" },
  { key: "x", label: "X" },
  { key: "youtube", label: "YouTube" },
] as const;

/**
 * One logical deliverable and every version of it, newest first.
 *
 * Both views listed `workspace.assets` flat, so a deck uploaded twice rendered as two rows with
 * the same name, the same date format and nothing saying which one an organizer would download
 * — the readable half of the CNT-04 defect, still true after storage started versioning
 * correctly. Grouping is derived rather than stored on the wire because `versionGroupId` is
 * already there and a second projection of the same fact could disagree with it.
 */
interface AssetVersions {
  readonly groupId: string;
  /** The version an organizer downloads and the public projection reads. */
  readonly latest: SpeakerAsset;
  /** Superseded versions, newest first. Empty for a deliverable uploaded once. */
  readonly prior: readonly SpeakerAsset[];
}

function assetVersionGroups(assets: readonly SpeakerAsset[]): AssetVersions[] {
  const groups = new Map<string, SpeakerAsset[]>();
  for (const asset of assets) {
    // A row written before versioning existed carries no group; it is its own chain of one.
    const key = asset.versionGroupId ?? asset.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(asset);
    else groups.set(key, [asset]);
  }
  return [...groups.entries()]
    .map(([groupId, members]) => {
      const ordered = members.toSorted(
        (left, right) => (right.versionNumber ?? 1) - (left.versionNumber ?? 1),
      );
      // `isLatest` is the stored answer; the highest version is the fallback for a chain that
      // predates the flag. Never both, and never neither — one row is always returned.
      const latest = ordered.find(({ isLatest }) => isLatest !== false) ?? ordered[0];
      return {
        groupId,
        latest: latest as SpeakerAsset,
        prior: ordered.filter((asset) => asset !== latest),
      };
    })
    .toSorted(
      (left, right) =>
        new Date(right.latest.uploadedAt).getTime() - new Date(left.latest.uploadedAt).getTime(),
    );
}

export type {
  AssetVersions,
  ContentSession,
  Props,
  PublicationState,
  Run,
  RunResult,
  SessionDraft,
  SpeakerAsset,
  SpeakerProfile,
  Workspace,
};
/* ------------------------- add-to-calendar links -------------------------- *
 *
 * "Add this session to my calendar", for the two web clients that take a URL.
 *
 * Google Calendar and Outlook both accept a pre-filled compose link, which is the only way to
 * reach them from a browser without OAuth — native calendar API integration is explicitly out of
 * scope (`PORT-CALENDAR`). Apple Calendar and everything else take the `.ics` download the portal
 * already offers, and an emailed invitation is the third route (`speaker.calendar_invite`).
 *
 * Pure, so they can be tested without a DOM and produce the same URL on every run.
 *
 * @spec PRD-SPK-002 PORT-CALENDAR
 */

/**
 * A stored instant, or null when it is not one.
 *
 * An explicit offset is required for the same reason the `.ics` generator requires one: a bare
 * `2026-09-15T17:00:00` is read in whatever zone the *reader* is in, so the same session would
 * land at a different hour on two speakers' calendars. Better no button than a wrong time.
 */
function instant(value: string | undefined): Date | null {
  if (!value || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** ISO 8601 in UTC without milliseconds, which is what the Outlook deeplink documents. */
function isoSeconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `YYYYMMDDTHHMMSSZ` — Google's `dates` parameter, and RFC 5545's UTC DATE-TIME form. */
function compactUtc(value: Date): string {
  return value
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export interface CalendarLinkSession {
  readonly title: string;
  readonly startsAt: string | undefined;
  readonly endsAt: string | undefined;
  readonly location: string | undefined;
}

/**
 * Start and end as instants, or null when the session has no usable start.
 *
 * An end that is missing, unparsable, or not after the start collapses to the start — the same
 * rule the `.ics` applies, where such an event reads as the zero-length instant `DTSTART` already
 * describes. Inventing a duration would put a wrong finish time on a speaker's calendar, which is
 * worse than a zero-length entry they can drag.
 */
function span(session: CalendarLinkSession): { start: Date; end: Date } | null {
  const start = instant(session.startsAt);
  if (!start) return null;
  const end = instant(session.endsAt);
  return { start, end: end && end > start ? end : start };
}

/** Whether either add-to-calendar link can be built for this session. */
export function hasCalendarLinks(session: CalendarLinkSession): boolean {
  return span(session) !== null;
}

/**
 * Google Calendar's event template.
 *
 * `action=TEMPLATE` opens the compose form pre-filled rather than writing anything, so the
 * speaker still confirms — which is the correct posture for a link they clicked, as opposed to
 * an invitation an organizer sent them.
 */
export function googleCalendarUrl(session: CalendarLinkSession): string | null {
  const range = span(session);
  if (!range) return null;
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", session.title);
  url.searchParams.set("dates", `${compactUtc(range.start)}/${compactUtc(range.end)}`);
  if (session.location) url.searchParams.set("location", session.location);
  return url.toString();
}

/**
 * Outlook's compose deeplink.
 *
 * `outlook.office.com` is the work/school host; personal accounts live on `outlook.live.com`, and
 * Microsoft does **not** reliably redirect between them — a speaker signed in to a personal
 * account may get an unhelpful page. The office host is offered as the single link because a
 * conference speaker is more often on a work account and because making them pick which Microsoft
 * they are is a worse first impression than one link that works for most. The `.ics` download
 * beside it is the route that works for everyone, which is what makes the trade acceptable.
 *
 * Times go as ISO 8601 in UTC, which is what `startdt`/`enddt` accept; the compose form then
 * renders them in the user's own zone.
 */
export function outlookCalendarUrl(session: CalendarLinkSession): string | null {
  const range = span(session);
  if (!range) return null;
  const url = new URL("https://outlook.office.com/calendar/0/deeplink/compose");
  url.searchParams.set("path", "/calendar/action/compose");
  url.searchParams.set("rru", "addevent");
  url.searchParams.set("subject", session.title);
  // Seconds precision, no milliseconds: the deeplink's parser is documented for ISO 8601 and the
  // fractional form is the least standard thing we could send it.
  url.searchParams.set("startdt", isoSeconds(range.start));
  url.searchParams.set("enddt", isoSeconds(range.end));
  if (session.location) url.searchParams.set("location", session.location);
  return url.toString();
}

export {
  assetVersionGroups,
  SOCIAL_PLATFORMS,
  commaList,
  DueStatus,
  daysUntil,
  dueLabel,
  FieldErrors,
  isImageAsset,
  memberName,
  PUBLICATION_LABEL,
  PUBLICATION_TONE,
  photoVisibility,
  presentSocialLinks,
  plural,
  sessionDraft,
  shortDate,
  shortDateTime,
};
