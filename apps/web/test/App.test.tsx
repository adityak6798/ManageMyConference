// @acceptance ACC-IDENTITY-EVENTS
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

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

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the role-aware shell and persisted events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).endsWith("/api/session") ? organizerSession : { events: [event] },
            ),
            { status: 200 },
          ),
        ),
      ),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Greenroom Summit" });
    expect(screen.getByText("Olivia Organizer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Event settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create event" })).toBeEnabled();
  });

  it("shows a safe unauthenticated state with correlation reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "UNAUTHORIZED",
                message: "Sign in to continue.",
                correlationId: "trace-123",
              },
            }),
            { status: 401 },
          ),
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
          return Promise.resolve(
            new Response(JSON.stringify({ persona: "reviewer" }), { status: 200 }),
          );
        }
        if (!signedIn)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "UNAUTHORIZED",
                  message: "Sign in to continue.",
                  correlationId: "initial-trace",
                },
              }),
              { status: 401 },
            ),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify(url.endsWith("/api/session") ? reviewerSession : { events: [event] }),
            { status: 200 },
          ),
        );
      }),
    );
    render(<App />);
    await screen.findByText("Reference: initial-trace", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "Continue as reviewer" }));
    await screen.findByRole("link", { name: "Review assignments" });
    expect(screen.queryByRole("button", { name: "Create event" })).toBeNull();
    expect(screen.getByText("Role-limited access")).toBeInTheDocument();
  });

  it("keeps the public identity out of private event APIs", async () => {
    const publicSession = {
      actor: { id: "seed-public", name: "Pat Attendee", persona: "public" },
      organizations: [],
      eventAccess: [{ eventId, role: "public", capabilities: [] }],
      capabilities: [],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(String(input).endsWith("/api/session") ? publicSession : { events: [] }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByText("Pat Attendee");
    expect(screen.getByRole("link", { name: "Published event" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates an event inside the organizer organization", async () => {
    const created = { ...event, id: "223e4567-e89b-42d3-a456-426614174000", name: "New Summit" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session"))
        return Promise.resolve(new Response(JSON.stringify(organizerSession), { status: 200 }));
      if (url.endsWith("/api/events") && init?.method === "POST")
        return Promise.resolve(new Response(JSON.stringify({ event: created }), { status: 201 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            events: fetchMock.mock.calls.some(([, options]) => options?.method === "POST")
              ? [event, created]
              : [event],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("heading", { name: "Greenroom Summit" });
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "New Summit" } });
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
