// @acceptance ACC-IDENTITY-EVENTS
/*
 * The signed-out surfaces, which are the only ones an evaluator is guaranteed to see.
 *
 * These assert what the surface *offers*, because every one of those offers is a claim about
 * the deployment behind it: a Google button on a deployment with no Google configuration is a
 * 404 with a friendly label, and a missing demo button is thirteen browser specs that cannot
 * sign in. The browser suite owns the rest — landmarks, focus order, contrast — because none of
 * that is decidable in jsdom.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeIdentity } from "../src/api/identity";
import { clearOrganizerOverviewCache } from "../src/api/overview";
import { LandingRoot } from "../src/landing/LandingPage";
import { OverviewPage } from "../src/OverviewPage";

const unauthorized = {
  error: { code: "UNAUTHORIZED", message: "Sign in to continue.", correlationId: "trace-landing" },
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

/** A signed-out deployment that offers exactly the doors named. */
function stubDeployment(doors: { demoMode: boolean; google: boolean }) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).endsWith("/api/auth/config")
      ? jsonResponse(doors)
      : jsonResponse(unauthorized, 401),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the landing surfaces", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("states what Greenroom is and offers both doors", async () => {
    stubDeployment({ demoMode: true, google: false });
    // Under StrictMode, as `main.tsx` mounts it: development mounts twice, and a root that
    // treats the simulated unmount as the real one drops the probe's answer and never leaves
    // its loading state — in the dev server, which is where the demo is driven from.
    render(
      <StrictMode>
        <LandingRoot bootstrap={probeIdentity()} />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "One workspace from the first proposal to the closing keynote.",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Get started" })[0]).toHaveAttribute(
      "href",
      "/signin",
    );
    expect(screen.getAllByRole("link", { name: "Explore the demo" })[0]).toHaveAttribute(
      "href",
      "#signin-panel",
    );
    // The page describes the two capabilities that are built but unproven as exactly that,
    // rather than counting them among the seven that ship.
    expect(screen.getAllByText("Built, not yet proven end to end")).toHaveLength(2);
  });

  it("offers the demo personas at the root of a seeded deployment", async () => {
    stubDeployment({ demoMode: true, google: false });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    // The exact accessible names the browser suite signs in with. Renaming any of them breaks
    // every spec that bootstraps from "/".
    for (const persona of ["organizer", "reviewer", "speaker", "public"])
      expect(await screen.findByRole("button", { name: `Continue as ${persona}` })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
  });

  it("starts the demo session the visitor picked", async () => {
    const fetchMock = stubDeployment({ demoMode: true, google: false });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue as organizer" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/demo-session") && String(init?.body).includes("organizer"),
        ),
      ).toBe(true),
    );
  });

  it("offers the Google door only where the deployment is configured for it", async () => {
    stubDeployment({ demoMode: false, google: true });
    const { unmount } = render(<LandingRoot bootstrap={probeIdentity()} />);

    // A plain link, not a fetch: the route answers with a redirect to Google's consent screen.
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toHaveAttribute(
      "href",
      "/api/auth/google/start",
    );
    expect(screen.queryByRole("button", { name: "Continue as organizer" })).toBeNull();
    unmount();
    cleanup();
    vi.unstubAllGlobals();

    stubDeployment({ demoMode: false, google: false });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
  });

  it("renders the emailed-code form and the Google door on the sign-in page", async () => {
    window.history.replaceState(null, "", "/signin");
    stubDeployment({ demoMode: false, google: true });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeInTheDocument();
  });

  it("reports a refused callback without naming the check that refused it", async () => {
    window.history.replaceState(null, "", "/signin?auth=failed");
    stubDeployment({ demoMode: false, google: true });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That sign-in did not complete. Please try again.");
    // Naming the failed check — unknown attempt, stale state, unverified address — would hand
    // an attacker the oracle the callback deliberately refuses them.
    for (const leak of ["state", "expired", "signature", "verified", "attempt"])
      expect(alert.textContent?.toLowerCase()).not.toContain(leak);
    // The doors are still there underneath it: a refusal is a retry, not a dead end.
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
  });

  it("says so when the deployment does not answer, instead of guessing at its doors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    render(<LandingRoot bootstrap={probeIdentity()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(screen.queryByRole("button", { name: "Continue as organizer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  /*
   * The handover, which is the path every signed-in organizer takes on "/" and every browser
   * spec takes on `page.reload()`.
   *
   * It had no coverage at all, and it is exactly where the one defect found by hand in this
   * surface lived — a `mounted` ref that was never re-armed, which left "/" on "Loading
   * Greenroom…" forever. A regression here leaves the console home permanently blank, so it is
   * worth the stub.
   */
  it("hands a signed-in visitor to the console, and leaves /signin behind when it does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith("/api/auth/config")
          ? jsonResponse({ demoMode: false, google: true })
          : jsonResponse({
              actor: { id: "user-1", name: "Olivia Organizer", persona: "organizer" },
              organizations: [{ id: "00000000-0000-4000-8000-000000000010" }],
              eventAccess: [],
              capabilities: [],
            }),
      ),
    );
    window.history.replaceState(null, "", "/signin");
    render(<LandingRoot bootstrap={probeIdentity()} />);

    // The console is a real dynamic import of ../App, not a double: what is being proven is
    // that the handover completes, and a stubbed module would prove only that this test can
    // call setState.
    await waitFor(() => expect(screen.queryByText("Loading Greenroom…")).toBeNull());
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    // The marketing surface is gone rather than layered underneath.
    expect(
      screen.queryByRole("heading", {
        level: 1,
        name: "One workspace from the first proposal to the closing keynote.",
      }),
    ).toBeNull();
  });
});

/*
 * What the door opens onto.
 *
 * A workspace provisioned by signing in has one event in it and nothing else, and every panel
 * on the overview was written for an event mid-flight. Left alone it greets a first-time
 * organizer with "Every proposal has a decision" and "No open onboarding tasks" — a finished
 * conference — which reads as a product that has lost their data rather than one they have not
 * used yet.
 */
describe("the first thing a provisioned workspace says", () => {
  const eventId = "00000000-0000-4000-8000-000000000002";
  const firstEvent = {
    id: eventId,
    organizationId: "00000000-0000-4000-8000-000000000010",
    name: "Your first event",
    timezone: "UTC",
    createdAt: "2026-08-12T12:00:00.000Z",
  };

  /** Every source answering, with nothing in it: the shape a new organization actually has. */
  function stubEmptyWorkspace() {
    const ok = (data: unknown) => ({ ok: true, data });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          content: ok({ sessions: [], speakers: [], tasks: [], assets: [], messages: [] }),
          review: ok({
            proposals: [],
            plan: null,
            assignments: [],
            outcomes: [],
            audit: [],
            statuses: [],
            reviewers: [],
          }),
          agenda: ok({
            eventId,
            rooms: [],
            tracks: [],
            slots: [],
            sessions: [],
            placements: [],
            conflicts: [],
          }),
          publication: {
            ok: false,
            error: { code: "NOT_FOUND", message: "None", correlationId: "t" },
          },
        }),
      ),
    );
  }

  beforeEach(() => clearOrganizerOverviewCache());
  afterEach(() => {
    clearOrganizerOverviewCache();
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says what to do next, naming the event and the two surfaces that start the work", async () => {
    stubEmptyWorkspace();
    render(<OverviewPage event={firstEvent} query={`?event=${eventId}`} welcome />);

    expect(await screen.findByText("Your workspace is ready")).toBeInTheDocument();
    expect(screen.getByText(/Name the event and set its timezone/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Event settings" })).toHaveAttribute(
      "href",
      `/settings?event=${eventId}`,
    );
    expect(screen.getByRole("link", { name: "Open the call for proposals" })).toHaveAttribute(
      "href",
      `/cfp?event=${eventId}`,
    );
  });

  /**
   * The half of the welcome condition the flag alone cannot express.
   *
   * `?welcome=1` is a URL, so it survives a bookmark and a shared link. Greeting a conference
   * mid-flight with "Your workspace is ready" would read as the product having lost its data,
   * which is the opposite of what the card is for — so the card is gated on the workspace still
   * being untouched as well as on the flag. Without a populated workspace here, deleting
   * `&& unstarted` from the condition leaves the whole suite green.
   */
  it("does not greet a workspace that is already in use, however the flag arrived", async () => {
    const ok = (data: unknown) => ({ ok: true, data });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          content: ok({
            sessions: [{ id: "s1", title: "Opening keynote", speakerIds: [], state: "scheduled" }],
            speakers: [{ id: "p1", name: "Sam Speaker" }],
            tasks: [],
            assets: [],
            messages: [],
          }),
          review: ok({
            proposals: [{ id: "r1", title: "A talk", status: "submitted" }],
            plan: null,
            assignments: [],
            outcomes: [],
            audit: [],
            statuses: [],
            reviewers: [],
          }),
          agenda: ok({ eventId, rooms: [], tracks: [], slots: [], placements: [], version: 1 }),
        }),
      ),
    );
    render(<OverviewPage event={firstEvent} query={`?event=${eventId}`} welcome />);

    await waitFor(() => expect(screen.queryByText("Your workspace is ready")).toBeNull());
  });

  it("reads its empty panels as a beginning rather than as finished work", async () => {
    stubEmptyWorkspace();
    render(<OverviewPage event={firstEvent} query={`?event=${eventId}`} />);

    expect(await screen.findByRole("heading", { name: "No proposals yet" })).toBeInTheDocument();
    // Also the hint under the speaker stat, which is why this asks for the panel's heading.
    expect(screen.getByRole("heading", { name: "No speakers yet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nothing to schedule yet" })).toBeInTheDocument();
    // The sentences that would be true of a conference that has already happened.
    expect(screen.queryByText("Every proposal has a decision")).toBeNull();
    expect(screen.queryByText("No open onboarding tasks")).toBeNull();
    expect(screen.queryByText("Every accepted session is on the board")).toBeNull();
    // …and no welcome, because nothing said this workspace was just provisioned.
    expect(screen.queryByText("Your workspace is ready")).toBeNull();
  });
});
