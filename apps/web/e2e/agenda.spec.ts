// @acceptance ACC-AGENDA
import { confirmInDrawer, switchEvent } from "./controls";
import { expect, type Locator, type Page, test } from "./fixtures";

const demoEventId = "00000000-0000-4000-8000-000000000001";
const openingSession = "20000000-0000-4000-8000-000000000001";
const secondSessionId = "20000000-0000-4000-8000-000000000002";
const secondSession = "Accessible by default";
const openingPlacement = "placement-opening";
const accessiblePlacement = "placement-accessible";
// Assisted placement derives a placement's id from the session it seats, so a card the pass
// created is addressable without reading it back off the board.
const assistedSecondPlacement = `assisted-${secondSessionId}`;
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
      if (id !== openingPlacement && id !== accessiblePlacement)
        await page.request.delete(`/api/events/${demoEventId}/agenda/placements/${id}`);
  }
  for (const placement of [
    {
      id: openingPlacement,
      sessionId: openingSession,
      roomId: "room-main",
      trackId: "track-platform",
      slotId: "slot-0900",
    },
    {
      id: accessiblePlacement,
      sessionId: secondSessionId,
      roomId: "room-lab",
      trackId: "track-practice",
      slotId: "slot-day-two",
    },
  ]) {
    const restored = await page.request.put(
      `/api/events/${demoEventId}/agenda/placements/${placement.id}`,
      {
        data: {
          ...placement,
        },
      },
    );
    expect(restored.ok()).toBeTruthy();
  }
  // Agenda publication now advances an already-live public programme. Hand both the draft and
  // that programme back to the next spec, rather than restoring only the private board.
  const published = await page.request.post(`/api/events/${demoEventId}/agenda/publications`);
  expect(published.ok()).toBeTruthy();
}

async function openAgenda(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  // The click posts the demo session; navigating before its cookie lands loads the board
  // unauthenticated and the shell paints the demo role picker with "Sign in to continue."
  // Every other spec that signs in and then navigates already waits here — cfp, cfp-window,
  // communications and event-templates each say so in a comment — and this helper was the one
  // that did not, which is why a red `agenda.spec.ts` kept picking a different test each run.
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(`/schedule?event=${demoEventId}&tab=agenda&view=room`);
  /*
   * More patience than the 5s default, for the cold boot only.
   *
   * Every spec in this file pays a full sign-in and first paint here — session probe, event
   * list, then the hub's own reads. On a loaded runner the eleventh one paid more than five
   * seconds and the suite failed at this heading with "element(s) not found", which reads as a
   * broken page rather than a slow one. `returnToAgenda` below keeps the default, because it
   * navigates inside an application that has already booted.
   */
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("tab", { name: /^Room/ })).toHaveAttribute("aria-selected", "true");
}

/** Come back to the board from another workspace, already signed in. */
async function returnToAgenda(page: Page) {
  await page.goto(`/schedule?event=${demoEventId}&tab=agenda&view=room`);
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Room/ })).toHaveAttribute("aria-selected", "true");
}

/**
 * A board cell, which is a `gridcell` rather than a button.
 *
 * The drop target is the whole `<td>` — an inner strip meant the drag-over highlight reported the
 * wrong area — and a focusable board cell is a WAI-ARIA gridcell, so the arrow keys walk the grid
 * at rest and not only while something is being carried.
 */
function cell(page: Page, name: RegExp): Locator {
  return page.getByRole("gridcell", { name });
}

/**
 * The board's own answer to a press.
 *
 * While the draft has conflicts the standing summary is a second polite region on this page, so
 * an unscoped `getByRole("status")` is ambiguous exactly when the board has most to say. The
 * announcement is picked out by what it is announcing.
 */
function announced(page: Page, text: string | RegExp): Locator {
  return page.getByRole("status").filter({ hasText: text }).first();
}

/**
 * Assert the draft is publishable, from the view that owns the answer.
 *
 * The board bar used to carry "No conflicts. This draft is ready to publish." at zero conflicts.
 * The Conflicts tab's own count says that at no vertical cost, so the sentence lives in the
 * Conflicts view's empty state now — which is where an organizer goes to check.
 */
async function expectNoConflicts(page: Page, returnTo: RegExp): Promise<void> {
  await page.getByRole("tab", { name: /^Conflicts/ }).click();
  await expect(page.getByRole("heading", { name: "No conflicts" })).toBeVisible();
  await expect(page.getByText("This draft can be published.")).toBeVisible();
  await page.getByRole("tab", { name: returnTo }).click();
}

/** Publish the current draft and read back the version the organizer is told about. */
async function publishAndReadVersion(page: Page): Promise<number> {
  // Publication is irreversible, so the board asks first and previews what will become public.
  await page.getByRole("button", { name: "Publish schedule" }).click();
  await confirmInDrawer(page, "Publish the schedule", "Publish schedule");
  const published = announced(page, /Published version \d+/);
  await expect(published).toBeVisible();
  const version = /Published version (\d+)/.exec(await published.innerText())?.[1];
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
  const listPanel = page.getByRole("tabpanel", { name: /^List/ });
  const listBounds = await listPanel.boundingBox();
  const unscheduleBounds = await listPanel
    .getByRole("row", { name: /Designing the calm conference/ })
    .getByRole("button", { name: "Unschedule" })
    .boundingBox();
  expect(listBounds).not.toBeNull();
  expect(unscheduleBounds?.x).toBeGreaterThanOrEqual(listBounds?.x ?? 0);
  expect((unscheduleBounds?.x ?? 0) + (unscheduleBounds?.width ?? 0)).toBeLessThanOrEqual(
    (listBounds?.x ?? 0) + (listBounds?.width ?? 0),
  );
  await page
    .getByRole("row", { name: /Designing the calm conference/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(announced(page, "moved back to Unscheduled")).toBeVisible();
  const unscheduledRail = page.getByRole("region", { name: "Unscheduled" });
  await expect(unscheduledRail).toBeVisible();
  // Unscheduling removes a row and changes the panel's height, so compare both boxes from the
  // settled layout rather than comparing the new rail with the panel's pre-mutation bounds.
  const stackedListBounds = await listPanel.boundingBox();
  const railBounds = await unscheduledRail.boundingBox();
  expect(railBounds?.y).toBeGreaterThanOrEqual(
    (stackedListBounds?.y ?? 0) + (stackedListBounds?.height ?? 0),
  );

  await page.getByRole("tab", { name: /^Room/ }).click();
  const card = page.getByRole("button", { name: /Designing the calm conference\. Not scheduled/ });
  await card.focus();
  await card.press("Enter");
  await expect(announced(page, "Holding")).toBeVisible();

  // Pick-up moves focus onto the first cell; the arrow keys walk the grid from there.
  // The cell names are the event's local times: the seeded slots are 16:00Z and 17:00Z,
  // and the demo event is America/Los_Angeles.
  const firstCell = cell(page, /Place .* in Main stage at 09:00–10:00/);
  await expect(firstCell).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(cell(page, /Place .* in Workshop lab at 09:00–10:00/)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const target = cell(page, /Place .* in Workshop lab at 10:00–11:00/);
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
  await expect(announced(page, "Holding")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(announced(page, "was not moved")).toBeVisible();
  await expect(placed).toBeVisible();
});

test("moves a placed session by dragging it onto another room and slot", async ({ page }) => {
  await openAgenda(page);

  // Native drag-and-drop is driven with real DragEvents so the same dragstart/dragover/
  // drop contract a person triggers is what the test exercises.
  const dragResult = await page.evaluate(async () => {
    const card = document.querySelector('[id^="agenda-placement-"]');
    const rows = document.querySelectorAll("table.board tbody tr");
    const lastRow = rows[rows.length - 1];
    const cells = lastRow?.querySelectorAll("td");
    const cell = cells?.[cells.length - 1];
    if (!card || !cell) return null;
    const boardCells = [...document.querySelectorAll("table.board td")];
    const bounds = () =>
      boardCells.map((boardCell) => {
        const rect = boardCell.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    const before = bounds();
    const cardRect = card.getBoundingClientRect();
    const pickup = { x: cardRect.left + cardRect.width / 2, y: cardRect.top + cardRect.height / 2 };
    const pickupCellBefore = document.elementFromPoint(pickup.x, pickup.y)?.closest("td");
    const transfer = new DataTransfer();
    const fire = (node: Element, type: string) =>
      node.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    fire(card, "dragstart");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = bounds();
    const pickupCellAfter = document.elementFromPoint(pickup.x, pickup.y)?.closest("td");
    // A drop target announces itself by cancelling dragover.
    const accepted = !fire(cell, "dragover");
    fire(cell, "drop");
    return {
      accepted,
      stable: before.every((rect, index) => {
        const next = after[index];
        const withinPixel = (left: number, right: number) => Math.abs(left - right) < 1;
        return (
          next !== undefined &&
          withinPixel(rect.x, next.x) &&
          withinPixel(rect.y, next.y) &&
          withinPixel(rect.width, next.width) &&
          withinPixel(rect.height, next.height)
        );
      }),
      pickupStayedInCell: pickupCellBefore !== null && pickupCellBefore === pickupCellAfter,
    };
  });
  expect(dragResult).toEqual({ accepted: true, stable: true, pickupStayedInCell: true });

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
    await page.goto(`/schedule?event=${demoEventId}&tab=sessions`);
    await page.getByRole("button", { name: `Edit ${secondSession}` }).click();
    // Scoped to the editor's own fieldset rather than to the page. Sessions & speakers grew a
    // second checkbox per speaker when #189 added portal invitations to the roster below, and an
    // unscoped `/Sam Speaker/` then matched both — the assignment tick and "Select Sam Speaker for
    // a portal invitation" — so this read as a strict-mode violation rather than as the ambiguity
    // it was. Naming the group keeps this journey pointed at session membership even as the page
    // accumulates further per-speaker controls.
    const speaker = page
      .getByRole("group", { name: "Speakers on this session" })
      .getByRole("checkbox", { name: /Sam Speaker/ });
    if (checked) await speaker.check();
    else await speaker.uncheck();
    await page.getByRole("button", { name: "Save session" }).click();
    await expect(speaker).toBeChecked({ checked });
    await page.getByRole("button", { name: "Close editor" }).click();
  };

  await openAgenda(page);
  await expectNoConflicts(page, /^Room/);
  const publish = page.getByRole("button", { name: "Publish schedule" });
  await expect(publish).toBeEnabled();
  const before = await publishAndReadVersion(page);

  await shareSpeaker(true);
  await returnToAgenda(page);

  // ---- one click on an occupied cell is all it takes ------------------------
  // Wave 5 gives the seed a real second day, so this session starts placed there. Move it
  // back to the rail before deliberately creating the overlap on day one.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: new RegExp(secondSession) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await page.getByRole("tab", { name: /^Room/ }).click();
  const card = page.getByRole("button", { name: new RegExp(`${secondSession}\\. Not scheduled`) });
  await card.focus();
  await card.press("Enter");
  const occupied = cell(page, /Place .* in Main stage at 09:00–10:00\. Holds 1 session/);
  await expect(occupied).toBeFocused();
  await occupied.press("Enter");
  // The placement is accepted and the conflict it created is announced with it, rather
  // than being left for the organizer to notice.
  await expect(announced(page, "it now has 2 conflicts")).toBeVisible();

  await expect(page.getByText("Room double-booked", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Speaker double-booked", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("2 conflicts block publication")).toBeVisible();
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
  await expect(announced(page, "moved to a new room")).toBeVisible();
  await expect(page.getByText("Room double-booked", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Speaker double-booked", { exact: false }).first()).toBeVisible();
  await expect(publish).toBeDisabled();

  // Moving the time settles the rest.
  await page.getByLabel(`Time assignment ${secondPlacement}`).selectOption({ index: 1 });
  await expect(announced(page, "moved to a new time")).toBeVisible();
  await expectNoConflicts(page, /^List/);
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
  await expect(announced(page, "moved back to Unscheduled")).toBeVisible();
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
  await page.getByRole("button", { name: "Rooms and times" }).click();
  const resources = page.getByRole("dialog", { name: "Rooms, tracks and times" });

  // Named on creation. The editor used to mint "Room 3" and leave renaming to a prompt, so a
  // room could only be named by creating it wrong first.
  await resources.getByRole("textbox", { name: "New room name" }).fill("Room 3");
  await resources.getByRole("button", { name: "Add room" }).click();
  await expect(page.getByRole("status")).toContainText("Room added.");
  await expect(resources.getByRole("form", { name: "Room Room 3" })).toBeVisible();
  await resources.getByRole("textbox", { name: "New track name" }).fill("Track 3");
  await resources.getByRole("button", { name: "Add track" }).click();
  await expect(page.getByRole("status")).toContainText("Track added.");
  await expect(resources.getByRole("form", { name: "Track Track 3" })).toBeVisible();
  await resources.getByRole("button", { name: "Done" }).click();

  // A new room is a new column on the board, and a new track is offerable to a placement.
  await page.getByRole("tab", { name: /^Room/ }).click();
  await expect(page.getByRole("columnheader", { name: "Room 3" })).toBeVisible();

  await page.getByRole("tab", { name: /^List/ }).click();
  await page.getByLabel(`Track assignment ${openingPlacement}`).selectOption({ label: "Track 3" });
  await expect(page.getByRole("status")).toContainText("moved to a new track");
  await page.getByLabel(`Room assignment ${openingPlacement}`).selectOption({ label: "Room 3" });
  await expect(announced(page, "moved to a new room")).toBeVisible();

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
  await page.getByRole("button", { name: "Rooms and times" }).click();
  // The row is a named form holding an editable name, so it is found by that name rather than by
  // text: an `<input value="Room 3">` contributes no text content for a filter to match.
  const roomRow = page.getByRole("form", { name: "Room Room 3" });
  await roomRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alert")).toContainText("Remove affected placements");
  await expect(roomRow).toBeVisible();

  // The placement selects are behind the drawer, so it closes before they are used and opens
  // again for the removal that the move has now made possible.
  await page
    .getByRole("dialog", { name: "Rooms, tracks and times" })
    .getByRole("button", {
      name: "Done",
    })
    .click();
  await page
    .getByLabel(`Room assignment ${openingPlacement}`)
    .selectOption({ label: "Main stage" });
  await expect(announced(page, "moved to a new room")).toBeVisible();
  await page.getByLabel(`Track assignment ${openingPlacement}`).selectOption({ label: "Platform" });
  await expect(page.getByRole("status")).toContainText("moved to a new track");

  await page.getByRole("button", { name: "Rooms and times" }).click();
  await roomRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText("Room removed.");
  await expect(roomRow).toHaveCount(0);
  await page
    .getByRole("form", { name: "Track Track 3" })
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
  await switchEvent(page, "Greenroom Workshop Day");
  await expect(page.getByText("No agenda yet — create the first room and track")).toBeVisible();

  // Hand the shared fixture back the event the rest of this file works on.
  await switchEvent(page, "Greenroom Demo Summit");
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

  // The two-day seed starts complete. Free one session so generating a draft still exercises
  // a persisted placement instead of asserting against a correctly disabled no-op control.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: new RegExp(secondSession) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await page.getByRole("tab", { name: /^Room/ }).click();
  const scheduledBefore = await page.getByText(/\d+ of \d+ scheduled/).innerText();
  await page.getByRole("button", { name: "Generate draft" }).click();

  await expect(announced(page, /Placed \d+ session/)).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ scheduled/)).not.toHaveText(scheduledBefore);

  // A generated draft is publishable, which is the whole promise: no room or speaker clash.
  await expectNoConflicts(page, /^Room/);

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
  await expect(announced(page, "moved back to Unscheduled")).toBeVisible();
});

/*
 * `#119`: the same action over a chosen subset, reached with the keyboard alone.
 *
 * Every gesture below is a key press, because selection is subject to the board's standing rule
 * that a scheduling tool which needs a mouse is unusable for part of an organizing team. The
 * assertions either side of the press are the ones that matter: the control has to say which of
 * the two things it will do *before* it is pressed, and the session that was not ticked has to
 * still be sitting unscheduled afterwards.
 */
test("places only the sessions ticked in the rail, chosen with the keyboard", async ({ page }) => {
  await openAgenda(page);

  // Free both sessions, so a subset is a real choice rather than the only one available.
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByRole("row", { name: /Designing the calm conference/ })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(announced(page, "moved back to Unscheduled")).toBeVisible();
  await page
    .getByRole("row", { name: new RegExp(secondSession) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(announced(page, "moved back to Unscheduled")).toBeVisible();
  await page.getByRole("tab", { name: /^Room/ }).click();
  const scheduledBefore = await page.getByText(/\d+ of \d+ scheduled/).innerText();

  const action = page.getByRole("button", { name: /Generate draft|Place \d+ selected/ });
  await expect(action).toHaveText(/Generate draft/);

  // ---- the rail's controls are in the tab order -----------------------------
  // Reachability, not just operability: a checkbox that only `element.focus()` can reach is
  // no use to a keyboard, and every other keyboard assertion in this file would still pass.
  const all = page.getByRole("checkbox", { name: /^Select all/ });
  await all.focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => {
      const focused = document.activeElement;
      return Boolean(
        focused instanceof HTMLInputElement &&
          focused.type === "checkbox" &&
          focused.closest(".agenda-rail"),
      );
    }),
    "Tab from the group control must reach a session's own checkbox",
  ).toBe(true);

  // ---- ticking one session, by keyboard ------------------------------------
  // Matched on the title alone: a session whose title is shared with another also carries a
  // position in its name, which is what keeps the two apart. These two seeded titles differ.
  const chosen = page.getByRole("checkbox", { name: new RegExp(`^Select ${secondSession}[ (]`) });
  await chosen.focus();
  await page.keyboard.press("Space");
  await expect(chosen).toBeChecked();
  // The group control now says "some of these", which is a different answer from "all of them".
  expect(await all.evaluate((node) => (node as HTMLInputElement).indeterminate)).toBe(true);

  // The control names the selection rather than the board, so it cannot promise to place
  // everything and then place one — the defect class the search filter had in #113.
  await expect(action).toHaveText(/Place 1 selected/);

  // Clearing is reachable the same way, and the promise reverts with it.
  const clear = page.getByRole("button", { name: "Clear selection" });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(action).toHaveText(/Generate draft/);
  await expect(chosen).not.toBeChecked();
  // That control left the screen with the selection it cleared. Focus has to land somewhere
  // the operator can carry on from; on `document.body` it means Tab restarts at the top.
  await expect(all).toBeFocused();

  await chosen.focus();
  await page.keyboard.press("Space");
  await expect(action).toHaveText(/Place 1 selected/);

  // ---- and one press seats exactly that session ----------------------------
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Placed 1 session\./ })
      .first(),
  ).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ scheduled/)).not.toHaveText(scheduledBefore);

  // The session that was not ticked is untouched: still in the rail, still unscheduled, and
  // carrying no explanation, because no pass was ever asked to seat it.
  await expect(
    page.getByRole("button", { name: /Designing the calm conference\. Not scheduled/ }),
  ).toBeVisible();

  // ---- and what it produced is an ordinary, editable placement --------------
  await page.getByRole("tab", { name: /^List/ }).click();
  await page
    .getByLabel(`Room assignment ${assistedSecondPlacement}`)
    .selectOption({ label: "Workshop lab" });
  await expect(announced(page, "moved to a new room")).toBeVisible();
  await page
    .getByRole("row", { name: new RegExp(secondSession) })
    .getByRole("button", { name: "Unschedule" })
    .click();
  await expect(announced(page, "moved back to Unscheduled")).toBeVisible();
});
