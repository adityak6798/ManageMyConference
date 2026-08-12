// @acceptance ACC-SPEAKER
import { describe, expect, it } from "vitest";
import { googleCalendarUrl, hasCalendarLinks, outlookCalendarUrl } from "../src/content/shared";

const session = {
  title: "Reliable Systems",
  startsAt: "2026-09-01T16:00:00.000Z",
  endsAt: "2026-09-01T17:00:00.000Z",
  location: "Main stage",
};

describe("add-to-calendar links", () => {
  it("builds a Google template carrying the title, range and location", () => {
    const url = new URL(googleCalendarUrl(session) ?? "");
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Reliable Systems");
    // Google reads `dates` as compact UTC, start and end separated by a slash.
    expect(url.searchParams.get("dates")).toBe("20260901T160000Z/20260901T170000Z");
    expect(url.searchParams.get("location")).toBe("Main stage");
  });

  it("builds an Outlook deeplink carrying the same facts in the form it accepts", () => {
    const url = new URL(outlookCalendarUrl(session) ?? "");
    expect(url.origin + url.pathname).toBe(
      "https://outlook.office.com/calendar/0/deeplink/compose",
    );
    expect(url.searchParams.get("rru")).toBe("addevent");
    expect(url.searchParams.get("subject")).toBe("Reliable Systems");
    // Outlook takes ISO 8601, not the compact form, and renders it in the reader's own zone.
    // Seconds precision: the deeplink documents ISO 8601, and milliseconds are the least
    // standard thing we could hand its parser.
    expect(url.searchParams.get("startdt")).toBe("2026-09-01T16:00:00Z");
    expect(url.searchParams.get("enddt")).toBe("2026-09-01T17:00:00Z");
    expect(url.searchParams.get("location")).toBe("Main stage");
  });

  it("offers nothing for a session with no usable start", () => {
    // Unscheduled, and a stored time with no offset — which a reader would resolve in their own
    // zone, putting the session on the wrong hour of two speakers' calendars.
    for (const startsAt of [undefined, "2026-09-01T16:00:00"]) {
      const unusable = { ...session, startsAt };
      expect(hasCalendarLinks(unusable)).toBe(false);
      expect(googleCalendarUrl(unusable)).toBeNull();
      expect(outlookCalendarUrl(unusable)).toBeNull();
    }
  });

  it("collapses an unusable end onto the start instead of inventing a duration", () => {
    for (const endsAt of [undefined, "2026-09-01T15:00:00.000Z", "not a date"]) {
      expect(
        new URL(googleCalendarUrl({ ...session, endsAt }) ?? "").searchParams.get("dates"),
      ).toBe("20260901T160000Z/20260901T160000Z");
      expect(
        new URL(outlookCalendarUrl({ ...session, endsAt }) ?? "").searchParams.get("enddt"),
      ).toBe("2026-09-01T16:00:00Z");
    }
  });

  it("escapes a title and location that would otherwise break the query", () => {
    const url = new URL(
      googleCalendarUrl({
        ...session,
        title: "Q&A: scale, safety?",
        location: "Room A & B",
      }) ?? "",
    );
    // Read back through the parser: what matters is that the client receives the original text.
    expect(url.searchParams.get("text")).toBe("Q&A: scale, safety?");
    expect(url.searchParams.get("location")).toBe("Room A & B");
  });
});
