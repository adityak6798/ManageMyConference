// @acceptance ACC-DEMO-SMOKE ACC-OPS
import AxeBuilder from "@axe-core/playwright";
import { switchPersona } from "./controls";
import { expect, type Locator, type Page, test } from "./fixtures";

const SLUG = "greenroom-demo-summit";
const PUBLIC_SURFACES = [
  { path: "", heading: "Greenroom Demo Summit" },
  { path: "/schedule", heading: "Plan your time" },
  { path: "/sessions", heading: "Sessions" },
  { path: "/speakers", heading: "Speakers" },
  { path: "/gallery", heading: "Speaker gallery" },
  { path: "/itinerary", heading: "My itinerary" },
  { path: "/cfp", heading: "Share your conference story" },
] as const;
const EMBED_SURFACES = ["schedule", "sessions", "speakers", "gallery", "itinerary"] as const;
/**
 * The three signed-out surfaces. They are audited exactly as the public event pages are, because
 * they are the same kind of thing: the first screen a stranger sees, rendered before anybody has
 * authenticated. `/` is the marketing page only while signed out — an organizer's `/` is the
 * console Overview, which the organizer sweep below already covers.
 *
 * `/developers` is the exception to that last sentence and is here for it: it is a public
 * reference rather than the signed-out half of a console surface, so it renders for a signed-in
 * reader too. What it needs from this audit is the same as the other two — landmarks, contrast,
 * heading order, and a document that does not pan sideways at 390px, which its `curl` samples
 * are the standing risk to.
 */
const MARKETING_SURFACES = [
  { path: "/", heading: "Run the whole conference without losing the thread." },
  { path: "/signin", heading: "Sign in" },
  { path: "/developers", heading: "Greenroom is an API with a console on top of it." },
] as const;

async function expectNoAxeViolations(page: Page, surface: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target.join(" ")),
    })),
    `${surface} has automated accessibility violations`,
  ).toEqual([]);
}

/**
 * The document does not pan sideways, *and* the things an organizer came to press are on screen.
 *
 * The document half alone is not the guarantee it reads as (#155): a `.table-wrap` scrolls its
 * own overflow, so `/abstracts` passed this check at 390px while the Decision column — the
 * primary action of the whole surface — started 235px past the right edge. Measuring only
 * `documentElement` certifies "the page does not overflow" and says nothing about whether the
 * page is usable, which is the property the row in the scorecard is actually claiming.
 *
 * A control is counted when it is visible and inside `main`; the offenders are named rather than
 * counted, because "3 controls are off-screen" is not something anyone can act on.
 *
 * This ran with an exemption list while the surfaces it found were repaired one at a time. All
 * three — `/abstracts`, `/sessions`, `/communications` — now restack into cards below 780px by
 * one shared recipe, so there is nothing left to exempt and the assertion applies everywhere.
 */
async function expectNoHorizontalOverflow(page: Page, surface: string) {
  // The shell paints its `<h1>` before the workspace fetch resolves, so a check that runs on the
  // heading alone can measure an empty `main` and pass because there was nothing to measure. The
  // tables are the things that overflow; `settled` waits for this surface's own content first.
  await settled(page, surface);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${surface} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);

  const offscreen = await page.evaluate(() => {
    const main = document.querySelector("main");
    // Absent `main` is a broken page, not a clean one — reported rather than counted as zero.
    if (!main) return ["<no main landmark on the page>"];
    const width = document.documentElement.clientWidth;
    // Every interactive control, not only buttons and links: the guarantee is about what an
    // organizer can reach, and an off-screen select, textarea or disclosure summary fails it
    // exactly as a button does.
    const interactive =
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    return [...main.querySelectorAll<HTMLElement>(interactive)]
      .filter((element) => {
        if (element.hasAttribute("disabled") || element.getAttribute("aria-hidden") === "true")
          return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        // `.visually-hidden` parks a 1px clipped box off-layout; it is announced, not pointed at.
        if (element.classList.contains("visually-hidden")) return false;
        const box = element.getBoundingClientRect();
        // A zero-box control is collapsed or inside a closed disclosure, not misplaced.
        if (box.width === 0 || box.height === 0) return false;
        return box.right > width + 1 || box.left < -1;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.tagName.toLowerCase()}“${(element.textContent ?? "").trim().slice(0, 40)}” at x=${Math.round(box.left)}..${Math.round(box.right)}`;
      });
  });

  expect(
    offscreen,
    `${surface} puts ${offscreen.length} control(s) outside the viewport: ${offscreen.join("; ")}`,
  ).toEqual([]);
}

/**
 * What "this surface's own content has arrived" looks like, one entry per audited surface.
 *
 * There is no shared readiness signal in this app to wait for, and the version of `settled` that
 * waited for `main .skeleton` to reach zero was only ever a wait on the surfaces that *have* a
 * skeleton. Eleven do — Overview, `/abstracts`, `/sessions`, `/cfp`, `/speakers`,
 * `/speaker-directory`, `/communications`, `/publishing`, `/event-templates`, `/reviews` and
 * `/portal`. The rest announce loading their own way or not at all: `/agenda` paints
 * `<p role="status">Loading agenda…</p>`, `/members` and `/integrations/api-clients` a plain
 * "Loading…" card, `/inbox` a single paragraph, and `/audit` paints its Card, its table head and
 * an empty `<tbody>` from the first frame with no loading element anywhere. On every one of those,
 * `.skeleton` matched nothing, `toHaveCount(0)` passed on the spot, and the 390px audit went on
 * measuring an unpainted page — the hole the wait claimed to close.
 *
 * So every entry here is a *positive* signal: an element that exists only once the fetch behind
 * this surface has landed. That direction is the whole point. `toBeVisible()` on a selector that
 * matches nothing fails; `toHaveCount(0)` on the same selector passes. A wait that cannot tell
 * "there is nothing to wait for here" from "it has not arrived yet" is not a wait, which is the
 * same trap `openEveryDisclosure` documents below on the other side of the fetch.
 *
 * A surface with no entry throws rather than falling back to something generic, so a nav
 * destination added later joins this table loudly instead of joining the audit unwaited-for.
 */
const READY: Readonly<Record<string, (page: Page) => Locator>> = {
  /*
   * Signed out. Both surfaces render the same demo doors, and the doors are the *answer* to the
   * identity probe the document boots with: until it resolves, the page is one
   * "Loading Greenroom…" paragraph with no `<h1>` on it at all.
   */
  "marketing /": (page) => page.getByRole("button", { name: "Continue as organizer" }),
  "marketing /signin": (page) => page.getByRole("button", { name: "Continue as organizer" }),
  /*
   * The exception on this surface, and the reason it gets its own signal rather than the doors.
   *
   * `/developers` reads nothing the probe returns, so `LandingRoot` renders it without waiting —
   * there are no demo doors on it to wait for, and waiting for them would hang. Its last section
   * is the readiness signal instead: if the closing door has painted, everything the audit
   * measures is above it.
   */
  "marketing /developers": (page) =>
    page.getByRole("heading", { level: 2, name: "Read the operations" }),

  /*
   * The public site renders `main.public-state` — a lone `<p role="status">` — until its
   * projection arrives, and `#public-main` only once it has, so the id is the projection.
   *
   * `/cfp` is the one public surface where that is not enough: the live submission form is a
   * second fetch made after the projection, and until it answers the page says "Checking
   * submission availability…" and renders no form fields. Waiting for the resolved status line
   * is waiting for the fields the audit is there to measure.
   */
  "public /": publicProjection,
  "public /schedule": publicProjection,
  "public /sessions": publicProjection,
  "public /speakers": publicProjection,
  "public /gallery": publicProjection,
  "public /itinerary": publicProjection,
  "public /cfp": (page) =>
    page
      .locator("p.pub-tz")
      .filter({
        hasText: /Open for submissions|Not open yet|Submissions closed|Submission form unavailable/,
      })
      .first(),

  /*
   * The organizer console, by hub.
   *
   * The sweep below discovers destinations from the sidebar, and the sidebar is nine job hubs and
   * two utilities rather than twenty workspace routes. Each entry names the *first* tab of its
   * hub, because that is what a hub URL with no `tab` opens on.
   */
  // Overview's stats are `<div class="skeleton">` until all three reads answer; this section is
  // in the loaded return only.
  "organizer /": (page) =>
    page.getByRole("heading", { level: 2, name: "Speaker onboarding", exact: true }),
  "organizer /inbox": (page) =>
    page.locator("p.hint").filter({ hasText: /\d+ items? (is|are) waiting on this event\./ }),
  /*
   * Reports render the builder only once the catalogue answers, and the Columns checkboxes *are*
   * the catalogue — one per field of the selected dataset — so this waits for the content rather
   * than for the form around it.
   */
  "organizer /reports": (page) =>
    page.getByRole("group", { name: "Columns" }).getByRole("checkbox").first(),
  // Program opens on Submissions, the daily queue: the table, or the empty state that replaces it.
  "organizer /program": (page) =>
    page.locator("table.triage-table").or(page.getByRole("heading", { name: /^No abstracts/ })),
  // The Card around the pipeline is painted with skeletons inside it, so the card is not the
  // signal — `.pipeline-board` replaces those skeletons and exists only in the loaded branch.
  "organizer /people": (page) => page.locator(".pipeline-board"),
  "organizer /schedule": (page) =>
    page.getByRole("heading", { level: 2, name: "Accepted sessions", exact: true }),
  // The outbox region is painted before its read answers; only its description counts what
  // arrived — before that it says "Loading the outbox…".
  "organizer /communications": (page) =>
    page.locator("p.section-description").filter({ hasText: /\d+ deliver(y|ies) loaded/ }),
  "organizer /publish": (page) =>
    page.getByRole("heading", { level: 2, name: "Publication", exact: true }),
  // Creating an event is a destination of its own, and it is the shell's own form: nothing is
  // fetched for it, so its first field is the whole of "ready".
  "organizer /events/new": (page) => page.getByLabel("Event name", { exact: true }),
  // Settings opens on Event, which is the shell's own state with nothing fetched.
  "organizer /settings": (page) =>
    page.getByRole("heading", { level: 2, name: "Event details", exact: true }),
  /*
   * Two console surfaces the sidebar does not offer, audited by the journeys that reach them.
   * `/search` fetches nothing on mount — it is a form and a resting announcement until somebody
   * submits — so this waits for that resting state rather than implying a read it never makes.
   */
  "organizer /search": (page) =>
    page.locator("p.hint").filter({ hasText: "Enter a search to begin." }),
  /*
   * `/audit` renders no skeleton and no loading gate, so the toolbar, the caption and an empty
   * `<tbody>` are on screen from the first frame. The live region is the only thing on the page
   * that distinguishes "reading" from "read".
   */
  "organizer /audit": (page) => page.locator("p.hint").filter({ hasText: /\d+ records? loaded\./ }),
  "reviewer assignments": (page) => page.locator(".review-main"),
  // The task card's title counts the outstanding tasks, so the name moves; the id does not.
  "speaker portal": (page) => page.locator("#speaker-tasks-title"),
  "command palette at 390px": (page) =>
    page.getByRole("dialog", { name: "Search this event" }).getByRole("option").first(),
};

function publicProjection(page: Page) {
  return page.locator("#public-main");
}

/** The `READY` key for a console destination, whose nav href carries the selected event. */
function organizerSurface(href: string) {
  return `organizer ${href.split("?")[0]}`;
}

/**
 * Block until the named surface has painted the content the audit is about to measure.
 *
 * An element wait, not `networkidle`: these destinations are reached by clicking a nav link, so
 * the SPA starts no document load and the idle state is already satisfied before the workspace
 * fetch is issued — and on this app `networkidle` never resolves at all.
 *
 * What it guarantees is exactly what `READY` declares for that one surface, and nothing wider.
 * The gap it closes is real and was not theoretical: every console workspace paints its own
 * header and toolbar before its fetch resolves, so an audit gated on the `<h1>` measured a
 * `/speakers` board with no cards on it and passed — and the one run in four where the cards
 * arrived first is how a real 390px defect surfaced as a flake instead of a failure.
 *
 * Two surfaces are covered by declaration rather than by a load: `/search` fetches nothing on
 * mount, and `/settings` is the shell's own form. On `/integrations/api-clients` the demo persona
 * never reaches the workspace's fetch at all, so what is waited for there is the refusal it does
 * render. Each says so at its entry, by name, rather than being counted as covered.
 */
async function settled(page: Page, surface: string) {
  const ready = READY[surface];
  if (!ready)
    throw new Error(
      `No readiness signal is declared for “${surface}”. Add one to READY — a surface audited ` +
        "without one is a surface audited before it has painted anything.",
    );
  await expect(
    ready(page),
    `${surface} never rendered the content this audit measures`,
  ).toBeVisible();
}

/**
 * Expand every disclosure on the current page, so an audit sees their contents.
 *
 * Sets `open` directly rather than clicking: the point is to expose the content to axe, and a
 * click-per-panel would make the sweep depend on each summary's hit target. Whether the
 * disclosure *works* is asserted separately, and in the unit suite.
 *
 * The wait is the whole mechanism — `settled` above. The first version of this helper ran ~25ms
 * after the navigation, while the panels first exist ~50ms in, so it found zero of them on every
 * run and reported success while the sweep audited a page with all seven tools closed. A helper
 * that cannot tell "there are no panels here" from "the panels have not rendered yet" is not a
 * check.
 *
 * It opens every `<details>`, not only `details.tool-panel`. Most of what that class named has
 * become a drawer — a `<dialog>` that renders nothing until it is opened — so a locator scoped to
 * the old class would now find nothing on most hubs and say nothing about it. Drawer contents are
 * audited by `auditDrawer` below, which opens the ones the sweep can no longer reach.
 */
async function openEveryDisclosure(page: Page, surface: string) {
  await settled(page, surface);
  await page.evaluate(() => {
    for (const panel of document.querySelectorAll<HTMLDetailsElement>("details")) panel.open = true;
  });
  await expect(page.locator("details:not([open])")).toHaveCount(0);
}

/**
 * Audit one drawer, opened by the control that offers it.
 *
 * A `<dialog>` renders nothing until it is shown, so content that moved out of an inline panel
 * and into a drawer left the sweep above entirely. These are the two largest of those: the
 * agenda's rooms/tracks/times editor and the call for proposals' public preview.
 */
async function auditDrawer(page: Page, opener: string, drawer: string, label: string) {
  await page.getByRole("button", { name: opener, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: drawer });
  await expect(dialog).toBeVisible();
  await expectNoAxeViolations(page, label);
  await dialog.getByRole("button", { name: `Close ${drawer}` }).click();
  await expect(dialog).toBeHidden();
}

async function openOrganizer(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

test("shows the seeded speaker's outstanding task at t=0", async ({ page }) => {
  await openOrganizer(page);

  const taskRow = page.getByRole("row", { name: /Sam Speaker.*Confirm profile details/ });
  await expect(taskRow).toContainText("Sam Speaker");
  await expect(taskRow).toContainText("Confirm profile details");
  await expect(taskRow).toContainText("Aug 20");
});

test("audits the landing and sign-in surfaces a signed-out visitor lands on", async ({ page }) => {
  for (const surface of MARKETING_SURFACES) {
    await page.goto(surface.path);
    await expect(page.getByRole("heading", { level: 1, name: surface.heading })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expectNoAxeViolations(page, `marketing ${surface.path}`);
  }

  await page.goto("/");
  const firstTabStop = page
    .locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    .first();
  await expect(firstTabStop).toHaveAccessibleName("Skip to main content");

  // The demo door is the one an evaluator with ten minutes uses, and the browser suite's own
  // bootstrap depends on it being here, on "/": twelve spec files open "/" and click this button.
  await expect(page.getByRole("button", { name: "Continue as organizer" })).toBeVisible();

  // Client-side navigation between the two surfaces has to move focus, or a keyboard user is
  // left at the top of a document that silently changed underneath them.
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.locator("main")).toBeFocused();

  // The API is reachable from the bar of every signed-out surface, which is the whole reason the
  // bar became a navigation landmark. Reached from `/signin` here on purpose: the link is in the
  // shared chrome rather than on the marketing page, and this is what proves it.
  await page.getByRole("link", { name: "API Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/developers$/);
  await expect(page.locator("main")).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Browse the API reference" }).first(),
  ).toHaveAttribute("href", "/docs");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const surface of MARKETING_SURFACES) {
    await page.goto(surface.path);
    await expect(page.getByRole("heading", { level: 1, name: surface.heading })).toBeVisible();
    await expectNoHorizontalOverflow(page, `marketing ${surface.path}`);
  }
});

test("audits every organizer destination and the Wave 2 evaluator surfaces", async ({ page }) => {
  await openOrganizer(page);

  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  const firstTabStop = page
    .locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    .first();
  await expect(firstTabStop).toHaveAccessibleName("Skip to main content");
  await skipLink.focus();
  await skipLink.click();
  await expect(page.locator("main")).toBeFocused();

  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
  const destinations = await navigation.getByRole("link").evaluateAll((links) =>
    links.map((link) => ({
      href: (link as HTMLAnchorElement).getAttribute("href") ?? "",
      label: link.textContent?.trim() ?? "",
    })),
  );
  expect(destinations.length).toBeGreaterThanOrEqual(7);
  for (const destination of destinations) {
    // Addressed by href rather than by name. A destination with work waiting carries the count
    // in its own text — "Inbox5 waiting5" — so an exact name match finds nothing precisely when
    // the destination has something to say, and the href is what this loop is enumerating anyway.
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .locator(`a[href="${destination.href}"]`)
      .click();
    await expect(page).toHaveURL(destination.href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    // A closed <details> renders nothing, and axe skips what is not rendered. #144 moved seven
    // tools — the CSV import form, the Accelevents controls, the workflow selects and textareas,
    // the bulk-assignment list, the deliverables inputs, the edit-history table, the speaker
    // checklist editor (#176) and the whole resource editor — into closed panels, which would
    // have quietly narrowed this audit to the dashboard while the scorecard still called the
    // destination clean. They are opened first so the sweep covers at least what it covered when
    // they were expanded Cards.
    await openEveryDisclosure(page, organizerSurface(destination.href));
    await expectNoAxeViolations(page, `organizer ${destination.label}`);
  }

  await page.goto("/schedule?tab=sessions");
  // #144: the dashboard leads. The accepted-sessions table is above the authoring tools and
  // inside the first screen, where it used to start 1420px down — 32% of a 4475px page.
  const sessionsHeading = page.getByRole("heading", { name: "Accepted sessions" });
  await expect(sessionsHeading).toBeVisible();
  const sessionsBox = await sessionsHeading.boundingBox();
  expect(sessionsBox, "the accepted-sessions table is rendered").not.toBeNull();
  // Measured against the viewport actually in use, not a number that happens to exceed it —
  // neither Playwright config sets a viewport, so this runs at the 1280x720 default and a 900px
  // threshold would have accepted a table 130px below the fold while claiming it was above it.
  const firstScreen = page.viewportSize()?.height ?? 720;
  expect(
    sessionsBox?.y ?? 0,
    `accepted sessions is inside the first ${firstScreen}px screen, not behind authoring forms`,
  ).toBeLessThan(firstScreen);
  // Resource authoring moved to its focused People > Files job and remains one deliberate action
  // away; its HTML fields are not rendered until then.
  await page.goto("/people?tab=files");
  const resourcesHeading = page.getByRole("heading", { name: "Speaker resources" });
  await expect(resourcesHeading).toBeVisible();
  await expect(page.locator('input[value="Speaker handbook"]')).toHaveCount(0);
  await resourcesHeading.click();
  await page.getByRole("button", { name: "Edit Speaker handbook" }).click();
  await expect(page.locator('input[value="Speaker handbook"]')).toBeVisible();
  await expect(page.locator('input[value="speaker-handbook"]')).toBeVisible();
  await page.goto("/schedule?tab=agenda");
  await expect(page.getByRole("button", { name: "Generate draft" })).toBeVisible();
  await expect(page.getByText("2 of 2 scheduled")).toBeVisible();
  /*
   * The two drawers the sweep above can no longer reach.
   *
   * A `<dialog>` renders nothing until it is shown, so the rooms/tracks/times editor and the
   * public-form preview left the sweep when they stopped being inline panels. They are the
   * largest two, and both are dense forms — exactly what an automated rule set is for.
   */
  await auditDrawer(page, "Rooms and times", "Rooms, tracks and times", "agenda resources drawer");
  await page.goto("/program?tab=forms");
  await auditDrawer(page, "Preview", "Public form", "call for proposals preview drawer");

  await page.goto("/schedule?tab=agenda");
  // The room board shows one day at a time, so every event day is exposed without making an
  // organizer infer that a session on day two is hidden inside the Day select.
  await page.getByRole("radio", { name: "Wed, Sep 2 1 scheduled sessions" }).click();
  await expect(
    page.getByRole("button", {
      name: /Accessible by default\. Workshop lab, 10:00–11:00/,
    }),
  ).toBeVisible();
  await page.goto("/program?tab=review");
  await expect(page.getByRole("heading", { name: "Reviewer progress" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Designing for the hallway track", exact: true }),
  ).toBeVisible();
});

/**
 * The command palette, which the sweep above cannot reach.
 *
 * Every workspace joins that sweep by being a link in the navigation landmark. The palette is
 * not a destination — it is a dialog over whichever destination the operator is already on — so
 * nothing enumerates it, and without this test it would be the one console surface with no axe
 * coverage at all. Focus return and Escape are asserted here too, because they are exactly what
 * an automated rule set cannot see: axe reports that the dialog is labelled and modal, and says
 * nothing about where a keyboard user ends up when it closes.
 */
test("audits the command palette, its focus return, and its 390px layout", async ({ page }) => {
  await openOrganizer(page);

  // Scoped to the banner: `/search` has a submit control with the same name, and the palette is
  // the topbar's.
  const opener = page.getByRole("banner").getByRole("button", { name: /^Search/ });
  await opener.click();
  const palette = page.getByRole("dialog", { name: "Search this event" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toBeFocused();

  // A term the deterministic seed actually holds, so an empty listbox is a defect rather than an
  // accurate answer about a word nobody wrote.
  await palette.getByRole("combobox").fill("accessible");
  await expect(palette.getByRole("option").first()).toBeVisible();
  await expectNoAxeViolations(page, "command palette");

  // Closing must put the operator back on the control they used, not at the top of a document
  // that changed underneath them.
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(opener).toBeFocused();

  // The chord is the other way in, and it is the one a keyboard-only operator will use.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search this event" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await opener.click();
  await expect(palette).toBeVisible();
  // Scoped to the palette throughout: the shell's two `<select>` controls contribute `option`
  // roles of their own, and an unscoped query resolves to one of those instead — a passing
  // locator that is not this widget.
  await palette.getByRole("combobox").fill("accessible");
  await expect(palette.getByRole("option").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "command palette at 390px");
});

test("audits reviewer and speaker shells including evaluator-grade content", async ({ page }) => {
  await openOrganizer(page);

  // The persona picker moved inside the account control, where everything about who is signed in
  // now lives, and is drawn only on a demo deployment.
  await switchPersona(page, "Reviewer");
  await expect(page.getByRole("heading", { level: 1, name: "Review assignments" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Designing for the hallway track" }),
  ).toBeVisible();
  await expect(page.getByText("Relevance", { exact: true }).first()).toBeVisible();
  await expectNoAxeViolations(page, "reviewer assignments");

  await switchPersona(page, "Speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Speaker resources" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Speaker handbook" })).toBeVisible();
  await expect(page.getByText("Designing the calm conference", { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "speaker portal and resources");
});

test("audits every public and embed surface, focus transition, landmarks, and mobile layout", async ({
  page,
}) => {
  for (const surface of PUBLIC_SURFACES) {
    await page.goto(`/events/${SLUG}${surface.path}`);
    await expect(page.getByRole("heading", { level: 1, name: surface.heading })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    if (surface.path === "/schedule")
      await expect(page.getByRole("link", { name: "Designing the calm conference" })).toBeVisible();
    if (surface.path === "/sessions") {
      await expect(page.getByRole("link", { name: "Accessible by default" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Designing the calm conference" })).toBeVisible();
    }
    if (surface.path === "/itinerary")
      await expect(page.getByRole("heading", { name: "Nothing starred yet" })).toBeVisible();
    await expectNoAxeViolations(page, `public ${surface.path || "/"}`);
  }

  await page.goto(`/events/${SLUG}`);
  const firstTabStop = page
    .locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    .first();
  await expect(firstTabStop).toHaveAccessibleName("Skip to main content");
  await page.getByRole("link", { name: "Schedule", exact: true }).click();
  await expect(page.locator("main")).toBeFocused();

  for (const surface of EMBED_SURFACES) {
    await page.goto(`/embed/events/${SLUG}/${surface}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoAxeViolations(page, `embed ${surface}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const surface of PUBLIC_SURFACES) {
    await page.goto(`/events/${SLUG}${surface.path}`);
    await expect(page.getByRole("heading", { level: 1, name: surface.heading })).toBeVisible();
    await expectNoHorizontalOverflow(page, `public ${surface.path || "/"}`);
  }
  await openOrganizer(page);
  const mobileNavigationTrigger = page.getByRole("button", {
    name: "Open workspace navigation",
  });
  await mobileNavigationTrigger.click();
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toHaveJSProperty("inert", true);
  await page.keyboard.press("Shift+Tab");
  await expect(skipLink).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mobileNavigationTrigger).toBeFocused();
  const organizerPaths = await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link")
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
  for (const path of organizerPaths) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page, organizerSurface(path));
  }
  // The persona picker lives inside the account control at every width, so `switchPersona` opens
  // it first; there is no narrow-layout special case left for this to carry.
  await switchPersona(page, "Reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "reviewer assignments");
  await switchPersona(page, "Speaker");
  await expect(page.getByRole("heading", { name: "Speaker portal" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "speaker portal");
});

test("measures meaningful budgets on the Worker-served production artifact", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "quality", "The Vite project does not serve the artifact.");
  await page.goto(`/events/${SLUG}`);
  await expect(page.getByRole("heading", { name: "Greenroom Demo Summit" })).toBeVisible();
  const measurement = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return {
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      transferredBytes:
        navigation.transferSize + resources.reduce((sum, item) => sum + item.transferSize, 0),
      resourceCount: resources.length,
    };
  });

  // Measured locally on the built Worker artifact before setting these ceilings: 55 ms DCL,
  // 166 KiB transferred, and 5 resources. The margin tolerates slower CI without making a
  // doubled bundle or a newly introduced request waterfall invisible.
  expect(measurement.domContentLoadedMs).toBeLessThan(1_500);
  expect(measurement.transferredBytes).toBeLessThan(300 * 1024);
  expect(measurement.resourceCount).toBeLessThan(12);
});
