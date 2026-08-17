// @acceptance ACC-SPEAKER
/*
 * The requested-work tracker's two selection actions, and the comment control on a row.
 *
 * This file exists because of two defects a skeptical review found in the surface that replaced
 * the old assets panel, both of which a component test would have caught the day it was written:
 *
 * 1. Selectability was "the task is open", and the ZIP takes uploads — so an organizer filtering
 *    to Complete to collect the finished decks was offered no checkbox on any row, and the ZIP
 *    button could never leave its disabled state. The two buttons do not act on the same rows,
 *    and the assertions below pin that rather than the count of ticked boxes.
 * 2. The panel this replaced carried a per-asset comment form; this one dropped it, which left
 *    `POST /api/content-comments` reachable only by a speaker commenting on their own file. An
 *    organizer-authored comment is the "cross-role" half of a capability the scorecard claims.
 */
import type { ContentWorkspaceDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliverableTracker } from "../src/content/DeliverableTracker";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const profileId = "223e4567-e89b-42d3-a456-426614174001";

const uuid = (seed: number) => `423e4567-e89b-42d3-a456-${String(seed).padStart(12, "0")}`;

type Workspace = ContentWorkspaceDto;
type Task = Workspace["tasks"][number];
type Asset = Workspace["assets"][number];

const task = (seed: number, overrides: Partial<Task> = {}): Task => ({
  id: uuid(seed),
  eventId,
  speakerProfileId: profileId,
  title: `Task ${seed}`,
  // Far enough out that nothing here is incidentally overdue; the overdue filter is not what
  // these cases are about.
  dueAt: "2099-01-01T00:00:00.000Z",
  status: "open",
  type: "file-request",
  ...overrides,
});

const asset = (seed: number, taskId: string, overrides: Partial<Asset> = {}): Asset => ({
  id: uuid(900 + seed),
  eventId,
  speakerProfileId: profileId,
  name: `deck-${seed}.pdf`,
  contentType: "application/pdf",
  storageKey: `k/${seed}`,
  visibility: "private",
  uploadedAt: "2026-08-10T12:00:00.000Z",
  taskId,
  versionGroupId: uuid(900 + seed),
  versionNumber: 1,
  isLatest: true,
  ...overrides,
});

const workspace = (tasks: Task[], assets: Asset[]): Workspace => ({
  sessions: [],
  speakers: [
    {
      id: profileId,
      eventId,
      userId: "user-1",
      sourcePersonId: "crm-email:ada@example.test",
      name: "Ada Speaker",
      email: "ada@example.test",
      bio: "",
      pronouns: "",
      jobTitle: "",
      organization: "",
      version: 0,
      workflowStatus: "onboarding",
      logistics: {},
      customFields: {},
    },
  ],
  tasks,
  assets,
  messages: [],
});

/** The workspace's runner: resolves ok, so a handler's success path is the one under test. */
const run = vi.fn(async (action: () => Promise<unknown>) => {
  await action();
  return { ok: true } as const;
});
const announce = vi.fn();

function mount(value: Workspace) {
  return render(
    <DeliverableTracker
      eventId={eventId}
      workspace={value}
      busy={false}
      run={run as never}
      announce={announce}
    />,
  );
}

/** Switch the Show filter, which is the control the ZIP defect hid behind. */
const show = (label: string) =>
  fireEvent.change(screen.getByLabelText("Show"), { target: { value: label } });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("the requested-work tracker", () => {
  const open = task(1, { title: "Send your slides" });
  const done = task(2, { title: "Upload a headshot", status: "complete" });
  const doneEmpty = task(3, { title: "Confirm your bio", status: "complete" });
  const upload = asset(2, done.id, { name: "headshot.png" });

  it("offers a completed deliverable to the ZIP, which is what the ZIP is for", () => {
    mount(workspace([open, done, doneEmpty], [upload]));
    show("complete");

    // The defect: this row had no checkbox at all, so the ZIP button could never enable.
    const box = screen.getByRole("checkbox", { name: /Upload a headshot for Ada Speaker/ });
    fireEvent.click(box);
    expect(screen.getByRole("button", { name: "Download 1 file as ZIP" })).toBeEnabled();

    // A completed task nothing was uploaded against is genuinely un-actionable, so it offers no
    // control rather than one that does nothing when pressed.
    expect(screen.queryByRole("checkbox", { name: /Confirm your bio for Ada Speaker/ })).toBeNull();
  });

  it("counts only the open share of a selection as remindable", () => {
    mount(workspace([open, done], [upload]));
    show("all");

    fireEvent.click(screen.getByRole("checkbox", { name: /Send your slides for Ada Speaker/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Upload a headshot for Ada Speaker/ }));

    // Two rows ticked, one of them finished: the ZIP takes the upload, the reminder takes only
    // the outstanding one. Counting both here would promise a chase that never happens.
    expect(screen.getByRole("button", { name: "Send 1 reminder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download 1 file as ZIP" })).toBeEnabled();
  });

  it("lets an organizer comment on the upload in front of them", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ comment: {} }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    mount(workspace([done], [upload]));
    show("complete");

    fireEvent.change(screen.getByLabelText("Comment on headshot.png for Ada Speaker"), {
      target: { value: "Wrong template — please use the 16:9 one." },
    });
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/content-comments");
    // Addressed to the asset the row shows, not to the task or the speaker.
    expect(JSON.parse(String(init.body))).toMatchObject({
      assetId: upload.id,
      body: "Wrong template — please use the 16:9 one.",
    });
    // Waited for, because the `waitFor` above is satisfied by the request going out: the handler
    // calls fetch before it yields, so `toHaveBeenCalled` is true while the announcement is still
    // two ticks away — the response, its body, and the `.then` that announces.
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith("success", expect.stringContaining("headshot.png")),
    );
  });

  it("refuses to send an empty comment rather than posting one", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount(workspace([done], [upload]));
    show("complete");

    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Comment" }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
