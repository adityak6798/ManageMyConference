// @acceptance ACC-CFP
/*
 * Republishing a closed call.
 *
 * "Publish changes" used to reopen a call the organizer had deliberately closed. The service
 * no longer does that — a publication carries the new *form* and leaves open/closed alone —
 * but the announcement still read "Published. Applicants now see this version of the form.",
 * which is the half of the outcome nobody needed telling. The surprising half is that the
 * call is still shut, and an organizer who is not told it will find out from an empty inbox.
 *
 * These are jsdom tests because the whole assertion is about the words in the live region at
 * the moment the write returns, which is exactly what a screen reader is handed.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfpWorkspace } from "../src/CfpWorkspace";

const eventId = "00000000-0000-4000-8000-000000000001";

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const notFound = () =>
  jsonResponse(
    { error: { code: "NOT_FOUND", message: "Nothing here.", correlationId: "trace-cfp" } },
    404,
  );

const form = (overrides: Record<string, unknown> = {}) => ({
  eventId,
  title: "Call for proposals",
  description: "Tell us what you would like to talk about.",
  fields: [
    {
      id: "title",
      type: "short_text",
      label: "Proposal title",
      guidance: "",
      required: true,
      options: [],
    },
  ],
  status: "closed",
  version: 3,
  publishedAt: "2026-08-01T12:00:00.000Z",
  publishedStatus: "closed",
  ...overrides,
});

/**
 * A live call in `liveState`, republished with a typo fix.
 *
 * The state endpoint answers with whatever the CFP service would: `publish` promotes the
 * stored draft and preserves the live open/closed state, so the response carries the same
 * `publishedStatus` it went in with. That preservation is the behaviour under test's premise;
 * the announcement is the thing under test.
 */
function renderRepublish(liveState: "open" | "closed") {
  const live = form({ status: liveState, publishedStatus: liveState });
  const saved = form({ status: "draft", version: 4, publishedStatus: liveState });
  const republished = form({ status: liveState, version: 4, publishedStatus: liveState });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/cfp/state")) return jsonResponse({ cfp: republished });
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return jsonResponse({ cfp: saved });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: live });
      if (url.startsWith("/api/public/events/")) return jsonResponse({ cfp: live });
      return notFound();
    }),
  );
  render(<CfpWorkspace eventId={eventId} organizer />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("publishing a call that is closed", () => {
  it("says the call is still closed, and names the control that would reopen it", async () => {
    renderRepublish("closed");

    fireEvent.change(await screen.findByLabelText("Form title"), {
      target: { value: "Call for proposals 2027" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));

    // The form went live; submissions did not. Saying only the first is how an organizer
    // concludes the call reopened — the mistake the service-side fix already prevents.
    expect(
      await screen.findByText(/Published\. The call remains closed to new submissions/),
    ).toBeInTheDocument();
    // Named, not described: "Reopen live CFP" is the label on the button beside this message,
    // so the sentence does not send anyone hunting for a control by another name.
    expect(screen.getByRole("button", { name: "Reopen live CFP" })).toBeInTheDocument();
    // And the state the announcement describes is the state on screen.
    expect(screen.getByText("Published · closed")).toBeInTheDocument();
  });

  it("still reports a republished open call as reaching applicants", async () => {
    renderRepublish("open");

    fireEvent.change(await screen.findByLabelText("Form title"), {
      target: { value: "Call for proposals 2027" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));

    // The closed sentence must not leak onto the ordinary path: an open call really is
    // "applicants now see this version", and telling them otherwise is the same defect
    // pointing the other way.
    expect(
      await screen.findByText("Published. Applicants now see this version of the form."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/remains closed/)).toBeNull();
    expect(screen.getByRole("button", { name: "Close live CFP" })).toBeInTheDocument();
  });
});
