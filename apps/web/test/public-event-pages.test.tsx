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
 * The projection is frozen when the organizer publishes; whether the call is taking
 * submissions is live state the CFP domain enforces on submit. Anywhere the public
 * surface reads the snapshot for that, it can invite a visitor into a closed call — or
 * hide an open one. These pin the whole surface to the live answer.
 */
describe("what the public surface says about the call for proposals", () => {
  const EVENT_ID = projection.event.eventId;

  /** The published form the API serves at /api/public/events/{eventId}/cfp. */
  const liveForm = (status: "open" | "closed") => ({
    cfp: {
      eventId: EVENT_ID,
      title: "Share what you learned",
      description: "Submit a practical session for organizers and community builders.",
      fields: [
        {
          id: "proposal-title",
          type: "short_text",
          label: "Proposal title",
          guidance: "",
          required: true,
          options: [],
        },
      ],
      status,
      version: 4,
      publishedAt: "2026-08-01T16:00:00.000Z",
      publishedStatus: status,
    },
  });

  /** Serves the projection, and whatever the live CFP endpoint should answer this time. */
  function serve(cfp: () => Promise<Response>) {
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/public/events/${EVENT_ID}/cfp`) return cfp();
      if (url.includes(`/api/public/events/${SLUG}`))
        return Promise.resolve(new Response(JSON.stringify({ projection }), { status: 200 }));
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  const answering = (status: "open" | "closed") => () =>
    Promise.resolve(new Response(JSON.stringify(liveForm(status)), { status: 200 }));

  it("never offers to submit into a call the CFP page will report as closed", async () => {
    // The snapshot in `projection` still says "open": this is the state an organizer
    // leaves behind by closing the call without republishing the event.
    expect(projection.cfp.status).toBe("open");
    serve(answering("closed"));
    const { container } = mountAt(`/events/${SLUG}`);
    await screen.findByRole("heading", { level: 1, name: "Greenroom Demo Summit" });

    const side = await waitFor(() => {
      const node = container.querySelector(".pub-cta-side");
      expect(node?.textContent).toContain("Closed");
      return node as HTMLElement;
    });
    expect(side.textContent).not.toContain("Open");
    expect(within(side).queryByRole("link", { name: "Submit a proposal" })).toBeNull();

    // And the page one click away agrees with the page that sent them there.
    fireEvent.click(within(side).getByRole("link", { name: "Read the CFP" }));
    await screen.findByRole("heading", { level: 1, name: "Share what you learned" });
    expect(container.textContent).toContain("Submissions closed.");
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
  });

  it("advertises a reopened call the snapshot still calls closed", async () => {
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/public/events/${EVENT_ID}/cfp`) return answering("open")();
      if (url.includes(`/api/public/events/${SLUG}`))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projection: { ...projection, cfp: { ...projection.cfp, status: "closed" } },
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = mountAt(`/events/${SLUG}`);
    await screen.findByRole("heading", { level: 1, name: "Greenroom Demo Summit" });

    const cta = await screen.findByRole("link", { name: "Submit a proposal" });
    expect(container.querySelector(".pub-cta-side")?.textContent).toContain("Open");
    fireEvent.click(cta);
    await screen.findByRole("heading", { level: 1, name: "Share what you learned" });
    expect(await screen.findByRole("button", { name: "Submit proposal" })).toBeVisible();
    expect(container.textContent).toContain("Open for submissions.");
  });

  it("claims neither state while the live call cannot be read", async () => {
    serve(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "The CFP is not published.",
              correlationId: "trace-3",
            },
          }),
          { status: 409 },
        ),
      ),
    );
    const { container } = mountAt(`/events/${SLUG}`);
    await screen.findByRole("heading", { level: 1, name: "Greenroom Demo Summit" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // No pill either way, and the link promises only what it can deliver.
    const side = container.querySelector(".pub-cta-side") as HTMLElement;
    expect(side.textContent).toBe("Read the CFP");

    fireEvent.click(within(side).getByRole("link", { name: "Read the CFP" }));
    await screen.findByRole("heading", { level: 1, name: "Share what you learned" });
    expect(container.textContent).toContain(
      "Whether this call is accepting submissions could not be checked.",
    );
    expect(container.textContent).not.toContain("Open for submissions.");
    expect(container.textContent).not.toContain("Submissions closed.");
    // The reason is stated as a reading failure, not as a rejected submission.
    expect(await screen.findByRole("alert")).toHaveTextContent("The CFP is not published.");
    expect(container.textContent).not.toContain("Not submitted");
  });

  it("reads the live call for the views that speak for it, and for no others", async () => {
    const cfpReads = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/cfp")).length;
    serve(answering("open"));
    mountAt(`/events/${SLUG}`);
    await screen.findByRole("heading", { level: 1, name: "Greenroom Demo Summit" });
    await waitFor(() => expect(cfpReads()).toBe(1));

    // The gallery and the itinerary say nothing about the call, so they ask nothing.
    fireEvent.click(screen.getByRole("link", { name: "Speakers" }));
    await screen.findByRole("heading", { level: 1, name: "Speakers" });
    fireEvent.click(screen.getByRole("link", { name: "Schedule" }));
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });
    expect(cfpReads()).toBe(1);

    // Opening the call asks again: one closed while the visitor was reading the schedule
    // must not still be presented as open at the moment they go to submit.
    fireEvent.click(screen.getByRole("link", { name: "CFP" }));
    await screen.findByRole("heading", { level: 1, name: "Share what you learned" });
    await waitFor(() => expect(cfpReads()).toBe(2));
  });
});

/*
 * Static guards for the phone viewport. These are not a substitute for the browser
 * assertion in e2e/public-event.spec.ts — they are the rules that assertion depends on,
 * checked where a regression is cheap to catch.
 */
/*
 * The two surfaces the evaluator names separately from the sessions list: a directory to
 * find a name in, and a gallery to recognise a face in. Both read one projection, so the
 * risk is not that either renders — it is that they disagree about who is where.
 */
describe("speaker directory and gallery", () => {
  const names = (root: HTMLElement) =>
    [...root.querySelectorAll(".pub-speaker h3")].map((node) => node.textContent);

  it("sorts both surfaces by surname rather than by projection order", async () => {
    // The projection lists Chen, Bell, Ruiz. A directory is read by surname, so it is
    // Bell, Chen, Ruiz on both — and neither surface may invent its own order.
    const gallery = mountAt(`/events/${SLUG}/gallery`);
    await screen.findByRole("heading", { level: 1, name: "Speaker gallery" });
    expect(names(gallery.container)).toEqual(["Jordan Bell", "Maya Chen", "Ana Ruiz"]);
    cleanup();

    const list = mountAt(`/events/${SLUG}/speakers`);
    await screen.findByRole("heading", { level: 1, name: "Speakers" });
    expect(names(list.container)).toEqual(["Jordan Bell", "Maya Chen", "Ana Ruiz"]);
  });

  it("keeps the gallery photo-aware and links the same detail page as the directory", async () => {
    const { container } = mountAt(`/events/${SLUG}/gallery`);
    await screen.findByRole("heading", { level: 1, name: "Speaker gallery" });

    expect(container.querySelector(`img[src="${PHOTO_URL}"]`)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Maya Chen" })).toHaveAttribute(
      "href",
      `/events/${SLUG}/speakers/maya-chen`,
    );
  });

  it("finds a speaker by organization as well as by name", async () => {
    mountAt(`/events/${SLUG}/speakers`);
    await screen.findByRole("heading", { level: 1, name: "Speakers" });

    fireEvent.change(screen.getByLabelText("Search speakers"), {
      target: { value: "harbor collective" },
    });

    expect(screen.getByRole("link", { name: "Ana Ruiz" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Maya Chen" })).toBeNull();
  });
});

/*
 * The itinerary. The identity is a capability token: minted on the first star, kept in
 * localStorage, and put in the request path — see src/public-event/itinerary.tsx.
 */
/*
 * jsdom in this configuration exposes `window.localStorage` as a bare object with no
 * Storage methods on it, so persistence has to be supplied here to be exercised at all.
 * The production code survives its absence — every access is wrapped, and an attendee who
 * cannot persist still gets an itinerary for the visit — but "survives a reload" is not a
 * claim that can be made against a store that never stores.
 */
function installMemoryStorage(): () => void {
  const entries = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, String(value));
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
      clear: () => entries.clear(),
      key: (index: number) => [...entries.keys()][index] ?? null,
      get length() {
        return entries.size;
      },
    },
  });
  return () => {
    if (original) Object.defineProperty(window, "localStorage", original);
  };
}

describe("attendee itinerary", () => {
  // Deliberately low-entropy and self-describing: a random-looking fixture here trips the
  // secret scanner in CI, which is the scanner behaving correctly. It still has to satisfy
  // `itineraryTokenSchema` — 16-128 characters of [A-Za-z0-9_-].
  const TOKEN = "itinerary-test-token-not-a-real-secret";
  let saved: string[] = [];
  let restoreStorage: (() => void) | null = null;

  afterEach(() => restoreStorage?.());

  beforeEach(() => {
    saved = [];
    restoreStorage = installMemoryStorage();
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { sessionSlugs: string[] })
        : null;
      if (url.endsWith("/itinerary") && init?.method === "POST") {
        saved = body?.sessionSlugs ?? [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: TOKEN,
              itinerary: {
                eventSlug: SLUG,
                sessionSlugs: saved,
                updatedAt: "2026-08-20T10:00:00.000Z",
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url.includes("/api/public/itineraries/")) {
        if (init?.method === "POST") saved = body?.sessionSlugs ?? [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              itinerary: {
                eventSlug: SLUG,
                sessionSlugs: saved,
                updatedAt: "2026-08-20T10:00:00.000Z",
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes(`/api/public/events/${SLUG}`))
        return Promise.resolve(new Response(JSON.stringify({ projection }), { status: 200 }));
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "not_found", message: "no" } }), {
          status: 404,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  /** Same stub, but the mint resolves a tick late so two stars can overlap it. */
  function stubPublishing_itinerary_delayed() {
    const base = fetchMock as ReturnType<typeof vi.fn>;
    const delayed = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const response = base(input, init) as Promise<Response>;
      return String(input).endsWith("/itinerary") && init?.method === "POST"
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(response), 5))
        : response;
    });
    vi.stubGlobal("fetch", delayed);
    return delayed;
  }

  const star = async (title: string) => {
    fireEvent.click(await screen.findByRole("button", { name: `Add ${title} to my itinerary` }));
  };

  it("mints one itinerary on the first star and reuses its token afterwards", async () => {
    mountAt(`/events/${SLUG}/sessions`);
    await screen.findByRole("heading", { level: 1, name: "Sessions" });

    await star("Closing notes");
    await waitFor(() =>
      expect(window.localStorage.getItem(`greenroom:itinerary:${projection.event.eventId}`)).toBe(
        TOKEN,
      ),
    );
    await star("Calm systems for busy event teams");

    // Exactly one mint. A second POST to the collection would strand the first itinerary
    // and lose whatever the attendee had already starred.
    const mints = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/itinerary") && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(mints).toHaveLength(1);
    await waitFor(() => expect(saved).toEqual(["closing-notes", "calm-systems"]));
  });

  it("mints once even when two stars are fired before the first mint returns", async () => {
    const fetchMock = stubPublishing_itinerary_delayed();
    mountAt(`/events/${SLUG}/sessions`);
    await screen.findByRole("heading", { level: 1, name: "Sessions" });

    // No await between them: this is the race the token-in-state guard cannot see, because
    // `token` is still null for the second click.
    fireEvent.click(screen.getByRole("button", { name: "Add Closing notes to my itinerary" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add Accessible by default to my itinerary" }),
    );

    await waitFor(() => expect(saved).toHaveLength(2));
    const mints = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/itinerary") && (init as RequestInit | undefined)?.method === "POST",
    );
    // Two rows would orphan one and silently move the browser onto the other.
    expect(mints).toHaveLength(1);
    expect(saved).toEqual(["closing-notes", "accessible-by-default"]);
  });

  it("survives a reload with exactly the chosen sessions", async () => {
    mountAt(`/events/${SLUG}/sessions`);
    await screen.findByRole("heading", { level: 1, name: "Sessions" });
    await star("Closing notes");
    await star("Accessible by default");
    await waitFor(() => expect(saved).toHaveLength(2));
    cleanup();

    // A fresh mount is a reload: nothing survives but localStorage and the server.
    mountAt(`/events/${SLUG}/itinerary`);
    await screen.findByRole("heading", { level: 1, name: "My itinerary" });

    const starred = await screen.findAllByRole("link", {
      name: /Closing notes|Accessible by default/,
    });
    expect(starred.map((link) => link.textContent).sort()).toEqual([
      "Accessible by default",
      "Closing notes",
    ]);
    expect(screen.queryByRole("link", { name: "Calm systems for busy event teams" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("2 sessions in your itinerary");
  });

  it("adopts an itinerary handed over as a link, so a second device can open it", async () => {
    saved = ["calm-systems"];
    mountAt(`/events/${SLUG}/itinerary?plan=${TOKEN}`);
    await screen.findByRole("heading", { level: 1, name: "My itinerary" });

    expect(
      await screen.findByRole("link", { name: "Calm systems for busy event teams" }),
    ).toBeVisible();
    // Adopted into storage, so the next visit to this device needs no link.
    expect(window.localStorage.getItem(`greenroom:itinerary:${projection.event.eventId}`)).toBe(
      TOKEN,
    );
  });

  it("says the itinerary is a link rather than an account", async () => {
    mountAt(`/events/${SLUG}/itinerary`);
    await screen.findByRole("heading", { level: 1, name: "My itinerary" });
    expect(screen.getByText(/kept against a private link for this browser/)).toBeVisible();
    expect(screen.getByText(/Anyone with the link can see this itinerary/)).toBeVisible();
  });

  it("offers no star inside an embed, where storage may be partitioned away", async () => {
    mountAt(`/embed/events/${SLUG}/sessions`);
    await screen.findByRole("heading", { level: 1, name: "Sessions" });
    expect(screen.queryByRole("button", { name: /to my itinerary/ })).toBeNull();
  });
});

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

/*
 * The projection derives `startsOn`/`endsOn` from the published agenda's timeslots, so an event
 * published before anything is scheduled emits empty strings — and `venue`/`summary` are empty
 * until an organizer fills them in. `new Date("T12:00:00Z")` is an Invalid Date and `Intl` throws
 * `RangeError` on one, which took the whole public page down. These pin the degradation.
 */
describe("an event published before anything is scheduled", () => {
  const undated = {
    ...projection,
    event: { ...projection.event, startsOn: "", endsOn: "", venue: "", summary: "" },
    sessions: projection.sessions.map(({ startsAt, endsAt, room, ...rest }) => rest),
  };

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes(`/api/public/events/${SLUG}`)
        ? Promise.resolve(new Response(JSON.stringify({ projection: undated }), { status: 200 }))
        : Promise.resolve(new Response("{}", { status: 404 })),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  it("renders the landing page instead of throwing on an empty date range", async () => {
    const { container } = mountAt(`/events/${SLUG}`);
    await screen.findByRole("heading", { level: 1, name: "Greenroom Demo Summit" });
    expect(container.textContent).toContain("Dates to be announced");
    // No dangling separator where the venue would have been.
    expect(container.textContent).not.toContain("· ·");
    expect(container.querySelector(".kicker")?.textContent).toBe("Dates to be announced");
  });

  it("renders a schedule of unscheduled sessions in every view", async () => {
    for (const view of ["list", "day", "track", "room"]) {
      window.history.pushState({}, "", `/events/${SLUG}/schedule?view=${view}`);
      const { container, unmount } = render(<PublicEventApp />);
      await screen.findByRole("heading", { level: 1, name: "Plan your time" });
      expect(container.textContent).toContain("Accessible by default");
      unmount();
    }
  });

  it("drops the zone abbreviation rather than reading it off today's clock", async () => {
    const { container } = mountAt(`/events/${SLUG}/schedule`);
    await screen.findByRole("heading", { level: 1, name: "Plan your time" });
    expect(container.textContent).toContain("All times in America/Los_Angeles.");
    expect(container.textContent).not.toContain("(PDT)");
    expect(container.textContent).not.toContain("(PST)");
  });
});
