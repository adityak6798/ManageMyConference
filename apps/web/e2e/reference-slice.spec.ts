// @acceptance ACC-IDENTITY-EVENTS
import { expect, test } from "@playwright/test";

test("signs in, switches events and roles, creates, and reloads an event", async ({ page }) => {
  const eventName = `Greenroom Browser Summit ${Date.now()}`;
  // The correlation-aware refusal moved rather than went. `/` is now the marketing landing
  // page, and a visitor at the front door is not looking at an error — but a *deep link* while
  // signed out still reaches the console's own signed-out surface, which is where `PRD-IAM-002`
  // requires the reference to appear. Asserting it there keeps the property proven instead of
  // deleting the assertion along with the screen that used to carry it.
  await page.goto("/agenda");
  await expect(page.getByRole("alert")).toContainText("Reference:");

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();

  const switcher = page.getByRole("combobox", { name: "Event workspace" });
  await expect(switcher).toContainText("Greenroom Demo Summit");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  await switcher.selectOption({ label: "Greenroom Workshop Day" });
  // The selected event is carried in the URL so a workspace view is shareable.
  await expect(page).toHaveURL(/\?event=/);

  await page.getByRole("link", { name: /Event settings/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Event settings" })).toBeVisible();
  await page.getByLabel("Current event name").fill("Greenroom Workshop Day Renamed");
  await page.getByLabel("Event timezone").fill("America/Chicago");
  await page.getByRole("button", { name: "Save event settings" }).click();
  await expect(switcher).toContainText("Greenroom Workshop Day Renamed");
  await page.getByLabel("Event name", { exact: true }).fill(eventName);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(switcher).toContainText(eventName);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(eventName);

  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("reviewer");
  await expect(page.getByRole("link", { name: /Review assignments/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Event settings/ })).toHaveCount(0);
});

// @acceptance ACC-AGENDA
test("publishes a clean agenda, explains draft conflicts, and keeps publication stable", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.getByRole("link", { name: /Agenda/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();

  await page.getByRole("button", { name: "Publish schedule" }).click();
  // The publication counter advances with every run against a shared fixture, so assert
  // that a version was published rather than pinning the number.
  await expect(page.getByRole("status")).toContainText(/Published version \d+/);

  // The conflict is made the way an organizer would make one: the second session is
  // dropped into the cell the opening keynote already holds. It used to be forged with a
  // `page.request.put` against the placements route, which proved the rule and nothing
  // about whether the product can reach it — and left a placement no control could clear.
  const card = page.getByRole("button", { name: /Accessible by default\. Not scheduled/ });
  await card.focus();
  await card.press("Enter");
  await page
    .getByRole("button", {
      name: /Place .* in Main stage at 09:00–10:00\. Already holds 1 session/,
    })
    .press("Enter");
  await expect(page.getByText("Room double-booked", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeDisabled();

  // Publication is immutable: the draft conflict must not reach the public projection.
  // The public schedule is addressed by the published slug, not the internal event id.
  const publicResponse = await request.get("/api/public/events/greenroom-demo-summit/schedule");
  expect(publicResponse.ok()).toBeTruthy();
  const body = await publicResponse.json();
  expect(body.schedule.version).toBeGreaterThanOrEqual(2);
  // The draft now places a second session on the main stage at the published session's
  // time, so a draft that reached the public route would arrive here as a second entry.
  expect(body.schedule.sessions).toHaveLength(1);
  expect(body.schedule.sessions[0].slug).toBe("designing-the-calm-conference");
  expect(body.schedule.sessions[0].room).toBe("Main stage");
  // The public schedule is composed from the published projection, so it carries readable
  // identifiers only — never the internal room/track/slot/placement keys the board uses.
  expect(JSON.stringify(body)).not.toMatch(/room-main|track-platform|slot-0900|placement-/);

  // Cleared with the same controls that made it. Leaving the conflict behind would block
  // publication for every later run against this fixture.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: /Accessible by default/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeEnabled();
});
