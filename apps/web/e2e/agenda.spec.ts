// @acceptance ACC-AGENDA
import { expect, type Page, test } from "@playwright/test";

const demoEventId = "00000000-0000-4000-8000-000000000001";
const openingSession = "20000000-0000-4000-8000-000000000001";
const openingPlacement = "placement-opening";
const keyboardPlacement = `placement-${openingSession}`;

/** The board is a shared fixture, so every test hands it back the way it found it. */
async function restoreSeedPlacement(page: Page) {
  await page.request.delete(`/api/events/${demoEventId}/agenda/placements/${keyboardPlacement}`);
  await page.request.delete(`/api/events/${demoEventId}/agenda/placements/placement-clash`);
  const restored = await page.request.put(
    `/api/events/${demoEventId}/agenda/placements/${openingPlacement}`,
    {
      data: {
        id: openingPlacement,
        sessionId: openingSession,
        roomId: "room-main",
        trackId: "track-platform",
        slotId: "slot-0900",
      },
    },
  );
  expect(restored.ok()).toBeTruthy();
}

async function openAgenda(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await page.getByRole("link", { name: /Agenda/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Room/ })).toHaveAttribute("aria-selected", "true");
}

test.afterEach(async ({ page }) => {
  await restoreSeedPlacement(page);
});

test("schedules a session with the keyboard alone", async ({ page }) => {
  await openAgenda(page);

  // Unschedule the seeded placement so the session has to be placed from scratch.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: /Designing the calm conference/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");

  await page.getByRole("tab", { name: /^Room/ }).click();
  const card = page.getByRole("button", { name: /Designing the calm conference\. Not scheduled/ });
  await card.focus();
  await card.press("Enter");
  await expect(page.getByRole("status")).toContainText("Holding");

  // Pick-up moves focus onto the first cell; the arrow keys walk the grid from there.
  const firstCell = page.getByRole("button", { name: /Place .* in Main stage at 16:00–17:00/ });
  await expect(firstCell).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: /Place .* in Workshop lab at 16:00–17:00/ }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const target = page.getByRole("button", { name: /Place .* in Workshop lab at 17:00–18:00/ });
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toContainText(
    "“Designing the calm conference” placed in Workshop lab at 17:00–18:00.",
  );
  const placed = page.getByRole("button", {
    name: /Designing the calm conference\. Workshop lab, 17:00–18:00/,
  });
  await expect(placed).toBeVisible();
  await expect(placed).toBeFocused();

  // Escape releases a held session without changing the board.
  await placed.press("Enter");
  await expect(page.getByRole("status")).toContainText("Holding");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toContainText("was not moved");
  await expect(placed).toBeVisible();
});

test("moves a placed session by dragging it onto another room and slot", async ({ page }) => {
  await openAgenda(page);

  // Native drag-and-drop is driven with real DragEvents so the same dragstart/dragover/
  // drop contract a person triggers is what the test exercises.
  const dragged = await page.evaluate(() => {
    const card = document.querySelector('[id^="agenda-placement-"]');
    const rows = document.querySelectorAll("table.board tbody tr");
    const lastRow = rows[rows.length - 1];
    const cells = lastRow?.querySelectorAll("td");
    const cell = cells?.[cells.length - 1];
    if (!card || !cell) return false;
    const transfer = new DataTransfer();
    const fire = (node: Element, type: string) =>
      node.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    fire(card, "dragstart");
    // A drop target announces itself by cancelling dragover.
    const accepted = !fire(cell, "dragover");
    fire(cell, "drop");
    return accepted;
  });
  expect(dragged).toBe(true);

  await expect(page.getByRole("status")).toContainText(
    "“Designing the calm conference” placed in Workshop lab at 17:00–18:00.",
  );
  await expect(
    page.getByRole("button", { name: /Designing the calm conference\. Workshop lab, 17:00–18:00/ }),
  ).toBeVisible();
});

test("explains a conflict in every view and blocks publication until it is fixed", async ({
  page,
}) => {
  await openAgenda(page);
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();

  // A second placement of the same session in the same room and slot is the simplest
  // way to produce all three overlap kinds the API detects.
  const clash = await page.request.put(
    `/api/events/${demoEventId}/agenda/placements/placement-clash`,
    {
      data: {
        id: "placement-clash",
        sessionId: openingSession,
        roomId: "room-main",
        trackId: "track-platform",
        slotId: "slot-0900",
      },
    },
  );
  expect(clash.ok()).toBeTruthy();
  await page.reload();

  await expect(page.getByText("room overlap")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeDisabled();
  // The room board marks the offending cards, not only the summary panel.
  await expect(
    page.getByRole("button", { name: /Designing the calm conference.*In conflict/ }).first(),
  ).toBeVisible();

  await page.getByRole("tab", { name: /^Conflicts/ }).click();
  await expect(page.getByRole("cell", { name: "Room double-booked" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Speaker double-booked" }).first()).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: /Main stage holds .* and .* at the same time/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Move one session to a different room or time." }),
  ).toBeVisible();

  await page.request.delete(`/api/events/${demoEventId}/agenda/placements/placement-clash`);
  await page.reload();
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish schedule" })).toBeEnabled();
});

test("switches views and keeps the chosen view in a shareable URL", async ({ page }) => {
  await openAgenda(page);

  await page.getByRole("tab", { name: /^List/ }).click();
  await expect(page.getByRole("columnheader", { name: "Session" })).toBeVisible();

  await page.getByRole("tab", { name: /^Week/ }).click();
  await expect(page.getByRole("columnheader", { name: /Sep 1/ })).toBeVisible();
  await expect(page).toHaveURL(/view=week/);

  await page.reload();
  await expect(page.getByRole("tab", { name: /^Week/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("columnheader", { name: /Sep 1/ })).toBeVisible();

  await page.getByRole("tab", { name: /^Track/ }).click();
  await expect(page.getByRole("heading", { name: "Platform" })).toBeVisible();
  await expect(page).toHaveURL(/view=track/);
});
