// @spec ENG-DEV-001
/**
 * Driving the control tier the way a person does.
 *
 * `ui/fields.tsx` replaced the native `<select>` popup with the WAI-ARIA select-only combobox,
 * because the popup list of a native select cannot be styled at all. The element is now a
 * `<button role="combobox">` that opens a `role="listbox"`, so `locator.selectOption` writes
 * nothing — it reports "Element is not a <select> element", and every spec that used it against a
 * converted picker was silently asserting about an unchanged value.
 *
 * These helpers are the replacement, and they are deliberately the *user's* path: the trigger is
 * pressed, the option is clicked in the list the press opened, and the list is asserted closed
 * afterwards. A spec that reached inside the component to set state would keep passing through a
 * regression that left the popover open or dropped the commit.
 */

import { expect, type Locator, type Page } from "./fixtures";

/** The listbox a trigger owns, found through its own `aria-controls` rather than by page search. */
async function listboxOf(page: Page, trigger: Locator): Promise<Locator> {
  const id = await trigger.getAttribute("aria-controls");
  // `useId` ids are legal in HTML and awkward in a CSS selector, so they are matched as an
  // attribute value rather than escaped into an `#id`.
  return id ? page.locator(`[id="${id}"]`) : page.getByRole("listbox");
}

/**
 * Open a `Select` or `Combobox` and commit one of its options.
 *
 * `option` is matched against the option's accessible name, which is its label plus any hint the
 * surface set — so a substring is usually what a caller wants and is what Playwright does by
 * default.
 */
export async function chooseOption(
  page: Page,
  control: Locator,
  option: string | RegExp,
): Promise<void> {
  /*
   * Narrowed to the combobox itself. The popover's `role="listbox"` is labelled by the same
   * `<label>` as the trigger — that is what makes the list announce which field it belongs to —
   * so a caller's `getByLabel("…")` resolves to both of them the moment the list is open.
   */
  const trigger = control.and(page.getByRole("combobox"));
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const listbox = await listboxOf(page, trigger);
  await listbox.getByRole("option", { name: option }).first().click();
  // The commit closes the popover. Asserting it here means a spec never races the next control
  // against a list that is still covering it.
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

/**
 * Filter a `Combobox` down to one match and commit it.
 *
 * The filtering variant exists for a list too long to scan — roughly 400 timezones is the one
 * length a native select popup is worst at. The textbox holds the filter, never the value, so
 * typing narrows and Enter commits whatever the list is pointing at.
 */
export async function filterAndCommit(
  page: Page,
  control: Locator,
  text: string,
): Promise<void> {
  // Narrowed for the reason `chooseOption` gives: the popover shares the field's label.
  const input = control.and(page.getByRole("combobox"));
  await input.fill(text);
  await input.press("Enter");
  await expect(input).toHaveValue(text);
}

/** Point the console at another event. The switcher is the shell's own listbox. */
export async function switchEvent(page: Page, name: string | RegExp): Promise<void> {
  await chooseOption(page, page.getByRole("combobox", { name: "Event workspace" }), name);
}

/**
 * Become another demo persona.
 *
 * The picker moved inside the account control and is only rendered on a demo deployment, so the
 * menu is opened first. It closes itself on the reload the switch causes; where it does not, the
 * caller's next assertion is against the console behind it, so it is dismissed here.
 */
export async function switchPersona(page: Page, persona: string): Promise<void> {
  const account = page.getByRole("button", { name: /^Account and access for / });
  await expect(account).toBeVisible();
  if ((await account.getAttribute("aria-expanded")) !== "true") await account.click();
  const role = page.getByRole("combobox", { name: "Demo role" });
  await chooseOption(page, role, persona);
  // Switching identity re-reads the shell without unmounting it, so the popover is still open
  // and still covering the topbar. Escape is the affordance it offers for that.
  await page.keyboard.press("Escape");
  await expect(account).toHaveAttribute("aria-expanded", "false");
}

/**
 * Answer a `SegmentedControl` — a bounded choice shown in full rather than hidden in a popover.
 *
 * It is a radiogroup, so the answer is pressed rather than selected, and "not answered" is the
 * absence of a checked radio rather than an empty string.
 */
export async function chooseSegment(group: Locator, option: string): Promise<void> {
  await group.getByRole("radio", { name: option, exact: true }).click();
}

/** What a segmented control is set to, or `null` while it has not been answered. */
export async function segmentValue(group: Locator): Promise<string | null> {
  const checked = group.getByRole("radio", { checked: true });
  if ((await checked.count()) === 0) return null;
  return (await checked.first().innerText()).trim();
}

/**
 * Run one command from an action menu.
 *
 * `ui/menu.tsx` is the WAI-ARIA menu button: the once-a-season actions a surface used to line up
 * as buttons now live behind one trigger, so reaching them means opening it first.
 */
export async function chooseMenuItem(
  page: Page,
  menu: string,
  item: string | RegExp,
): Promise<void> {
  const trigger = page.getByRole("button", { name: menu });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await page.getByRole("menu", { name: menu }).getByRole("menuitem", { name: item }).click();
}

/**
 * Answer a confirmation drawer, named by its own heading.
 *
 * Two things make the name worth passing rather than taking whichever dialog is open. The page
 * behind a modal `<dialog>` keeps its own copy of the control that opened it, so an unscoped
 * button query matches both and fails strict mode; and a confirmation raised from inside an
 * editor drawer leaves two dialogs open at once, so an unscoped *dialog* query does too.
 */
export async function confirmInDrawer(
  page: Page,
  drawer: string | RegExp,
  button: string | RegExp,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: drawer });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: button }).click();
}
