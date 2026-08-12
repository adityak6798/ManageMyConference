/*
 * "Add this session to my calendar", for the two web clients that take a URL.
 *
 * Google Calendar and Outlook both accept a pre-filled compose link, which is the only way to
 * reach them from a browser without OAuth — native calendar API integration is explicitly out of
 * scope (`PORT-CALENDAR`). Apple Calendar and everything else take the `.ics` download the portal
 * already offers, and an emailed invitation is the third route (`speaker.calendar_invite`).
 *
 * Both builders are pure and take the session's stored strings, so they can be tested without a
 * DOM and produce the same URL on every run.
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
 * `outlook.office.com` is the work/school host; personal accounts live on `outlook.live.com`.
 * Microsoft redirects between them for a signed-in user, and the office host is the one a
 * conference speaker is more likely to be signed in to, so it is the single link offered rather
 * than making the speaker choose which Microsoft they are.
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
  url.searchParams.set("startdt", range.start.toISOString());
  url.searchParams.set("enddt", range.end.toISOString());
  if (session.location) url.searchParams.set("location", session.location);
  return url.toString();
}
