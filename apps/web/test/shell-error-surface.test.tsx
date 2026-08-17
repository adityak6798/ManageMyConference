// @acceptance ACC-HARNESS
/*
 * Where a failure is rendered.
 *
 * A workspace that cannot be read has nothing else to say, so the reason takes the place of
 * the skeleton, carries the correlation id, and offers the retry. The shell keeps only the
 * failures it owns — signing in, switching identity, creating an event — which it starts and
 * finishes itself and can therefore keep accurate.
 *
 * Both halves of that rule were broken at once: a page-level surface held the only account of
 * a failed load, and it was retired by a click on any control at all — including a tab that
 * starts no request — which left a permanent skeleton with no explanation anywhere on screen.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";

const session = {
  actor: { id: "seed-organizer", name: "Olivia Organizer", persona: "organizer" },
  organizations: [{ id: organizationId, name: "Greenroom Labs" }],
  eventAccess: [{ eventId, role: "organizer", capabilities: ["events:read", "content:read"] }],
  capabilities: ["events:read", "communications:manage"],
};
const events = [
  {
    id: eventId,
    organizationId,
    name: "Summit",
    timezone: "UTC",
    createdAt: "2026-08-10T12:00:00.000Z",
  },
];

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const refusal = (correlationId: string, message: string) =>
  json({ error: { code: "INTERNAL_ERROR", message, correlationId } }, 500);

const noFixture = () =>
  json({ error: { code: "NOT_FOUND", message: "No fixture.", correlationId: "none" } }, 404);

/** A request that never answers, so nothing it returns can explain what is on screen. */
const pending = () => new Promise<Response>(() => undefined);

describe("where a failed load is explained", () => {
  beforeEach(() => window.history.replaceState(null, "", "/communications"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("puts a failed outbox read where the outbox would have been, and keeps it there", async () => {
    let outboxFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session")) return json(session);
        if (url.endsWith("/api/events/assigned")) return json({ events });
        // The compose panel above the outbox reads its own templates, recipients and merge
        // fields. All three succeed here so that exactly one read on this page has failed,
        // which is what makes "one alert" the right assertion below.
        if (url.includes("/api/communications/templates")) return json({ templates: [] });
        if (url.includes("/api/communications/recipients"))
          return json({ recipients: [], audienceVersion: "0-empty" });
        if (url.includes("/api/communications/merge-fields")) return json({ fields: [] });
        if (url.includes("/api/communications/history"))
          return outboxFails
            ? refusal("comms-trace", "The outbox could not be read.")
            : json({ history: [], nextCursor: null });
        return noFixture();
      }),
    );
    render(<App />);

    // The reason is inside the outbox card rather than at the foot of the page, and it
    // identifies the failure in the server's log.
    const outbox = await screen.findByRole("region", { name: "Delivery history" });
    // The reason, and the retry, in place of the skeleton. The reference the server answered
    // with belongs beside it as its own value; the communications workspace does not pass one
    // through yet, which is that lane's to close rather than this test's to assert away.
    const failed = await within(outbox).findByRole("alert");
    expect(failed).toHaveTextContent("The outbox could not be read.");
    expect(within(failed).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // …in place of the skeleton, so nothing claims to still be loading.
    expect(screen.queryByText("Loading the delivery history.")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    // The reproduction: a tab only narrows an already-loaded list and starts no request. It
    // used to delete the one explanation on the page and leave the skeleton up forever.
    fireEvent.click(screen.getByRole("tab", { name: /Queued/ }));
    expect(within(outbox).getByRole("alert")).toHaveTextContent("The outbox could not be read.");
    expect(screen.queryByText("Loading the delivery history.")).toBeNull();

    // The retry sits with the explanation, and a read that succeeds replaces the whole block.
    outboxFails = false;
    fireEvent.click(within(outbox).getByRole("button", { name: "Try again" }));
    await screen.findByText(/0 deliveries loaded/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/comms-trace/)).toBeNull();
  });

  it("puts a failed sessions read where the workspace would have been", async () => {
    window.history.replaceState(null, "", "/sessions");
    let contentFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session")) return json(session);
        if (url.endsWith("/api/events/assigned")) return json({ events });
        if (url.endsWith(`/api/events/${eventId}/content`))
          return contentFails
            ? refusal("content-trace", "Sessions could not be read.")
            : json({ sessions: [], speakers: [], tasks: [], assets: [], messages: [] });
        /*
         * The checklist read, answered rather than left to `noFixture`.
         *
         * It is not what this test is about, but its failure renders a `Notice tone="error"` — so
         * it lands in the same shared live region, and whether its 404 arrived before or after the
         * retry's success decided whether the final `queryByRole("alert")` saw an alert reading
         * "No fixture". Measured on this machine: 11 failures in 12 runs before, 0 in 12 after.
         *
         * The workspace fires one *other* unstubbed read, `integrations/accelevents`, and it is
         * deliberately left alone: its client swallows a failure into a null integration and
         * announces nothing, so it never raced anything. A first attempt at this fix stubbed it
         * anyway, with a body its own schema rejects — a fixture that looks like coverage and is
         * not, and one that made this comment's account of the race untrue.
         *
         * An incomplete fixture does not make a test wrong; it makes it nondeterministic, and a
         * suite that fails at random teaches people to re-run it.
         */
        if (url.endsWith(`/api/events/${eventId}/speaker-task-templates`))
          return json({ templates: [] });
        return noFixture();
      }),
    );
    render(<App />);

    // The reference is a value rather than prose: it used to be glued onto the end of the
    // server's sentence ("… Reference: content-trace"), which left the one string a reader has
    // to quote to support unselectable in the middle of a paragraph. It is now the copyable
    // line `NoticeReference` draws, so the sentence and the reference are asserted separately —
    // the same pair this file's own "keeps a failure of the shell's own on screen" already reads.
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Sessions could not be read.");
    expect(within(failure).getByText("content-trace")).toBeInTheDocument();
    // The skeleton is replaced rather than left up forever, and the shell adds no second copy.
    expect(screen.queryByText("Loading the sessions and speakers workspace.")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    contentFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Accepted sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still carries the agenda board's load failure, and no longer retires it on a click", async () => {
    // The board is the one workspace that still reports to the shell: with no draft it has
    // no grid to render a refusal in. The shell used to delete any such report on the next
    // click on any control at all, which is what left a page loading with no explanation.
    window.history.replaceState(null, "", "/agenda");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session"))
          return json({
            ...session,
            eventAccess: [{ eventId, role: "organizer", capabilities: ["agenda:manage"] }],
          });
        if (url.endsWith("/api/events/assigned")) return json({ events });
        if (url.endsWith(`/api/events/${eventId}/agenda`))
          return refusal("agenda-trace", "The agenda could not be read.");
        return noFixture();
      }),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The agenda could not be read.");
    // A control that starts nothing must not delete the only account of the failure. Opening
    // the event chip is exactly that: a listbox, no request.
    fireEvent.click(screen.getByRole("combobox", { name: "Event workspace" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The agenda could not be read.");
  });

  it("renders the board's failure above the board, and leaves it on the event it belongs to", async () => {
    /*
     * The one report the shell still accepts owes the organizer the same two things every
     * inline one gives: it is rendered against the surface it is about rather than appended
     * after everything on the page — the measured shape of the original defect — and it has
     * no life beyond the event that produced it.
     */
    window.history.replaceState(null, "", "/agenda");
    const otherEventId = "00000000-0000-4000-8000-000000000002";
    const bothEvents = [...events, { ...events[0], id: otherEventId, name: "Workshop Day" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session"))
          return json({
            ...session,
            eventAccess: bothEvents.map(({ id }) => ({
              eventId: id,
              role: "organizer",
              capabilities: ["agenda:manage"],
            })),
          });
        if (url.endsWith("/api/events/assigned")) return json({ events: bothEvents });
        if (url.endsWith(`/api/events/${eventId}/agenda`))
          return refusal("agenda-trace", "The agenda could not be read.");
        // The second board never answers, so nothing it reports can stand in for the
        // clearing this asserts: whatever is on screen after the switch got there by
        // being left over.
        if (url.endsWith(`/api/events/${otherEventId}/agenda`)) return pending();
        return noFixture();
      }),
    );
    const { container } = render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The agenda could not be read.");
    const board = container.querySelector(".agenda");
    if (!board) throw new Error("the board's own container is missing");
    expect(board.contains(alert)).toBe(false);
    expect(alert.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Switching event keeps the path, so this is a clearing rule of its own — and the
    // switcher is a listbox rather than a button, so no interaction rule can cover for it.
    const chip = screen.getByRole("combobox", { name: "Event workspace" });
    fireEvent.keyDown(chip, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: /Workshop Day/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // …and the second board is genuinely still waiting, so nothing on screen got there by
    // being left over from the event that failed.
    expect(screen.getByRole("status", { name: "Loading the run sheet" })).toBeInTheDocument();
  });

  it("keeps a failure of the shell's own on screen", async () => {
    // The shell starts and finishes its own operations, so it keeps this one accurate by
    // itself — and a click elsewhere on the page must not erase it. Creating an event is a
    // destination of its own now, rather than a second form hidden below the settings page.
    window.history.replaceState(null, "", "/events/new");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/session"))
          return json({ ...session, capabilities: [...session.capabilities, "events:create"] });
        if (url.endsWith("/api/events") && init?.method === "POST")
          return json(
            {
              error: {
                code: "VALIDATION_FAILED",
                message: "That event could not be created.",
                correlationId: "create-trace",
              },
            },
            422,
          );
        if (url.endsWith("/api/events/assigned")) return json({ events });
        return noFixture();
      }),
    );
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Event name"), {
      target: { value: "Probe Event" },
    });
    fireEvent.change(screen.getByLabelText("Public address"), {
      target: { value: "probe-event" },
    });
    fireEvent.change(screen.getByLabelText("Starts"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.change(screen.getByLabelText("Ends"), {
      target: { value: "2026-09-11" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("That event could not be created.");
    expect(within(failure).getByText("create-trace")).toBeInTheDocument();
    // Pinned under the topbar rather than appended after the whole page body, so the answer to
    // a press is beside the control that made it however long the surface behind it is.
    expect(failure.closest(".page-alert")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("Event name"));
    expect(within(screen.getByRole("alert")).getByText("create-trace")).toBeInTheDocument();
  });
});
