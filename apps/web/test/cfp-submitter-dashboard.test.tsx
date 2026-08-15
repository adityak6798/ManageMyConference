// @acceptance ACC-CFP
/*
 * The applicant's dashboard, and the three writes behind it.
 *
 * These are jsdom tests because each one turns on *what the page sends* and in what order: which
 * revision a save names back, whether a submit of a never-saved proposal creates one first, and
 * whether a refused write leaves the answers on screen. A browser assertion on visible text passes
 * happily while any of those is wrong, and the cost of being wrong is somebody's proposal.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicCfpView } from "../src/public-event/PublicCfpView";

const eventId = "00000000-0000-4000-8000-000000000001";
const LA = "America/Los_Angeles";
const proposalsPath = `/api/events/${eventId}/cfp/proposals`;

const liveCfp = {
  eventId,
  title: "Share what you learned",
  description: "Submit a practical session.",
  fields: [
    {
      id: "title",
      type: "short_text" as const,
      label: "Proposal title",
      guidance: "",
      required: true,
      options: [],
    },
  ],
  routing: [],
  status: "open" as const,
  version: 3,
  publishedAt: "2026-08-01T12:00:00.000Z",
  publishedStatus: "open" as const,
  opensAt: null,
  closesAt: null,
  effectiveStatus: "open" as const,
};

const session = {
  actor: { id: "user-pat", name: "Pat Attendee", persona: "public" },
  organizations: [],
  eventAccess: [],
  capabilities: [],
  authentication: "session",
};

const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: "50000000-0000-4000-8000-000000000001",
  eventId,
  lifecycle: "draft",
  state: "draft",
  title: "Half an idea",
  answers: { title: "Half an idea" },
  revision: 1,
  updatedAt: "2026-08-10T12:00:00.000Z",
  submittedAt: null,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Call = { url: string; method: string; body: Record<string, unknown> };

/**
 * A signed-in applicant, with the dashboard answering `proposals` and every write routed by the
 * caller. Records the writes so a test can assert the request rather than the rendering.
 */
function mount(
  options: {
    proposals?: readonly Record<string, unknown>[];
    status?: "open" | "closed";
    /** Replaces the published form's questions, for the conditional-visibility cases. */
    liveFields?: readonly Record<string, unknown>[];
    write?: (url: string, init: RequestInit) => Promise<Response> | undefined;
  } = {},
) {
  const calls: Call[] = [];
  let listed = options.proposals ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method)
        calls.push({
          url,
          method: init.method,
          body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
      if (url === "/api/session") return jsonResponse(session);
      if (url === "/api/auth/config") return jsonResponse({ demoMode: true, google: false });
      if (init?.method) {
        const answered = options.write?.(url, init);
        if (answered) return answered;
      }
      if (url === proposalsPath) return jsonResponse({ proposals: listed });
      return jsonResponse({ error: {} }, 404);
    }),
  );
  const status = options.status ?? "open";
  const renderView = (fields = options.liveFields) => (
    <PublicCfpView
      eventId={eventId}
      schedule={liveCfp as never}
      liveCfp={
        {
          ...liveCfp,
          ...(fields ? { fields } : {}),
          effectiveStatus: status,
        } as never
      }
      unavailable={null}
      status={status}
      statusLine={status === "open" ? "Open for submissions." : "Submissions closed."}
      title={liveCfp.title}
      description={liveCfp.description}
      timezone={LA}
    />
  );
  const view = render(renderView());
  return {
    calls,
    /** Change what the dashboard answers next, so a write's refresh can be observed. */
    setProposals(next: readonly Record<string, unknown>[]) {
      listed = next;
    },
    /** Deliver a newly published form to the mounted view, as the visibility refresh does. */
    rerenderLiveFields(next: readonly Record<string, unknown>[]) {
      view.rerender(renderView(next));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the signed-in applicant's proposals", () => {
  it("submits even when the list read that follows the draft fails", async () => {
    /*
     * A view must not gate the action.
     *
     * Adopting the created draft before the submit fixed silent data loss, and refreshing the
     * dashboard with it stops the page contradicting itself ("Nothing yet." above a form editing a
     * draft). But awaiting that refresh inside the same guarded action meant a failed *list* read
     * — a decorative request — prevented the submit from being attempted at all, and told the
     * applicant their proposal could not be submitted when nothing had tried to submit it.
     */
    let listReads = 0;
    const test = mount({
      write: (url, init) => {
        if (url.endsWith("/submit"))
          return jsonResponse({
            proposal: proposal({ lifecycle: "submitted", state: "under_consideration" }),
          });
        if (url === proposalsPath && init.method === "POST")
          return jsonResponse({ proposal: proposal() }, 201);
        return undefined;
      },
    });
    // The dashboard read fails from here on; the writes still answer.
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === proposalsPath && !init?.method) {
        listReads += 1;
        if (listReads > 1)
          return jsonResponse(
            { error: { code: "INTERNAL_ERROR", message: "no", correlationId: "x" } },
            500,
          );
      }
      return original(input, init);
    });

    fireEvent.change(await screen.findByLabelText(/Proposal title/), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));

    await waitFor(() => expect(test.calls.some(({ url }) => url.endsWith("/submit"))).toBe(true));
    /*
     * And it is *reported* as submitted, which is the assertion that matters most.
     *
     * A first version of this stopped at the line above. That passes while the refresh still
     * sits after the submit, where a failed list read reports "The proposal could not be
     * submitted." over a proposal that was — with the form already cleared and the idempotency
     * key already rotated, so the applicant retypes, presses Submit, and creates a second one.
     * On a one-way action, that is the worst outcome this surface can produce.
     */
    // `queryByRole` rather than a rejected `findByRole`: the notice element is always mounted and
    // only its role changes, so an error notice would be findable immediately if there were one.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent("Proposal submitted.");
  });

  it("cannot be rebound to another proposal while a write is in flight", async () => {
    /*
     * The list's buttons are writes-in-waiting, and they were the only live controls on the page
     * during a save.
     *
     * `Continue …` sets `answers` immediately; the save that is still in flight sets `editing`
     * when it resolves. Press one during the other and the form is bound to proposal A while
     * holding proposal B's answers — and the next save sends B's content under A's id, at a
     * current revision, so nothing refuses it. The page says "Saved." and A is gone.
     * `Start another proposal` is worse: it clears the form, so a whole new proposal is typed and
     * then written over the previous one as a PUT, with no create issued at all.
     */
    let releaseSave: (() => void) | undefined;
    const test = mount({
      proposals: [
        proposal({ id: "50000000-0000-4000-8000-00000000000a", title: "Alpha" }),
        proposal({ id: "50000000-0000-4000-8000-00000000000b", title: "Beta" }),
      ],
      write: (url, init) =>
        init.method === "PUT"
          ? new Promise((resolve) => {
              releaseSave = () => resolve(new Response(JSON.stringify({ proposal: proposal() })));
            })
          : undefined,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    // Every control that could rebind the form is out of reach until the write settles.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Continue Beta/ })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /Continue Alpha/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start another proposal" })).toBeDisabled();

    releaseSave?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Continue Beta/ })).not.toBeDisabled(),
    );
    expect(test.calls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });

  it("drops answers the republished form would refuse, rather than stranding the draft", async () => {
    /*
     * A stored proposal is a snapshot of the form it was written against; the server validates a
     * revision against the form as published **now**.
     *
     * So a draft holding an answer to a question the organizer has since removed — or since
     * hidden behind a condition — failed every save and every submit. And the error could not be
     * shown: `fieldErrors` renders inside the loop over *visible* fields, so one keyed to a
     * removed field has nowhere to go. The applicant saw "Review the highlighted proposal fields"
     * with nothing highlighted, and there is no delete, so the row was stranded for good.
     */
    const test = mount({
      proposals: [
        proposal({
          answers: { title: "Kept", retired: "Answer to a question that no longer exists" },
        }),
      ],
      write: (url, init) =>
        init.method === "PUT"
          ? jsonResponse({ proposal: proposal({ answers: { title: "Kept" }, revision: 2 }) })
          : undefined,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(test.calls.some(({ method }) => method === "PUT")).toBe(true));
    // The retired answer is not sent, so the write the server would have refused is never made.
    expect(test.calls.find(({ method }) => method === "PUT")?.body).toEqual({
      answers: { title: "Kept" },
      expectedRevision: 1,
    });
  });

  it("reloads the dashboard after an action, and lets the newest answer win", async () => {
    /*
     * The refresh line, and the generation counter that guards it.
     *
     * Both shipped uncovered — deleting either left the whole web suite green, which is how this
     * one line came to be wrong in four consecutive rounds. Only the browser gate noticed, and
     * that is the slowest signal there is.
     *
     * The interleave is the one the counter exists for: a save's list read is held open, a submit
     * completes and its list lands first, and only then does the save's older list arrive. Without
     * the counter that older answer wins and repaints a submitted proposal as a draft — beside a
     * notice saying it was submitted, offering a Continue whose Submit can only 409.
     */
    let releaseFirstList: (() => void) | undefined;
    let lists = 0;
    const submitted = proposal({ lifecycle: "submitted", state: "under_consideration" });
    const test = mount({
      proposals: [proposal()],
      write: (url, init) => {
        if (url.endsWith("/submit")) return jsonResponse({ proposal: submitted });
        if (init.method === "PUT") return jsonResponse({ proposal: proposal({ revision: 2 }) });
        return undefined;
      },
    });
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === proposalsPath && !init?.method) {
        lists += 1;
        // 1 is the mount read. 2 is the save's — held open until the submit's has landed, and it
        // answers with the *draft*, which is what it would genuinely have seen.
        if (lists === 1)
          return Promise.resolve(new Response(JSON.stringify({ proposals: [proposal()] })));
        if (lists === 2)
          return new Promise((resolve) => {
            releaseFirstList = () =>
              resolve(new Response(JSON.stringify({ proposals: [proposal()] })));
          });
        return Promise.resolve(new Response(JSON.stringify({ proposals: [submitted] })));
      }
      return original(input, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(test.calls.some(({ method }) => method === "PUT")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));

    // The submit's list lands and the row reads as submitted…
    expect(await screen.findByText("Under consideration")).toBeVisible();
    // …and the save's older list, arriving afterwards, does not put it back.
    releaseFirstList?.();
    await waitFor(() => expect(lists).toBeGreaterThanOrEqual(3));
    expect(screen.getByText("Under consideration")).toBeVisible();
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it("does not read the proposals list on the two actions that end the session", async () => {
    /*
     * `refreshes: false`, which also shipped uncovered.
     *
     * Signing out destroys the cookie and reloads the page; the read that followed could only
     * answer 401 and be thrown away. It existed because the guard asked "is somebody signed in"
     * rather than "does this action leave a list worth reading".
     */
    const test = mount({
      proposals: [proposal()],
      write: (url) => (url === "/api/auth/signout" ? jsonResponse({ ok: true }) : undefined),
    });
    await screen.findByRole("heading", { name: /Your proposals/ });

    // Counted directly rather than through `calls`, which records only requests carrying a
    // method — a list read is a GET, so the very request under test would not have appeared.
    let listsAfterSignOut = 0;
    let signedOut = false;
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/auth/signout") signedOut = true;
      // `!init?.method` *or* an explicit GET: `loadMyProposals` passes no init today, and a test
      // that silently stops counting if it ever does is a test that passes for the wrong reason.
      const reading = !init?.method || init.method === "GET";
      if (signedOut && String(input) === proposalsPath && reading) listsAfterSignOut += 1;
      return original(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));

    await waitFor(() =>
      expect(test.calls.some(({ url }) => url === "/api/auth/signout")).toBe(true),
    );
    expect(listsAfterSignOut).toBe(0);
  });

  it("drops an answer whose question is now hidden, not only one that was removed", async () => {
    /*
     * The second half of the prune, which also shipped uncovered: deleting the hidden-field loop
     * left every test green.
     *
     * A conditional question the applicant answered can become hidden without being removed —
     * the organizer changes what reveals it, or an earlier answer changes. The server refuses an
     * answer to a hidden field exactly as it refuses an unknown one, so both halves have to run.
     */
    const test = mount({
      liveFields: [
        {
          id: "title",
          type: "short_text" as const,
          label: "Proposal title",
          guidance: "",
          required: true,
          options: [],
        },
        {
          id: "detail",
          type: "long_text" as const,
          label: "Tell us more",
          guidance: "",
          required: false,
          options: [],
          visibleWhen: { fieldId: "title", operator: "equals" as const, values: ["Workshop"] },
        },
      ],
      proposals: [proposal({ answers: { title: "Talk", detail: "Written while it was shown" } })],
      write: (url, init) =>
        init.method === "PUT" ? jsonResponse({ proposal: proposal({ revision: 2 }) }) : undefined,
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(test.calls.some(({ method }) => method === "PUT")).toBe(true));
    // `detail` still *exists* on the form, so the unknown-key half would keep it. Its condition no
    // longer matches, which is what the second loop is for.
    expect(test.calls.find(({ method }) => method === "PUT")?.body).toEqual({
      answers: { title: "Talk" },
      expectedRevision: 1,
    });
  });

  it("resumes from whichever copy of a proposal is newer, after a win and after a refusal", async () => {
    /*
     * Both directions, because fixing one broke the other.
     *
     * The list can be a refresh behind, so `Continue` on a row just saved handed back the
     * *pre-save* revision and the applicant's own next save was refused as a conflict with
     * themselves. Preferring the in-hand copy fixed that — and broke the refusal case, where the
     * in-hand copy is the stale one: `editing` is replaced only on a successful write, while the
     * list refreshes either way. So after a 409 from another tab, pressing `Continue` on the row
     * the conflict message points at rebound the same stale revision and was refused identically —
     * the only escape being `Start another proposal`, which is labelled as making a new one.
     * Neither copy is reliably newer; the revision says which is.
     */
    let refuseNextSave = false;
    const listed = [proposal({ revision: 2, title: "Moved on elsewhere" })];
    const test = mount({
      proposals: listed,
      write: (url, init) =>
        init.method === "PUT"
          ? refuseNextSave
            ? jsonResponse(
                { error: { code: "CONFLICT", message: "Changed elsewhere.", correlationId: "x" } },
                409,
              )
            : jsonResponse({ proposal: proposal({ revision: 3 }) })
          : undefined,
    });

    // The list is ahead of anything held: resume from the list.
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(test.calls.some(({ method }) => method === "PUT")).toBe(true));
    expect(test.calls.find(({ method }) => method === "PUT")?.body).toMatchObject({
      expectedRevision: 2,
    });

    // Now the write has returned revision 3 and the list still shows 2: resume from the copy in
    // hand, or the applicant is refused for an edit they themselves just made.
    refuseNextSave = true;
    // Another tab moves it on again, which is what the refusal below will be about; the refresh
    // that follows the failed save is what brings this back.
    test.setProposals([proposal({ revision: 4, title: "Moved on elsewhere" })]);
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(test.calls.filter(({ method }) => method === "PUT")).toHaveLength(2),
    );
    expect(test.calls.filter(({ method }) => method === "PUT")[1]?.body).toMatchObject({
      expectedRevision: 3,
    });

    // The refusal came from another tab moving the proposal on, so the refresh that follows that
    // failed save brings back a *newer* row than the copy in hand.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Continue/ })).not.toBeDisabled(),
    );
    refuseNextSave = false;

    // Pressing Continue on the row the conflict message points at must rebind to the list, not to
    // the revision that just lost — otherwise the next save is refused identically, for ever.
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(test.calls.filter(({ method }) => method === "PUT")).toHaveLength(3),
    );
    expect(test.calls.filter(({ method }) => method === "PUT")[2]?.body).toMatchObject({
      expectedRevision: 4,
    });
  });

  it("says how many answers a republished form has left without questions", async () => {
    /*
     * Saving is what makes the loss permanent, so it is said before the save rather than found
     * afterwards — and on a *submitted* proposal it deletes content the organizers already hold.
     * This shipped with no assertion anywhere, in the commit whose subject was a false coverage
     * claim.
     */
    mount({
      proposals: [proposal({ answers: { title: "Kept", gone: "One", alsoGone: "Two" } })],
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("2 answers no longer have questions");
    expect(notice).toHaveTextContent("saving will drop them");
  });

  it("does not tell an applicant a submission failed when what failed was signing out", async () => {
    /*
     * This notice used to serve one action, so a blanket "Not submitted — " prefix was always
     * true of it. It now carries sign-out, demo sign-in, save and identity failures too, where
     * the prefix was at best irrelevant and at worst self-contradicting — the lifecycle conflict
     * rendered as "Not submitted — This proposal has already been submitted."
     */
    const test = mount({
      proposals: [proposal()],
      write: (url) =>
        url === "/api/session"
          ? jsonResponse(
              { error: { code: "INTERNAL_ERROR", message: "no", correlationId: "x" } },
              500,
            )
          : undefined,
    });
    await screen.findByRole("heading", { name: /Your proposals/ });
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Signing out did not work. Close the browser to be sure.");
    expect(notice.textContent).not.toContain("Not submitted");
    expect(test.calls.some(({ url }) => url === "/api/auth/signout")).toBe(true);
  });

  it("still says what failed when the server's own reason says nothing", async () => {
    /*
     * The half a blanket prefix was covering for.
     *
     * The API's generic refusal message is "Something went wrong.", and this notice preferred the
     * server's message over the action's — so a failed save spoke exactly that, with nothing
     * saying what had not happened. Removing the prefix without fixing this would trade one wrong
     * sentence for a missing one, and this live region is the only outcome a screen reader gets.
     */
    mount({
      write: (url, init) =>
        url === proposalsPath && init.method === "POST"
          ? jsonResponse(
              {
                error: {
                  code: "INTERNAL_ERROR",
                  message: "Something went wrong.",
                  correlationId: "x",
                },
              },
              500,
            )
          : undefined,
    });
    fireEvent.change(await screen.findByLabelText(/Proposal title/), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    // The action first, the server's reason after it — never the reason alone.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The proposal could not be saved. Something went wrong.",
    );
  });

  it("keeps a correction typed after a failed submit, rather than saying it saved it", async () => {
    /*
     * Silent data loss, and the notice that made it invisible.
     *
     * Submitting an unsaved proposal is two calls: create the draft, then submit it. The row
     * exists after the first one whatever the second does — and a submit can be refused for
     * things the browser cannot pre-catch. If the page does not adopt that draft until the submit
     * *succeeds*, the applicant's next Save draft takes the create branch again, with the same
     * idempotency key, and `createDraft` converges on the row that already exists **without
     * updating its answers**. The correction they just typed is dropped, and the page says
     * "Saved. You can come back to this proposal any time."
     *
     * The assertion is on the request, not the rendering: what is on screen after a discarded
     * write is exactly what is on screen after a kept one, which is what made this survive seven
     * review passes.
     */
    let submits = 0;
    const test = mount({
      write: (url, init) => {
        if (url.endsWith("/submit")) {
          submits += 1;
          return jsonResponse(
            { error: { code: "INTERNAL_ERROR", message: "Nope.", correlationId: "x" } },
            500,
          );
        }
        if (url === proposalsPath && init.method === "POST")
          return jsonResponse({ proposal: proposal({ answers: { title: "First try" } }) }, 201);
        if (init.method === "PUT")
          return jsonResponse({
            proposal: proposal({ answers: { title: "Corrected" }, revision: 2 }),
          });
        return undefined;
      },
    });

    const title = await screen.findByLabelText(/Proposal title/);
    fireEvent.change(title, { target: { value: "First try" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await waitFor(() => expect(submits).toBe(1));

    // The applicant fixes it and saves rather than submitting again.
    fireEvent.change(await screen.findByLabelText(/Proposal title/), {
      target: { value: "Corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(test.calls.some(({ method }) => method === "PUT")).toBe(true));
    // A revision of the draft that already exists — not a second create that converges on it and
    // throws the new answers away.
    const writes = test.calls.filter(({ url }) => url.startsWith(proposalsPath));
    expect(
      writes.filter(({ url, method }) => url === proposalsPath && method === "POST"),
    ).toHaveLength(1);
    expect(writes.at(-1)).toMatchObject({
      method: "PUT",
      body: { answers: { title: "Corrected" } },
    });
  });

  it("lists nothing as an invitation rather than as an error", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Your proposals" })).toBeVisible();
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    // Signing in is not offered again to somebody already signed in.
    expect(screen.queryByRole("heading", { name: "Keep track of your proposal" })).toBeNull();
    // And the control a draft needs is offered, because now there is an owner for one.
    expect(screen.getByRole("button", { name: "Save draft" })).toBeVisible();
  });

  it("saves a draft by creating one, then names its revision back on the next save", async () => {
    const created = proposal();
    const revised = proposal({
      revision: 2,
      title: "A whole idea",
      answers: { title: "A whole idea" },
    });
    const harness = mount({
      write: (url, init) => {
        if (url === proposalsPath && init.method === "POST")
          return jsonResponse({ proposal: created }, 201);
        if (url === `${proposalsPath}/${created.id}` && init.method === "PUT")
          return jsonResponse({ proposal: revised });
        return undefined;
      },
    });
    await screen.findByRole("heading", { name: "Your proposals" });

    fireEvent.change(screen.getByLabelText(/Proposal title/), {
      target: { value: "Half an idea" },
    });
    harness.setProposals([created]);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/You can come back to this proposal any time/);

    fireEvent.change(screen.getByLabelText(/Proposal title/), {
      target: { value: "A whole idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(harness.calls).toHaveLength(2));

    // The second save is an update naming the revision the first one returned — not a second
    // create, which would leave two half-written proposals on the dashboard.
    expect(harness.calls[0]).toMatchObject({
      url: proposalsPath,
      method: "POST",
      body: { answers: { title: "Half an idea" } },
    });
    expect(harness.calls[1]).toMatchObject({
      url: `${proposalsPath}/${created.id}`,
      method: "PUT",
      body: { answers: { title: "A whole idea" }, expectedRevision: 1 },
    });
  });

  it("submits a proposal it has never saved by creating it first", async () => {
    const created = proposal();
    const harness = mount({
      write: (url, init) => {
        if (url === proposalsPath && init.method === "POST")
          return jsonResponse({ proposal: created }, 201);
        if (url === `${proposalsPath}/${created.id}/submit`)
          return jsonResponse({
            proposal: proposal({
              lifecycle: "submitted",
              state: "under_consideration",
              revision: 2,
            }),
          });
        return undefined;
      },
    });
    await screen.findByRole("heading", { name: "Your proposals" });

    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "Straight in" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await screen.findByText(/Proposal submitted/);

    // Two calls, in this order, so every submitted proposal has the same shape on the dashboard
    // however it got there — and the create's idempotency key still converges on a retry.
    expect(harness.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${proposalsPath}`,
      `POST ${proposalsPath}/${created.id}/submit`,
    ]);
    expect(harness.calls[1]?.body).toMatchObject({ expectedRevision: 1 });
    // The form is cleared, so the next visitor action starts a new proposal rather than silently
    // editing the one just submitted.
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("");
  });

  it("offers a save and no submit when the proposal it is editing is already submitted", async () => {
    const submitted = proposal({
      lifecycle: "submitted",
      state: "under_consideration",
      title: "Already with the organizers",
      revision: 3,
      submittedAt: "2026-08-11T12:00:00.000Z",
    });
    const harness = mount({
      proposals: [submitted],
      write: (url, init) =>
        url === `${proposalsPath}/${submitted.id}` && init.method === "PUT"
          ? jsonResponse({ proposal: { ...submitted, revision: 4 } })
          : undefined,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /Edit Already with the organizers/ }),
    );

    // Submitting a submitted proposal is refused by the service, so a "Submit proposal" button here
    // would have exactly one outcome: an error message. It is not offered.
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // And the revision the edit names back is the one the dashboard listed, not 1.
    await waitFor(() => expect(harness.calls).toHaveLength(1));
    expect(harness.calls[0]).toMatchObject({
      url: `${proposalsPath}/${submitted.id}`,
      method: "PUT",
      body: { expectedRevision: 3 },
    });
    // A revision to something the organizers already hold is not still private, and does not say so.
    expect(await screen.findByText(/The organizers see this revision/)).toBeVisible();
  });

  it("reports a stale second tab and keeps the answers on screen", async () => {
    const existing = proposal();
    mount({
      proposals: [existing],
      write: (url, init) => {
        if (url === `${proposalsPath}/${existing.id}` && init.method === "PUT")
          return jsonResponse(
            {
              error: {
                code: "CONFLICT",
                message: "This proposal changed in another tab or window",
                correlationId: "trace-cfp",
              },
            },
            409,
          );
        return undefined;
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Continue Half an idea/ }));
    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "My version" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another tab");
    // Losing the race must not also lose the words: the refusal is data-loss-free.
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("My version");
  });

  it("keeps typing when the proposal already open is re-opened, and says so", async () => {
    /*
     * Issue #211: pressing the same row's button reloaded the stored copy over whatever had been
     * typed and said only "Editing …. Change what you need" — a silent discard on the one surface
     * whose spec (`PRD-CFP-004`) requires a drop to be stated *before* the save that makes it
     * permanent. Reverting `openForEditing` to the unconditional `setAnswers` fails both
     * assertions below.
     */
    mount({ proposals: [proposal()] });

    fireEvent.click(await screen.findByRole("button", { name: /Continue Half an idea/ }));
    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "My version" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue Half an idea/ }));

    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("My version");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your unsaved changes are still on the form",
    );
  });

  it("refuses to switch to another proposal while typing is unsaved, and says why", async () => {
    /*
     * The sibling of #211 that the first repair missed, found one click sideways by a review pass:
     * the same silent discard, reached by pressing a *different* proposal's button. The comment in
     * `openForEditing` claimed the same-proposal path was "the one path on this surface" — it was
     * not, and `GAP-025` is in this repository because a lane once repaired three of four siblings.
     *
     * Rebinding while keeping the answers would be worse than either option: it sends one
     * proposal's text under another's id.
     */
    const test = mount({
      proposals: [
        proposal({ id: "50000000-0000-4000-8000-00000000000a", title: "Alpha" }),
        proposal({ id: "50000000-0000-4000-8000-00000000000b", title: "Beta" }),
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue Alpha/ }));
    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "My version" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue Beta/ }));

    // The typing is still there, and the form is still bound to Alpha.
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("My version");
    expect(await screen.findByRole("alert")).toHaveTextContent("You have unsaved changes to Alpha");
    // The way out is named rather than left to be guessed at.
    expect(screen.getByRole("alert")).toHaveTextContent("Start another proposal");
    // And nothing was written: a refused switch is not a save.
    expect(test.calls.filter(({ method }) => method !== "GET")).toHaveLength(0);
  });

  it("does not invent unsaved changes from answers removed by a refreshed form", async () => {
    const titleField = liveCfp.fields[0]!;
    const abstractField = {
      id: "abstract",
      type: "long_text" as const,
      label: "Abstract",
      guidance: "",
      required: false,
      options: [],
    };
    const test = mount({
      liveFields: [titleField, abstractField],
      proposals: [
        proposal({
          id: "50000000-0000-4000-8000-00000000000a",
          title: "Alpha",
          answers: { title: "Alpha", abstract: "The old question's answer" },
        }),
        proposal({
          id: "50000000-0000-4000-8000-00000000000b",
          title: "Beta",
          answers: { title: "Beta" },
        }),
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: /Continue Alpha/ }));
    expect(screen.getByLabelText("Abstract")).toHaveValue("The old question's answer");

    // A visibility refresh can remove a question while React retains its old answer in state.
    // That invisible key is not work the applicant changed and must not block a proposal switch.
    test.rerenderLiveFields([titleField]);
    expect(screen.queryByLabelText("Abstract")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Continue Beta/ }));

    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("Beta");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses to open a stored proposal over a new one that has been typed into", async () => {
    /*
     * The third sibling, found by the review pass that followed the one above. `unsaved` was
     * measured against `editing`, so a form bound to *nothing* — an applicant part-way through a
     * new proposal, which is the state after every submit and after `Start another proposal` —
     * measured as having nothing to lose. Opening anything from the list wiped a whole unsent
     * abstract and announced "Editing …. Change what you need", which is the exact sentence issue
     * #211 exists to have removed.
     */
    const test = mount({ proposals: [proposal({ title: "Alpha" })] });

    // No proposal is open: the form is the empty new-proposal form.
    await screen.findByRole("button", { name: /Continue Alpha/ });
    fireEvent.change(screen.getByLabelText(/Proposal title/), {
      target: { value: "A brand new idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue Alpha/ }));

    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("A brand new idea");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You have unsaved answers on a new proposal",
    );
    expect(test.calls.filter(({ method }) => method !== "GET")).toHaveLength(0);
  });

  it("says what an empty form discarded even when no proposal was open", async () => {
    // The same statement for the deliberate discard on a form bound to nothing. It cannot claim
    // the previous proposal is unchanged, because there was no previous proposal — what was on
    // screen was never stored anywhere.
    mount({ proposals: [proposal({ title: "Alpha" })] });

    await screen.findByRole("button", { name: /Continue Alpha/ });
    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "Unsent" } });
    fireEvent.click(screen.getByRole("button", { name: "Start another proposal" }));

    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "were not saved anywhere and are gone",
    );
  });

  it("claims no loss when the proposal on the form was never changed", async () => {
    /*
     * The other half of the same sentence, and a regression the first version of this repair
     * introduced: `abandoned` is null both when no proposal is open *and* when an open one is
     * unmodified, so a discard notice guarded only on that fired for somebody who had just opened
     * — or just saved — a proposal that is sitting unchanged in the list above. Telling an
     * applicant their work is gone when it is not is the same defect as losing it silently.
     */
    mount({ proposals: [proposal({ title: "Alpha", answers: { title: "Alpha" } })] });

    fireEvent.click(await screen.findByRole("button", { name: /Continue Alpha/ }));
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Start another proposal" }));

    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("");
    expect(screen.queryByText(/are gone/)).toBeNull();
    expect(screen.queryByText(/were not saved/)).toBeNull();
  });

  it("says what it discarded when the applicant chooses an empty form", async () => {
    // `Start another proposal` is the one control that is *meant* to discard. It still says so,
    // because the applicant choosing the loss is not a reason to leave them guessing whether the
    // previous proposal was saved.
    mount({ proposals: [proposal({ title: "Half an idea" })] });

    fireEvent.click(await screen.findByRole("button", { name: /Continue Half an idea/ }));
    fireEvent.change(screen.getByLabelText(/Proposal title/), { target: { value: "My version" } });
    fireEvent.click(screen.getByRole("button", { name: "Start another proposal" }));

    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your unsaved changes to Half an idea were not saved",
    );
  });

  it("reloads the newer stored copy when the same row is re-opened untouched", async () => {
    /*
     * The other half of #211's fix, and the reason it is measured against the *bound* copy: an
     * applicant who has typed nothing has nothing to keep, so the rebind that lets them escape a
     * conflict raised by another tab still reloads. Keeping the old text here would strand them
     * on it.
     */
    const test = mount({ proposals: [proposal()] });
    fireEvent.click(await screen.findByRole("button", { name: /Continue Half an idea/ }));

    test.setProposals([
      proposal({ title: "Saved elsewhere", answers: { title: "Saved elsewhere" }, revision: 2 }),
    ]);
    // A write is what refreshes the list; the failed save leaves `editing` at revision 1.
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: /Continue Saved elsewhere/ });

    fireEvent.click(screen.getByRole("button", { name: /Continue Saved elsewhere/ }));
    expect(screen.getByLabelText(/Proposal title/)).toHaveValue("Saved elsewhere");
  });

  it("shows a decision, and stops offering edits once the call has closed", async () => {
    mount({
      status: "closed",
      proposals: [
        proposal({
          lifecycle: "submitted",
          state: "accepted",
          title: "Accepted talk",
          submittedAt: "2026-08-11T12:00:00.000Z",
        }),
        proposal({
          id: "50000000-0000-4000-8000-000000000002",
          lifecycle: "submitted",
          state: "declined",
          title: "Declined talk",
          submittedAt: "2026-08-11T12:05:00.000Z",
        }),
      ],
    });

    expect(await screen.findByText("Accepted")).toBeVisible();
    // "Not accepted" rather than "Declined": the same fact, addressed to the person it is about.
    expect(screen.getByText("Not accepted")).toBeVisible();
    // No triage vocabulary reaches this page — an event may configure "shortlist_maybe".
    expect(screen.queryByText(/under_review|shortlist/)).toBeNull();
    // After the deadline the list is a record, and it says so rather than offering dead buttons.
    expect(screen.queryByRole("button", { name: /Edit / })).toBeNull();
    expect(screen.getByText(/read but not changed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
  });
});
