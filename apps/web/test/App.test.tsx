// @acceptance ACC-IDENTITY-EVENTS
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { bytesToBase64 } from "../src/ContentWorkspace";
import { instanceLabel } from "../src/InstanceMarker";
import { clearOrganizerOverviewCache } from "../src/api/overview";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "123e4567-e89b-12d3-a456-426614174000";
const organizerSession = {
  actor: { id: "seed-organizer", name: "Olivia Organizer", persona: "organizer" },
  organizations: [{ id: organizationId, name: "Greenroom Labs" }],
  eventAccess: [
    {
      eventId,
      role: "organizer",
      capabilities: ["events:read", "events:settings:read", "events:settings:update"],
    },
  ],
  capabilities: ["events:read", "events:create"],
};
const event = {
  id: eventId,
  organizationId,
  name: "Greenroom Summit",
  timezone: "America/Los_Angeles",
  createdAt: "2026-08-09T12:00:00.000Z",
};

/** Empty-but-valid payloads for the overview fan-out so the landing page settles. */
const emptyWorkspaces: Record<string, unknown> = {
  content: { sessions: [], speakers: [], tasks: [], assets: [], messages: [] },
  "review/organizer": {
    proposals: [],
    plan: { eventId, criteria: [], updatedAt: "2026-08-09T12:00:00.000Z" },
    assignments: [],
    outcomes: [],
    audit: [],
    statuses: [],
    reviewers: [],
  },
  agenda: {
    eventId,
    rooms: [],
    tracks: [],
    slots: [],
    sessions: [],
    placements: [],
    conflicts: [],
  },
};

function workspaceBody(url: string) {
  if (url.endsWith("/overview"))
    return {
      content: { ok: true, data: emptyWorkspaces.content },
      review: { ok: true, data: emptyWorkspaces["review/organizer"] },
      agenda: { ok: true, data: emptyWorkspaces.agenda },
      publication: {
        ok: true,
        data: {
          eventId,
          slug: "greenroom-summit",
          state: "published",
          draft: {
            event: {
              eventId,
              slug: "greenroom-summit",
              name: event.name,
              summary: "A summit.",
              startsOn: "2026-09-01",
              endsOn: "2026-09-01",
              timezone: event.timezone,
              venue: "Greenroom Labs",
            },
            cfp: {
              title: "CFP",
              description: "Submit.",
              status: "closed",
              publishedAt: null,
              submissionUrl: "/cfp",
            },
            sessions: [],
            speakers: [],
          },
          published: null,
          publishedAt: null,
        },
      },
    };
  for (const [suffix, body] of Object.entries(emptyWorkspaces))
    if (url.includes(`/${suffix}`)) return body;
  return null;
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("App", () => {
  beforeEach(() => {
    // Routing is real now, so each test must start from the app root.
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // The overview fan-out is memoised per event at module scope, so a test that renders the
    // Overview leaves a warm cache behind and the next one measures fewer requests than it made.
    // Cleared here rather than in the one test that noticed, because any test reaching the
    // Overview has the same effect on whatever runs after it.
    clearOrganizerOverviewCache();
  });

  it("encodes files larger than the JavaScript argument limit", () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("names local and deployed instances without relying on the URL bar", () => {
    expect(instanceLabel("localhost")).toBe("Local instance");
    expect(instanceLabel("project-greenroom-api.adityak6798.workers.dev")).toBe("Deployed demo");
    expect(instanceLabel("greenroom.example.com")).toBe("Hosted instance");
  });

  /**
   * Sign out is offered for a session and withheld from a persona, decided by what the server
   * says rather than by how the console was reached.
   *
   * This is the assertion the defect needed and did not have. The shell used to take the answer
   * from a prop the landing page passed, which meant it was absent on every deep link — nobody
   * to pass it — and hard-coded false on any demo deployment that also offered Google, so a
   * genuinely signed-in user was never offered a sign-out anywhere. `App` is rendered here with
   * no props at all, which is exactly the deep-link case.
   */
  it("offers sign-out for both a real session and a demo persona", async () => {
    const stub = (authentication: "session" | "demo") =>
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session"))
          return jsonResponse({ ...organizerSession, authentication });
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      });

    vi.stubGlobal("fetch", stub("session"));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    cleanup();
    vi.stubGlobal("fetch", stub("demo"));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    // Switching changes the active demo identity; signing out clears the demo cookie and returns
    // to the landing page. They are separate, deliberate exits and both must stay reachable.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Signed-in role" })).toBeInTheDocument();
  });

  /**
   * "Sign out everywhere" is offered under exactly the same condition as sign-out, calls
   * revoke-all, and leaves by a full document load.
   *
   * The document load is the part worth pinning rather than the request. The console is mounted
   * around a session this action has just ended, so a client-side navigation would re-render a
   * shell whose every subsequent fetch is a 401; `/` has to be decided again from the API. That
   * is also why the count the API returns is not rendered — the surface that would show it is
   * the one being torn down.
   */
  it("ends every session from the console, and leaves by reloading", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const calls: string[] = [];
    const stub = (authentication: "session" | "demo") =>
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${new URL(url, "http://localhost").pathname}`);
        if (url.endsWith("/api/auth/sessions/revoke-all")) return jsonResponse({ revoked: 3 });
        if (url.endsWith("/api/session"))
          return jsonResponse({ ...organizerSession, authentication });
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      });

    vi.stubGlobal("fetch", stub("session"));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(calls).toContain("POST /api/auth/sessions/revoke-all");
    // The plain sign-out is a different action and must not also have fired.
    expect(calls).not.toContain("POST /api/auth/signout");

    // A persona holds no session record, the API refuses it, and the control is withheld too —
    // both halves, because either one alone would leave a demo caller pressing a real button.
    cleanup();
    vi.stubGlobal("fetch", stub("demo"));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out everywhere" })).toBeNull();
  });

  it("lands an organizer on the overview with role-aware navigation", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
      const workspace = workspaceBody(url);
      if (workspace) return jsonResponse(workspace);
      return jsonResponse({ events: [event] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Event workspace" })).toHaveValue(eventId);
    expect(screen.getByRole("link", { name: /Event settings/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Agenda/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Signed-in role" })).toHaveValue("organizer");
    expect(screen.getByText("Local instance")).toBeInTheDocument();
    // The console remains the product, not a walkthrough of seeded identities. Only the
    // environment marker names a deployment as a demo (issue #146 supersedes issue #35 here).
    expect((document.body.textContent ?? "").toLowerCase()).not.toContain("demo");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "/api/session",
        "/api/events/assigned",
        `/api/events/${eventId}/overview`,
      ]),
    );
  });

  it("does not mount communications for a selected event where the actor is not organizer", async () => {
    const mixedRoleSession = {
      ...organizerSession,
      eventAccess: [{ eventId, role: "reviewer", capabilities: ["events:read"] }],
      capabilities: ["events:read", "communications:manage"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session")) return jsonResponse(mixedRoleSession);
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      }),
    );
    render(<App />);

    // A reviewer-only actor never sees the organizer's communications entry point.
    await screen.findByRole("link", { name: /Review assignments/ });
    expect(screen.queryByRole("link", { name: /Communications/ })).not.toBeInTheDocument();
  });

  it("shows a safe unauthenticated state with correlation reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith("/api/auth/config")
          ? jsonResponse({ demoMode: true, google: false })
          : jsonResponse(
              {
                error: {
                  code: "UNAUTHORIZED",
                  message: "Sign in to continue.",
                  correlationId: "trace-123",
                },
              },
              401,
            ),
      ),
    );
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Reference: trace-123");
    expect(
      screen.getByRole("heading", { name: "Demo mode: choose a workspace role" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue as organizer" })).toBeEnabled();
  });

  it("lets an expired production challenge return to code issuance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/config"))
          return jsonResponse({ demoMode: false, google: false });
        if (url.endsWith("/api/auth/code"))
          return jsonResponse({ challenge: "signed-challenge" }, 202);
        return jsonResponse(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Sign in to continue.",
              correlationId: "trace-production",
            },
          },
          401,
        );
      }),
    );
    render(<App />);

    const email = await screen.findByLabelText("Email address");
    fireEvent.change(email, { target: { value: "organizer@greenroom.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByLabelText("Six-digit code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    expect(await screen.findByLabelText("Email address")).toHaveValue("organizer@greenroom.test");
  });

  it("switches identities and renders role-limited navigation", async () => {
    const reviewerSession = {
      actor: { id: "seed-reviewer", name: "Ravi Reviewer", persona: "reviewer" },
      organizations: [],
      eventAccess: [{ eventId, role: "reviewer", capabilities: ["events:read"] }],
      capabilities: ["events:read"],
    };
    let signedIn = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/config"))
          return jsonResponse({ demoMode: true, google: false });
        if (url.endsWith("/api/demo-session")) {
          signedIn = true;
          return jsonResponse({ persona: "reviewer" });
        }
        if (!signedIn)
          return jsonResponse(
            {
              error: {
                code: "UNAUTHORIZED",
                message: "Sign in to continue.",
                correlationId: "initial-trace",
              },
            },
            401,
          );
        if (url.endsWith("/api/session")) return jsonResponse(reviewerSession);
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      }),
    );
    render(<App />);

    await screen.findByText("Reference: initial-trace", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "Continue as reviewer" }));

    await screen.findByRole("link", { name: /Review assignments/ });
    // Role-limited means the organizer surfaces are absent, not merely disabled.
    expect(screen.queryByRole("link", { name: /Event settings/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Speaker CRM/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create event" })).toBeNull();
  });

  it("keeps the public identity out of private event APIs", async () => {
    const publicSession = {
      actor: { id: "seed-public", name: "Pat Attendee", persona: "public" },
      organizations: [],
      eventAccess: [{ eventId, role: "public", capabilities: [] }],
      capabilities: [],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      jsonResponse(String(input).endsWith("/api/session") ? publicSession : { events: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("combobox", { name: "Signed-in role" });
    expect(fetchMock).toHaveBeenCalledWith("/api/events/assigned");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/events");
  });

  it("creates an event inside the organizer organization", async () => {
    const created = { ...event, id: "223e4567-e89b-42d3-a456-426614174000", name: "New Summit" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
      if (url.endsWith("/api/events") && init?.method === "POST")
        return jsonResponse({ event: created }, 201);
      const workspace = workspaceBody(url);
      if (workspace) return jsonResponse(workspace);
      return jsonResponse({
        events: fetchMock.mock.calls.some(([, options]) => options?.method === "POST")
          ? [event, created]
          : [event],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    // Event creation lives on its own route now, so navigate the way a user would.
    fireEvent.click(await screen.findByRole("link", { name: /Event settings/ }));
    fireEvent.change(await screen.findByLabelText("Event name"), {
      target: { value: "New Summit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Event workspace" })).toHaveValue(created.id),
    );
    const createCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      organizationId,
      name: "New Summit",
    });
  });

  it("renames the selected event and changes its timezone", async () => {
    const updated = { ...event, name: "Renamed Summit", timezone: "America/New_York" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
      if (url.endsWith(`/api/events/${eventId}`) && init?.method === "PATCH")
        return jsonResponse({ event: updated });
      const workspace = workspaceBody(url);
      if (workspace) return jsonResponse(workspace);
      return jsonResponse({ events: [event] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: /Event settings/ }));
    fireEvent.change(await screen.findByLabelText("Current event name"), {
      target: { value: updated.name },
    });
    fireEvent.change(screen.getByLabelText("Event timezone"), {
      target: { value: updated.timezone },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save event settings" }));

    await waitFor(() =>
      expect(screen.getByText(`${updated.name} · ${updated.timezone}`)).toBeVisible(),
    );
    const patchCall = fetchMock.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      name: updated.name,
      timezone: updated.timezone,
    });
  });

  it("points the address bar at the event it just created", async () => {
    // The shell reads the selected event from the URL on the next load, so a URL still
    // carrying the previous event silently undoes the switch on reload or when the link
    // is shared. Creating an event is a selection like any other and must move it.
    const created = { ...event, id: "223e4567-e89b-42d3-a456-426614174000", name: "New Summit" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
      if (url.endsWith("/api/events") && init?.method === "POST")
        return jsonResponse({ event: created }, 201);
      const workspace = workspaceBody(url);
      if (workspace) return jsonResponse(workspace);
      return jsonResponse({
        events: fetchMock.mock.calls.some(([, options]) => options?.method === "POST")
          ? [event, created]
          : [event],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: /Event settings/ }));
    await waitFor(() => expect(window.location.search).toBe(`?event=${eventId}`));
    fireEvent.change(await screen.findByLabelText("Event name"), {
      target: { value: "New Summit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(window.location.search).toBe(`?event=${created.id}`));
    // …on the route the organizer was already on, not back at the shell root.
    expect(window.location.pathname).toBe("/settings");
  });
});
