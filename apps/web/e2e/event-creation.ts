import type { Page } from "@playwright/test";
import { filterAndCommit } from "./controls";

/**
 * Fill the canonical fields every deliberate additional-event create requires.
 *
 * The form is its own destination now. It used to be a second form on `/settings?tab=event`,
 * reached by an anchor that could not work — `navigate` strips the hash — so callers landed on
 * Settings with the event's own name field in front of them and filled that instead. Opening
 * `/events/new` here keeps every caller on the form this helper is about.
 */
export async function fillAdditionalEvent(page: Page, input: { name: string; timezone?: string }) {
  await page.goto("/events/new");
  await page.getByLabel("Event name", { exact: true }).fill(input.name);
  // The zone control is a filtering combobox: type to narrow, Enter to commit the match. It is
  // named "Event timezone" here as well as in Settings — creating an event is now its own page
  // rather than a second form beside the settings one, so the two can no longer collide.
  if (input.timezone)
    await filterAndCommit(page, page.getByLabel("Event timezone", { exact: true }), input.timezone);
  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Starts").fill("2027-09-10");
  await page.getByLabel("Ends").fill("2027-09-12");
}
