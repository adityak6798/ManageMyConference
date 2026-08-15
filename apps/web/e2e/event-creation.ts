import type { Page } from "@playwright/test";

/** Fill the canonical fields every deliberate additional-event create requires. */
export async function fillAdditionalEvent(page: Page, input: { name: string; timezone?: string }) {
  await page.getByLabel("Event name", { exact: true }).fill(input.name);
  if (input.timezone) await page.getByLabel("New event timezone").selectOption(input.timezone);
  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Starts").fill("2027-09-10");
  await page.getByLabel("Ends").fill("2027-09-12");
}
