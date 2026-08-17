// @acceptance ACC-OPS
/*
 * The palette's own responsibilities, none of which a service test can see.
 *
 * Three things are pinned here. Every state the operator can be in has words on the screen —
 * loading, nothing found, a section their role does not include, a section that failed —
 * because a palette that renders a heading over nothing is indistinguishable from a broken one.
 * The keyboard is the whole point of the surface, so Arrow and Enter are driven rather than
 * assumed. And a superseded keystroke's answer must never paint, which is the one defect a
 * debounce alone does not prevent.
 *
 * Focus return and the axe sweep with the palette open belong to the browser suite; jsdom can
 * assert where focus *is*, and does below, but modality is the browser's to provide.
 */
import type { SearchResponseDto, SearchSectionDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/CommandPalette";
import type { WorkspaceAccess } from "../src/workspaces/contract";

/*
 * An identity with no hub tabs at all, so the cases below measure the *search* half of the
 * palette without the destination list moving the arrow-key indices under them. The
 * destination half has its own case at the foot of this file.
 */
const noDestinations: WorkspaceAccess = {
  session: null,
  activeRole: "public",
  capabilities: [],
  isEventOrganizer: false,
};

const organizer: WorkspaceAccess = {
  session: null,
  activeRole: "organizer",
  capabilities: [
    "events:read",
    "events:settings:read",
    "events:settings:update",
    "cfp:manage",
    "review:manage",
  ],
  isEventOrganizer: true,
};

const eventId = "123e4567-e89b-12d3-a456-426614174000";

const emptySections: SearchResponseDto["sections"] = {
  content: { state: "ok", results: [] },
  review: { state: "ok", results: [] },
  agenda: { state: "ok", results: [] },
  communications: { state: "ok", results: [] },
  crm: { state: "ok", results: [] },
};

const answer = (
  query: string,
  overrides: Partial<Record<keyof SearchResponseDto["sections"], SearchSectionDto>> = {},
): SearchResponseDto => ({
  query,
  limit: 10,
  sections: { ...emptySections, ...overrides },
});

const populated = answer("keynote", {
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
      {
        kind: "speaker",
        id: "speaker-1",
        title: "Keynote Speaker",
        subtitle: "Speaker · Greenroom",
        href: `/sessions?event=${eventId}`,
      },
    ],
  },
  crm: { state: "unauthorized" },
  communications: {
    state: "failed",
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong.",
      correlationId: "abc-123",
    },
  },
});

function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }),
  );
  return calls;
}

const type = (value: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });

describe("the command palette", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("is a named modal dialog that puts focus in its own input", () => {
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Search this event" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("says what it needs before it will search, and asks nothing of the server", async () => {
    const calls = stubFetch(answer("k"));
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    type("k");

    expect(await screen.findAllByText(/at least 2 characters/i)).not.toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(calls).toHaveLength(0);
  });

  it("renders each populated state rather than a heading over nothing", async () => {
    stubFetch(populated);
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    type("keynote");

    expect(await screen.findByRole("option", { name: /Opening keynote/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Keynote Speaker/ })).toBeInTheDocument();
    // The role-omitted section is named as omitted rather than silently absent.
    expect(screen.getByText(/Not available to your role/)).toHaveTextContent("Contacts");
    // The failed section is reported without taking the working ones with it.
    expect(screen.getByText(/could not be searched/)).toHaveTextContent("Deliveries");
    expect(screen.getByText(/2 matches for/)).toBeInTheDocument();
  });

  it("says so when nothing matched, naming what was searched for", async () => {
    stubFetch(answer("zzz"));
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    type("zzz");

    expect(await screen.findByText(/No matches for “zzz”/)).toBeInTheDocument();
  });

  it("moves the active option with the arrow keys without moving DOM focus", async () => {
    stubFetch(populated);
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);
    type("keynote");
    const first = await screen.findByRole("option", { name: /Opening keynote/ });
    const second = screen.getByRole("option", { name: /Keynote Speaker/ });
    const input = screen.getByRole("combobox");

    expect(input).toHaveAttribute("aria-activedescendant", first.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    expect(second).toHaveAttribute("aria-selected", "true");
    // The listbox stays a single tab stop; the option is pointed at, never focused.
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
  });

  it("opens the active result at the link the server produced for it", async () => {
    stubFetch(populated);
    const onClose = vi.fn();
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={onClose} />);
    type("keynote");
    await screen.findByRole("option", { name: /Opening keynote/ });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(window.location.pathname + window.location.search).toBe(`/sessions?event=${eventId}`);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to whatever opened it", async () => {
    stubFetch(answer("keynote"));
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("drops the answer to a keystroke that has been superseded", async () => {
    const resolvers: ((value: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    type("keyn");
    await waitFor(() => expect(resolvers).toHaveLength(1));
    type("keynote");
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // The first request answers last. Applying it would paint a result set for a query the
    // operator has already moved on from — the defect a debounce alone does not prevent.
    resolvers[1]?.(new Response(JSON.stringify(populated), { status: 200 }));
    await screen.findByRole("option", { name: /Opening keynote/ });
    resolvers[0]?.(
      new Response(
        JSON.stringify(
          answer("keyn", {
            content: {
              state: "ok",
              results: [
                {
                  kind: "task",
                  id: "stale",
                  title: "Stale answer",
                  href: `/sessions?event=${eventId}`,
                },
              ],
            },
          }),
        ),
        { status: 200 },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Opening keynote/ })).toBeInTheDocument();
  });

  it("reports a refusal with its reference rather than an empty list", async () => {
    stubFetch(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Something went wrong.",
          correlationId: "ref-9",
        },
      },
      500,
    );
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    type("keynote");

    expect(await screen.findByText(/Reference: ref-9/)).toBeInTheDocument();
  });

  /**
   * The half of the palette that asks nobody anything.
   *
   * Roughly twenty hub-tab destinations had no keyboard route at all: the palette searched
   * records and nothing else, so a surface with no records in it — Settings, Publishing, the
   * review configuration — could be reached only by pointing at the sidebar and then at a tab.
   */
  it("offers every hub tab this account can open, before a single request is made", async () => {
    const calls = stubFetch(answer("keynote"));
    render(<CommandPalette eventId={eventId} access={organizer} open onClose={vi.fn()} />);

    const goTo = screen.getByRole("group", { name: "Go to" });
    expect(within(goTo).getByRole("option", { name: /Program · Submissions/ })).toBeInTheDocument();
    expect(within(goTo).getByRole("option", { name: /Settings · Event/ })).toBeInTheDocument();
    // The list opens pointing at its first row, so Enter alone is a complete gesture.
    expect(within(goTo).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    // Nothing was asked of the server: the destination list is the registry's own answer.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(calls).toHaveLength(0);
  });

  it("filters destinations by the same keystrokes that search, and opens the active one", () => {
    stubFetch(answer("set"));
    const onClose = vi.fn();
    render(<CommandPalette eventId={eventId} access={organizer} open onClose={onClose} />);

    type("activity");

    const goTo = screen.getByRole("group", { name: "Go to" });
    expect(within(goTo).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(window.location.pathname + window.location.search).toBe(
      `/settings?tab=activity&event=${eventId}`,
    );
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * `/search` is no longer a sidebar item — it answered exactly the question this surface
   * answers — so the palette is what carries a reader to the full page, with their query.
   */
  it("offers the full search page as the last thing in the list", async () => {
    stubFetch(populated);
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    type("keynote");

    const seeAll = await screen.findByRole("option", { name: /See all results for “keynote”/ });
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1]).toBe(seeAll);
    fireEvent.click(seeAll);
    expect(window.location.pathname + window.location.search).toBe(`/search?event=${eventId}`);
  });

  it("names the keys it is driven by rather than a Close button that scrolled away", () => {
    render(<CommandPalette eventId={eventId} access={noDestinations} open onClose={vi.fn()} />);

    expect(screen.getByText("↑↓ navigate · ↵ open · esc close")).toBeInTheDocument();
  });

  it("renders nothing at all while closed", () => {
    render(
      <CommandPalette eventId={eventId} access={noDestinations} open={false} onClose={vi.fn()} />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
