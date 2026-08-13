// @acceptance ACC-AGENDA
/*
 * The week board's cost follows its slots, not its cells (`DEBT-009`).
 *
 * The week view is a day × time-of-day grid, and every cell used to rescan every slot —
 * recomputing each one's calendar day through `Intl.DateTimeFormat.formatToParts`, three calls per
 * reading, as it went. Cells are the product of the two axes, so the work grew with days × times
 * on a component that re-renders continuously during a drag.
 *
 * Two things make this measurable rather than merely plausible.
 *
 * **Only the cells change.** Both boards carry twelve slots over four days, three slots a day; in
 * one the four days repeat the same three hours, in the other every day uses its own three, so the
 * rows go from three to twelve and the cells from twelve to forty-eight. Slot count and day count
 * are identical, so nothing else about the board moves.
 *
 * **The meter is per render, not per test.** `formatToParts` is reached from exactly two places in
 * `clockFor` — `dayKey`, three calls a reading, and `abbreviation`, one call per render — and they
 * are told apart by the formatter's own `resolvedOptions`. Dividing day-key readings by
 * abbreviation calls gives readings *per render*, which is the quantity `DEBT-009` is about and the
 * only one that is stable: two earlier versions of this test counted raw calls and flaked under
 * load, because how many times React renders this component before the grid appears is not a
 * property of the board's arithmetic.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { EventDto } from "@greenroom/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaWorkspace } from "../src/agenda/AgendaWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

/** UTC, so a slot's calendar day is the one its instant obviously names. */
const event: EventDto = {
  id: eventId,
  organizationId: "00000000-0000-4000-8000-000000000010",
  name: "Greenroom Summit",
  timezone: "UTC",
  createdAt: "2026-08-09T12:00:00.000Z",
};

const DAYS = 4;
const PER_DAY = 3;

/**
 * Twelve slots over four days, with either three distinct times of day or twelve.
 *
 * `sharedHours` is the only difference between the two boards, and it moves nothing except how
 * many rows the grid has — and so how many cells the same twelve slots are spread across.
 */
function boardOf(sharedHours: boolean) {
  const slots = [];
  for (let day = 0; day < DAYS; day += 1)
    for (let index = 0; index < PER_DAY; index += 1) {
      const hour = sharedHours ? index : day * PER_DAY + index;
      slots.push({
        id: `slot-${day}-${index}`,
        startsAt: `2026-09-0${day + 1}T${String(hour).padStart(2, "0")}:00:00.000Z`,
        endsAt: `2026-09-0${day + 1}T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
      });
    }
  return {
    eventId,
    rooms: [{ id: "room-main", name: "Main stage" }],
    tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
    slots,
    sessions: [{ id: "session-opening", title: "Opening keynote", speakerIds: [] }],
    placements: [
      {
        id: "placement-opening",
        sessionId: "session-opening",
        roomId: "room-main",
        trackId: "track-platform",
        slotId: "slot-0-0",
      },
    ],
    conflicts: [],
  };
}

describe("the week board's formatting cost", () => {
  const onError = vi.fn<(message: string) => void>();

  beforeEach(() => {
    window.history.replaceState(null, "", "/agenda?view=week");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    onError.mockReset();
    window.history.replaceState(null, "", "/agenda");
  });

  /** Render one week board of the given shape; answer how many day keys it read per render. */
  async function dayKeysPerRender(sharedHours: boolean) {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    let dayKeyCalls = 0;
    let renders = 0;
    const counting = vi
      .spyOn(Intl.DateTimeFormat.prototype, "formatToParts")
      .mockImplementation(function counted(this: Intl.DateTimeFormat, date) {
        // The zone-abbreviation formatter is read exactly once per render, which makes it the
        // render counter; every other `formatToParts` in `clockFor` belongs to `dayKey`.
        if (this.resolvedOptions().timeZoneName) renders += 1;
        else dayKeyCalls += 1;
        return original.call(this, date);
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ agenda: boardOf(sharedHours) }), { status: 200 }),
        ),
      ),
    );
    render(<AgendaWorkspace event={event} onError={onError} />);
    // The caption belongs to the week board itself, so this waits for the grid, not the shell.
    await screen.findByText(/Days across the top, time slots down the side/);
    // The rows really did multiply, or "fewer cells" would be the reason for less work.
    expect(screen.getAllByRole("rowheader")).toHaveLength(sharedHours ? PER_DAY : DAYS * PER_DAY);
    expect(screen.getAllByRole("columnheader")).toHaveLength(DAYS + 1);
    counting.mockRestore();
    cleanup();
    vi.unstubAllGlobals();
    expect(onError).not.toHaveBeenCalled();
    expect(renders).toBeGreaterThan(0);
    // Three `formatToParts` calls make one day key: year, month and day.
    return dayKeyCalls / 3 / renders;
  }

  it("does not grow when the same slots are spread over four times as many cells", async () => {
    const twelveCells = await dayKeysPerRender(true);
    const fortyEightCells = await dayKeysPerRender(false);

    // Identical under the fix, which reads each slot's day once and buckets the cells from that:
    // 38 readings a render at both shapes. The pre-change form read every slot's day in every
    // cell, which measured 206 and 638 across this pair. Half again is a generous bound on "did
    // not notice", and the numbers are an illustration — the assertion is the growth.
    expect(fortyEightCells).toBeLessThan(twelveCells * 1.5);
    // Only meaningful if the smaller board read any day keys at all.
    expect(twelveCells).toBeGreaterThan(0);
  });
});
