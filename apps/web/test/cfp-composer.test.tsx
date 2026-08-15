// @acceptance ACC-CFP
/*
 * The CFP composer edits a document that is *also* live in front of applicants, and every
 * regression it has shipped came from that split: the draft on screen, the draft on the
 * server, and the immutable snapshot the public is submitting against are three different
 * things, and the composer is the only place a human can tell them apart.
 *
 * These are jsdom tests rather than browser ones because each one turns on what the
 * workspace *sends* and in what order — a Playwright assertion on rendered text passes
 * happily while the wrong version goes live.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfpWorkspace } from "../src/CfpWorkspace";

const eventId = "00000000-0000-4000-8000-000000000001";

type Call = { url: string; method: string; body: Record<string, unknown> };

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const errorResponse = (
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
) => jsonResponse({ error: { code, message, correlationId: "trace-cfp", fieldErrors } }, status);

const notFound = () => errorResponse(404, "NOT_FOUND", "No call for proposals exists yet.");

const field = (overrides: Record<string, unknown> = {}) => ({
  id: "title",
  type: "short_text",
  label: "Proposal title",
  guidance: "",
  required: true,
  options: [],
  ...overrides,
});

const form = (overrides: Record<string, unknown> = {}) => ({
  eventId,
  title: "Call for proposals",
  description: "Tell us what you would like to talk about.",
  fields: [field()],
  routing: [],
  status: "draft",
  version: 1,
  publishedAt: null,
  publishedStatus: null,
  // The scheduled window and the state it resolves to, which every CFP response now carries.
  // Unbounded here: these tests are about the form's own draft/live split, and the window has its
  // own test below.
  opensAt: null,
  closesAt: null,
  effectiveStatus: "unpublished",
  ...overrides,
});

/** The event's zone, which is what the composer enters and shows every deadline in. */
const TIMEZONE = "America/Los_Angeles";

/** Records every write so a test can assert *what* was sent and in *which order*. */
function stubApi(routes: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return routes(url, init) ?? notFound();
    }),
  );
  return calls;
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

/** The `<li>` for one question, found by the control only that question owns. */
const question = (label: string) =>
  screen.getByRole("button", { name: `Remove ${label}` }).closest("li") as HTMLElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("publishing what is on screen", () => {
  it("saves an unsaved edit before promoting it, so the live form is the one being looked at", async () => {
    const edited = form({ title: "Call for talks", version: 2 });
    const published = { ...edited, status: "open", publishedStatus: "open" };
    const calls = stubApi((url, init) => {
      if (url.endsWith("/cfp/state")) return jsonResponse({ cfp: published });
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return jsonResponse({ cfp: edited });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: form() });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    fireEvent.change(await screen.findByLabelText("Form title"), {
      target: { value: "Call for talks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish CFP" }));

    await screen.findByText("Published. Applicants now see this version of the form.");
    // The order is the whole point: `publish` promotes the *stored* draft, so a publish that
    // ran before the save would put the previous title in front of applicants.
    expect(writes(calls).map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT /api/events/${eventId}/cfp`,
      `POST /api/events/${eventId}/cfp/state`,
    ]);
    expect(writes(calls)[0]?.body).toMatchObject({ title: "Call for talks" });
    expect(writes(calls)[1]?.body).toEqual({ state: "publish" });
  });

  it("leaves the live form alone when the save that would precede it is refused", async () => {
    const calls = stubApi((url, init) => {
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return errorResponse(400, "VALIDATION_FAILED", "The form could not be saved.", {
          "fields.1.label": ["Give this question a label."],
        });
      if (url.startsWith("/api/events/"))
        return jsonResponse({
          cfp: form({ fields: [field(), field({ id: "abstract", label: "Session abstract" })] }),
        });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    fireEvent.change(await screen.findByLabelText("Form title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish CFP" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Reference: trace-cfp");
    // A refused save must abort the publish; promoting the stored draft here would ship the
    // version the organizer was trying to replace.
    expect(writes(calls).map((call) => call.url)).toEqual([`/api/events/${eventId}/cfp`]);
    // The server names the question by index; the organizer has to be shown which one.
    expect(
      within(question("Session abstract")).getByText("Give this question a label."),
    ).toBeInTheDocument();
    expect(
      within(question("Proposal title")).queryByText("Give this question a label."),
    ).toBeNull();
  });

  it("reports a stale draft and reloads only when the organizer chooses recovery", async () => {
    let organizerLoads = 0;
    const calls = stubApi((url, init) => {
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return errorResponse(
          409,
          "CONFLICT",
          "This CFP draft changed in another editor. Reload the latest draft before saving again.",
        );
      if (url.startsWith("/api/events/")) {
        organizerLoads += 1;
        return jsonResponse({
          cfp: form({
            title: organizerLoads === 1 ? "Loaded draft" : "Other editor's draft",
            version: organizerLoads === 1 ? 4 : 5,
          }),
        });
      }
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    fireEvent.change(await screen.findByLabelText("Form title"), {
      target: { value: "My unsaved edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another editor");
    expect(screen.getByLabelText("Form title")).toHaveValue("My unsaved edit");
    expect(writes(calls)[0]?.body.expectedVersion).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest draft" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Form title")).toHaveValue("Other editor's draft"),
    );
  });
});

describe("building the question list", () => {
  const twoQuestions = () =>
    form({ fields: [field(), field({ id: "abstract", label: "Session abstract" })] });

  it("adds only contract-backed types from a searchable keyboard dialog", async () => {
    stubApi((url) => (url.startsWith("/api/events/") ? jsonResponse({ cfp: form() }) : undefined));
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add question" }));
    const dialog = screen.getByRole("dialog", { name: "Add a question" });
    expect(within(dialog).getByRole("button", { name: /Short text/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Long text/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Email/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Single select/ })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search question types" }), {
      target: { value: "single" },
    });
    expect(within(dialog).queryByRole("button", { name: /Short text/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Single select/ }));
    expect(screen.queryByRole("dialog", { name: "Add a question" })).toBeNull();
    expect(screen.getByDisplayValue("New question")).toBeInTheDocument();
  });

  it("posts the order the organizer arranged, not the order the server sent", async () => {
    const calls = stubApi((url, init) => {
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return jsonResponse({ cfp: twoQuestions() });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: twoQuestions() });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    fireEvent.click(await screen.findByRole("button", { name: "Move Proposal title down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const sent = writes(calls)[0]?.body.fields as { id: string }[];
    expect(sent.map((entry) => entry.id)).toEqual(["abstract", "title"]);
    // Applicants answer these in order, so the numbering the organizer reads has to move too.
    expect(within(question("Session abstract")).getByText("1")).toBeInTheDocument();
    expect(within(question("Proposal title")).getByText("2")).toBeInTheDocument();
  });

  it("refuses to remove the last question, which the API would reject as an empty form", async () => {
    stubApi((url) => (url.startsWith("/api/events/") ? jsonResponse({ cfp: form() }) : undefined));
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    expect(await screen.findByRole("button", { name: "Remove Proposal title" })).toBeDisabled();
  });

  it("carries select options only while the question is a select", async () => {
    const calls = stubApi((url, init) => {
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return jsonResponse({ cfp: form() });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: form() });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    fireEvent.change(await screen.findByLabelText("Field type"), { target: { value: "select" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Beginner" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Intermediate" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getByLabelText("Option 3"), { target: { value: "Advanced" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    // The contract rejects blank options and a select with none, so the split has to
    // trim and drop empties rather than send whatever was typed between the commas.
    expect(writes(calls)[0]?.body.fields).toMatchObject([
      { type: "select", options: ["Beginner", "Intermediate", "Advanced"] },
    ]);

    fireEvent.change(screen.getByLabelText("Field type"), { target: { value: "short_text" } });
    expect(screen.queryByText("Answer options")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    // Options left behind on a short-text question would reappear the next time somebody
    // switched the type back, silently resurrecting a vocabulary that was removed.
    expect(writes(calls)[1]?.body.fields).toMatchObject([{ type: "short_text", options: [] }]);
  });

  it("seeds conditional visibility as is answered, never as equals blank", async () => {
    const conditionalForm = form({
      fields: [field(), field({ id: "abstract", label: "Session abstract" })],
    });
    const calls = stubApi((url, init) => {
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return jsonResponse({ cfp: conditionalForm });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: conditionalForm });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    await screen.findByRole("button", { name: "Remove Session abstract" });
    const abstract = question("Session abstract");
    fireEvent.click(await within(abstract).findByLabelText("Show this question conditionally"));
    expect(within(abstract).getByLabelText("Match")).toHaveValue("notEmpty");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body.fields).toMatchObject([
      {},
      { visibleWhen: { fieldId: "title", operator: "notEmpty", values: [] } },
    ]);
  });

  it("saves both comma-separated routing answers with an operator that honours both", async () => {
    const routedForm = form({
      fields: [
        field({ id: "track", type: "select", label: "Track", options: ["Workshop", "Lightning"] }),
      ],
    });
    const calls = stubApi((url, init) => {
      if (url.endsWith("/cfp/routing-statuses"))
        return jsonResponse({ statuses: [{ key: "under_review", label: "Under review" }] });
      if (url.startsWith("/api/events/") && init?.method === "PUT")
        return jsonResponse({ cfp: routedForm });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: routedForm });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    const routingCard = await screen.findByRole("region", { name: "Submission routing" });
    fireEvent.click(within(routingCard).getByRole("button", { name: "Add routing rule" }));
    expect(within(routingCard).getByLabelText("Match")).toHaveValue("in");
    fireEvent.change(within(routingCard).getByLabelText("Answer values"), {
      target: { value: "Workshop, Lightning" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body.routing).toMatchObject([
      { when: { fieldId: "track", operator: "in", values: ["Workshop", "Lightning"] } },
    ]);
  });

  it("names a stored route to a decision rather than rendering a blank control", async () => {
    /*
     * The case the dropdown filter creates rather than the one it prevents.
     *
     * `accepted` and `declined` stopped being offered as destinations, but a form saved before
     * that rule can still hold one — and a `select` whose value matches no option renders empty.
     * The organizer would have seen a blank control, an unexplained 400 on save, and nothing
     * saying which of their rules was the problem. This is the template slice's repair applied to
     * the surface an organizer actually edits on.
     */
    const legacyForm = form({
      fields: [
        field({ id: "track", type: "select", label: "Track", options: ["Workshop", "Keynote"] }),
      ],
      routing: [
        {
          id: "legacy",
          when: { fieldId: "track", operator: "in", values: ["Keynote"] },
          routeTo: { status: "accepted" },
        },
      ],
    });
    stubApi((url) => {
      if (url.endsWith("/cfp/routing-statuses"))
        return jsonResponse({
          statuses: [
            { key: "under_review", label: "Under review" },
            { key: "accepted", label: "Accepted" },
            { key: "declined", label: "Declined" },
          ],
        });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: legacyForm });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    const routingCard = await screen.findByRole("region", { name: "Submission routing" });
    const destination = within(routingCard).getByLabelText("Triage status");
    // The stored value is still the control's value, so the organizer sees which rule is wrong.
    expect(destination).toHaveValue("accepted");
    const shown = within(destination as HTMLSelectElement).getByRole("option", {
      name: /Accepted — no longer a routing destination/,
    });
    // Named, and unchoosable: the option exists to explain the current value, not to offer it.
    expect(shown).toBeDisabled();
    // And it is the only way `accepted` appears — it is not back in the list of destinations.
    expect(
      within(destination as HTMLSelectElement).queryByRole("option", { name: "Accepted" }),
    ).toBeNull();
    expect(
      within(destination as HTMLSelectElement).queryByRole("option", { name: "Declined" }),
    ).toBeNull();
  });

  it("says nothing about a rule's destination while it does not know which statuses exist", async () => {
    /*
     * The failure mode the label above creates if it is left ungated.
     *
     * `routingStatuses` starts empty and is filled asynchronously, and stays empty for good if
     * that read fails. Without the guard the "no longer a routing destination" option renders for
     * **every** rule, including perfectly valid ones — under its raw key, because the labels are
     * empty too, in a select holding nothing else to choose. The organizer is then told to pick
     * another destination with none on offer, next to a notice saying existing rules are
     * unchanged.
     */
    const routedForm = form({
      fields: [
        field({ id: "track", type: "select", label: "Track", options: ["Workshop", "Keynote"] }),
      ],
      routing: [
        {
          id: "valid",
          when: { fieldId: "track", operator: "in", values: ["Keynote"] },
          routeTo: { status: "under_review" },
        },
      ],
    });
    stubApi((url) => {
      // The statuses read fails; everything else answers.
      if (url.endsWith("/cfp/routing-statuses")) return jsonResponse({ error: {} }, 500);
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: routedForm });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    const routingCard = await screen.findByRole("region", { name: "Submission routing" });
    const destination = within(routingCard).getByLabelText("Triage status");
    expect(destination).toHaveValue("under_review");
    expect(
      within(destination as HTMLSelectElement).queryByText(/no longer a routing destination/),
    ).toBeNull();
  });

  it("refuses an empty equals condition before sending the draft", async () => {
    const conditionalForm = form({
      fields: [field(), field({ id: "abstract", label: "Session abstract" })],
    });
    const calls = stubApi((url) =>
      url.startsWith("/api/events/") ? jsonResponse({ cfp: conditionalForm }) : undefined,
    );
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);

    await screen.findByRole("button", { name: "Remove Session abstract" });
    const abstract = question("Session abstract");
    fireEvent.click(await within(abstract).findByLabelText("Show this question conditionally"));
    fireEvent.change(within(abstract).getByLabelText("Match"), { target: { value: "equals" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(
      await within(abstract).findByText("Choose the answer that shows Session abstract."),
    ).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("the live form beside the draft", () => {
  const draft = form({
    title: "Call for proposals 2027",
    status: "open",
    version: 4,
    publishedAt: "2026-08-01T12:00:00.000Z",
    publishedStatus: "open",
  });
  const live = { ...draft, title: "Call for proposals 2026", version: 3 };

  function renderDiverged() {
    const calls = stubApi((url) => {
      if (url.startsWith("/api/public/events/")) return jsonResponse({ cfp: live });
      if (url.startsWith("/api/events/")) return jsonResponse({ cfp: draft });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer timezone={TIMEZONE} />);
    return calls;
  }

  it("reads the published snapshot from the public endpoint, not from the draft it already has", async () => {
    const calls = renderDiverged();

    await screen.findByText("Draft ahead of live");
    // The Live tab is only evidence if it is the same bytes an applicant receives.
    expect(calls.map((call) => call.url)).toContain(`/api/public/events/${eventId}/cfp`);
  });

  it("says in words that the saved draft has moved ahead of what applicants are served", async () => {
    renderDiverged();

    expect(await screen.findByText("Draft ahead of live")).toBeInTheDocument();
    expect(screen.getByText(/The saved draft is ahead of the live form/)).toBeInTheDocument();
    // "Unsaved edits" is a different state with a different remedy; conflating them is how
    // an organizer concludes they have already published.
    expect(screen.queryByText("Unsaved edits")).toBeNull();
  });

  it("shows each version under its own tab so the two can actually be compared", async () => {
    renderDiverged();

    await screen.findByText("Draft ahead of live");
    expect(screen.getByText("Call for proposals 2027")).toBeInTheDocument();
    expect(screen.queryByText("Call for proposals 2026")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Live form" }));

    expect(screen.getByText("Call for proposals 2026")).toBeInTheDocument();
    expect(screen.getByText(/This is exactly what applicants see right now/)).toBeInTheDocument();
  });
});

describe("the public submission form", () => {
  const openForm = form({
    status: "open",
    publishedStatus: "open",
    // The applicant surface branches on `effectiveStatus`, not `status`: a published call whose
    // deadline has passed is `open` and `closed` at the same time, and only the second answer is
    // the one an applicant experiences. A fixture that set only `status` described a call that
    // cannot exist.
    effectiveStatus: "open",
    publishedAt: "2026-08-01T12:00:00.000Z",
    fields: [
      field(),
      field({ id: "abstract", type: "long_text", label: "Session abstract", required: false }),
    ],
  });

  it("submits answers keyed by question id with an idempotency key", async () => {
    const calls = stubApi((url) => {
      if (url.endsWith("/submissions"))
        return jsonResponse({
          submission: {
            confirmationId: "11111111-1111-4111-8111-111111111111",
            submittedAt: "2026-08-11T12:00:00.000Z",
          },
        });
      if (url.startsWith("/api/public/events/")) return jsonResponse({ cfp: openForm });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer={false} timezone={TIMEZONE} />);

    fireEvent.change(await screen.findByLabelText(/Proposal title/), {
      target: { value: "Shipping a CFP" },
    });
    fireEvent.change(screen.getByLabelText("Session abstract"), {
      target: { value: "How the composer keeps draft and live apart." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));

    await screen.findByText(/Confirmation: 11111111-1111-4111-8111-111111111111/);
    const submission = writes(calls)[0];
    expect(submission?.url).toBe(`/api/public/events/${eventId}/submissions`);
    // Answers are keyed by field id, never by label or position: the server matches them
    // against the published snapshot's ids.
    expect(submission?.body.answers).toEqual({
      title: "Shipping a CFP",
      abstract: "How the composer keeps draft and live apart.",
    });
    expect(String(submission?.body.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  });

  it("reveals dependent questions only when their condition matches", async () => {
    const conditional = form({
      status: "open",
      publishedStatus: "open",
      effectiveStatus: "open",
      fields: [
        field({ id: "category", type: "select", label: "Category", options: ["Talk", "Workshop"] }),
        field({
          id: "equipment",
          label: "Equipment needs",
          visibleWhen: { fieldId: "category", operator: "equals", values: ["Workshop"] },
        }),
      ],
    });
    stubApi((url) =>
      url.startsWith("/api/public/events/") ? jsonResponse({ cfp: conditional }) : undefined,
    );
    render(<CfpWorkspace eventId={eventId} organizer={false} timezone={TIMEZONE} />);

    expect(await screen.findByLabelText("Category *")).toBeInTheDocument();
    expect(screen.queryByLabelText("Equipment needs *")).toBeNull();
    fireEvent.change(screen.getByLabelText("Category *"), { target: { value: "Workshop" } });
    expect(screen.getByLabelText("Equipment needs *")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category *"), { target: { value: "Talk" } });
    expect(screen.queryByLabelText("Equipment needs *")).toBeNull();
  });

  it("puts the server's rejection on the answer that caused it", async () => {
    stubApi((url) => {
      if (url.endsWith("/submissions"))
        return errorResponse(400, "VALIDATION_FAILED", "The proposal could not be submitted.", {
          "answers.title": ["Keep the title under 120 characters."],
        });
      if (url.startsWith("/api/public/events/")) return jsonResponse({ cfp: openForm });
      return undefined;
    });
    render(<CfpWorkspace eventId={eventId} organizer={false} timezone={TIMEZONE} />);

    fireEvent.change(await screen.findByLabelText(/Proposal title/), {
      target: { value: "A title well past the limit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));

    expect(await screen.findByText("Keep the title under 120 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Proposal title/)).toHaveAttribute("aria-invalid", "true");
    // An applicant must not have to guess which of their answers the server disliked.
    expect(screen.getByLabelText("Session abstract")).toHaveAttribute("aria-invalid", "false");
  });

  it("offers no form at all when nothing is published, rather than a dead submit button", async () => {
    stubApi(() => undefined);
    render(<CfpWorkspace eventId={eventId} organizer={false} timezone={TIMEZONE} />);

    expect(await screen.findByText("This call for proposals is not available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
  });
  it("shows the console applicant a scheduled and a closed call, not a form it cannot submit", async () => {
    /*
     * This surface branched on `status`, which describes the publication rather than whether a
     * submission is possible — so a published call past its deadline rendered a green "Open for
     * submissions" pill over a whole working form that answers 409. Both non-open states get their
     * own words, because "not open yet" and "you have missed it" are opposite messages.
     */
    for (const [effectiveStatus, heading, pill] of [
      ["scheduled", "Submissions have not opened yet", "Opening soon"],
      ["closed", "Submissions are closed", "Closed"],
    ] as const) {
      cleanup();
      stubApi((url) =>
        url.startsWith("/api/")
          ? jsonResponse({
              cfp: form({ status: "open", publishedStatus: "open", effectiveStatus }),
            })
          : undefined,
      );
      render(<CfpWorkspace eventId={eventId} organizer={false} timezone={TIMEZONE} />);

      expect(await screen.findByText(heading)).toBeVisible();
      expect(screen.getByText(pill)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Submit proposal" })).toBeNull();
      expect(screen.queryByText("Open for submissions")).toBeNull();
    }
  });
});
