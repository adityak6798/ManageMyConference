// @acceptance ACC-PUBLIC
/*
 * Public surface rendering: headshots and monograms, day/track/room grouping, start–end
 * times, and the landing page below the hero.
 *
 * jsdom has no layout engine, so the 390px "no horizontal overflow" promise cannot be
 * measured here — the browser check lives in e2e/public-event.spec.ts. What this file
 * can do is guard the rules that make overflow impossible in the first place (every
 * grid track floor is `min(<px>, 100%)`, the switcher wraps, no fixed width wider than
 * a phone), and that guard runs on every commit rather than only under Playwright.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicEventApp } from "../src/PublicEventApp";

const SLUG = "greenroom-demo-summit";
/* The composer builds this server-side; the gallery must work whether or not it 200s. */
const PHOTO_URL = "/api/speaker-assets/00000000-0000-4000-8000-0000000000a1";

/*
 * A projection shaped like the one the composer emits: deliberately unsorted, two days,
 * two sessions sharing one start with different lengths, one session with no time and
 * no room, one speaker carrying a photoUrl and two without.
 */
const projection = {
  event: {
    eventId: "00000000-0000-4000-8000-000000000001",
    slug: SLUG,
    name: "Greenroom Demo Summit",
    summary: "A practical gathering for people building thoughtful, inclusive events.",
    startsOn: "2026-09-17",
    endsOn: "2026-09-18",
    timezone: "America/Los_Angeles",
    venue: "Harbor Conference Center, Oakland",
  },
  cfp: {
    title: "Share what you learned",
    description: "Submit a practical session for organizers and community builders.",
    status: "open" as const,
    publishedAt: "2026-08-01T16:00:00.000Z",
    submissionUrl: `/events/${SLUG}/cfp`,
  },
  sessions: [
    {
      slug: "closing-notes",
      title: "Closing notes",
      abstract: "What we learned together and what happens next.",
      format: "Talk",
      track: "Operations",
      speakerSlugs: ["maya-chen"],
      startsAt: "2026-09-18T16:00:00.000Z",
      endsAt: "2026-09-18T16:45:00.000Z",
      room: "Cedar Hall",
    },
    {
      slug: "accessible-by-default",
      title: "Accessible by default",
      abstract: "A hands-on guide to inclusive conference experiences.",
      format: "Workshop",
      track: "Experience",
      speakerSlugs: ["jordan-bell"],
      startsAt: "2026-09-17T18:15:00.000Z",
      endsAt: "2026-09-17T19:15:00.000Z",
      room: "Bay Studio",
    },
    {
      slug: "calm-systems",
      title: "Calm systems for busy event teams",
      abstract: "Design operational systems that make the next action obvious.",
      format: "Talk",
      track: "Operations",
      speakerSlugs: ["maya-chen"],
      startsAt: "2026-09-17T17:00:00.000Z",
      endsAt: "2026-09-17T17:45:00.000Z",
      room: "Cedar Hall",
    },
    {
      slug: "hallway-track",
      title: "The hallway track, on purpose",
      abstract: "Designing the unstructured parts of a programme.",
      format: "Roundtable",
      track: "Community",
      speakerSlugs: ["ana-ruiz", "jordan-bell"],
      startsAt: "2026-09-17T17:00:00.000Z",
      endsAt: "2026-09-17T18:00:00.000Z",
      room: "Atrium",
    },
    {
      slug: "unplaced-idea",
      title: "Community office hours",
      abstract: "Accepted, not yet placed on the grid.",
      format: "Office hours",
      track: "Community",
      speakerSlugs: ["ana-ruiz"],
    },
  ],
  speakers: [
    {
      slug: "maya-chen",
      name: "Maya Chen",
      bio: "Maya helps growing communities build humane operational practices.",
      organization: "Greenroom Labs",
      photoUrl: PHOTO_URL,
    },
    {
      slug: "jordan-bell",
      name: "Jordan Bell",
      bio: "Jordan works with event teams on inclusive experiences.",
      organization: "Accessibility lead",
    },
    {
      slug: "ana-ruiz",
      name: "Ana Ruiz",
      bio: "Ana runs a volunteer-led community conference.",
      organization: "Harbor Collective",
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function mountAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<PublicEventApp />);
}

// Vite rewrites a literal `new URL(..., import.meta.url)`, so the directory is
// resolved once, by hand, and joined afterwards.
const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const readCss = (name: string) => readFileSync(join(sourceDirectory, name), "utf8");

/** Strip comments so a commented-out rule cannot satisfy or break a guard. */
const withoutComments = (css: string) => css.replaceAll(/\/\*[\s\S]*?\*\//g, "");

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/api/public/events/${SLUG}`))
      return Promise.resolve(new Response(JSON.stringify({ projection }), { status: 200 }));
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: "not_found", message: "no" } }), {
        status: 404,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  // jsdom implements neither, and both run on a plain link click.
  vi.stubGlobal("scrollTo", vi.fn());
  if (!globalThis.crypto?.randomUUID)
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: () => "00000000-0000-4000-8000-000000000abc",
    });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Heading levels in document order, for outline checks. */
function headingLevels(root: HTMLElement) {
  return [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) =>
    Number(node.tagName.slice(1)),
  );
}

describe("public speaker gallery", () => {
  it("gives every speaker a headshot or a monogram tile", async () => {
    const { container } = mountAt(`/events/${SLUG}/speakers`);
    await screen.findByRole("heading", { level: 1, name: "Speakers" });

    const cards = container.querySelectorAll(".pub-speaker");
    expect(cards).toHaveLength(projection.speakers.length);
    for (const card of cards) expect(card.querySelectorAll(".pub-avatar")).toHaveLength(1);

    // The one speaker with a photoUrl gets the image; the others get initials in the
    // palette rather than an empty square.
    const photo = container.querySelector<HTMLImageElement>("img.pub-avatar");
    expect(photo?.getAttribute("src")).toBe(PHOTO_URL);
    expect(photo?.getAttribute("alt")).toBe("");
    expect(
      [...container.querySelectorAll("span.pub-avatar")].map((node) => node.textContent),
    ).toEqual(["JB", "AR"]);
    for (const monogram of container.querySelectorAll("span.pub-avatar"))
      expect(monogram.className).toMatch(/tone-\d/);
    // No image on the page may be unlabelled, headshots included.
    expect(container.querySelectorAll("img:not([alt])")).toHaveLength(0);
  });

  it("falls back to the monogram when a headshot URL fails to load", async () => {
    const { container } = mountAt(`/events/${SLUG}/speakers`);
    await screen.findByRole("heading", { level: 1, name: "Speakers" });

    const photo = container.querySelector<HTMLImageElement>("img.pub-avatar");
    expect(photo).not.toBeNull();
    // A composed photoUrl can 404 (the asset route is server-side); the gallery must
    // not leave a broken-image glyph behind.
    if (photo) fireEvent.error(photo);

    await waitFor(() => expect(container.querySelector("img.pub-avatar")).toBeNull());
    const monograms = [...container.querySelectorAll("span.pub-avatar")].map(
      (node) => node.textContent,
    );
    expect(monograms).toContain("MC");
    expect(container.querySelectorAll(".pub-speaker .pub-avatar")).toHaveLength(3);
  });

  it("renders the speaker detail route with its avatar, affiliation, and sessions", async () => {
    const { container } = mountAt(`/events/${SLUG}/speakers/ana-ruiz`);
    await screen.findByRole("heading", { level: 1, name: "Ana Ruiz" });

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelectorAll(".pub-profile .pub-avatar")).toHaveLength(1);
    // The projection publishes the speaker profile's `organization`, so the line is
    // labelled as an affiliation instead of being announced as a job title.
    const headline = container.querySelector(".pub-speaker-headline");
    expect(headline?.textContent).toBe("Affiliation: Harbor Collective");
    expect(headline?.querySelector(".pub-sr")?.textContent).toBe("Affiliation: ");

    const sessions = within(screen.getByRole("region", { name: "Sessions" }));
    expect(sessions.getByRole("link", { name: "The hallway track, on purpose" })).toBeVisible();
    // Both of Ana's sessions are reachable, including the one with no time.
    expect(sessions.getByRole("link", { name: "Community office hours" })).toBeVisible();
    expect(sessions.getByText("Time to be announced")).toBeVisible();
    // Outside the day rail a card states its own start and end.
    expect(sessions.getByText("Sep 17, 10:00 AM")).toBeVisible();
    expect(sessions.getByText("11:00 AM")).toBeVisible();
    expect(headingLevels(container.querySelector("main") as HTMLElement)).toEqual([1, 2, 3, 3]);
  });

  it("renders an unknown speaker slug as a not-found page rather than a blank gallery", async () => {
    mountAt(`/events/${SLUG}/speakers/nobody-here`);
    await screen.findByRole("heading", { level: 1, name: "Page not found" });
  });
});

describe("public schedule", () => {
  it("orders by start time, groups by day, and shows start–end times", async () => {
    const { container } = mountAt(`/events/${SLUG}/schedule`);
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });

    const days = [...container.querySelectorAll(".pub-day > h2")].map((node) => node.textContent);
    expect(days).toEqual([
      "Thursday, September 17",
      "Friday, September 18",
      "Time to be announced",
    ]);

    // Slots ascend within a day, and the two 10:00 sessions share one block whose end
    // reaches the later of the two.
    const rails = [...container.querySelectorAll(".pub-slot-time")].map((node) =>
      node.textContent?.replace(" to ", ""),
    );
    expect(rails).toEqual(["10:00 AM–11:00 AM", "11:15 AM–12:15 PM", "9:00 AM–9:45 AM"]);
    const firstSlot = container.querySelector(".pub-slot") as HTMLElement;
    expect(
      [...firstSlot.querySelectorAll(".pub-session h3")].map((node) => node.textContent),
    ).toEqual(["Calm systems for busy event teams", "The hallway track, on purpose"]);
    // The machine-readable range travels with the visible one.
    const railTimes = [...firstSlot.querySelectorAll("time")].map((node) =>
      node.getAttribute("datetime"),
    );
    expect(railTimes).toEqual(["2026-09-17T17:00:00.000Z", "2026-09-17T18:00:00.000Z"]);
    // The dash is decoration; a screen reader hears a word.
    expect(firstSlot.querySelector(".pub-sr")?.textContent).toBe(" to ");
    expect(firstSlot.querySelector("span[aria-hidden='true']")?.textContent).toBe("–");
  });

  it("states the timezone once for the whole itinerary", async () => {
    const { container } = mountAt(`/events/${SLUG}/schedule`);
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });

    const zoneLines = [...container.querySelectorAll(".pub-tz")];
    expect(zoneLines).toHaveLength(1);
    const zoneLine = zoneLines[0]?.textContent ?? "";
    expect(zoneLine).toContain("All times in America/Los_Angeles (PDT).");
    // The unplaced session is accounted for in the header rather than left unexplained.
    expect(zoneLine).toContain("4 sessions across 2 days.");
    expect(zoneLine).toContain("1 session still awaiting a time.");

    const main = container.querySelector("main") as HTMLElement;
    const occurrences = main.textContent?.match(/America\/Los_Angeles/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("regroups by list, track, and room without refetching", async () => {
    const { container } = mountAt(`/events/${SLUG}/schedule`);
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });
    const fetchesAfterLoad = fetchMock.mock.calls.length;

    const switcher = screen.getByRole("group", { name: "Group the schedule by" });
    expect(
      within(switcher)
        .getAllByRole("button")
        .map((node) => node.textContent),
    ).toEqual(["List", "Day", "Track", "Room"]);
    expect(within(switcher).getByRole("button", { name: "Day" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(within(switcher).getByRole("button", { name: "Track" }));
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".pub-day > h2")].map((node) => node.textContent),
      ).toEqual(["Community", "Experience", "Operations"]),
    );
    expect(within(switcher).getByRole("button", { name: "Track" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(switcher).getByRole("button", { name: "Day" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(within(switcher).getByRole("button", { name: "Room" }));
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".pub-day > h2")].map((node) => node.textContent),
      ).toEqual(["Atrium", "Bay Studio", "Cedar Hall", "Room to be announced"]),
    );
    // A session with no room is still reachable, in a named group that sorts last.
    const unplaced = container.querySelectorAll(".pub-day")[3] as HTMLElement;
    expect(within(unplaced).getByRole("link", { name: "Community office hours" })).toBeVisible();

    fireEvent.click(within(switcher).getByRole("button", { name: "List" }));
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".pub-day > h2")].map((node) => node.textContent),
      ).toEqual(["Every session in start order"]),
    );
    expect(
      [...container.querySelectorAll(".pub-session h3")].map((node) => node.textContent),
    ).toEqual([
      "Calm systems for busy event teams",
      "The hallway track, on purpose",
      "Accessible by default",
      "Closing notes",
      "Community office hours",
    ]);
    // Every session in the projection is present in the flat view.
    expect(container.querySelectorAll(".pub-session")).toHaveLength(projection.sessions.length);

    // The whole exercise reads the projection already in state.
    expect(fetchMock.mock.calls).toHaveLength(fetchesAfterLoad);
  });

  it("keeps the switcher keyboard-operable and announces the regrouping", async () => {
    const { container } = mountAt(`/events/${SLUG}/schedule`);
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });

    const switcher = screen.getByRole("group", { name: "Group the schedule by" });
    const buttons = within(switcher).getAllByRole("button");
    for (const button of buttons) {
      // Native buttons in the tab order: focusable, activated by Enter and Space by the
      // browser itself, so no key handler of ours can get it wrong.
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button).not.toHaveAttribute("tabindex");
      expect(button).not.toBeDisabled();
      button.focus();
      expect(document.activeElement).toBe(button);
    }

    // The announced count has to agree with the visible header: four sessions are placed
    // across the two days, the fifth is not on the grid at all.
    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toBe(
      "Day view. 4 sessions across 2 days, and 1 session still awaiting a time.",
    );
    fireEvent.click(within(switcher).getByRole("button", { name: "Room" }));
    await waitFor(() =>
      expect(container.querySelector("[role='status']")?.textContent).toBe(
        "Room view. 5 sessions.",
      ),
    );
  });

  it("keeps one h1 and an unbroken heading outline on every public route", async () => {
    for (const path of [
      `/events/${SLUG}`,
      `/events/${SLUG}/schedule`,
      `/events/${SLUG}/sessions`,
      `/events/${SLUG}/sessions/calm-systems`,
      `/events/${SLUG}/speakers`,
      `/events/${SLUG}/speakers/maya-chen`,
      `/embed/events/${SLUG}/schedule`,
      `/embed/events/${SLUG}/speakers`,
    ]) {
      const { container, unmount } = mountAt(path);
      await waitFor(() => expect(container.querySelectorAll("h1")).toHaveLength(1));
      const levels = headingLevels(container.querySelector("main") as HTMLElement);
      expect(levels[0], `${path} starts at h1`).toBe(1);
      for (const [index, level] of levels.entries())
        expect(
          level - (levels[index - 1] ?? level),
          `${path} heading order ${levels}`,
        ).toBeLessThan(2);
      // Duplicate ids break every aria-labelledby that points at them.
      const ids = [...container.querySelectorAll("[id]")].map((node) => node.id);
      expect(new Set(ids).size, `${path} duplicate id`).toBe(ids.length);
      unmount();
    }
  });

  it("labels every control on the section pages", async () => {
    const { container, unmount } = mountAt(`/events/${SLUG}/sessions`);
    await screen.findByRole("heading", { level: 1, name: "Sessions" });
    expect(screen.getByLabelText("Search sessions")).toBeVisible();
    expect(screen.getByLabelText("Track")).toBeVisible();
    for (const control of container.querySelectorAll("input, select, textarea"))
      expect(
        container.querySelector(`label[for="${control.id}"]`),
        control.outerHTML,
      ).not.toBeNull();
    unmount();

    mountAt(`/events/${SLUG}/speakers`);
    await screen.findByRole("heading", { level: 1, name: "Speakers" });
    expect(screen.getByLabelText("Search speakers")).toBeVisible();
  });
});

describe("public landing page", () => {
  it("prints a human date range and carries real content below the hero", async () => {
    const { container } = mountAt(`/events/${SLUG}`);
    await screen.findByRole("heading", { level: 1, name: "Greenroom Demo Summit" });

    const kicker = container.querySelector(".pub-hero .kicker");
    expect(kicker?.textContent).toBe("September 17–18, 2026 · Harbor Conference Center, Oakland");
    expect(kicker?.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    // Featured sessions row: the next few placed sessions, in order, with their rooms.
    const glance = container.querySelector(".pub-glance") as HTMLElement;
    expect([...glance.querySelectorAll("li a")].map((node) => node.textContent)).toEqual([
      "Calm systems for busy event teams",
      "The hallway track, on purpose",
      "Accessible by default",
      "Closing notes",
    ]);
    expect(
      [...glance.querySelectorAll(".pub-glance-what p")].map((node) => node.textContent),
    ).toEqual([
      "Cedar Hall · Operations",
      "Atrium · Community",
      "Bay Studio · Experience",
      "Cedar Hall · Operations",
    ]);

    // Speaker strip: the gallery, with the same avatars the /speakers route draws.
    const strip = within(screen.getByRole("region", { name: "Speakers" }));
    expect(strip.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    expect(container.querySelectorAll(".pub-section .pub-speaker .pub-avatar")).toHaveLength(3);

    expect(container.querySelectorAll("main > section").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector(".pub-facts")?.textContent).toContain("5 sessions · 3 speakers");
  });
});

describe("embedded variants", () => {
  it("strips the chrome but keeps the schedule and its grouping", async () => {
    const { container } = mountAt(`/embed/events/${SLUG}/schedule`);
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });

    expect(container.querySelector(".public-shell")?.className).toContain("embed");
    expect(screen.queryByRole("navigation", { name: "Event navigation" })).toBeNull();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    // The wordmark and the one CTA are the only ways out, and both leave the frame.
    for (const link of container.querySelectorAll("header a, .pub-embed-cta a"))
      expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /Open the full event site/ })).toHaveAttribute(
      "href",
      `/events/${SLUG}/schedule`,
    );
    // Every in-page link stays inside the embed so a host page is never navigated away.
    for (const link of container.querySelectorAll("main a:not([target])"))
      expect(link.getAttribute("href")).toMatch(new RegExp(`^/embed/events/${SLUG}`));

    const switcher = screen.getByRole("group", { name: "Group the schedule by" });
    fireEvent.click(within(switcher).getByRole("button", { name: "Track" }));
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".pub-day > h2")].map((node) => node.textContent),
      ).toEqual(["Community", "Experience", "Operations"]),
    );
  });

  it("keeps the gallery and its avatars in the embed", async () => {
    const { container } = mountAt(`/embed/events/${SLUG}/speakers`);
    await screen.findByRole("heading", { level: 1, name: "Speakers" });
    expect(container.querySelectorAll(".pub-speaker .pub-avatar")).toHaveLength(3);
    expect(screen.queryByRole("navigation", { name: "Event navigation" })).toBeNull();
    expect(container.querySelectorAll("img:not([alt])")).toHaveLength(0);
  });
});

/*
 * Static guards for the phone viewport. These are not a substitute for the browser
 * assertion in e2e/public-event.spec.ts — they are the rules that assertion depends on,
 * checked where a regression is cheap to catch.
 */
describe("390px safety rules in the public stylesheets", () => {
  const sheets = ["styles/public-pages.css", "public-event.css"].map((name) => ({
    name,
    css: withoutComments(readCss(name)),
  }));
  const pageStyles = withoutComments(readCss("styles/public-pages.css"));

  it("floors every auto grid track with min(<px>, 100%)", () => {
    let checked = 0;
    for (const { name, css } of sheets)
      for (const match of [...css.matchAll(/grid-template-columns:\s*repeat\(auto-[^;]+;/g)]) {
        checked += 1;
        expect(match[0], name).toMatch(/minmax\(min\([^)]*,\s*100%\)/);
      }
    expect(checked).toBeGreaterThan(0);
  });

  it("never declares a fixed width wider than a 390px phone", () => {
    for (const { name, css } of sheets)
      for (const match of css.matchAll(/(?<!max-)(?:min-)?width:\s*(\d+)px/g))
        expect(Number(match[1]), `${name}: ${match[0]}`).toBeLessThanOrEqual(360);
  });

  it("lets the view switcher wrap instead of pushing the page sideways", () => {
    const css = pageStyles;
    const rule = css.slice(css.indexOf(".pub-viewswitch {"), css.indexOf(".pub-viewswitch button"));
    expect(rule).toContain("flex-wrap: wrap");
    expect(rule).toContain("max-width: 100%");
    // A visible focus state is part of being keyboard-operable.
    expect(css).toContain(".pub-viewswitch button:focus-visible");
  });

  it("collapses the day rail and the profile to one column on a phone", () => {
    const css = pageStyles;
    const mobile = css.slice(css.indexOf("@media (max-width: 680px)"));
    expect(mobile).toContain(".pub-slot {");
    expect(mobile).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(mobile).toContain(".pub-profile {");
  });

  it("keeps the sticky day heading on the site and drops it inside an embed", () => {
    const css = pageStyles;
    const dayHeading = css.slice(css.indexOf(".public-shell .pub-day > h2 {"));
    expect(dayHeading.slice(0, 200)).toContain("position: sticky");
    expect(css).toContain(".public-shell.embed .pub-day > h2");
  });
});
