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
import { fromZonedInput, toZonedInput } from "../src/cfp/model";
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

describe("what the applicant is shown when the call is not open", () => {
  const view = (overrides: Record<string, unknown>, status: "scheduled" | "closed" | "open") =>
    render(
      <PublicCfpView
        eventId={eventId}
        liveCfp={form(overrides) as never}
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
