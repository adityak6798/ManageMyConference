// @acceptance ACC-IDENTITY-EVENTS
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { bytesToBase64 } from "../src/ContentWorkspace";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "123e4567-e89b-12d3-a456-426614174000";
const organizerSession = {
  actor: { id: "seed-organizer", name: "Olivia Organizer", persona: "organizer" },
  organizations: [{ id: organizationId, name: "Greenroom Labs" }],
  eventAccess: [
    { eventId, role: "organizer", capabilities: ["events:read", "events:settings:read"] },
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
  });

  it("encodes files larger than the JavaScript argument limit", () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("lands an organizer on the overview with role-aware navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      }),
    );
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Event workspace" })).toHaveValue(eventId);
    expect(screen.getByRole("link", { name: /Event settings/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Agenda/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Demo identity" })).toHaveValue("organizer");
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
      vi.fn(() =>
        jsonResponse(
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
    expect(screen.getByRole("button", { name: "Continue as organizer" })).toBeEnabled();
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

    await screen.findByRole("combobox", { name: "Demo identity" });
    expect(fetchMock).toHaveBeenCalledWith("/api/public/events");
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
});
