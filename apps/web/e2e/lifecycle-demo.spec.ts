// @acceptance ACC-DEMO-SMOKE ACC-OPS
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

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
const EMBED_SURFACES = ["schedule", "sessions", "speakers", "gallery"] as const;
/**
 * The two signed-out surfaces. They are audited exactly as the public event pages are, because
 * they are the same kind of thing: the first screen a stranger sees, rendered before anybody has
 * authenticated. `/` is the marketing page only while signed out — an organizer's `/` is the
 * console Overview, which the organizer sweep below already covers.
 */
const MARKETING_SURFACES = [
  { path: "/", heading: "One workspace from the first proposal to the closing keynote." },
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
  // tables are the things that overflow; waiting for the network settles them first.
  await settled(page);

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
 * The workspace's own content has arrived, not just the shell that frames it.
 *
 * An element wait, not `networkidle`: these destinations are reached by clicking a nav link, so
 * the SPA starts no document load and the idle state is already satisfied before the workspace
 * fetch is issued — and on this app `networkidle` never resolves at all. Waiting for a control
 * inside `main` is the signal that the page has something to measure.
 */
async function settled(page: Page) {
  await expect(page.locator("main").locator("button, a[href]").first()).toBeVisible();
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
async function openEveryToolPanel(page: Page, expected?: number) {
  await settled(page);
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
  expect(destinations.length).toBeGreaterThanOrEqual(10);
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
    await openEveryToolPanel(page, destination.href.startsWith("/sessions") ? 8 : undefined);
    await expectNoAxeViolations(page, `organizer ${destination.label}`);
  }

  await page.goto("/sessions");
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
  await page.goto("/agenda");
  await expect(page.getByRole("button", { name: "Generate draft" })).toBeVisible();
  await expect(page.getByText("1 of 2 scheduled")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Accessible by default\. Not scheduled/ }),
  ).toBeVisible();
  await page.goto("/abstracts");
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
  const organizerPaths = await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link")
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
  for (const path of organizerPaths) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page, `organizer ${path}`);
  }
  const role = page.getByRole("combobox", { name: "Signed-in role" });
  await role.selectOption("reviewer");
  await expect(page.getByRole("heading", { name: "Review assignments" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "reviewer assignments");
  await role.selectOption("speaker");
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
