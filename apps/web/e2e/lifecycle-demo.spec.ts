// @acceptance ACC-DEMO-SMOKE ACC-OPS
import AxeBuilder from "@axe-core/playwright";
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
 * The two signed-out surfaces. They are audited exactly as the public event pages are, because
 * they are the same kind of thing: the first screen a stranger sees, rendered before anybody has
 * authenticated. `/` is the marketing page only while signed out — an organizer's `/` is the
 * console Overview, which the organizer sweep below already covers.
 */
const MARKETING_SURFACES = [
  { path: "/", heading: "Run the whole conference without losing the thread." },
  { path: "/signin", heading: "Sign in" },
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
 * same trap `openEveryToolPanel` documents below on the other side of the fetch.
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

  // Overview's stats are `<div class="skeleton">` until all three reads answer; this card is in
  // the loaded return only.
  "organizer /": (page) =>
    page.getByRole("heading", { level: 2, name: "Outstanding speaker onboarding", exact: true }),
  "organizer /abstracts": (page) =>
    page.getByRole("heading", { level: 2, name: "Reviewer progress", exact: true }),
  "organizer /sessions": (page) =>
    page.getByRole("heading", { level: 2, name: "Accepted sessions", exact: true }),
  // No accessible name to hold on to: the board's toolbar counter is rendered past both the
  // "Loading agenda…" gate and the "no agenda yet" one, so it is the board itself.
  "organizer /agenda": (page) => page.locator(".agenda-count"),
  "organizer /cfp": (page) =>
    page.getByRole("heading", { level: 2, name: "Publication", exact: true }),
  "organizer /program": (page) =>
    page.getByRole("heading", { level: 2, name: "Publication", exact: true }),
  // The Card around the pipeline is painted with skeletons inside it, so the card is not the
  // signal — `.pipeline-board` replaces those skeletons and exists only in the loaded branch.
  "organizer /speakers": (page) => page.locator(".pipeline-board"),
  "organizer /people": (page) => page.locator(".pipeline-board"),
  "organizer /schedule": (page) =>
    page.getByRole("heading", { level: 2, name: "Accepted sessions", exact: true }),
  // Same shape, and the empty directory is a loaded directory: both are the branch that replaces
  // the skeletons, and only one of the two is ever on screen.
  "organizer /speaker-directory": (page) =>
    page
      .locator("table.crm-table")
      .or(page.getByRole("heading", { name: /No contacts (yet|match these filters)/ })),
  "organizer /members": (page) =>
    page.getByRole("heading", { level: 2, name: "Recent identity activity", exact: true }),
  /*
   * Roles paint a `Loading roles…` card until the read answers, and both branches that replace it
   * are loaded branches: an event with composed roles shows the table, one without shows the empty
   * state. Waiting for either is waiting for the read; waiting for the card's own title would not
   * be, because the title is on screen in the loading branch too.
   */
  "organizer /roles": (page) =>
    page
      .locator("table.data")
      .first()
      .or(page.getByRole("heading", { name: "No custom roles yet" })),
  /*
   * The demo organizer is a throwaway persona, and this workspace refuses those before it fetches
   * anything (#206) — so its list never loads here and there is no loaded list to wait for. The
   * refusal *is* what this audit measures, and naming it is the honest entry; a real-session
   * organizer sees the client table instead, and `api-clients.spec.ts` is where that is audited.
   */
  "organizer /integrations/api-clients": (page) =>
    page.getByRole("link", { name: "Sign in with Google" }),
  /*
   * Webhooks answer `503 WEBHOOK_UNAVAILABLE` wherever the deployment carries no egress
   * configuration, which is every local checkout — so what loads here is the "not configured"
   * state, and that state *is* what this audit measures. Named rather than counted as covered, the
   * same way the api-clients refusal above is. A configured deployment shows the subscription
   * table instead, and no suite in this repository audits that.
   */
  "organizer /integrations/webhooks": (page) =>
    page
      .getByRole("heading", { name: "Webhook delivery is not configured here" })
      .or(page.getByRole("heading", { name: "No webhooks yet" })),
  // The outbox card is painted before its read answers; only the hint counts what arrived.
  "organizer /communications": (page) =>
    page.locator("p.hint").filter({ hasText: /\d+ deliver(y|ies) loaded/ }),
  "organizer /publishing": (page) =>
    page.getByRole("heading", { level: 2, name: "Publication", exact: true }),
  "organizer /publish": (page) =>
    page.getByRole("heading", { level: 2, name: "Publication", exact: true }),
  // Portals have the same two loaded branches as the directory above — a table of portals, or the
  // empty state that replaces it — and a `Loading sites…` card before either.
  "organizer /sites": (page) =>
    page
      .locator("table.data")
      .first()
      .or(page.getByRole("heading", { name: "No portals yet" })),
  "organizer /event-templates": (page) =>
    page.getByRole("heading", { level: 2, name: "Templates", exact: true }),
  /*
   * `/search` fetches nothing on mount — it is a form and a resting announcement until somebody
   * submits — so this waits for that resting state rather than implying a read it never makes.
   * Stated positively for the same reason as everywhere else here: an absent form would fail.
   */
  "organizer /search": (page) =>
    page.locator("p.palette-announce").filter({ hasText: "Enter a search to begin." }),
  "organizer /inbox": (page) =>
    page
      .locator("p.palette-announce")
      .filter({ hasText: /\d+ items? (is|are) waiting on this event\./ }),
  /*
   * Reports render the builder only once the catalogue answers, and the Columns checkboxes *are*
   * the catalogue — one per field of the selected dataset — so this waits for the content rather
   * than for the form around it.
   *
   * Deliberately not the dataset `<option>`s, which was the first attempt and failed twice over:
   * an option inside a closed `<select>` is never visible to a visibility assertion, and
   * `getByRole("combobox")` finds the shell's own event switcher in the banner long before it
   * finds anything this workspace rendered.
   */
  "organizer /reports": (page) =>
    page.getByRole("group", { name: "Columns" }).getByRole("checkbox").first(),
  /*
   * `/audit` is the surface the old wait was named for and did not cover: it renders no skeleton
   * and no loading gate, so the toolbar, the caption and an empty `<tbody>` are on screen from the
   * first frame and the audit measured a table with no rows in it. The live region is the only
   * thing on the page that distinguishes "reading" from "read".
   */
  "organizer /audit": (page) =>
    page.locator("p.palette-announce").filter({ hasText: /\d+ records? loaded\./ }),
  // The shell's own surface: its form is state this document already holds, with nothing fetched.
  "organizer /settings": (page) =>
    page.getByRole("heading", { level: 2, name: "Current event", exact: true }),
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
 * The wait is the whole mechanism. The first version of this helper ran ~25ms after the
 * navigation, while the panels first exist ~50ms in, so it found zero of them on every run — and
 * because it only verified a count it had itself computed as zero, it reported success while the
 * axe sweep went on auditing a page with all seven tools closed. A helper that cannot tell "there
 * are no panels here" from "the panels have not rendered yet" is not a check.
 */
async function openEveryToolPanel(page: Page, surface: string, expected?: number) {
  await settled(page, surface);
  // `networkidle` is not enough on its own here. These destinations are reached by clicking a
  // nav link, so the SPA never starts a document load and the idle state is already satisfied
  // before the workspace fetch has even been issued. A route that says how many panels it has
  // waits for them to exist; that wait is what makes the count meaningful.
  if (expected !== undefined)
    await expect(page.locator("details.tool-panel")).toHaveCount(expected);
  const opened = await page.evaluate(() => {
    const panels = [...document.querySelectorAll<HTMLDetailsElement>("details.tool-panel")];
    for (const panel of panels) panel.open = true;
    return panels.length;
  });
  // Routes with no tool panels are legitimate; a route that is supposed to have them says how
  // many, so "found none" fails here instead of passing quietly into the audit.
  if (expected !== undefined) expect(opened, "tool panels found to expand").toBe(expected);
  await expect(page.locator("details.tool-panel:not([open])")).toHaveCount(0);
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
    await page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: destination.label, exact: true })
      .click();
    await expect(page).toHaveURL(destination.href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    // A closed <details> renders nothing, and axe skips what is not rendered. #144 moved seven
    // tools — the CSV import form, the Accelevents controls, the workflow selects and textareas,
    // the bulk-assignment list, the deliverables inputs, the edit-history table, the speaker
    // checklist editor (#176) and the whole
    // resource editor — into closed panels, which would have quietly narrowed this audit to the
    // dashboard while the scorecard still called the destination clean. They are opened first so
    // the sweep covers at least what it covered when they were expanded Cards.
    await openEveryToolPanel(
      page,
      organizerSurface(destination.href),
      destination.href.startsWith("/schedule") ? 11 : undefined,
    );
    await expectNoAxeViolations(page, `organizer ${destination.label}`);
  }

  await page.goto("/schedule?tab=sessions");
  // #144: the dashboard leads. The accepted-sessions table is above the authoring tools and
  // inside the first screen, where it used to start 1420px down — 32% of a 4475px page.
  const sessionsHeading = page.getByRole("heading", { name: "Accepted sessions" });
  const resourcesHeading = page.getByRole("heading", { name: "Speaker resources" });
  await expect(sessionsHeading).toBeVisible();
  const sessionsBox = await sessionsHeading.boundingBox();
  const resourcesBox = await resourcesHeading.boundingBox();
  expect(sessionsBox, "the accepted-sessions table is rendered").not.toBeNull();
  expect(resourcesBox, "the resource tool is rendered").not.toBeNull();
  // Measured against the viewport actually in use, not a number that happens to exceed it —
  // neither Playwright config sets a viewport, so this runs at the 1280x720 default and a 900px
  // threshold would have accepted a table 130px below the fold while claiming it was above it.
  const firstScreen = page.viewportSize()?.height ?? 720;
  expect(
    sessionsBox?.y ?? 0,
    `accepted sessions is inside the first ${firstScreen}px screen, not behind authoring forms`,
  ).toBeLessThan(firstScreen);
  expect(sessionsBox?.y ?? 0, "the dashboard is above the authoring tools").toBeLessThan(
    resourcesBox?.y ?? 0,
  );
  // Authoring is one deliberate action away, and its HTML fields are not rendered until then.
  await expect(page.locator('input[value="Speaker handbook"]')).toHaveCount(0);
  await resourcesHeading.click();
  await page.getByRole("button", { name: "Edit Speaker handbook" }).click();
  await expect(page.locator('input[value="Speaker handbook"]')).toBeVisible();
  await expect(page.locator('input[value="speaker-handbook"]')).toBeVisible();
  await page.goto("/schedule?tab=agenda");
  await expect(page.getByRole("button", { name: "Generate draft" })).toBeVisible();
  await expect(page.getByText("2 of 2 scheduled")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Day", exact: true })
    .selectOption({ label: "Wed, Sep 2" });
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
  const role = page.getByRole("combobox", { name: "Signed-in role" });

  await role.selectOption("reviewer");
  await expect(page.getByRole("heading", { level: 1, name: "Review assignments" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Designing for the hallway track" }),
  ).toBeVisible();
  await expect(page.getByText("Relevance", { exact: true }).first()).toBeVisible();
  await expectNoAxeViolations(page, "reviewer assignments");

  await role.selectOption("speaker");
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
  const openRoleControl = async () => {
    const role = page.getByRole("combobox", { name: "Signed-in role" });
    if (!(await role.isVisible())) await page.locator(".account-menu summary").click();
    return role;
  };
  await (await openRoleControl()).selectOption("reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "reviewer assignments");
  await (await openRoleControl()).selectOption("speaker");
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
