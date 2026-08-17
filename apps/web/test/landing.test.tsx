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

/** A deployment whose only door is an emailed code, with both steps of it answering. */
function stubEmailDeployment() {
  let issued = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/auth/config")) return jsonResponse({ demoMode: false, google: false });
    if (url.endsWith("/api/auth/code")) {
      issued += 1;
      return jsonResponse({ challenge: `challenge-${issued}` });
    }
    if (url.endsWith("/api/auth/verify")) return jsonResponse({ authenticated: true });
    return jsonResponse(unauthorized, 401);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the landing surfaces", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it("states what Greenroom is and leads with the capability ledger", async () => {
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
        name: "Run the whole conference without losing the thread.",
      }),
    ).toBeInTheDocument();
    // The hero primary opens the demo rather than linking to a page that shows a strict subset
    // of what is already on screen — and it does not answer to the persona buttons' name.
    expect(screen.getAllByRole("button", { name: "Open the demo as an organizer" })).toHaveLength(
      2,
    );
    expect(screen.getByRole("link", { name: "Choose another role" })).toHaveAttribute(
      "href",
      "#signin-panel",
    );
    // The honest count is the section heading, not a sentence inside a collapsed disclosure.
    expect(
      screen.getByRole("heading", { name: "9 capabilities. 7 proven end to end, 2 not." }),
    ).toBeInTheDocument();
    // …and the ledger is on the page rather than behind a triangle: both unproven rows are
    // readable without opening anything.
    expect(screen.getAllByText("Built, not yet proven end to end")).toHaveLength(2);
    expect(screen.queryByRole("group")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Four principles, not a pile of features" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Six steps. One continuous record." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View source" })).toHaveAttribute(
      "href",
      "https://github.com/adityak6798/ManageMyConference",
    );
    // The repository is reachable from the footer too. It used to be reachable only from one
    // link in the middle of the page.
    expect(screen.getByRole("link", { name: "Source on GitHub" })).toBeInTheDocument();
  });

  /**
   * The hero primary, which used to be a link to a page showing fewer doors than the one it
   * was on.
   */
  it("starts the demo from the hero without borrowing a persona button's name", async () => {
    const fetchMock = stubDeployment({ demoMode: true, google: false });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    const heroDoors = await screen.findAllByRole("button", {
      name: "Open the demo as an organizer",
    });
    fireEvent.click(heroDoors[0] as HTMLElement);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/api/demo-session") && String(init?.body).includes("organizer"),
        ),
      ).toBe(true),
    );
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

  /**
   * The panel on "/" exists so that an evaluator never has to find a second page before they
   * are inside the product. On an emailed-code deployment it used to contain a heading, a
   * sentence and a footnote link: the form was gated on the sign-in *page*, so the deployment
   * with only one door was the one whose landing page had none.
   */
  it("puts a working door on the landing panel of a deployment that only emails codes", async () => {
    stubEmailDeployment();
    render(<LandingRoot bootstrap={probeIdentity()} />);

    await screen.findByRole("heading", {
      level: 1,
      name: "Run the whole conference without losing the thread.",
    });
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeInTheDocument();
  });

  /**
   * The second step of the emailed-code flow, which used to rewrite the first field in place.
   *
   * Mutating `type` and `autocomplete` on a live input is how a password manager that has
   * already filled an address ends up saving it as a one-time code; nothing announced the
   * change; the caret stayed on a field that was now for something else; and "Request a new
   * code" threw the address away and asked for it again rather than issuing a second code.
   */
  it("moves to a fresh code field, says where the code went, and re-issues for that address", async () => {
    const fetchMock = stubEmailDeployment();
    render(<LandingRoot bootstrap={probeIdentity()} />);

    const address = await screen.findByLabelText("Email address");
    fireEvent.change(address, { target: { value: "chair@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));

    const codeField = await screen.findByLabelText("Six-digit code");
    expect(codeField).not.toBe(address);
    // Waited for, because the caret is moved by an effect and the field is committed before it.
    // `setChallenge` lands from an awaited fetch, so React flushes the commit and the passive
    // effect that calls `codeRef.current.focus()` in separate tasks — the query below resolves on
    // the DOM mutation, one task early. Sampling there is what produced the bare
    // "Expected element with focus / Received element with focus" under `--sequence.shuffle`.
    await waitFor(() => expect(codeField).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(
      "We sent a six-digit code to chair@example.test",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "A new code is on its way to chair@example.test",
      ),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith("/api/auth/code") &&
          String(init?.body).includes("chair@example.test"),
      ),
    ).toHaveLength(2);
    // Still on the code step. The reader is not sent back to type an address they already gave.
    expect(screen.getByLabelText("Six-digit code")).toBeInTheDocument();
  });

  /**
   * The invitation link, which is the third signed-out surface rather than a stray URL.
   *
   * An invitee arriving signed out used to get the marketing hero and the token was dropped on
   * the floor — the exact failure `AcceptInvitationPage`'s header comment says that surface
   * exists to prevent.
   */
  it("names the invitation and keeps its token while the invitee signs in", async () => {
    window.history.replaceState(null, "", "/invitations/accept?token=inv-token-1");
    stubDeployment({ demoMode: false, google: true });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Accept your invitation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
    // Held rather than carried in the URL: the Google flow leaves this document, and its
    // callback lands on a path the *server* chooses — that route refuses to take a destination
    // from the request, which is the open redirect it would otherwise be.
    expect(window.sessionStorage.getItem("greenroom.invitation-token")).toBe("inv-token-1");
  });

  it("hands a signed-in invitee back to the invitation when the callback lands on /", async () => {
    window.sessionStorage.setItem("greenroom.invitation-token", "inv-token-2");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith("/api/auth/config")
          ? jsonResponse({ demoMode: false, google: true })
          : jsonResponse({
              actor: { id: "user-1", name: "Ivy Invitee", persona: "speaker" },
              organizations: [],
              eventAccess: [],
              capabilities: [],
            }),
      ),
    );
    render(<LandingRoot bootstrap={probeIdentity()} />);

    // The hand-back waits on two chained reads — the auth config, then the session probe — so on
    // a runner executing several suites at once it can outlast waitFor's 1s default. The address
    // is asserted whole inside the wait rather than sampled after it, because a pathname that has
    // arrived does not mean the query has.
    await waitFor(
      () => {
        expect(window.location.pathname).toBe("/invitations/accept");
        expect(window.location.search).toBe("?token=inv-token-2");
      },
      { timeout: 5000 },
    );
    // Spent by the navigation it caused: a second sign-in in this tab is not a second
    // invitation.
    expect(window.sessionStorage.getItem("greenroom.invitation-token")).toBeNull();
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

  /**
   * The one outcome the callback does distinguish, because the fault is ours (issue #164).
   *
   * "That sign-in did not complete" sends somebody to check an account that is fine when what
   * actually happened is D1 being down or provisioning failing part-way. It still names no
   * check, so it hands a forged callback nothing: an outage is not the answer to any of them.
   */
  it("says the deployment broke rather than blaming a sign-in that was fine", async () => {
    window.history.replaceState(null, "", "/signin?auth=unavailable");
    stubDeployment({ demoMode: false, google: true });
    render(<LandingRoot bootstrap={probeIdentity()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("our side rather than yours");
    expect(alert).not.toHaveTextContent("That sign-in did not complete");
    for (const leak of ["state", "expired", "signature", "verified", "attempt"])
      expect(alert.textContent?.toLowerCase()).not.toContain(leak);
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeInTheDocument();
  });

  /**
   * The version-skew case, which is the one a `status === 404` guard alone misses.
   *
   * A frontend and its API do not roll atomically — `VITE_API_BASE_URL` allows them to be hosted
   * separately — so this bundle can meet the API immediately before this change, which answered
   * `200 {"demoMode": true}` with no `google` at all. A strict parse throws there, `doors` is
   * null, and the surface renders *no* doors: the failure mode the fallback exists to prevent,
   * arrived at through the fallback. Both older shapes have to keep the demo door open.
   */
  it("keeps its doors when the API is a version behind, in both shapes", async () => {
    for (const older of [
      { status: 200, body: { demoMode: true } },
      { status: 404, body: { error: { code: "NOT_FOUND", message: "no", correlationId: "c" } } },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) =>
          String(input).endsWith("/api/auth/config")
            ? jsonResponse(older.body, older.status)
            : jsonResponse(unauthorized, 401),
        ),
      );
      render(<LandingRoot bootstrap={probeIdentity()} />);

      expect(
        await screen.findByRole("button", { name: "Continue as organizer" }),
      ).toBeInTheDocument();
      // The door that API cannot serve is not offered, rather than offered and answering 404.
      expect(screen.queryByRole("link", { name: "Continue with Google" })).toBeNull();
      cleanup();
      vi.unstubAllGlobals();
    }
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
    //
    // Both halves of the handover are waited for together, and for longer than the 1s default,
    // because that import is the whole console module graph: when no earlier file in the run has
    // already pulled `../App` through vite-node, this test pays the transform itself and it
    // routinely takes over a second. Running this file alone failed here on 7 of 11 shuffled
    // seeds; the same gap is what makes it an occasional casualty of the full suite. The URL and
    // the loading state settle in one commit — `navigate` runs just before `setWorkspace` — so
    // asserting the second after waiting only on the first sampled a value that had no reason to
    // have arrived yet.
    await waitFor(
      () => {
        expect(screen.queryByText("Loading Greenroom…")).toBeNull();
        expect(window.location.pathname).toBe("/");
      },
      { timeout: 5000 },
    );
    // The marketing surface is gone rather than layered underneath.
    expect(
      screen.queryByRole("heading", {
        level: 1,
        name: "Run the whole conference without losing the thread.",
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
            occurrences: { sessions: {}, slots: {} },
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
