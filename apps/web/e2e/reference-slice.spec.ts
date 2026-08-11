// @acceptance ACC-IDENTITY-EVENTS
import { expect, test } from "@playwright/test";

test("signs in, switches events and roles, creates, and reloads an event", async ({ page }) => {
  const eventName = `Greenroom Browser Summit ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Reference:");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(
    "Greenroom Demo Summit",
  );
  await page
    .getByRole("combobox", { name: "Event workspace" })
    .selectOption({ label: "Greenroom Workshop Day" });
  await expect(page.getByRole("heading", { name: "Greenroom Workshop Day" })).toBeVisible();
  await page.getByLabel("Event name").fill(eventName);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { name: eventName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule sessions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build the proposal form" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toContainText(eventName);
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("reviewer");
  await expect(page.getByRole("link", { name: "Review assignments" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event" })).toHaveCount(0);
});

// @acceptance ACC-AGENDA
test("publishes a clean agenda, explains draft conflicts, and keeps publication stable", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("heading", { name: "Schedule sessions" })).toBeVisible();
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();

  await page.getByRole("button", { name: "Publish schedule" }).click();
  await expect(page.getByRole("status")).toContainText("Published version 2");
  const conflictResponse = await page.request.put(
    "/api/events/00000000-0000-4000-8000-000000000001/agenda/placements/placement-conflict",
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
  await expect(page.getByRole("alert")).toContainText("room overlap");
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeDisabled();
  await page.getByText("Manage rooms, tracks, and times").click();
  await page.getByRole("button", { name: "Add room" }).click();
  await expect(page.locator(".resource-row").filter({ hasText: "Room 3" })).toBeVisible();
  await page.getByLabel("Track").first().selectOption("track-practice");

  const publicResponse = await request.get(
    "/api/public/events/00000000-0000-4000-8000-000000000001/schedule",
  );
  expect(publicResponse.ok()).toBeTruthy();
  const body = await publicResponse.json();
  expect(body.schedule.version).toBe(2);
  expect(body.schedule.agenda.placements).toHaveLength(1);
});
