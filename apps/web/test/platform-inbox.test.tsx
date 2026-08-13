// @acceptance ACC-OPS
/*
 * The inbox surface, and specifically the two things a service test cannot see.
 *
 * Partial failure is a first-class criterion here rather than a nicety: one category that did
 * not answer must report itself and leave the other four usable, and the page must not blank.
 * And a dismissal has to round-trip through the surface — marked, still visible, and undoable —
 * because "dismissed" is a state of the item rather than a way of deleting it.
 */
import type { InboxResponseDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxWorkspace } from "../src/platform/InboxWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

const emptyCategories: InboxResponseDto["categories"] = {
  reviews: { state: "ok", items: [] },
  speakerWork: { state: "ok", items: [] },
  programme: { state: "ok", items: [] },
  deliveries: { state: "ok", items: [] },
  publication: { state: "ok", items: [] },
};

const TASK_KEY = "speaker-task:task-1:2026-08-20T23:59:00.000Z";

const answer = (overrides: Partial<InboxResponseDto["categories"]> = {}): InboxResponseDto => ({
  derivedAt: "2026-08-21T12:00:00.000Z",
  categories: { ...emptyCategories, ...overrides },
});

const withTask = (status: "open" | "dismissed") =>
  answer({
    speakerWork: {
      state: "ok",
      items: [
        {
          key: TASK_KEY,
          category: "speakerWork",
          title: "Confirm profile details",
          subtitle: "Overdue",
          priority: "high",
          status,
          owner: "Sam Speaker",
          dueAt: "2026-08-20T23:59:00.000Z",
          href: `/sessions?event=${eventId}`,
          ...(status === "dismissed" ? { dismissedAt: "2026-08-21T09:00:00.000Z" } : {}),
        },
      ],
    },
    deliveries: {
      state: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        correlationId: "ref-3",
      },
    },
    publication: { state: "unauthorized" },
  });

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Answers each GET from `reads`, in order, and records every write. */
function stubFetch(reads: unknown[], writeStatus = 204) {
  const calls: Call[] = [];
  let read = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(input),
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (method === "GET") {
        const body = reads[Math.min(read, reads.length - 1)];
        read += 1;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
      return Promise.resolve(
        writeStatus === 204
          ? new Response(null, { status: 204 })
          : new Response(
              JSON.stringify({
                error: {
                  code: "NOT_FOUND",
                  message: "That item is no longer waiting on this event.",
                  correlationId: "ref-8",
                },
              }),
              { status: writeStatus },
            ),
      );
    }),
  );
  return calls;
}

describe("the operational inbox", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("renders each category's populated state, not just its heading", async () => {
    stubFetch([withTask("open")]);
    render(<InboxWorkspace eventId={eventId} />);

    const speakerWork = within(
      (await screen.findByRole("region", { name: "Speaker work" })) as HTMLElement,
    );
    expect(speakerWork.getByRole("link", { name: "Confirm profile details" })).toHaveAttribute(
      "href",
      `/sessions?event=${eventId}`,
    );
    expect(speakerWork.getByText(/Sam Speaker/)).toBeInTheDocument();
    expect(speakerWork.getByText("high")).toBeInTheDocument();
    // An empty category says why it is empty rather than showing a bare heading.
    const reviews = within(screen.getByRole("region", { name: "Reviews outstanding" }));
    expect(reviews.getByText(/Every assignment has a completed evaluation/)).toBeInTheDocument();
  });

  it("reports the category that failed and keeps the others usable", async () => {
    stubFetch([withTask("open")]);
    render(<InboxWorkspace eventId={eventId} />);

    const deliveries = within(
      (await screen.findByRole("region", { name: "Deliveries that failed" })) as HTMLElement,
    );
    expect(deliveries.getByText(/Reference: ref-3/)).toBeInTheDocument();
    // The page did not blank: the categories that answered are still on screen.
    expect(screen.getByRole("link", { name: "Confirm profile details" })).toBeInTheDocument();
    expect(screen.getByText(/1 item is waiting/)).toBeInTheDocument();
  });

  it("names the category this role cannot read instead of hiding it", async () => {
    stubFetch([withTask("open")]);
    render(<InboxWorkspace eventId={eventId} />);

    expect(await screen.findByText(/Not available to your role/)).toHaveTextContent("Publication");
    // …and gives it no card, because there is nothing under it.
    expect(screen.queryByRole("region", { name: "Publication" })).not.toBeInTheDocument();
  });

  it("dismisses an item, keeps it visible as dismissed, and restores it", async () => {
    const calls = stubFetch([withTask("open"), withTask("dismissed"), withTask("open")]);
    render(<InboxWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Dismiss/ }));

    await waitFor(() => expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1));
    expect(calls.find(({ method }) => method === "POST")?.body).toEqual({ itemKey: TASK_KEY });
    // Still on the list, marked — an operator has to see what they set aside, and undo it.
    const restore = await screen.findByRole("button", { name: /^Restore/ });
    expect(screen.getByText("dismissed")).toBeInTheDocument();

    fireEvent.click(restore);
    await waitFor(() => expect(calls.some(({ method }) => method === "DELETE")).toBe(true));
    expect(calls.find(({ method }) => method === "DELETE")?.url).toContain(
      encodeURIComponent(TASK_KEY),
    );
  });

  it("puts the row back the way the server holds it when a dismissal is refused", async () => {
    // The read keeps answering "open", which is what the server still says after the refusal.
    stubFetch([withTask("open")], 404);
    render(<InboxWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Dismiss/ }));

    expect(await screen.findByText(/no longer waiting on this event/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Dismiss/ })).toBeInTheDocument();
    expect(screen.queryByText("dismissed")).not.toBeInTheDocument();
  });

  it("reports a refused read rather than rendering an empty inbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "FORBIDDEN", message: "Access denied.", correlationId: "ref-5" },
            }),
            { status: 403 },
          ),
        ),
      ),
    );
    render(<InboxWorkspace eventId={eventId} />);

    expect(await screen.findByText(/Reference: ref-5/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Speaker work" })).not.toBeInTheDocument();
  });
});
