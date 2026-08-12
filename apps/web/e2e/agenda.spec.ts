// @acceptance ACC-AGENDA
import { expect, type Page, test } from "@playwright/test";

const demoEventId = "00000000-0000-4000-8000-000000000001";
const openingSession = "20000000-0000-4000-8000-000000000001";
const secondSessionId = "20000000-0000-4000-8000-000000000002";
const secondSession = "Accessible by default";
const openingPlacement = "placement-opening";
// The board names a placement it creates after the session it holds, so a session the
// tests below schedule from scratch is always addressable by this id.
const secondPlacement = `placement-${secondSessionId}`;

/**
 * The board is a shared fixture, so every test hands it back the way it found it.
 *
 * Every placement that is not the seed's is removed, rather than a list of the ids the tests
 * below happen to create. Assisted placement can add one per unscheduled session, so a named
 * list would silently stop cleaning up the moment the seed gained a session (`DEBT-007`).
 */
async function restoreSeedPlacement(page: Page) {
  const board = await page.request.get(`/api/events/${demoEventId}/agenda`);
  if (board.ok()) {
    const { agenda } = (await board.json()) as { agenda: { placements: { id: string }[] } };
    for (const { id } of agenda.placements)
      if (id !== openingPlacement)
        await page.request.delete(`/api/events/${demoEventId}/agenda/placements/${id}`);
  }
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

/** Come back to the board from another workspace, already signed in. */
async function returnToAgenda(page: Page) {
  await page.goto(`/agenda?event=${demoEventId}&view=room`);
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Room/ })).toHaveAttribute("aria-selected", "true");
}

/** Publish the current draft and read back the version the organizer is told about. */
async function publishAndReadVersion(page: Page): Promise<number> {
  await page.getByRole("button", { name: "Publish schedule" }).click();
  const announced = page
    .getByRole("status")
    .filter({ hasText: /Published version \d+/ })
    .first();
  await expect(announced).toBeVisible();
  const version = /Published version (\d+)/.exec(await announced.innerText())?.[1];
  expect(version, "the publish announcement must name a version").toBeTruthy();
  return Number(version);
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
  // The cell names are the event's local times: the seeded slots are 16:00Z and 17:00Z,
  // and the demo event is America/Los_Angeles.
  const firstCell = page.getByRole("button", { name: /Place .* in Main stage at 09:00–10:00/ });
  await expect(firstCell).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: /Place .* in Workshop lab at 09:00–10:00/ }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const target = page.getByRole("button", { name: /Place .* in Workshop lab at 10:00–11:00/ });
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toContainText(
    "“Designing the calm conference” placed in Workshop lab at 10:00–11:00.",
  );
  const placed = page.getByRole("button", {
    name: /Designing the calm conference\. Workshop lab, 10:00–11:00/,
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
    "“Designing the calm conference” placed in Workshop lab at 10:00–11:00.",
  );
  await expect(
    page.getByRole("button", { name: /Designing the calm conference\. Workshop lab, 10:00–11:00/ }),
  ).toBeVisible();
});

/**
 * The conflict journey, driven entirely by the organizer's own controls.
 *
 * It used to forge the overlap with a `page.request.put` against the placements route,
 * which proved the *rules* and said nothing about whether an organizer can reach them —
 * and, because a forged placement cannot be cleared by any control on screen, it never
 * asserted the other direction either. Both conflicts here are produced by the board and
 * the placement selects, and both are cleared the same way.
 */
test("reaches a conflict from the board, explains it, and blocks publication until it clears", async ({
  page,
}) => {
  // The two seeded sessions carry different speakers, so a speaker overlap needs a shared
  // one. It is arranged the way an organizer would: by ticking the speaker onto the second
  // session in Sessions & speakers. Undone at the end of the test.
  const shareSpeaker = async (checked: boolean) => {
    await page.goto(`/sessions?event=${demoEventId}`);
    await page.getByRole("button", { name: `Edit ${secondSession}` }).click();
    const speaker = page.getByRole("checkbox", { name: /Sam Speaker/ });
    if (checked) await speaker.check();
    else await speaker.uncheck();
    await page.getByRole("button", { name: "Save session" }).click();
    await expect(speaker).toBeChecked({ checked });
    await page.getByRole("button", { name: "Close editor" }).click();
  };

  await openAgenda(page);
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();
  const publish = page.getByRole("button", { name: "Publish schedule" });
  await expect(publish).toBeEnabled();
  const before = await publishAndReadVersion(page);

  await shareSpeaker(true);
  await returnToAgenda(page);

  // ---- one click on an occupied cell is all it takes ------------------------
  const card = page.getByRole("button", { name: new RegExp(`${secondSession}\\. Not scheduled`) });
  await card.focus();
  await card.press("Enter");
  const occupied = page.getByRole("button", {
    name: /Place .* in Main stage at 09:00–10:00\. Already holds 1 session/,
  });
  await expect(occupied).toBeFocused();
  await occupied.press("Enter");
  // The placement is accepted and the conflict it created is announced with it, rather
  // than being left for the organizer to notice.
  await expect(page.getByRole("status")).toContainText("it now has 2 conflicts");

  await expect(page.getByText("room overlap")).toBeVisible();
  await expect(page.getByText("speaker overlap")).toBeVisible();
  await expect(publish).toBeDisabled();
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
  await expect(
    page.getByRole("cell", { name: "Move one session so the speaker has no overlap." }).first(),
  ).toBeVisible();

  // ---- and the same controls clear it --------------------------------------
  // Moving the room settles the double-booked room; the speakers are still on stage at the
  // same time, so one conflict remains and publication stays blocked.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByLabel(`Room assignment ${secondPlacement}`)
    .selectOption({ label: "Workshop lab" });
  await expect(page.getByRole("status")).toContainText("moved to a new room");
  await expect(page.getByText("room overlap")).toHaveCount(0);
  await expect(page.getByText("speaker overlap")).toBeVisible();
  await expect(publish).toBeDisabled();

  // Moving the time settles the rest.
  await page.getByLabel(`Time assignment ${secondPlacement}`).selectOption({ index: 1 });
  await expect(page.getByRole("status")).toContainText("moved to a new time");
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();
  await expect(publish).toBeEnabled();

  // ---- publication resumes, and advances ------------------------------------
  expect(await publishAndReadVersion(page)).toBe(before + 1);

  // ---- and the published snapshot is handed back ----------------------------
  // A publication is immutable, so removing the placement from the draft is not enough:
  // the snapshot just taken still carries it, and the next event publish would compose a
  // public schedule around a session this test only borrowed.
  await page
    .getByRole("row", { name: new RegExp(secondSession) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");
  expect(await publishAndReadVersion(page)).toBe(before + 2);

  await shareSpeaker(false);
});

/**
 * The resource editor.
 *
 * Rooms and tracks are the board's axes, and `saveAgendaResources` lost its only browser
 * coverage when the reference slice was rewritten for the routed UI. Everything this adds
 * it removes again, so the board the next spec meets is the seeded two-by-two.
 */
test("adds a room and a track, reassigns a placement onto them, and clears up after itself", async ({
  page,
}) => {
  await openAgenda(page);
  await page.getByText("Manage rooms, tracks, and times").click();

  // The editor names what it appends after the count it already has, so on the seeded
  // board these are always the third of each.
  await page.getByRole("button", { name: "Add room" }).click();
  await expect(page.getByRole("status")).toContainText("Room added.");
  await expect(page.locator(".resource-row").filter({ hasText: "Room 3" })).toBeVisible();
  await page.getByRole("button", { name: "Add track" }).click();
  await expect(page.getByRole("status")).toContainText("Track added.");
  await expect(page.locator(".resource-row").filter({ hasText: "Track 3" })).toBeVisible();

  // A new room is a new column on the board, and a new track is offerable to a placement.
  await page.getByRole("tab", { name: /^Room/ }).click();
  await expect(page.getByRole("columnheader", { name: "Room 3" })).toBeVisible();

  await page.getByRole("tab", { name: /^List/ }).click();
  await page.getByLabel(`Track assignment ${openingPlacement}`).selectOption({ label: "Track 3" });
  await expect(page.getByRole("status")).toContainText("moved to a new track");
  await page.getByLabel(`Room assignment ${openingPlacement}`).selectOption({ label: "Room 3" });
  await expect(page.getByRole("status")).toContainText("moved to a new room");

  // Saved, not merely rendered: a full reload asks the API again, and the Track view is
  // built from the placement's own track rather than from the select that changed it.
  await page.reload();
  await page.getByRole("tab", { name: /^Track/ }).click();
  await expect(
    page.getByRole("region", { name: "Track 3 track" }).getByText("Designing the calm conference"),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Room/ }).click();
  await expect(page.getByRole("columnheader", { name: "Room 3" })).toBeVisible();

  // ---- and put the board back -----------------------------------------------
  // A room or track still holding a placement cannot be removed, so the placement moves
  // home first. That refusal is the editor's own guard and is asserted on the way past.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page.getByText("Manage rooms, tracks, and times").click();
  const roomRow = page.locator(".resource-row").filter({ hasText: "Room 3" });
  await roomRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alert")).toContainText("Remove affected placements");
  await expect(roomRow).toBeVisible();

  await page
    .getByLabel(`Room assignment ${openingPlacement}`)
    .selectOption({ label: "Main stage" });
  await expect(page.getByRole("status")).toContainText("moved to a new room");
  await page.getByLabel(`Track assignment ${openingPlacement}`).selectOption({ label: "Platform" });
  await expect(page.getByRole("status")).toContainText("moved to a new track");

  await roomRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText("Room removed.");
  await expect(roomRow).toHaveCount(0);
  await page
    .locator(".resource-row")
    .filter({ hasText: "Track 3" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByRole("status")).toContainText("Track removed.");
  await page.reload();
  await page.getByRole("tab", { name: /^Room/ }).click();
  await expect(page.getByRole("columnheader", { name: "Room 3" })).toHaveCount(0);
});

test("renders slot times on the event's clock, not UTC", async ({ page }) => {
  await openAgenda(page);

  // The seeded slots are 16:00Z and 17:00Z and the demo event is America/Los_Angeles,
  // so a regression to UTC formatting turns every assertion below red.
  await expect(page.getByRole("rowheader", { name: "09:00–10:00" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "10:00–11:00" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "16:00–17:00" })).toHaveCount(0);
  await expect(
    page.getByText("Times are shown in America/Los_Angeles (PDT)").first(),
  ).toBeVisible();

  // The Day view puts the same slots across the top rather than down the side.
  await page.getByRole("tab", { name: /^Day/ }).click();
  await expect(page.getByRole("columnheader", { name: "09:00–10:00" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "16:00–17:00" })).toHaveCount(0);

  // The local day is what buckets the Week view, and 16:00Z is still September 1st
  // in Los Angeles.
  await page.getByRole("tab", { name: /^Week/ }).click();
  await expect(page.getByRole("columnheader", { name: /Tue, Sep 1/ })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "09:00–10:00" })).toBeVisible();

  // Switching to an event with no agenda now renders the explicit, read-only empty state.
  // Issue #70 deliberately removed the old read-time provisioning this assertion relied on.
  const switcher = page.getByRole("combobox", { name: "Event workspace" });
  await switcher.selectOption({ label: "Greenroom Workshop Day" });
  await expect(page.getByText("No agenda yet — create the first room and track")).toBeVisible();

  // Hand the shared fixture back the event the rest of this file works on.
  await switcher.selectOption({ label: "Greenroom Demo Summit" });
  await expect(
    page.getByText("Times are shown in America/Los_Angeles (PDT)").first(),
  ).toBeVisible();
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

/*
 * `AIA-08`: one action fills the board, and the result is an ordinary draft.
 *
 * The last two assertions are the ones that matter most. A generated draft that survives a
 * reload but cannot be edited afterwards would be a wizard's output rather than a starting
 * point, and one that reached the public schedule without the explicit publish step would
 * break the rule the whole domain is built on.
 */
test("generates a conflict-free draft in one action and keeps it editable", async ({ page }) => {
  await openAgenda(page);

  const scheduledBefore = await page.getByText(/\d+ of \d+ scheduled/).innerText();
  await page.getByRole("button", { name: "Generate draft" }).click();

  const announced = page
    .getByRole("status")
    .filter({ hasText: /Placed \d+ session/ })
    .first();
  await expect(announced).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ scheduled/)).not.toHaveText(scheduledBefore);

  // A generated draft is publishable, which is the whole promise: no room or speaker clash.
  await page.getByRole("tab", { name: /^Conflicts/ }).click();
  await expect(page.getByText("No conflicts. This draft is ready to publish.")).toBeVisible();
  await page.getByRole("tab", { name: /^Room/ }).click();

  // It survives a reload, so it is real draft state rather than something held on screen.
  await returnToAgenda(page);
  const afterReload = await page.getByText(/\d+ of \d+ scheduled/).innerText();
  expect(afterReload).not.toEqual(scheduledBefore);

  // And it is still an ordinary board: a session the pass placed can be sent back with the
  // same control that removes a hand-placed one, through the same list view.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: new RegExp(secondSession) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(page.getByRole("status")).toContainText("moved back to Unscheduled");
});
