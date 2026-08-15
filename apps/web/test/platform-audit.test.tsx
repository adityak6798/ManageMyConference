// @acceptance ACC-OPS
/*
 * The timeline surface. Three things it owes the reader that the API cannot show: every column
 * the record carries is on screen, a page appends to the list rather than replacing it, and an
 * empty log says so rather than rendering a heading over nothing.
 */
import type { AuditResponseDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditWorkspace } from "../src/platform/AuditWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";

const page = (
  records: AuditResponseDto["records"],
  nextCursor: string | null = null,
): AuditResponseDto => ({ records, nextCursor });

const human = {
  id: "record-1",
  occurredAt: "2026-08-12T09:00:00.000Z",
  actorId: "seed-organizer",
  actorName: "Olivia Organizer",
  source: "human" as const,
  action: "review.decision_accepted",
  targetType: "proposal",
  targetId: "proposal-1",
  targetVersion: 7,
  correlationId: "corr-1",
};

const system = {
  id: "record-2",
  occurredAt: "2026-08-11T09:00:00.000Z",
  actorId: null,
  actorName: "System",
  source: "system" as const,
  action: "agenda.schedule_published",
  targetType: "agenda-publication",
  targetId: "schedule:v1",
  correlationId: null,
};

function stubFetch(pages: unknown[], status = 200) {
  const calls: string[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      const body = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return calls;
}

describe("the audit timeline surface", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows every fact the record carries, including who and whether it was a person", async () => {
    stubFetch([page([human, system])]);
    render(<AuditWorkspace eventId={eventId} />);

    const decision = within(
      (await screen.findByRole("row", { name: /review\.decision_accepted/ })) as HTMLElement,
    );
    expect(decision.getByText("Olivia Organizer")).toBeInTheDocument();
    expect(decision.getByText("human")).toBeInTheDocument();
    expect(decision.getByText("proposal-1")).toBeInTheDocument();
    expect(decision.getByText("v7")).toBeInTheDocument();
    expect(decision.getByText("corr-1")).toBeInTheDocument();

    // A record nobody signed says so rather than showing a blank or inventing a name.
    const published = within(
      screen.getByRole("row", { name: /agenda\.schedule_published/ }) as HTMLElement,
    );
    expect(published.getByText("System")).toBeInTheDocument();
    expect(published.getByText("system")).toBeInTheDocument();
    expect(published.getByText("—")).toBeInTheDocument();
  });

  it("appends an older page rather than replacing the one being read", async () => {
    const calls = stubFetch([page([human], "2026-08-12T09:00:00.000Z~record-1"), page([system])]);
    render(<AuditWorkspace eventId={eventId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older records" }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain("cursor=");
    // Both on screen: this is one continuous list the reader is walking down.
    expect(screen.getByRole("row", { name: /review\.decision_accepted/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /agenda\.schedule_published/ })).toBeInTheDocument();
    // …and the control goes away when there is nothing older.
    expect(screen.queryByRole("button", { name: "Load older records" })).not.toBeInTheDocument();
  });

  it("says the log is empty rather than rendering a table with no rows, and still offers Refresh", async () => {
    const calls = stubFetch([page([])]);
    render(<AuditWorkspace eventId={eventId} />);

    expect(await screen.findByText("Nothing recorded yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    // An empty log is the state a reader most wants to re-check, so the one action on this page
    // is present before there is anything to page through.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).not.toContain("cursor=");
  });

  it("reports a refusal with its reference", async () => {
    stubFetch(
      [
        {
          error: { code: "FORBIDDEN", message: "Access denied.", correlationId: "ref-2" },
        },
      ],
      403,
    );
    render(<AuditWorkspace eventId={eventId} />);

    expect(await screen.findByText(/Reference: ref-2/)).toBeInTheDocument();
  });
});
