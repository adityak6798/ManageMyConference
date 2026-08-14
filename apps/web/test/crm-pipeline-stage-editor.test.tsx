// @acceptance ACC-CRM
/*
 * The seam between the two ways this editor changes a board.
 *
 * Names, order and categories are a draft the organizer saves deliberately; removing a stage is
 * its own request, and the board it answers with re-seeds that draft. What is pinned here is
 * what happens when the two meet — a removal begun with unsaved edits in hand used to carry them
 * off with no message and nothing to undo from, which is losing typed work rather than a rough
 * edge. The editor is rendered directly, the way the Accelevents panel's tests do, because the
 * property is about this component's own state rather than about anything the server said.
 */
import type { PipelineStageDto, StageCategoryDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineStageEditor } from "../src/crm/PipelineStageEditor";

const eventId = "00000000-0000-4000-8000-000000000001";
const stage = (
  key: string,
  label: string,
  sortOrder: number,
  category: StageCategoryDto = "open",
): PipelineStageDto => ({
  id: `70000000-0000-4000-8000-00000000000${sortOrder}`,
  eventId,
  key,
  label,
  category,
  sortOrder,
  createdAt: "2026-08-01T12:00:00.000Z",
});
const stages = [
  stage("identified", "Identified", 0),
  stage("engaged", "Engaged", 1),
  stage("converted", "Converted", 2, "won"),
];

function mount() {
  const onSave = vi.fn();
  const onDelete = vi.fn();
  render(
    <PipelineStageEditor
      stages={stages}
      counts={new Map([["engaged", 2]])}
      busy={false}
      onSave={onSave}
      onDelete={onDelete}
    />,
  );
  // The first row's name field. Queried by position because every row labels its input "Stage
  // name", which is what an organizer reads next to it.
  const firstName = () => screen.getAllByLabelText("Stage name")[0] as HTMLInputElement;
  // The row's own Remove control: every row carries Move up, Move down and Remove, and each of
  // them names its stage, so the verb has to be part of the query.
  const remove = (label: string) =>
    screen.getByRole("button", { name: new RegExp(`^Remove\\b.*${label}`) });
  return { onSave, onDelete, firstName, remove };
}

afterEach(cleanup);

describe("ACC-CRM pipeline stage editor", () => {
  it("refuses to remove a stage while a rename is unsaved, and keeps the rename", () => {
    const { onDelete, firstName, remove } = mount();
    fireEvent.change(firstName(), { target: { value: "Sourcing" } });
    fireEvent.click(remove("Engaged"));

    // Nothing was sent, so the reload that would have re-seeded this draft never happens...
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Remove and move them/ })).toBeNull();
    // ...the organizer is told why rather than left with a button that did nothing...
    expect(screen.getByRole("alert")).toHaveTextContent(/save or discard your changes/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/Engaged/);
    // ...and the typing is still on the screen, which is the whole point of refusing.
    expect(firstName().value).toBe("Sourcing");
  });

  it("refuses at the confirm too, so a rename typed while the dialog is open survives", () => {
    const { onDelete, firstName, remove } = mount();
    // Opened with a settled draft, so the dialog is offered — the name fields stay live while it
    // is open, and a rename typed here would otherwise slip past a check made only on opening.
    fireEvent.click(remove("Engaged"));
    fireEvent.change(firstName(), { target: { value: "Sourcing" } });
    fireEvent.click(screen.getByRole("button", { name: /Remove and move them/ }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/save or discard your changes/i);
    expect(firstName().value).toBe("Sourcing");
  });

  it("removes as it always did once the draft is settled, and forgets the refusal", () => {
    const { onDelete, firstName, remove } = mount();
    fireEvent.change(firstName(), { target: { value: "Sourcing" } });
    fireEvent.click(remove("Engaged"));
    // Discarding answers the message, so it goes: both ways out are on this screen, and the
    // refusal is a wait rather than a lockout.
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(firstName().value).toBe("Identified");

    fireEvent.click(remove("Engaged"));
    fireEvent.click(screen.getByRole("button", { name: /Remove and move them/ }));
    // Converted is never a destination, so the offered default is the other open stage.
    expect(onDelete).toHaveBeenCalledWith("engaged", "identified");
  });
});
