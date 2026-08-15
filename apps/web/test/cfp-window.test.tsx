// @acceptance ACC-CFP
/*
 * The submission window, on both sides of the product.
 *
 * The zone conversion is the part worth a unit test rather than a browser one: a `datetime-local`
 * input carries no timezone at all, so the difference between "23:59 in Los Angeles" and "23:59
 * wherever the operator happens to be" is eight hours of deadline and no visible difference on
 * screen. The rest asserts what the two surfaces say about a call that is not open, which is the
 * evaluator's CFP-03 in as many words.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfpWorkspace } from "../src/CfpWorkspace";
import { fromZonedInput, toZonedInput, zonedInputExists } from "../src/cfp/model";
import { PublicCfpView } from "../src/public-event/PublicCfpView";

const eventId = "00000000-0000-4000-8000-000000000001";
const LA = "America/Los_Angeles";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a deadline is entered in the event's timezone", () => {
  it("round-trips a wall-clock time through the zone rather than through the browser's", () => {
    // 23:59 on the last day of September, in Los Angeles, is 06:59Z the next morning.
    const instant = fromZonedInput("2026-09-30T23:59", LA);
    expect(instant).toBe("2026-10-01T06:59:00.000Z");
    expect(toZonedInput(instant, LA)).toBe("2026-09-30T23:59");
    // The same instant is a different wall clock elsewhere, which is the whole reason the zone is
    // applied here instead of being left to whichever laptop opened the composer.
    expect(toZonedInput(instant, "Europe/Berlin")).toBe("2026-10-01T08:59");
    expect(toZonedInput(instant, "UTC")).toBe("2026-10-01T06:59");
  });

  it("lands on the time that was typed across a daylight-saving change", () => {
    // Los Angeles leaves daylight time at 02:00 on 2026-11-01. An hour either side of that the
    // offset differs, so a single-pass conversion puts one of the two on the wrong hour.
    expect(fromZonedInput("2026-11-01T01:30", LA)).toBe("2026-11-01T08:30:00.000Z");
    expect(fromZonedInput("2026-11-01T03:30", LA)).toBe("2026-11-01T11:30:00.000Z");
    expect(toZonedInput("2026-11-01T11:30:00.000Z", LA)).toBe("2026-11-01T03:30");
  });

  it("refuses a wall time the clock skips, rather than moving the deadline an hour", async () => {
    /*
     * The spring-forward gap. On 2026-03-08 in Los Angeles the clock goes 01:59 → 03:00, so
     * 02:30 names no instant at all — and the two-pass conversion lands it on the same instant as
     * 01:30. Saving it moved the organizer's announced deadline an hour earlier than they typed,
     * with nothing on screen to say so, which is worse than refusing it.
     *
     * `null` is not available as the answer: `fromZonedInput` returns `null` for *no bound*, so
     * collapsing a skipped time into that would clear the deadline being set.
     */
    expect(zonedInputExists("2026-03-08T02:30", LA)).toBe(false);
    // The hours either side of the gap are ordinary, and so is the autumn overlap.
    for (const real of ["2026-03-08T01:30", "2026-03-08T03:30", "2026-11-01T01:30"])
      expect(zonedInputExists(real, LA)).toBe(true);
    // No bound and a malformed value are not "skipped times" — they have their own meanings.
    expect(zonedInputExists("", LA)).toBe(true);
    expect(zonedInputExists("not-a-date", LA)).toBe(true);

    // And the composer refuses it rather than sending it.
    const writes: { url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method) writes.push({ url: String(input) });
        return jsonResponse({ cfp: form() });
      }),
    );
    render(<CfpWorkspace eventId={eventId} organizer timezone={LA} />);
    const deadline = await screen.findByLabelText("Deadline");
    await waitFor(() => expect(screen.getByLabelText("Opens")).toHaveValue(""));
    fireEvent.change(deadline, { target: { value: "2026-03-08T02:30" } });
    await waitFor(() => expect(deadline).toHaveValue("2026-03-08T02:30"));
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));

    expect(await screen.findByText(/does not exist in America\/Los_Angeles/)).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it("treats an empty input as no bound at all, in both directions", () => {
    expect(fromZonedInput("", LA)).toBeNull();
    expect(toZonedInput(null, LA)).toBe("");
    // Not a silent zero: a malformed value is refused rather than becoming 1970.
    expect(fromZonedInput("not-a-date", LA)).toBeNull();
    expect(toZonedInput("not-a-date", LA)).toBe("");
  });
});

const form = (overrides: Record<string, unknown> = {}) => ({
  eventId,
  title: "Call for proposals",
  description: "Tell us what you would like to talk about.",
  fields: [
    {
      id: "title",
      type: "short_text",
      label: "Proposal title",
      guidance: "",
      required: true,
      options: [],
    },
  ],
  routing: [],
  status: "open",
  version: 3,
  publishedAt: "2026-08-01T12:00:00.000Z",
  publishedStatus: "open",
  opensAt: null,
  closesAt: null,
  effectiveStatus: "open",
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("the organizer's window controls", () => {
  it("sends the deadline as an instant derived from the event's zone, without publishing", async () => {
    const writes: { url: string; method: string; body: unknown }[] = [];
    const scheduled = form({ closesAt: "2026-10-01T06:59:00.000Z", effectiveStatus: "open" });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method)
          writes.push({
            url,
            method: init.method,
            body: init.body ? JSON.parse(String(init.body)) : {},
          });
        if (url.endsWith("/cfp/window")) return jsonResponse({ cfp: scheduled });
        if (url.startsWith("/api/events/") || url.startsWith("/api/public/events/"))
          return jsonResponse({ cfp: form() });
        return jsonResponse({}, 404);
      }),
    );
    render(<CfpWorkspace eventId={eventId} organizer timezone={LA} />);

    /*
     * Waited for the composer to settle before typing.
     *
     * `CfpWorkspace` seeds its two window inputs from the loaded form in a passive effect, so the
     * control can be findable on the commit that first renders it, *before* that effect has run —
     * and the effect's `setClosesAtInput("")` then lands after `fireEvent.change` and silently
     * clears what was typed. The save goes out with `closesAt: null` and the failure reads as a
     * broken deadline conversion, which is nowhere near the cause. Roughly 3 in 200 loaded runs.
     * Waiting on a rendered value the effect is responsible for is what makes the field settled
     * rather than merely present.
     */
    const deadline = await screen.findByLabelText("Deadline");
    await waitFor(() => expect(screen.getByLabelText("Opens")).toHaveValue(""));
    fireEvent.change(deadline, { target: { value: "2026-09-30T23:59" } });
    await waitFor(() => expect(deadline).toHaveValue("2026-09-30T23:59"));
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));

    /*
     * Waited on the *request*, not on the notice.
     *
     * The subject of this test is the instant that goes over the wire; the notice is a rendering
     * that follows it. Waiting on the notice with `findByText`'s one-second default made the test
     * fail roughly two runs in ten when both workspaces' suites run at once — a timing flake in
     * the assertion, reported as a defect in the deadline conversion it is nowhere near.
     */
    // One write, to the window route only: extending a deadline must not publish the form.
    await waitFor(() =>
      expect(writes).toEqual([
        {
          url: `/api/events/${eventId}/cfp/window`,
          method: "PUT",
          body: { opensAt: null, closesAt: "2026-10-01T06:59:00.000Z" },
        },
      ]),
    );
    // The outcome is still reported, and the control shows the instant back as the local time it
    // was typed as.
    expect(await screen.findByText(/Submission window saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("Deadline")).toHaveValue("2026-09-30T23:59");
    // And *still* only one write, checked after the response has landed. `waitFor` above succeeds
    // the instant the PUT is issued, so on its own it cannot see a second request that follows —
    // which is the half of "must not publish the form" this test is named for, and which the
    // reordering that fixed a timing flake quietly stopped checking.
    expect(writes).toHaveLength(1);
  });

  it("states the precedence rule beside the controls, in the event's zone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ cfp: form() })),
    );
    render(<CfpWorkspace eventId={eventId} organizer timezone={LA} />);
    // An organizer who cannot find out why Reopen did nothing will conclude the product is broken.
    expect(
      await screen.findByText(/cannot open one whose deadline has passed/),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(LA))).toBeInTheDocument();
  });

  it("reports the state applicants are in, not the one the publication flag suggests", async () => {
    // The live call is marked open and the deadline has gone: `liveStatus` and `effectiveStatus`
    // disagree, and it is the second one an applicant experiences.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          cfp: form({
            closesAt: "2026-08-01T00:00:00.000Z",
            publishedStatus: "open",
            effectiveStatus: "closed",
          }),
        }),
      ),
    );
    render(<CfpWorkspace eventId={eventId} organizer timezone={LA} />);
    expect(
      await screen.findByText(/deadline has passed, so applicants cannot submit/),
    ).toBeInTheDocument();
  });
});

describe("a saved window converges on the state the server computed", () => {
  /*
   * Issue #222. The application boundary already enforced a deadline correctly; what was stale
   * was everything on screen that describes it. A window save changes what applicants are in
   * *without* changing the publication, so `setForm(saved)` alone left the Live tab — "the same
   * bytes an applicant receives" — and every warning derived from it showing the previous answer
   * until somebody reloaded by hand.
   *
   * Every assertion here is about state the **server** returned. Nothing recomputes a window
   * against the browser's clock, which is the other half of what these tests protect.
   */
  const composer = (options: {
    initial: Record<string, unknown>;
    afterSave: Record<string, unknown> | "refuse";
  }) => {
    const reads: string[] = [];
    let saved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PUT" && url.endsWith("/cfp/window")) {
          if (options.afterSave === "refuse")
            return jsonResponse(
              {
                error: {
                  code: "VALIDATION_FAILED",
                  message: "The deadline must be after the opening time.",
                  correlationId: "trace-window",
                },
              },
              422,
            );
          saved = true;
          return jsonResponse({ cfp: form(options.afterSave) });
        }
        if (!init?.method) reads.push(url);
        // Every read after the write answers with the saved state, which is what a re-read of the
        // live form would genuinely see.
        return jsonResponse({
          cfp: form(saved && options.afterSave !== "refuse" ? options.afterSave : options.initial),
        });
      }),
    );
    render(<CfpWorkspace eventId={eventId} organizer timezone={LA} />);
    return { reads };
  };

  /**
   * Long enough for two awaited round trips, because that is what these assertions wait on.
   *
   * `persistWindow` awaits the save, then awaits `refreshLive()`, and only then announces — so a
   * rendering asserted after a window save is three microtask hops and two stubbed responses
   * away. RTL's one-second default is generous on an idle machine and not generous under
   * `gate:test-build`, which runs three workspaces' suites with vitest threading files inside
   * each. The comment on the deadline-conversion test above records the same pattern failing
   * "roughly two runs in ten when both workspaces' suites run at once"; there the fix was to
   * assert on the request instead, and here the rendering *is* the subject, so the wait is what
   * has to give. A timeout is not a race fix — it is the honest bound on a wait whose subject is
   * the render.
   *
   * Under vitest's own 5 s `testTimeout`, deliberately: a wait equal to the test budget can never
   * fire, so every failure would report "Test timed out" instead of the element diagnostic that
   * says what was on screen.
   */
  const SETTLED = { timeout: 3_000 } as const;
  // `findBy*` takes the wait options third; the second slot is the matcher's own options.

  const saveDeadline = async (value: string) => {
    const deadline = await screen.findByLabelText("Deadline");
    await waitFor(() => expect(screen.getByLabelText("Opens")).toHaveValue(""));
    fireEvent.change(deadline, { target: { value } });
    await waitFor(() => expect(deadline).toHaveValue(value));
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));
  };

  it("renders the closed state at once when the saved deadline is already past", async () => {
    const test = composer({
      initial: { effectiveStatus: "open", publishedStatus: "open" },
      afterSave: {
        closesAt: "2026-08-01T00:00:00.000Z",
        publishedStatus: "open",
        effectiveStatus: "closed",
      },
    });

    await saveDeadline("2026-07-31T17:00");

    // The status line applicants are described by, without a reload.
    expect(
      await screen.findByText(
        /deadline has passed, so applicants cannot submit/,
        undefined,
        SETTLED,
      ),
    ).toBeInTheDocument();
    // And the announcement says the call is shut rather than promising applicants a date.
    expect(screen.getByText(/already passed, so the call is closed/)).toBeInTheDocument();
    /*
     * The **public** form is read again, so the Live tab — the same bytes an applicant receives —
     * stops showing an open call too. Counted on that exact URL rather than on "a CFP read",
     * because the composer issues three unrelated reads at mount and a loose count passes without
     * the re-read this asserts.
     */
    const publicReads = () =>
      test.reads.filter((url) => url === `/api/public/events/${eventId}/cfp`).length;
    await waitFor(() => expect(publicReads()).toBe(2));
  });

  it("renders the reopened state when the deadline moves back into the future", async () => {
    // The other direction, which a fix that only ever added a closed banner would fail.
    composer({
      initial: {
        closesAt: "2026-08-01T00:00:00.000Z",
        publishedStatus: "open",
        effectiveStatus: "closed",
      },
      afterSave: {
        closesAt: "2026-10-01T06:59:00.000Z",
        publishedStatus: "open",
        effectiveStatus: "open",
      },
    });
    expect(
      await screen.findByText(/deadline has passed, so applicants cannot submit/),
    ).toBeInTheDocument();

    await saveDeadline("2026-09-30T23:59");

    expect(
      await screen.findByText("Applicants can submit now.", undefined, SETTLED),
    ).toBeInTheDocument();
    expect(screen.queryByText(/deadline has passed, so applicants cannot submit/)).toBeNull();
  });

  it("does not blame a deadline for a closure the organizer made by hand", async () => {
    /*
     * `cfpEffectiveState` answers `closed` for a manually closed call before it looks at the
     * window at all, so reading `effectiveStatus === "closed"` as "the deadline has passed" told
     * an organizer who had closed the call and then scheduled an opening date that a deadline
     * they never set had gone by.
     */
    composer({
      initial: { publishedStatus: "closed", effectiveStatus: "closed" },
      afterSave: {
        opensAt: "2027-01-01T00:00:00.000Z",
        // A deadline that has *also* passed, which is the overlap a clock comparison gets wrong:
        // an organizer may close a call whose deadline has already gone, and the closure is still
        // the reason applicants cannot submit.
        closesAt: "2026-08-01T00:00:00.000Z",
        publishedStatus: "closed",
        effectiveStatus: "closed",
      },
    });

    const opens = await screen.findByLabelText("Opens");
    await waitFor(() => expect(screen.getByLabelText("Deadline")).toHaveValue(""));
    fireEvent.change(opens, { target: { value: "2026-12-31T16:00" } });
    await waitFor(() => expect(opens).toHaveValue("2026-12-31T16:00"));
    fireEvent.click(screen.getByRole("button", { name: "Save window" }));

    expect(
      await screen.findByText(/closed to new submissions until you reopen it/, undefined, SETTLED),
    ).toBeInTheDocument();
    expect(screen.queryByText(/already passed/)).toBeNull();
  });

  it("promises applicants nothing while the form is unpublished", async () => {
    /*
     * The third false sentence in the same chain: an unpublished call reaches no applicant, so
     * "Applicants see the deadline on the public form" describes a page nobody can open.
     *
     * Matched on the **whole announcement**, and scoped to the live region. The first version of
     * this case matched `/Nothing is published yet/`, which the composer's own empty-state
     * paragraph already renders before any save — so it passed against a mutated announcement,
     * and could resolve against either of two matching elements depending on scheduling. A test
     * that a mutation cannot kill is not coverage, and one that can match two nodes is a flake
     * waiting for a slow machine.
     */
    composer({
      initial: {
        // A form nobody has published: `status` is the editable row's, and `changeState` is the
        // only writer of `open`/`closed` — it sets the publication in the same write, so an open
        // row with no publication is a state the server cannot return.
        status: "draft",
        publishedStatus: null,
        effectiveStatus: "unpublished",
        publishedAt: null,
      },
      afterSave: {
        status: "draft",
        closesAt: "2026-10-01T06:59:00.000Z",
        publishedStatus: null,
        publishedAt: null,
        effectiveStatus: "unpublished",
      },
    });

    await saveDeadline("2026-09-30T23:59");

    const announcement = await screen.findByText(
      /Submission window saved\. Nothing is published yet/,
      undefined,
      SETTLED,
    );
    expect(announcement).toBeInTheDocument();
    expect(screen.queryByText(/Applicants see the deadline/)).toBeNull();
  });

  it("leaves the previous state intact when the save is refused", async () => {
    /*
     * No optimistic close. The composer must not claim a state the server never accepted — an
     * organizer who is told the call is shut, and whose applicants are still submitting, has been
     * given the one wrong answer this whole surface exists to avoid.
     */
    composer({
      initial: { effectiveStatus: "open", publishedStatus: "open" },
      afterSave: "refuse",
    });

    await saveDeadline("2026-09-30T23:59");

    expect(await screen.findByText(/deadline must be after the opening time/)).toBeInTheDocument();
    expect(screen.getByText("Applicants can submit now.")).toBeInTheDocument();
    expect(screen.queryByText(/applicants cannot submit/)).toBeNull();
  });
});

describe("what the applicant is shown when the call is not open", () => {
  const view = (overrides: Record<string, unknown>, status: "scheduled" | "closed" | "open") =>
    render(
      <PublicCfpView
        eventId={eventId}
        liveCfp={form(overrides) as never}
        schedule={form(overrides) as never}
        unavailable={null}
        status={status}
        statusLine={status === "open" ? "Open for submissions." : "Not open."}
        title="Share what you learned"
        description="Submit a practical session."
        timezone={LA}
      />,
    );

  it("labels a deadline with the zone in force at that instant, not the event's own week", async () => {
    /*
     * A call closing in December for a conference in September.
     *
     * The abbreviation came from `zoneAbbreviation(timezone, eventStartsOn)`, which answers for
     * the week the programme runs — right for a session, wrong for a deadline, which usually sits
     * outside it and often on the other side of a daylight-saving change. Los Angeles is PDT in
     * September and PST in December, so the page rendered "December 15, 2026 at 12:00 PM PDT":
     * the clock time correct, the zone name an hour out. A reader converting from the stated zone
     * misses the deadline by an hour, which is the one number on this line that has to be right.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, 401)),
    );
    view({ closesAt: "2026-12-15T20:00:00.000Z", effectiveStatus: "open" }, "open");

    const line = await screen.findByText(/Submissions close/);
    expect(line.textContent).toContain("PST");
    expect(line.textContent).not.toContain("PDT");
    expect(line.textContent).toContain("12:00 PM");
  });

  it("names the opening date and offers no form before the window starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, 401)),
    );
    view({ opensAt: "2026-09-01T07:00:00.000Z", effectiveStatus: "scheduled" }, "scheduled");

    // "Closed" and "not open yet" are opposite messages; a surface that folded them together
    // would tell a third of its visitors the wrong one.
    expect(await screen.findByText(/Submissions open/)).toBeInTheDocument();
    expect(screen.getByText(/Submissions open/).textContent).toContain("2026");
    expect(screen.getByText("Opening soon")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
    expect(screen.getByText(/not open for submissions yet/)).toBeInTheDocument();
  });

  it("names the date it closed rather than reporting a bare refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, 401)),
    );
    view({ closesAt: "2026-10-01T06:59:00.000Z", effectiveStatus: "closed" }, "closed");

    // "Closed" with no date reads as a decision somebody made this morning.
    const line = await screen.findByText(/Submissions closed/);
    expect(line.textContent).toContain("September 30, 2026");
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
  });

  it("offers a way back in after the call has closed, because that is when decisions land", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/session") return jsonResponse({ error: {} }, 401);
        if (url === "/api/auth/config") return jsonResponse({ demoMode: true, google: false });
        return jsonResponse({}, 404);
      }),
    );
    view({ closesAt: "2026-10-01T06:59:00.000Z", effectiveStatus: "closed" }, "closed");

    // Gating the door on the call being open stranded a signed-out applicant on a closed call with
    // neither their dashboard nor any way to reach it — and an organizer records decisions *after*
    // the deadline, which makes this the main occasion for coming back at all.
    expect(
      await screen.findByRole("heading", { name: "Already proposed something?" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue as Sam Speaker" })).toBeVisible();
    // The invitation changes wording rather than promising a submission it cannot take.
    expect(screen.getByText(/Submissions are not open/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
  });

  it("offers the anonymous form and a way to sign in while the call is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        // Nobody is signed in, which `/api/session` reports as a 401 rather than a failure.
        if (url === "/api/session") return jsonResponse({ error: {} }, 401);
        if (url === "/api/auth/config") return jsonResponse({ demoMode: true, google: false });
        return jsonResponse({}, 404);
      }),
    );
    view({ closesAt: "2026-10-01T06:59:00.000Z" }, "open");

    expect(await screen.findByRole("button", { name: "Submit proposal" })).toBeInTheDocument();
    // The deadline is on the page an applicant is filling in, not only on the one they came from.
    expect(screen.getByText(/Submissions close/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Keep track of your proposal" })).toBeVisible(),
    );
    // Saving a draft needs an owner, so it is not offered to somebody with no account: a button
    // that refuses on press is a button that lies.
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
});
