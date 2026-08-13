// @acceptance ACC-OPS
/*
 * Searching the event the way an operator actually does it.
 *
 * The service suite proves the authorization model and the browser unit suite proves the
 * palette's states. What only a real browser can show is the journey between them: a keystroke
 * from anywhere in the console, a query typed, a result chosen with the keyboard alone, and the
 * surface that holds the record on screen afterwards with the record visible on it.
 *
 * Both roles are driven, because the permission rule is the point of the feature. A reviewer
 * gets an answer — theirs — and is told in words which sections their role does not include,
 * rather than being refused the surface or shown four empty headings.
 *
 * This spec mutates nothing. Every route it touches is a read.
 */
import { expect, type Page, test } from "@playwright/test";

async function openConsoleAs(page: Page, persona: "organizer" | "reviewer") {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  if (persona === "organizer") return;
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("reviewer");
  await expect(page.getByRole("heading", { level: 1, name: "Review assignments" })).toBeVisible();
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Search this event" });

test("an organizer reaches a session from the keyboard alone and lands on it", async ({ page }) => {
  await openConsoleAs(page, "organizer");
  await page.goto("/agenda");
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();

  // From a workspace rather than from the overview: the chord has to work wherever the operator
  // already is, which is the whole reason it is registered on the document.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole("combobox")).toBeFocused();

  // Typed with the keyboard, never filled: what is being asserted is that a keyboard-only
  // operator can drive this, and `fill()` would set the value without pressing a key. The term
  // is one the deterministic seed holds, so an empty listbox is a defect rather than a correct
  // answer about a word nobody wrote.
  await page.keyboard.type("Accessible by default");
  const option = palette(page)
    .getByRole("option", { name: /Accessible by default/ })
    .first();
  await expect(option).toBeVisible();

  // The listbox is a single tab stop: focus stays on the input while the active option moves.
  await expect(palette(page).getByRole("combobox")).toBeFocused();
  const activeId = await palette(page).getByRole("combobox").getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();

  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  // Landed on the surface that holds the record, with the record on it — the console has no
  // per-record routes today, which `GAP-022` records.
  await expect(page).toHaveURL(/\/(sessions|agenda)\?event=/);
  await expect(page.getByText("Accessible by default").first()).toBeVisible();
  // Focus followed the navigation rather than being left on a control that no longer exists.
  await expect(page.locator("main")).toBeFocused();
});

test("the full-page search surface answers an organizer and links every hit", async ({ page }) => {
  await openConsoleAs(page, "organizer");

  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Search", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();

  await page.getByLabel(/Sessions, speakers, proposals/).fill("accessible");
  // Scoped to `main`: the topbar's palette control carries the same name.
  await page.locator("main").getByRole("button", { name: "Search" }).click();

  const hit = page.getByRole("link", { name: /accessible/i }).first();
  await expect(hit).toBeVisible();
  // Every link carries the event it was searched in, produced by the server.
  await expect(hit).toHaveAttribute("href", /\?event=/);
  await hit.click();
  await expect(page).toHaveURL(/\?event=/);
});

test("a reviewer is answered from their own queue and told what their role omits", async ({
  page,
}) => {
  await openConsoleAs(page, "reviewer");

  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Search/ })
    .click();
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("hallway");

  // The reviewer's own assignment answers…
  await expect(
    palette(page).getByRole("option", { name: /Designing for the hallway track/ }),
  ).toBeVisible();
  // …and the sections their role does not include are named rather than silently absent.
  await expect(palette(page).getByText(/Not available to your role/)).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/reviews\?event=/);
  await expect(
    page.getByRole("heading", { name: "Designing for the hallway track" }),
  ).toBeVisible();
});
