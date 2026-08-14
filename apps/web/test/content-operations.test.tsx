// @acceptance ACC-SPEAKER
/*
 * The occasional jobs of Sessions & speakers, after #144 moved them below the dashboard.
 *
 * The redesign made three promises that a screenshot cannot hold anybody to, so they are held
 * here instead: a tool costs nothing until an organizer opens it, no tool's height is a function
 * of how many speakers or resources the event has, and an audit row names a person rather than
 * the id that person is stored under (#154).
 *
 * These render `ContentOperations` directly, the way the Accelevents panel's own tests render
 * theirs: the workspace is the input, `run` is the workspace's runner, and what is asserted is
 * what the surface does with them.
 *
 * A note on `<details>`: its closed children stay in the document, so "closed" is asserted on the
 * element's `open` state and on what the organizer can actually see, never on a query returning
 * nothing. jsdom implements the disclosure itself — clicking the summary toggles it — so the
 * opening below is the real activation and not a simulated one.
 */
import type { ContentWorkspaceDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentOperations } from "../src/content/ContentOperations";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

/** Distinct, well-formed ids, so the fixture is the shape the contract describes. */
const uuid = (prefix: string, seed: number) =>
  `${prefix}${prefix}${prefix}${prefix}-${prefix}${prefix}${prefix}${prefix}-4${prefix}${prefix}${prefix}-8${prefix}${prefix}${prefix}-${String(seed).padStart(12, "0")}`;

type Workspace = ContentWorkspaceDto;
type SpeakerProfile = Workspace["speakers"][number];
type Resource = NonNullable<Workspace["resources"]>[number];
type Revision = NonNullable<Workspace["revisions"]>[number];

const speaker = (seed: number, name: string): SpeakerProfile => ({
  id: uuid("3", seed),
  eventId,
  userId: `user-${seed}`,
  sourcePersonId: `crm-email:speaker${seed}@example.test`,
  name,
  email: `speaker${seed}@example.test`,
  bio: "",
  pronouns: "",
  organization: "Greenroom Labs",
  workflowStatus: "onboarding",
  logistics: {},
  customFields: {},
});

const resource = (seed: number, title: string, slug: string): Resource => ({
  id: uuid("4", seed),
  eventId,
  title,
  slug,
  bodyHtml: `<p>${title}</p>`,
  embedHtml: "",
  visibility: "visible",
  sortOrder: seed,
});

const revision = (seed: number, actorId: string): Revision => ({
  id: uuid("5", seed),
  eventId,
  entityType: "session",
  entityId: uuid("6", seed),
  revisionNumber: seed,
  snapshotJson: "{}",
  actorId,
  createdAt: "2026-08-10T12:00:00.000Z",
});

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    sessions: [],
    speakers: [speaker(1, "Ada Speaker")],
    tasks: [],
    assets: [],
    messages: [],
    resources: [],
    comments: [],
    revisions: [],
    actorDirectory: [],
    ...overrides,
  };
}

/** `run` as the workspace supplies it: awaits the action and reports only success or failure. */
const run = async (action: () => Promise<unknown>) => {
  try {
    await action();
    return { ok: true as const };
  } catch (error) {
    // ERROR-INTENT: this mirrors the workspace's own runner, whose contract is to convert a
    // rejection into a reported failure rather than to let it escape a click handler.
    return { ok: false as const, error };
  }
};

/**
 * Mount the panels with the two reads their children take on mount already answered: the
 * Accelevents status, and the event's speaker checklist. Nothing here asserts on either panel —
 * each has its own suite — but leaving a read unanswered would make every test depend on a
 * rejected promise settling, and would put a failure notice inside a panel about something else.
 */
function mount(value: Workspace) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).endsWith("/speaker-task-templates")
        ? { templates: [] }
        : { mode: "fixture", direction: "inbound", lastRun: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return render(<ContentOperations eventId={eventId} workspace={value} busy={false} run={run} />);
}

/** The disclosure a tool lives in, found through the heading its summary carries. */
function panel(title: string): HTMLDetailsElement {
  const element = screen.getByRole("heading", { name: title }).closest("details");
  if (!element) throw new Error(`No tool panel around the heading “${title}”.`);
  return element as HTMLDetailsElement;
}

/**
 * Open a tool the way an organizer does: by activating its summary.
 *
 * Idempotent, so that whether a panel starts closed is asserted in exactly one test rather than
 * silently underpinning the other four.
 */
function open(title: string): HTMLDetailsElement {
  const element = panel(title);
  const summary = element.querySelector("summary");
  if (!summary) throw new Error(`The “${title}” tool has no summary to open.`);
  if (!element.open) fireEvent.click(summary);
  expect(element.open).toBe(true);
  return element;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the organizer's tool panels", () => {
  it("names the person an audit row was written by, not the id it stores them under", () => {
    mount(
      workspace({
        actorDirectory: [{ id: "seed-organizer", name: "Olivia Organizer" }],
        revisions: [revision(1, "seed-organizer")],
      }),
    );

    const history = open("Edit history");
    // The point of the row is "who changed this", and `seed-organizer` does not answer it for
    // anyone who did not write the seed (#154). The directory travels on the same payload as the
    // revision, so there is no second request to make and no excuse for printing the id.
    expect(within(history).getByText("Olivia Organizer")).toBeInTheDocument();
    // Asserted against the whole document rather than the cell: a stored id that leaked into a
    // tooltip, a heading or a hidden label would be the same defect in a quieter place.
    expect(document.body.textContent).not.toContain("seed-organizer");
  });

  it("falls back to the stored id when nothing on the payload knows the actor", () => {
    mount(
      workspace({
        // A directory, a speaker and a comment author are the three sources a name can come
        // from. None of them is this actor: an integration wrote the revision.
        actorDirectory: [{ id: "seed-organizer", name: "Olivia Organizer" }],
        speakers: [speaker(1, "Ada Speaker")],
        revisions: [revision(1, "accelevents-import")],
      }),
    );

    const history = open("Edit history");
    // The raw id is the deliberate answer. "Unknown" or an empty cell would hide the one value
    // an operator can search the logs for, and would read as if the edit had no author at all.
    expect(within(history).getByText("accelevents-import")).toBeInTheDocument();
    expect(within(history).queryByText(/Unknown/)).toBeNull();
  });

  it("edits one speaker's workflow however long the roster is", () => {
    const roster = Array.from({ length: 12 }, (_, index) =>
      speaker(index + 1, `Speaker ${index + 1}`),
    );
    mount(workspace({ speakers: roster }));

    const workflow = open("Speaker workflow");
    // This is the half of #144 that was unbounded: the old column stacked a status select, two
    // textareas and a submit per speaker, so a 200-speaker event rendered 200 forms and a panel
    // nobody could scroll past. One form, whatever the roster costs.
    expect(within(workflow).getAllByRole("button", { name: /^Save workflow/ })).toHaveLength(1);
    // The whole roster is still reachable — the form is chosen from it, not a truncation of it.
    expect(within(workflow).getByLabelText("Speaker")).toHaveProperty("length", 12);
    // And the one form on screen belongs to the speaker the picker names.
    expect(
      within(workflow).getByRole("button", { name: "Save workflow for Speaker 1" }),
    ).toBeInTheDocument();
  });

  it("keeps every tool closed until one is asked for", () => {
    mount(workspace({ speakers: [speaker(1, "Ada Speaker")] }));

    const panels = Array.from(document.querySelectorAll<HTMLDetailsElement>("details.tool-panel"));
    // Seven jobs; none of them is what an organizer came to this page for, so none of them is
    // open. Before #144 all seven were expanded Cards rendered above the dashboard — six here
    // and the resource editor's own, which is why the page opened on its settings.
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.filter((element) => element.open)).toHaveLength(0);
    // Closed is a claim about what can be seen, not only about an attribute: the CSV field is in
    // the document, and an organizer looking at the page cannot see or reach it.
    expect(screen.getByLabelText("CSV")).not.toBeVisible();

    const imports = open("Import speakers");
    expect(screen.getByLabelText("CSV")).toBeVisible();
    // Opening one tool opens exactly that tool. The stack is a list of independent jobs, not an
    // accordion, so nothing else moved and nothing else became visible.
    expect(panels.filter((element) => element.open)).toEqual([imports]);
    expect(screen.getByLabelText("Task")).not.toBeVisible();
  });

  it("keeps one resource editor open at a time", () => {
    mount(
      workspace({
        resources: [
          resource(1, "Speaker handbook", "handbook"),
          resource(2, "Travel and expenses", "travel"),
        ],
      }),
    );

    const resources = open("Speaker resources");
    // The roster alone: authoring fields exist once somebody chooses to author something. This
    // is what replaced a create form stacked on top of an expanded form per resource (#144).
    expect(within(resources).queryByLabelText("Title")).toBeNull();

    fireEvent.click(within(resources).getByRole("button", { name: "Edit Speaker handbook" }));
    expect(within(resources).getByLabelText("Title")).toHaveValue("Speaker handbook");

    fireEvent.click(within(resources).getByRole("button", { name: "Edit Travel and expenses" }));
    // Exactly one editor, not two: the second choice replaces the first rather than adding to
    // it, so the panel's height does not grow with the number of resources opened.
    expect(within(resources).getAllByLabelText("Title")).toHaveLength(1);
    expect(within(resources).getByLabelText("Title")).toHaveValue("Travel and expenses");
    // The row that closed says so, which is what a keyboard user is told by its control.
    expect(
      within(resources).getByRole("button", { name: "Edit Speaker handbook" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      within(resources).getByRole("button", { name: "Close Travel and expenses" }),
    ).toHaveAttribute("aria-expanded", "true");

    // The create form is the same single slot: starting a new resource closes the open editor
    // instead of putting a second set of HTML fields beside it.
    fireEvent.click(within(resources).getByRole("button", { name: "New resource" }));
    expect(within(resources).getAllByLabelText("Title")).toHaveLength(1);
    expect(within(resources).getByRole("button", { name: "Create resource" })).toBeInTheDocument();
    expect(within(resources).queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("appends a new resource rather than dropping it on top of the list", () => {
    mount(
      workspace({
        resources: [
          resource(0, "Speaker handbook", "handbook"),
          resource(1, "Travel and expenses", "travel"),
          resource(2, "Stage tech", "stage"),
        ],
      }),
    );

    const resources = open("Speaker resources");
    fireEvent.click(within(resources).getByRole("button", { name: "New resource" }));
    // Reads are `ORDER BY sort_order,title`, so a new page defaulting to 0 does not land at the
    // bottom of the speaker portal — it ties with whatever already sits at 0 and is then ordered
    // alphabetically, which is how authoring three pages in a row scrambles the portal.
    expect(within(resources).getByLabelText("Order")).toHaveValue(3);

    // An existing resource keeps the position it has; only a new one is placed.
    fireEvent.click(within(resources).getByRole("button", { name: "Edit Speaker handbook" }));
    expect(within(resources).getByLabelText("Order")).toHaveValue(0);
  });

  it("keeps the workflow form on the speaker chosen when the roster changes underneath it", () => {
    const { rerender } = mount(
      workspace({ speakers: [speaker(2, "Ada Speaker"), speaker(3, "Zoe Speaker")] }),
    );

    const workflow = open("Speaker workflow");
    // Nobody has touched the picker, so the form defaults to the first speaker offered.
    expect(
      within(workflow).getByRole("button", { name: "Save workflow for Ada Speaker" }),
    ).toBeInTheDocument();

    // A CSV import commits and the workspace refetches, and the roster arrives ordered by name,
    // so a newly imported earlier name becomes the first entry. The form must not follow it: the
    // organizer may have typed logistics into it that are not saved yet.
    rerender(
      <ContentOperations
        eventId={eventId}
        workspace={workspace({
          speakers: [
            speaker(1, "Aaron Speaker"),
            speaker(2, "Ada Speaker"),
            speaker(3, "Zoe Speaker"),
          ],
        })}
        busy={false}
        run={run}
      />,
    );
    expect(
      within(panel("Speaker workflow")).getByRole("button", {
        name: "Save workflow for Ada Speaker",
      }),
    ).toBeInTheDocument();
  });
});
