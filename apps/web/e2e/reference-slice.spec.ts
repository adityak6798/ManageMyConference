// @acceptance ACC-IDENTITY-EVENTS
import { expect, test } from "@playwright/test";

const demoEventId = "00000000-0000-4000-8000-000000000001";

test("signs in, switches events and roles, creates, and reloads an event", async ({ page }) => {
  const eventName = `Greenroom Browser Summit ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Reference:");
  await page.getByRole("button", { name: "Continue as organizer" }).click();

  const switcher = page.getByRole("combobox", { name: "Event workspace" });
  await expect(switcher).toContainText("Greenroom Demo Summit");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  await switcher.selectOption({ label: "Greenroom Workshop Day" });
  // The selected event is carried in the URL so a workspace view is shareable.
  await expect(page).toHaveURL(/\?event=/);

  await page.getByRole("link", { name: /Event settings/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Event settings" })).toBeVisible();
  await page.getByLabel("Event name").fill(eventName);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(switcher).toContainText(eventName);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(eventName);

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
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

  const conflictResponse = await page.request.put(
    `/api/events/${demoEventId}/agenda/placements/placement-conflict`,
    {
      data: {
        id: "placement-conflict",
        sessionId: "20000000-0000-4000-8000-000000000001",
        roomId: "room-main",
        trackId: "track-platform",
        slotId: "slot-0900",
      },
    },
  );
  expect(conflictResponse.ok()).toBeTruthy();

  await page.reload();
  await expect(page.getByText("room overlap")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeDisabled();

  // Publication is immutable: the draft conflict must not reach the public projection.
  const publicResponse = await request.get(`/api/public/events/${demoEventId}/schedule`);
  expect(publicResponse.ok()).toBeTruthy();
  const body = await publicResponse.json();
  expect(body.schedule.version).toBeGreaterThanOrEqual(2);
  expect(body.schedule.agenda.placements).toHaveLength(1);

  // Remove the conflict this test introduced. Leaving it behind blocks publication for
  // every later spec that shares this fixture.
  const cleanup = await page.request.delete(
    `/api/events/${demoEventId}/agenda/placements/placement-conflict`,
  );
  expect(cleanup.ok(), `conflict cleanup failed: ${await cleanup.text()}`).toBeTruthy();
});
