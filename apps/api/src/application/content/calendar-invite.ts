/*
 * A speaker's session as an iTIP invitation.
 *
 * This is a different artefact from `ContentService.calendar`, not a variation of it. That one is
 * a plain import feed — every scheduled session of one speaker, no METHOD, downloaded and opened.
 * This is one session, addressed to one person, carrying `METHOD:REQUEST`, an `ORGANIZER` and an
 * `ATTENDEE`, which is what makes Gmail, Outlook and Apple Calendar render an Accept/Decline card
 * and write the entry to the recipient's own calendar rather than offering them a file.
 *
 * Deliberately a pure function with no service, no repository and no communications import: the
 * organizer-triggered send calls it today, and agenda's schedule-publication fan-out (#22/#66)
 * can call it with data it already holds without depending on anything in this module's lane.
 * Everything it needs is a parameter, including the clock.
 *
 * @spec PRD-SPK-002 PRD-COM-001 PORT-CALENDAR
 */
import {
  calendarDateTime,
  escapeCalendarText,
  foldCalendarLine,
  utcCalendarStamp,
} from "./content-service";

/**
 * A `CN=` parameter value, which is **not** escaped the way a property value is.
 *
 * RFC 5545 §3.1: `param-value = paramtext / quoted-string`, and `SAFE-CHAR` excludes `,`, `;`,
 * `:` and `"`. Backslash is not an escape character there — so running a name through
 * `escapeCalendarText` (§3.3.11 TEXT escaping) produces `CN=Ada Lovelace\, PhD`, which a
 * conforming parser reads as two parameter values with a literal backslash in the first. A comma
 * splits the parameter, and a colon — as in an event called `Greenroom: The Conference` — ends the
 * parameter list early and destroys the `mailto:` value that follows it. Either way the
 * `ORGANIZER` or `ATTENDEE` is malformed, and a malformed one is exactly what stops Gmail and
 * Outlook rendering the Accept/Decline card this whole artefact exists to produce.
 *
 * So: quote when the value contains anything `paramtext` forbids, and drop the one character a
 * `quoted-string` cannot itself contain. RFC 6868's `^` encoding would preserve the quote, but it
 * is not universally implemented and a dropped quote mark in a display name is a smaller loss than
 * an invitation half the clients refuse.
 */
function calendarParameter(value: string): string {
  const safe = [...value].filter(isCalendarParameterCharacter).join("").replaceAll('"', "");
  return /[,;:]/.test(safe) ? `"${safe}"` : safe;
}

/** Control characters are forbidden in a parameter value exactly as they are in a TEXT value. */
function isCalendarParameterCharacter(character: string) {
  const code = character.codePointAt(0) ?? 0;
  return character === "\t" || (code >= 0x20 && code !== 0x7f);
}

export interface SpeakerInviteInput {
  readonly event: { readonly id: string; readonly name: string };
  /**
   * The address the invitation comes from.
   *
   * Required, never defaulted. RFC 5546 makes `ORGANIZER` mandatory on a `REQUEST`, and Gmail and
   * Outlook both check it corresponds to the sending identity before offering Accept/Decline — an
   * invented address produces an invitation that looks delivered and does nothing. The caller
   * resolves it from configuration and refuses when it has none.
   */
  readonly organizer: { readonly name: string; readonly email: string };
  readonly speaker: { readonly name: string; readonly email: string };
  readonly session: {
    readonly id: string;
    readonly title: string;
    readonly startsAt: string | undefined;
    readonly endsAt: string | undefined;
    readonly location: string | undefined;
  };
  /**
   * iTIP revision number, starting at 0.
   *
   * RFC 5546 section 2.1.4: a client applies a `REQUEST` for a `UID` it already holds only when
   * the `SEQUENCE` is higher, so re-sending an unchanged invitation is ignored rather than
   * duplicated, and a rescheduled session must arrive with a higher number or the speaker's
   * calendar keeps the old time. The caller owns that counter because it owns the history.
   */
  readonly sequence: number;
  /** Injected so the same inputs always produce the same bytes. */
  readonly stamp: Date;
}

export interface SpeakerInvite {
  readonly ics: string;
  readonly uid: string;
  readonly sequence: number;
}

/**
 * Build the invitation, or `null` when the session has no start that can be expressed.
 *
 * `null` rather than a placeholder, for the same reason the download omits such a session: an
 * absent entry is honest and an invented one puts fiction in somebody's calendar. A session that
 * has not been placed on the published agenda has no start, so it produces no invitation.
 */
export function buildSpeakerInvite(input: SpeakerInviteInput): SpeakerInvite | null {
  const startsAt = calendarDateTime(input.session.startsAt ?? "");
  if (!startsAt) return null;
  const endsAt = calendarDateTime(input.session.endsAt ?? "");
  // The same UID the download uses for this session, so a speaker who imported the file and then
  // received the invitation ends up with one entry that updates, not two that disagree.
  const uid = `${escapeCalendarText(input.session.id)}@greenroom`;
  const summary = escapeCalendarText(input.session.title);
  const location = escapeCalendarText(input.session.location ?? "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Project Greenroom//Speaker Portal//EN",
    "CALSCALE:GREGORIAN",
    // 3.7.2: METHOD must match the `method` parameter of the Content-Type this is carried under,
    // which is why the transport and the mail adapter both send `method=REQUEST` alongside it.
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcCalendarStamp(input.stamp)}`,
    `DTSTART:${startsAt}`,
    // 3.6.1: DTEND MUST be later than DTSTART. Anything else is dropped and the event reads as
    // the zero-length instant DTSTART already describes, rather than inventing a duration.
    ...(endsAt && endsAt > startsAt ? [`DTEND:${endsAt}`] : []),
    `SEQUENCE:${Math.max(0, Math.trunc(input.sequence))}`,
    // The event name gives the entry context in a calendar that shows only the summary.
    `SUMMARY:${summary || escapeCalendarText(input.event.name)}`,
    ...(location ? [`LOCATION:${location}`] : []),
    `ORGANIZER;CN=${calendarParameter(input.organizer.name)}:mailto:${input.organizer.email}`,
    // RSVP=TRUE is what asks the client for an answer; NEEDS-ACTION is the state it starts in.
    // Without them Outlook shows the entry but no Accept/Decline.
    `ATTENDEE;CN=${calendarParameter(input.speaker.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${input.speaker.email}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  return { ics: lines.map(foldCalendarLine).join("\r\n"), uid, sequence: input.sequence };
}
