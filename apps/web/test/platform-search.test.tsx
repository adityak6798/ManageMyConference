// @acceptance ACC-OPS
/*
 * The `/search` surface, which differs from the palette in what it owes the operator: it is a
 * page they can leave open, so it keeps the sections apart, and every hit is a real anchor
 * rather than a listbox option. What it must never do is render a section heading over an
 * answer it did not get — the omitted and the failed sections are named on screen.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchWorkspace } from "../src/platform/SearchWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

const body = {
  query: "keynote",
  limit: 10,
  sections: {
    content: {
      state: "ok",
      results: [
        {
          kind: "session",
          id: "session-1",
          title: "Opening keynote",
          subtitle: "Session · talk",
          href: `/sessions?event=${eventId}`,
        },
      ],
    },
    review: { state: "ok", results: [] },
    agenda: {
      state: "ok",
      results: [
        {
          kind: "agenda-item",
          id: "placement-1",
          title: "Opening keynote",
          subtitle: "Keynote hall",
          href: `/agenda?event=${eventId}`,
        },
      ],
    },
    communications: {
      state: "failed",
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        correlationId: "ref-7",
      },
    },
    crm: { state: "unauthorized" },
  },
};

function stubFetch(response: unknown, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(response), { status }));
    }),
  );
  return calls;
}

const search = (value: string) => {
  fireEvent.change(screen.getByLabelText(/Sessions, speakers, proposals/i), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
};

describe("the search workspace", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("groups hits by section and links each one where the server said", async () => {
    const calls = stubFetch(body);
    render(<SearchWorkspace eventId={eventId} />);

    search("keynote");

    const links = await screen.findAllByRole("link", { name: "Opening keynote" });
    // The same title appears in two sections and each carries its own destination — which is the
    // reason the server produces the link rather than the browser deriving it from the label.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/sessions?event=${eventId}`,
      `/agenda?event=${eventId}`,
    ]);
    expect(screen.getByRole("heading", { name: "Sessions, speakers and tasks" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Agenda" })).toBeVisible();
    expect(calls[0]).toContain(`/api/events/${eventId}/search?q=keynote`);
  });

  it("names the section its role does not include and the section that failed", async () => {
    stubFetch(body);
    render(<SearchWorkspace eventId={eventId} />);

    search("keynote");

    expect(await screen.findByText(/Not available to your role/)).toHaveTextContent("Contacts");
    expect(screen.getByText(/could not be searched/)).toHaveTextContent("Deliveries");
    // Neither of the two absent sections gets a heading, because there is nothing under it.
    expect(screen.queryByRole("heading", { name: "Contacts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Deliveries" })).not.toBeInTheDocument();
  });

  it("refuses a query below the minimum without asking the server", () => {
    const calls = stubFetch(body);
    render(<SearchWorkspace eventId={eventId} />);

    search("k");

    expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("says nothing matched rather than showing an empty page", async () => {
    stubFetch({
      query: "zzz",
      limit: 10,
      sections: {
        content: { state: "ok", results: [] },
        review: { state: "ok", results: [] },
        agenda: { state: "ok", results: [] },
        communications: { state: "ok", results: [] },
        crm: { state: "ok", results: [] },
      },
    });
    render(<SearchWorkspace eventId={eventId} />);

    search("zzz");

    expect(await screen.findByText(/No matches for “zzz”/)).toBeInTheDocument();
  });

  it("reports a refused search with its reference", async () => {
    stubFetch(
      {
        error: { code: "FORBIDDEN", message: "Access denied.", correlationId: "ref-4" },
      },
      403,
    );
    render(<SearchWorkspace eventId={eventId} />);

    search("keynote");

    expect(await screen.findByText(/Reference: ref-4/)).toBeInTheDocument();
  });
});
