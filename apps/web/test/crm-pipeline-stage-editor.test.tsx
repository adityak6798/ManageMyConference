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
 *
 * The last case is the exception, and mounts the whole workspace: what it pins is not the
 * editor's state but *which board the workspace hands it*, and the board only fails to be there
 * while the workspace's first read is in flight.
 */
import type { PipelineStageDto, StageCategoryDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmWorkspace } from "../src/CrmWorkspace";
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

function mount(board: readonly PipelineStageDto[] = stages) {
  const onSave = vi.fn();
  const onDelete = vi.fn();
  render(
    <PipelineStageEditor
      stages={board}
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("shows the first stage added to an empty board instead of the empty state", () => {
    mount([]);
    fireEvent.change(screen.getByLabelText("New stage name"), {
      target: { value: "Shortlisted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add stage" }));

    // Every row is drawn from the draft, so the empty state has to ask the draft too: reading
    // the saved board there counted the stage as unsaved and drew "No stages yet" over it.
    expect(screen.queryByText("No stages yet")).toBeNull();
    expect(screen.getByLabelText("Stage name")).toHaveValue("Shortlisted");
    expect(screen.getByRole("button", { name: "Save board" })).toBeEnabled();
  });
});

/*
 * The board arriving late.
 *
 * `stages` is `[]` until the workspace's first read lands, and an empty array is not a board —
 * it is the absence of one. Handed that placeholder, this editor did what it does with any
 * board: took it as the thing being drafted. So a stage typed before the read landed was
 * discarded by the re-seed the arriving board triggers, leaving Save board permanently disabled
 * with nothing said; and a save sent *before* it landed posted a one-stage board, a whole-board
 * replacement that deleted every stage the read had not delivered. Two server guards bounded it:
 * Converted refuses removal, and `crm_pipeline_stage_no_stranded_prospects` aborts any delete of
 * a stage still holding one. So prospects were never strandable, and what was lost was the typed
 * stage plus any empty stage — silently, which is why nobody reported it.
 *
 * Which of the two happened turned on milliseconds, so on a fast machine neither did: this
 * reached CI as a browser journey that passed on every developer's Mac and failed on the runner.
 */
describe("ACC-CRM stage editor over a board that has not loaded", () => {
  const eventStages = [
    { key: "identified", label: "Identified", category: "open", sortOrder: 0 },
    { key: "contacted", label: "Contacted", category: "open", sortOrder: 1 },
    { key: "converted", label: "Converted", category: "won", sortOrder: 2 },
  ].map((entry, index) => ({
    ...entry,
    id: `52000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    eventId,
    createdAt: "2026-08-14T00:00:00.000Z",
  }));

  it("withholds the editor until the board is there, then drafts against the real one", async () => {
    // The read is held open rather than delayed by a timer, so the ordering this pins is the
    // one the test states rather than one a loaded machine might reorder.
    let deliverBoard!: () => void;
    const board = new Promise<void>((resolve) => {
      deliverBoard = resolve;
    });
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method && init.method !== "GET") sent.push(JSON.parse(String(init.body)));
        if (url.endsWith("/prospects/owners"))
          return new Response(JSON.stringify({ owners: [] }), { status: 200 });
        if (url.includes("/pipeline/stages")) {
          await board;
          return new Response(JSON.stringify({ stages: eventStages }), { status: 200 });
        }
        if (url.includes("/prospects"))
          return new Response(JSON.stringify({ prospects: [] }), { status: 200 });
        return new Response("{}", { status: 200 });
      }),
    );

    render(<CrmWorkspace eventId={eventId} ownerId="seed-organizer" />);
    fireEvent.click(await screen.findByRole("button", { name: "Configure stages" }));

    // Nothing to type into and nothing to press, rather than a draft of a board nobody has yet.
    expect(screen.queryByLabelText("New stage name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save board" })).toBeNull();
    // And the wait is announced once for the page, not once per placeholder: the panel's bars
    // are silent because the board underneath is already saying it. Counting the regions that
    // actually announce something — `useActionFeedback` keeps an empty one mounted on purpose,
    // so a bare count would be 2 and prove nothing — is what catches a second one returning.
    const announcing = screen
      .getAllByRole("status")
      .filter((node) => node.getAttribute("aria-label") ?? node.textContent?.trim());
    expect(announcing).toHaveLength(1);
    expect(announcing[0]).toHaveAttribute("aria-label", "Loading the sourcing board");

    deliverBoard();
    const newStage = await screen.findByLabelText("New stage name");
    fireEvent.change(newStage, { target: { value: "Shortlisted" } });
    fireEvent.click(screen.getByRole("button", { name: "Add stage" }));

    // The draft is the event's board plus the addition, so saving it adds a column rather than
    // replacing the board with one.
    fireEvent.click(screen.getByRole("button", { name: "Save board" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect((sent[0] as { stages: { key: string }[] }).stages.map(({ key }) => key)).toEqual([
      "identified",
      "contacted",
      "converted",
      "shortlisted",
    ]);
  });
});
