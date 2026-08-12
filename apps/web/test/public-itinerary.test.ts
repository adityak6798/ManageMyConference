// @acceptance ACC-PUBLIC
/*
 * The two pure pieces of the attendee surface: the calendar document an itinerary
 * downloads as, and the embed configuration a host page supplies in its query string.
 *
 * Both are worth testing away from the DOM. A malformed `.ics` fails in the attendee's
 * calendar client rather than on the page, and an embed option that is honoured too
 * liberally is a hole in a surface that renders inside somebody else's site.
 */
import { describe, expect, it } from "vitest";
import { itineraryCalendar } from "../src/public-event/itinerary";
import { parseEmbedOptions } from "../src/public-event/model";

const NOW = "2026-08-20T10:00:00.000Z";

const session = (overrides: Record<string, unknown> = {}) => ({
  slug: "calm-systems",
  title: "Calm systems",
  abstract: "Design operational systems.",
  format: "Talk",
  track: "Operations",
  speakerSlugs: [],
  startsAt: "2026-09-17T17:00:00.000Z",
  endsAt: "2026-09-17T17:45:00.000Z",
  room: "Cedar Hall",
  ...overrides,
});

describe("the itinerary as calendar data", () => {
  it("produces a document a calendar client will accept", () => {
    const calendar = itineraryCalendar("Greenroom Summit", "greenroom-summit", [session()], NOW);

    expect(calendar.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(calendar.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(calendar).toContain("VERSION:2.0");
    expect(calendar).toContain("PRODID:-//Greenroom//Attendee itinerary//EN");
    expect(calendar).toContain("DTSTART:20260917T170000Z");
    expect(calendar).toContain("DTEND:20260917T174500Z");
    expect(calendar).toContain("SUMMARY:Calm systems");
    expect(calendar).toContain("LOCATION:Cedar Hall");
    // CRLF throughout, not bare LF: some importers reject the document outright otherwise.
    expect(calendar.split("\r\n").length).toBeGreaterThan(5);
    expect(calendar.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("gives each session a stable UID, so re-importing updates rather than duplicates", () => {
    const first = itineraryCalendar("Summit", "summit", [session()], NOW);
    const later = itineraryCalendar("Summit", "summit", [session()], "2026-08-25T10:00:00.000Z");

    expect(first).toContain("UID:calm-systems.summit@greenroom");
    // Only the stamp moves between two exports of the same itinerary.
    expect(first.replace(/DTSTAMP:[0-9TZ]+/, "")).toBe(later.replace(/DTSTAMP:[0-9TZ]+/, ""));
  });

  it("omits a session the organizer has not scheduled", () => {
    const calendar = itineraryCalendar(
      "Summit",
      "summit",
      [session(), session({ slug: "unplaced", startsAt: undefined, endsAt: undefined })],
      NOW,
    );

    // An event with no start is not a calendar entry, and inventing one would put a
    // session on the attendee's calendar at a time nobody announced.
    expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(calendar).not.toContain("unplaced");
  });

  it("escapes the separators that would otherwise split a property", () => {
    const calendar = itineraryCalendar(
      "Summit",
      "summit",
      [session({ title: "Ops, tools; and process\\notes", abstract: "Line one\nLine two" })],
      NOW,
    );

    expect(calendar).toContain("SUMMARY:Ops\\, tools\\; and process\\\\notes");
    expect(calendar).toContain("DESCRIPTION:Line one\\nLine two");
  });

  it("folds a long line to 75 octets, as the format requires", () => {
    const calendar = itineraryCalendar(
      "Summit",
      "summit",
      [session({ title: "A".repeat(200) })],
      NOW,
    );

    // A client that enforces the limit truncates an unfolded line, silently losing the
    // end of the title it was supposed to display.
    for (const line of calendar.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
    expect(calendar).toContain("\r\n ");
  });
});

describe("embed options a host page supplies", () => {
  it("reads a track, a field selection, an accent and the chrome switch", () => {
    const options = parseEmbedOptions(
      "?track=Operations&fields=time,room&accent=%23ff8800&chrome=none",
    );

    expect(options.track).toBe("Operations");
    expect([...options.fields]).toEqual(["time", "room"]);
    expect(options.accent).toBe("#ff8800");
    expect(options.bare).toBe(true);
  });

  it("treats an empty query as asking for everything", () => {
    const options = parseEmbedOptions("");

    // Which is what every snippet issued before these options existed asks for, so an
    // embed already pasted into somebody's site keeps rendering exactly as it did.
    expect(options.fields.size).toBe(0);
    expect(options.track).toBe("");
    expect(options.accent).toBe("");
    expect(options.bare).toBe(false);
  });

  it("refuses an accent that is not a literal hex colour", () => {
    // The value reaches a style attribute. `url(...)`, a CSS variable reference, or a
    // stray closing brace are all things a host page can put in a query string and none
    // of them belong in one.
    for (const hostile of [
      "red; background:url(https://example.test/x)",
      "var(--secret)",
      "expression(alert(1))",
      "#12",
    ])
      expect(parseEmbedOptions(`?accent=${encodeURIComponent(hostile)}`).accent).toBe("");

    expect(parseEmbedOptions("?accent=%23abc").accent).toBe("#abc");
  });
});
