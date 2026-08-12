// @acceptance ACC-SPEAKER
import { describe, expect, it } from "vitest";
import { buildSpeakerInvite } from "../src/application/content/calendar-invite";

const input = {
  event: { id: "event-1", name: "Greenroom Conf" },
  organizer: { name: "Greenroom Conf", email: "programme@greenroom.test" },
  speaker: { name: "Ada Lovelace", email: "ada@example.test" },
  session: {
    id: "session-1",
    title: "Reliable Systems",
    startsAt: "2026-09-01T16:00:00.000Z",
    endsAt: "2026-09-01T17:00:00.000Z",
    location: "Main stage",
  },
  sequence: 7,
  stamp: new Date("2026-08-12T09:00:00.000Z"),
};

/** Unfold before asserting: a long line is split across CRLF+space by RFC 5545 section 3.1. */
const lines = (ics: string) => ics.replaceAll("\r\n ", "").split("\r\n");

describe("speaker calendar invitation", () => {
  it("is an iTIP request addressed to the speaker, not a feed", () => {
    const invite = buildSpeakerInvite(input);
    if (!invite) throw new Error("A scheduled session must produce an invitation");
    const emitted = lines(invite.ics);

    // The three properties that separate an invitation from the .ics download. Without METHOD
    // and a matching ORGANIZER/ATTENDEE pair a mail client shows a file, not Accept/Decline.
    expect(emitted).toContain("METHOD:REQUEST");
    expect(emitted).toContain("ORGANIZER;CN=Greenroom Conf:mailto:programme@greenroom.test");
    expect(emitted).toContain(
      "ATTENDEE;CN=Ada Lovelace;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ada@example.test",
    );
    // RFC 5546 2.1.4: a client replaces an entry it already holds only on a higher SEQUENCE.
    expect(emitted).toContain("SEQUENCE:7");
    expect(emitted).toContain("DTSTART:20260901T160000Z");
    expect(emitted).toContain("DTEND:20260901T170000Z");
    expect(emitted).toContain("SUMMARY:Reliable Systems");
    expect(emitted).toContain("LOCATION:Main stage");
    // Deterministic: the clock is injected, so the same inputs are the same bytes.
    expect(emitted).toContain("DTSTAMP:20260812T090000Z");
    expect(invite.ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("shares the download's UID so a client updates one entry instead of keeping two", () => {
    const invite = buildSpeakerInvite(input);
    // `ContentService.calendar` writes `UID:{session.id}@greenroom` for the same session. A
    // speaker who imported the file and is then sent the invitation must end up with one entry.
    expect(invite?.uid).toBe("session-1@greenroom");
    expect(lines(invite?.ics ?? "")).toContain("UID:session-1@greenroom");
  });

  it("produces nothing for a session with no usable start", () => {
    // An unscheduled session, and a stored start with no offset — which cannot be read as an
    // instant without guessing a timezone. Both yield no invitation rather than a wrong time.
    expect(
      buildSpeakerInvite({ ...input, session: { ...input.session, startsAt: undefined } }),
    ).toBeNull();
    expect(
      buildSpeakerInvite({
        ...input,
        session: { ...input.session, startsAt: "2026-09-01T16:00:00" },
      }),
    ).toBeNull();
  });

  it("drops an end that is not after the start rather than inventing a duration", () => {
    for (const endsAt of [undefined, "2026-09-01T16:00:00.000Z", "2026-09-01T15:00:00.000Z"]) {
      const invite = buildSpeakerInvite({ ...input, session: { ...input.session, endsAt } });
      expect(lines(invite?.ics ?? "").some((line) => line.startsWith("DTEND:"))).toBe(false);
      // The start survives: the entry reads as the zero-length instant DTSTART describes.
      expect(lines(invite?.ics ?? "")).toContain("DTSTART:20260901T160000Z");
    }
  });

  it("escapes and folds text so a client can read it back unchanged", () => {
    const invite = buildSpeakerInvite({
      ...input,
      session: {
        ...input.session,
        title: `Systems, Scale; and "Reliability" — ${"very long title ".repeat(6)}`,
        location: "Room A, Level 2",
      },
    });
    const ics = invite?.ics ?? "";
    // 3.3.11: comma and semicolon are escaped inside a TEXT value.
    expect(lines(ics).find((line) => line.startsWith("SUMMARY:"))).toContain(
      "Systems\\, Scale\\; and",
    );
    expect(lines(ics)).toContain("LOCATION:Room A\\, Level 2");
    // 3.1: no emitted line exceeds 75 octets before its CRLF.
    for (const line of ics.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  /**
   * A parameter value is not a TEXT value, and getting that wrong breaks the card silently.
   *
   * `CN=` is a `param-value` (RFC 5545 §3.1), where `,` `;` `:` `"` are not permitted bare and
   * backslash is not an escape character. TEXT escaping a name into it yields `CN=Ada\, PhD`,
   * which parses as two parameter values — and a colon ends the parameter list outright, taking
   * the `mailto:` with it. The delivery still reports success; the speaker just never sees an
   * Accept button.
   */
  it("quotes a CN containing characters a parameter value cannot carry bare", () => {
    const invite = buildSpeakerInvite({
      ...input,
      organizer: { name: "Greenroom: The Conference", email: "programme@greenroom.test" },
      speaker: { name: 'Ada Lovelace, PhD "Countess"', email: "ada@example.test" },
    });
    const emitted = lines(invite?.ics ?? "");

    // Quoted, not backslash-escaped, and the mailto: value survives intact after the parameter.
    expect(emitted).toContain(
      'ORGANIZER;CN="Greenroom: The Conference":mailto:programme@greenroom.test',
    );
    expect(emitted).toContain(
      'ATTENDEE;CN="Ada Lovelace, PhD Countess";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ada@example.test',
    );
    // No TEXT escape ever appears in a parameter: a literal backslash there is the defect.
    for (const line of emitted.filter(
      (value) => value.startsWith("ORGANIZER") || value.startsWith("ATTENDEE"),
    ))
      expect(line).not.toContain("\\");
  });

  it("leaves a CN alone when it needs no quoting", () => {
    // Quoting unconditionally would be legal but noisy, and the common case should stay readable.
    const emitted = lines(buildSpeakerInvite(input)?.ics ?? "");
    expect(emitted).toContain("ORGANIZER;CN=Greenroom Conf:mailto:programme@greenroom.test");
  });

  it("never emits a negative sequence", () => {
    // SEQUENCE is a non-negative integer; a caller's bad arithmetic must not produce an ICS a
    // client rejects outright.
    expect(lines(buildSpeakerInvite({ ...input, sequence: -3 })?.ics ?? "")).toContain(
      "SEQUENCE:0",
    );
  });
});
