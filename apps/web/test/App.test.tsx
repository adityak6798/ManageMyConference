// @acceptance ACC-IDENTITY-EVENTS
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { clearOrganizerOverviewCache } from "../src/api/overview";
import { bytesToBase64 } from "../src/ContentWorkspace";
import { instanceLabel } from "../src/InstanceMarker";

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
    occurrences: { sessions: {}, slots: {} },
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

function publicationSettingsResponse() {
  const overview = workspaceBody("/overview") as {
    publication: { data: unknown };
  };
  return jsonResponse({ publication: overview.publication.data });
}

/**
 * Everything about who is signed in now lives behind one control.
 *
 * Five topbar controls became Search, one contextual action, and this — which is also the only
 * place the deployment badge and, on a demo deployment, the role picker are offered.
 */
function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: /^Account and access/ }));
}

/** The event chip: a select-only combobox whose trigger shows the event it is pointed at. */
const eventChip = () => screen.getByRole("combobox", { name: "Event workspace" });

async function fillNewEvent(name = "New Summit") {
  fireEvent.change(await screen.findByLabelText("Event name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Public address"), {
    target: { value: "new-summit" },
  });
  fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2027-09-10" } });
  fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2027-09-12" } });
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
    openAccountMenu();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // A real session cannot become another persona: the request behind that control answers 404
    // whenever demo mode is off, so the control is not offered rather than offered and refusing.
    expect(screen.queryByRole("combobox", { name: "Demo role" })).toBeNull();

    cleanup();
    vi.stubGlobal("fetch", stub("demo"));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    openAccountMenu();
    // Switching changes the active demo identity; signing out clears the demo cookie and returns
    // to the landing page. They are separate, deliberate exits and both must stay reachable.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Demo role" })).toBeInTheDocument();
  });

  /**
   * "Sign out everywhere" is offered only for a durable session, calls revoke-all, and leaves by
   * a full document load. Demo personas retain ordinary sign-out but have no rows to revoke.
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
    openAccountMenu();
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
    openAccountMenu();
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
    // The chip names the event at every width, which is the whole reason it left the sidebar.
    expect(eventChip()).toHaveTextContent(event.name);
    expect(screen.getByText(event.timezone)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Schedule" })).toBeInTheDocument();
    openAccountMenu();
    expect(screen.getByText("Local instance")).toBeInTheDocument();
    // The console remains the product, not a walkthrough of seeded identities. Only the
    // environment marker names a deployment as a demo (issue #146 supersedes issue #35 here).
    expect((document.body.textContent ?? "").toLowerCase()).not.toContain("demo");
    // Three reads for the console, and one for what is waiting on the event — the counts the
    // sidebar badges have always been declared for and never been given.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "/api/session",
        "/api/events/assigned",
        `/api/events/${eventId}/overview`,
        `/api/events/${eventId}/inbox`,
      ]),
    );
  });

  /**
   * A legacy path mounts its destination once, not twice.
   *
   * `/cfp` still resolves through `workspaceForPath`, so the console used to mount CfpWorkspace,
   * fire its reads, and only then run the effect that navigates to `/program?tab=forms` — which
   * mounted the whole thing again. One guard covers every caller, the API-minted inbox and
   * search hrefs included, without the API having to change.
   */
  it("does not mount a legacy path's workspace on the way to its hub URL", async () => {
    window.history.replaceState(null, "", "/cfp");
    const cfpReads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/cfp")) cfpReads.push(url);
        if (url.endsWith("/api/session"))
          return jsonResponse({
            ...organizerSession,
            eventAccess: [
              { eventId, role: "organizer", capabilities: ["events:read", "content:manage"] },
            ],
          });
        if (url.endsWith(`/api/events/${eventId}/cfp`))
          return jsonResponse({ cfp: null, routing: [] }, 404);
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      }),
    );
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/program"));
    expect(window.location.search).toContain("tab=forms");
    // Each of the CFP workspace's reads was issued once. Two of anything here is the remount.
    expect(new Set(cfpReads).size).toBe(cfpReads.length);
  });

  /**
   * The badge beside a nav item was declared, rendered and styled, and no caller had ever
   * supplied one — so from anywhere but the Overview nothing told an organizer that proposals
   * were waiting on them.
   */
  it("says what is waiting beside the destination that can act on it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
        if (url.endsWith(`/api/events/${eventId}/inbox`))
          return jsonResponse({
            derivedAt: "2026-08-21T12:00:00.000Z",
            categories: {
              reviews: {
                state: "ok",
                items: [
                  {
                    key: "review:1",
                    category: "reviews",
                    title: "Evaluate a proposal",
                    priority: "normal",
                    status: "open",
                    href: `/abstracts?event=${eventId}`,
                  },
                ],
              },
              speakerWork: { state: "ok", items: [] },
              programme: { state: "ok", items: [] },
              deliveries: { state: "ok", items: [] },
              publication: { state: "ok", items: [] },
              configuration: { state: "ok", items: [] },
            },
          });
        const workspace = workspaceBody(url);
        if (workspace) return jsonResponse(workspace);
        return jsonResponse({ events: [event] });
      }),
    );
    render(<App />);

    const inbox = await screen.findByRole("link", { name: /^Inbox/ });
    await waitFor(() => expect(inbox).toHaveTextContent("1"));
    expect(inbox).toHaveAccessibleName(/1 waiting/);
    // Zero is not a count worth drawing: a nav item permanently reading 0 asks to be ignored.
    expect(screen.getByRole("link", { name: "Schedule" })).toHaveAccessibleName("Schedule");
  });

  /**
   * The first frame is the console, drawn empty — not a chromeless `<main>` holding one
   * sentence, which made the application arrive twice.
   */
  it("paints the real shell on first load, with the wait announced and not drawn", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const { container } = render(<App />);

    expect(container.querySelector(".app")).not.toBeNull();
    expect(container.querySelector(".sidebar .brandmark")).not.toBeNull();
    const announcement = screen.getByRole("status", { name: "" });
    expect(announcement).toHaveTextContent("Loading your workspace");
    expect(announcement).toHaveClass("visually-hidden");
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

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent("Sign in to continue.");
    // The reference is a value the reader can select, not a ULID glued to the end of a sentence.
    expect(within(refusal).getByText("trace-123")).toBeInTheDocument();
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

    expect(within(await screen.findByRole("alert")).getByText("initial-trace")).toBeInTheDocument();
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

    // An attendee identity gets a page, not a console with every block of chrome disabled.
    await screen.findByRole("heading", { name: "This account has no organizer workspace" });
    expect(screen.queryByRole("navigation", { name: "Workspace navigation" })).toBeNull();
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
      if (url.includes("/api/publishing/events/") && url.endsWith("/settings"))
        return publicationSettingsResponse();
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

    // The deliberate action sits beside the event switcher, not hidden below unrelated settings.
    fireEvent.click(await screen.findByRole("link", { name: "Create another event" }));
    // A real destination, not an inert `#create-event` anchor on the settings page.
    await waitFor(() => expect(window.location.pathname).toBe("/events/new"));
    await fillNewEvent();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(eventChip()).toHaveTextContent(created.name));
    const createCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      organizationId,
      name: "New Summit",
    });
    expect(new Headers(createCall?.[1]?.headers).get("Idempotency-Key")).toBeTruthy();
    const settingsCall = fetchMock.mock.calls.find(
      ([input, options]) =>
        String(input).includes(`/api/publishing/events/${created.id}/settings`) &&
        options?.method === "PATCH",
    );
    expect(JSON.parse(String(settingsCall?.[1]?.body))).toEqual({
      slug: "new-summit",
      startsOn: "2027-09-10",
      endsOn: "2027-09-12",
    });
  });

  it("applies only the template the organizer explicitly selected", async () => {
    const created = { ...event, id: "223e4567-e89b-42d3-a456-426614174001", name: "Templated" };
    const template = {
      id: "323e4567-e89b-42d3-a456-426614174000",
      organizationId,
      name: "Conference starter",
      state: "active" as const,
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    };
    const version = {
      id: "423e4567-e89b-42d3-a456-426614174000",
      version: 3,
      sourceEventId: eventId,
      sourceEventName: event.name,
      createdAt: "2026-08-09T12:00:00.000Z",
      createdBy: "seed-organizer",
      createdByName: "Olivia Organizer",
      slices: ["cfp", "agenda"],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
      if (url.endsWith(`/api/organizations/${organizationId}/event-templates`))
        return jsonResponse({ templates: [template] });
      if (url.endsWith(`/api/event-templates/${template.id}`))
        return jsonResponse({ template, versions: [version] });
      if (url.endsWith("/api/events") && init?.method === "POST")
        return jsonResponse({ event: created }, 201);
      if (url.includes("/api/publishing/events/") && url.endsWith("/settings"))
        return publicationSettingsResponse();
      if (url.endsWith(`/api/events/${created.id}/template-applications`))
        return jsonResponse({
          application: {
            templateId: template.id,
            templateName: template.name,
            versionId: version.id,
            version: version.version,
            sourceEventId: eventId,
            sourceEventName: event.name,
            eventId: created.id,
            destination: { startsOn: "2027-09-10", endsOn: "2027-09-12" },
            appliedAt: "2026-08-14T12:00:00.000Z",
            outcome: "applied",
            slices: [],
          },
        });
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

    fireEvent.click(await screen.findByRole("link", { name: "Create another event" }));
    // A real destination, not an inert `#create-event` anchor on the settings page.
    await waitFor(() => expect(window.location.pathname).toBe("/events/new"));
    await fillNewEvent("Templated");
    fireEvent.click(screen.getByLabelText("Apply a selected template"));
    await waitFor(() => expect(screen.getByLabelText("Template")).toHaveValue(template.id));
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, options]) =>
            String(input).endsWith(`/api/events/${created.id}/template-applications`) &&
            options?.method === "POST",
        ),
      ).toBe(true),
    );
    const applyCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith(`/api/events/${created.id}/template-applications`),
    );
    expect(JSON.parse(String(applyCall?.[1]?.body))).toEqual({
      templateId: template.id,
      version: 3,
      destination: { startsOn: "2027-09-10", endsOn: "2027-09-12" },
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

    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    // Settings > Event is the registered hub tab now. The shell used to keep a second copy of
    // this form of its own — without the success announcement, and without telling the rest of
    // the console the name had changed, which is why saving looked like it had done nothing.
    fireEvent.change(await screen.findByLabelText("Event name"), {
      target: { value: updated.name },
    });
    // The timezone field is a filtering combobox rather than a `<select>`: typing narrows the
    // ~400 zones and Enter takes the match, so a value change is two events, not one.
    const timezone = screen.getByLabelText("Event timezone");
    fireEvent.change(timezone, { target: { value: updated.timezone } });
    fireEvent.keyDown(timezone, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save event settings" }));

    expect(await screen.findByText("Event settings saved.")).toBeInTheDocument();
    // The page header, and the chip in the topbar, both read the shell's event list.
    await waitFor(() =>
      expect(screen.getByText(`${updated.name} · ${updated.timezone}`)).toBeVisible(),
    );
    expect(eventChip()).toHaveTextContent(updated.name);
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
      if (url.includes("/api/publishing/events/") && url.endsWith("/settings"))
        return publicationSettingsResponse();
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

    fireEvent.click(await screen.findByRole("link", { name: "Create another event" }));
    await waitFor(() => expect(window.location.search).toBe(`?event=${eventId}`));
    await fillNewEvent();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(window.location.search).toBe(`?event=${created.id}`));
    // …on the route the organizer was already on, not back at the shell root.
    expect(window.location.pathname).toBe("/events/new");
  });
});
