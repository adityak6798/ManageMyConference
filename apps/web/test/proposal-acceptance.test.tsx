// @acceptance ACC-REVIEW ACC-SPEAKER
/*
 * Acceptance is an action on a real triaged proposal, and the organizer surfaces carry no
 * placeholder payloads. These cover the UI half of the CFP -> review -> content chain: what the
 * Accept control posts, what it does with the server's typed refusals, who sees the submitter,
 * and that the task and message forms send what the organizer typed rather than a fixture.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentWorkspace } from "../src/ContentWorkspace";
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "../src/ReviewWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const proposalId = "11111111-1111-4111-8111-111111111111";
const otherProposalId = "22222222-2222-4222-8222-222222222222";
const profileId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const assignmentId = "55555555-5555-4555-8555-555555555555";

// Held in constants because a literal `role=` prop reads as an ARIA role to the linter.
const ORGANIZER = "organizer" as const;
const SPEAKER = "speaker" as const;

type Json = Record<string, unknown>;

const proposal = (overrides: Json = {}) => ({
  id: proposalId,
  eventId,
  title: "Typed boundaries at scale",
  abstract: "How a monolith learns to keep its promises.",
  submitterName: "Alex Morgan",
  submitter: { name: "Alex Morgan", email: "alex.morgan@example.test" },
  answers: [
    {
      fieldId: "abstract",
      label: "Abstract",
      type: "long_text" as const,
      value: "How a monolith learns to keep its promises.",
    },
  ],
  status: "submitted",
  ...overrides,
});

const statuses = [
  { key: "submitted", label: "Submitted", sortOrder: 0 },
  { key: "accepted", label: "Accepted", sortOrder: 1 },
  { key: "declined", label: "Declined", sortOrder: 2 },
];

const organizerWorkspace = (overrides: Json = {}) => ({
  proposals: [proposal()],
  plan: null,
  assignments: [],
  outcomes: [],
  audit: [],
  statuses,
  reviewers: [],
  decisions: [],
  ...overrides,
});

const decision = {
  eventId,
  proposalId,
  outcome: "accepted" as const,
  decidedBy: "seed-organizer",
  decidedAt: "2026-08-11T10:00:00.000Z",
  note: "",
};

/** The content half of an acceptance, as the decisions route reports it. */
const accepted = (overrides: Json = {}) => ({
  proposalId,
  state: "content" as const,
  sessionId,
  detail: "",
  fieldErrors: {},
  ...overrides,
});

const emptyContent = {
  sessions: [],
  speakers: [],
  tasks: [],
  assets: [],
  messages: [],
};

const speaker = {
  id: profileId,
  eventId,
  userId: "user-alex",
  sourcePersonId: "crm-email:alex.morgan@example.test",
  name: "Alex Morgan",
  email: "alex.morgan@example.test",
  bio: "",
  pronouns: "",
  organization: "Greenroom Labs",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const failure = (code: string, message: string, fieldErrors?: Record<string, string[]>) => ({
  error: { code, message, correlationId: "trace-77", ...(fieldErrors ? { fieldErrors } : {}) },
});

type Sent = { url: string; method: string; body: Json };

/** Records every mutation so a test can assert exactly what the organizer's click posted. */
function stubApi(routes: (url: string, sent: Sent[]) => Promise<Response> | undefined) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== "GET")
        sent.push({
          url,
          method: init.method,
          body: init.body ? (JSON.parse(String(init.body)) as Json) : {},
        });
      return routes(url, sent) ?? jsonResponse({});
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("accepting a triaged proposal", () => {
  it("accepts in one call and announces the resolved title", async () => {
    let decided = false;
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer"))
        return jsonResponse(organizerWorkspace(decided ? { decisions: [decision] } : {}));
      if (url.endsWith("/review/decisions")) {
        decided = true;
        return jsonResponse(
          {
            proposals: [proposal({ status: "accepted" })],
            decisions: [decision],
            acceptances: [accepted()],
          },
          201,
        );
      }
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept Typed boundaries at scale" }),
    );

    // The confirmation names what is being accepted and who becomes its speaker, and takes
    // focus so the keyboard follows the control it opened.
    const panel = await screen.findByText(/Creates a session from this abstract/);
    expect(panel).toHaveTextContent("Alex Morgan (alex.morgan@example.test)");
    expect(document.activeElement).toHaveClass("decision-confirm");
    expect(screen.getByRole("heading", { name: "Accept this abstract" })).toBeInTheDocument();
    expect(screen.getByText("Typed boundaries at scale", { selector: "strong" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Decision note (optional)"), {
      target: { value: "Strongest of the batch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm acceptance" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // One request, and the review domain's own route: the workspace never reaches into the
    // content domain to finish an acceptance the server can finish itself.
    expect(sent[0]).toMatchObject({
      url: `/api/events/${eventId}/review/decisions`,
      method: "POST",
      body: { proposalIds: [proposalId], outcome: "accepted", note: "Strongest of the batch" },
    });
    expect(sent.some(({ url }) => url.includes("/content/accept"))).toBe(false);

    // Several live regions are permanently mounted, so the announcement is found by its text.
    const status = await screen.findByText(/is accepted\. It is now a session/);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("“Typed boundaries at scale” is accepted");
    expect(status).toHaveTextContent("Alex Morgan linked as its speaker");
    // The recorded outcome is now on the row it was decided from.
    expect(await screen.findByText("Accepted", { selector: ".pill" })).toBeInTheDocument();
  });

  it("keeps the acceptance out of content when the review decision itself is refused", async () => {
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(organizerWorkspace());
      if (url.endsWith("/review/decisions"))
        return jsonResponse(failure("CONFLICT", "That abstract was withdrawn."), 409);
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept Typed boundaries at scale" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm acceptance" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That abstract was withdrawn. Reference: trace-77");
    expect(alert).not.toHaveTextContent("was recorded");
    // One request only — a refused decision must not reach the content domain.
    expect(sent.map(({ url }) => url)).toEqual([`/api/events/${eventId}/review/decisions`]);
  });

  it("says the decision stands when the server could not create the session", async () => {
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(organizerWorkspace());
      if (url.endsWith("/review/decisions"))
        return jsonResponse(
          {
            proposals: [proposal()],
            decisions: [decision],
            acceptances: [
              accepted({
                state: "decision_only",
                sessionId: null,
                detail: "The speaker identity could not be created from this proposal.",
                fieldErrors: {
                  "submitter.email": [
                    "The published form collected no email address, so no speaker can be created.",
                  ],
                },
              }),
            ],
          },
          201,
        );
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept Typed boundaries at scale" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm acceptance" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The 2xx carried a partial outcome, so the workspace reports it as a failure rather than
    // announcing an acceptance that produced no session.
    expect(
      await screen.findByText(/The published form collected no email address/),
    ).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The acceptance decision was recorded");
    expect(alert).toHaveTextContent("The speaker identity could not be created");
    expect(alert).toHaveTextContent("Retry session creation to finish it");
    // Re-posting the same decision heals server-side, so the action survives — but it says
    // which half it would retry rather than repeating the label that already ran.
    expect(screen.getByRole("button", { name: "Retry session creation" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Confirm acceptance" })).toBeNull();
  });

  it("refuses to offer an acceptance that could never produce a speaker", async () => {
    const sent = stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            organizerWorkspace({
              proposals: [proposal({ submitter: null, submitterName: "Applicant" })],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept Typed boundaries at scale" }),
    );

    const confirm = await screen.findByRole("button", { name: "Confirm acceptance" });
    expect(confirm).toBeDisabled();
    // The reason is the control's accessible description, not a sentence elsewhere on the page.
    expect(confirm).toHaveAccessibleDescription(
      /carries no contact address, so no speaker can be created from it and it cannot be accepted/,
    );
    fireEvent.click(confirm);
    expect(sent).toHaveLength(0);

    // Declining the same abstract is still offered: only acceptance needs an identity.
    fireEvent.click(screen.getByRole("button", { name: "Decline Typed boundaries at scale" }));
    expect(await screen.findByRole("button", { name: "Confirm decline" })).toBeEnabled();
  });

  it("declines without creating content", async () => {
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(organizerWorkspace());
      if (url.endsWith("/review/decisions"))
        return jsonResponse(
          {
            proposals: [proposal({ status: "declined" })],
            decisions: [{ ...decision, outcome: "declined" }],
            acceptances: [],
          },
          201,
        );
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Decline Typed boundaries at scale" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm decline" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body).toMatchObject({ outcome: "declined", proposalIds: [proposalId] });
    const status = await screen.findByText(/is declined\./);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("“Typed boundaries at scale” is declined");
  });
});

describe("who sees the submitter", () => {
  it("gives organizers the submitter's name and contact address", async () => {
    stubApi((url) =>
      url.includes("/review/organizer") ? jsonResponse(organizerWorkspace()) : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    const row = (await screen.findByRole("button", { name: "Typed boundaries at scale" })).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText(/Alex Morgan · alex\.morgan@example\.test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Typed boundaries at scale" }));
    expect(await screen.findByRole("link", { name: "alex.morgan@example.test" })).toHaveAttribute(
      "href",
      "mailto:alex.morgan@example.test",
    );
  });

  it("respects the mask the server applies to the reviewer queue", async () => {
    stubApi((url) =>
      url.includes("/review/assignments")
        ? jsonResponse({
            assignments: [
              {
                assignment: {
                  id: assignmentId,
                  eventId,
                  proposalId,
                  reviewerId: "seed-reviewer",
                  createdAt: "2026-08-10T09:00:00.000Z",
                },
                // Exactly what the server sends a reviewer: the mask, and no contact details.
                proposal: proposal({ submitterName: "Applicant", submitter: null }),
                plan: null,
                conflict: null,
                evaluation: null,
              },
            ],
          })
        : undefined,
    );
    const { container } = render(<ReviewerWorkspace eventId={eventId} />);

    expect(
      await screen.findByText(/the submitter's name and contact details are hidden/i),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("Alex Morgan");
    expect(container.textContent).not.toContain("alex.morgan@example.test");
    // The mask is not paraded as a person's name either.
    expect(container.textContent).not.toContain("Submitted by Applicant");
  });
});

describe("sessions and speakers workspace", () => {
  function renderOrganizer(workspace: unknown = emptyContent) {
    const sent = stubApi((url) =>
      url.endsWith(`/api/events/${eventId}/content`) ? jsonResponse(workspace) : undefined,
    );
    render(<ContentWorkspace eventId={eventId} role={ORGANIZER} />);
    return sent;
  }

  it("offers no acceptance control and no placeholder copy", async () => {
    renderOrganizer();

    expect(await screen.findByRole("heading", { name: "Accepted sessions" })).toBeInTheDocument();
    // Acceptance belongs to the review workspace, on a proposal that actually exists.
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    const copy = (document.body.textContent ?? "").toLowerCase();
    expect(copy).not.toContain("demo");
    expect(copy).not.toContain("upload final presentation");
    expect(copy).not.toContain("speaker preparation reminder sent");
  });

  it("requests the task the organizer typed and starts from an empty form", async () => {
    const sent = renderOrganizer({ ...emptyContent, speakers: [speaker] });

    const title = await screen.findByLabelText<HTMLInputElement>("Request a task");
    const due = screen.getByLabelText<HTMLInputElement>("Due date");
    // Nothing is pre-filled: the previous version shipped a title and a due date nobody chose.
    expect(title.value).toBe("");
    expect(due.value).toBe("");

    fireEvent.change(title, { target: { value: "Send your slides" } });
    fireEvent.change(due, { target: { value: "2026-10-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Request this task" }));

    await waitFor(() => expect(sent.some(({ url }) => url === "/api/speaker-tasks")).toBe(true));
    expect(sent.find(({ url }) => url === "/api/speaker-tasks")?.body).toEqual({
      profileId,
      title: "Send your slides",
      dueAt: "2026-10-02T23:59:00.000Z",
    });
    expect(
      await screen.findByText("Requested “Send your slides” from Alex Morgan."),
    ).toHaveAttribute("role", "status");
    // Cleared, so a second click cannot re-send the first request by accident.
    expect(screen.getByLabelText<HTMLInputElement>("Request a task").value).toBe("");
  });

  it("refuses an empty task request before anything is sent", async () => {
    const sent = renderOrganizer({ ...emptyContent, speakers: [speaker] });
    const form = (await screen.findByRole("button", { name: "Request this task" })).closest(
      "form",
    ) as HTMLFormElement;

    fireEvent.submit(form);

    expect(await screen.findByText("Say what you need from this speaker.")).toBeInTheDocument();
    expect(screen.getByText("Choose the day this is due.")).toBeInTheDocument();
    expect(screen.getByLabelText("Request a task")).toHaveAttribute("aria-invalid", "true");
    expect(sent.filter(({ url }) => url === "/api/speaker-tasks")).toHaveLength(0);
  });

  it("records the subject the organizer typed and renders the server's field error", async () => {
    const sent = stubApi((url) => {
      if (url.endsWith(`/api/events/${eventId}/content`))
        return jsonResponse({ ...emptyContent, speakers: [speaker] });
      if (url === "/api/speaker-messages")
        return jsonResponse(
          failure("VALIDATION_FAILED", "Speaker message is invalid.", {
            subject: ["Subject must be 200 characters or fewer."],
          }),
          400,
        );
      return undefined;
    });
    render(<ContentWorkspace eventId={eventId} role={ORGANIZER} />);

    const subject = await screen.findByLabelText<HTMLInputElement>("Record a communication");
    expect(subject.value).toBe("");
    fireEvent.change(subject, { target: { value: "Travel details confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Record this message" }));

    await waitFor(() => expect(sent.some(({ url }) => url === "/api/speaker-messages")).toBe(true));
    expect(sent.find(({ url }) => url === "/api/speaker-messages")?.body).toEqual({
      profileId,
      subject: "Travel details confirmed",
    });
    expect(await screen.findByText("Subject must be 200 characters or fewer.")).toBeInTheDocument();
    // The typed subject survives the failure so it can be corrected rather than retyped.
    expect(screen.getByLabelText<HTMLInputElement>("Record a communication").value).toBe(
      "Travel details confirmed",
    );
  });

  it("withholds the calendar download until a session has a time", async () => {
    const unscheduled = {
      ...emptyContent,
      speakers: [speaker],
      sessions: [
        {
          id: sessionId,
          eventId,
          proposalId: otherProposalId,
          title: "Typed boundaries at scale",
          abstract: "…",
          format: "Talk",
          speakerProfileIds: [profileId],
          tags: [],
          tracks: [],
          publicationState: "draft" as const,
        },
      ],
    };
    stubApi((url) =>
      url.endsWith(`/api/events/${eventId}/content`) ? jsonResponse(unscheduled) : undefined,
    );
    render(<ContentWorkspace eventId={eventId} role={SPEAKER} />);

    // The export answers 404 with no VEVENT to write, so the link is not offered yet. The
    // sentence that says so belongs to ContentWorkspace; what this pins is that one is shown
    // in place of the download.
    expect(await screen.findByText(/^Downloadable once/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download calendar/ })).toBeNull();
  });
});

/*
 * The decision column used to offer both outcomes on every row and render its confirmation as a
 * block appended after the table. Clicking Accept on an already-accepted abstract therefore did
 * nothing visible and nothing at all, several hundred pixels below the control that was pressed.
 * These pin the two corrections. Modality itself belongs to the browser suite — jsdom cannot
 * assert a focus trap or a top layer — so what is asserted here is which controls a row offers,
 * that the question is asked inside a `<dialog>`, and that a reversal states its consequence.
 */
describe("the decision column on a row that is already decided", () => {
  const renderDecided = async (outcome: "accepted" | "declined") => {
    stubApi((url) =>
      url.includes("/review/organizer")
        ? jsonResponse(
            organizerWorkspace({
              proposals: [proposal({ status: outcome })],
              decisions: [{ ...decision, outcome }],
            }),
          )
        : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);
    // The row's own title link, which every row carries whatever its decision.
    return screen.findByRole("button", { name: "Typed boundaries at scale" });
  };

  it("drops the outcome already recorded and offers only the reversal", async () => {
    await renderDecided("accepted");
    // The pill states where the abstract stands. Scoped to the decision cell, because the
    // status column carries its own pill and the two are different facts about the row.
    expect(document.querySelector(".decision-cell .pill")).toHaveTextContent("Accepted");
    // ...and the only decision left to take is the one that would change it.
    expect(
      screen.getByRole("button", { name: "Decline instead Typed boundaries at scale" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Accept Typed boundaries at scale/ })).toBeNull();
  });

  it("mirrors that for a declined abstract", async () => {
    await renderDecided("declined");
    expect(document.querySelector(".decision-cell .pill")).toHaveTextContent("Declined");
    expect(
      screen.getByRole("button", { name: "Accept instead Typed boundaries at scale" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Decline Typed boundaries at scale/ })).toBeNull();
  });

  it("asks inside a dialog and says a reversal does not withdraw the session", async () => {
    await renderDecided("accepted");
    fireEvent.click(
      screen.getByRole("button", { name: "Decline instead Typed boundaries at scale" }),
    );

    const dialog = document.querySelector("dialog.decision-dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog).toContainElement(screen.getByRole("button", { name: "Confirm decline" }));
    // Declining does not delete content, so the organizer is told what survives the reversal.
    expect(screen.getByText(/a session and a speaker already exist for it/)).toBeVisible();
    expect(screen.getByText(/does not remove them/)).toBeVisible();
    // ...and it names the control by the word actually printed on the other screen. The row
    // action in Sessions & speakers reads "Withdraw"; this sentence used to send the organizer
    // looking for a "delete the session" button that does not exist there.
    expect(screen.getByText(/use Withdraw in Sessions & speakers/)).toBeVisible();
    expect(document.body.textContent).not.toContain("delete the session");

    // Escape is the dialog's own affordance and must put it away.
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog.open).toBe(false));
  });

  it("does not offer a reversal warning on an abstract that was never accepted", async () => {
    await renderDecided("declined");
    fireEvent.click(
      screen.getByRole("button", { name: "Accept instead Typed boundaries at scale" }),
    );
    expect(screen.queryByText(/a session and a speaker already exist/)).toBeNull();
  });
});

/*
 * The Reviewers column, and the undo it never had.
 *
 * Two separate defects meet in this cell. `reviewers` is the *assignable* list and withholds the
 * signed-in organizer, so resolving an existing assignment's name through it printed a raw user
 * id for anyone that list holds back — a co-organizer's assignment showed up as "seed-organizer".
 * And assigning was one click and permanent: there was no control and no route to take it back,
 * so an abstract sat with somebody who could not open it, and the evaluation rubric — which locks
 * on the existence of any assignment at all — stayed frozen for the whole event.
 */
describe("the Reviewers column", () => {
  const assignmentId = "77777777-7777-4777-8777-777777777777";
  const assigned = {
    id: assignmentId,
    eventId,
    proposalId,
    // A co-organizer who also holds the reviewer role: exactly the identity the assignable list
    // withholds from whoever is looking at triage.
    reviewerId: "seed-organizer",
    createdAt: "2026-08-11T09:00:00.000Z",
  };
  const plan = {
    eventId,
    criteria: [
      {
        id: "fit",
        name: "Audience fit",
        description: "Overall strength for this event",
        minScore: 1,
        maxScore: 5,
      },
    ],
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
  /** What the server sends: two lists, because they answer two different questions. */
  const withAssignment = (overrides: Json = {}) =>
    organizerWorkspace({
      plan,
      assignments: [assigned],
      reviewers: [{ id: "seed-reviewer", name: "Ravi Reviewer" }],
      reviewerDirectory: [
        { id: "seed-organizer", name: "Olivia Organizer" },
        { id: "seed-reviewer", name: "Ravi Reviewer" },
      ],
      ...overrides,
    });
  const rowFor = async () =>
    (await screen.findByRole("button", { name: "Typed boundaries at scale" })).closest(
      "tr",
    ) as HTMLElement;

  it("names an assigned reviewer the assignable list withholds", async () => {
    stubApi((url) =>
      url.includes("/review/organizer") ? jsonResponse(withAssignment()) : undefined,
    );
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    const row = await rowFor();
    expect(within(row).getByText("Olivia Organizer")).toBeInTheDocument();
    // The user id is what this cell printed while one list answered both questions.
    expect(row.textContent).not.toContain("seed-organizer");
  });

  it("takes the assignment back and says the rubric is editable again", async () => {
    let removed = false;
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer"))
        return jsonResponse(removed ? withAssignment({ assignments: [] }) : withAssignment());
      if (url.endsWith(`/review/assignments/${assignmentId}`)) {
        removed = true;
        return jsonResponse({ assignment: assigned });
      }
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    // While the assignment stands the rubric is a read-only summary with no way back.
    expect(
      await screen.findByText(/Reviewers are already assigned, so the criteria are locked/),
    ).toBeInTheDocument();
    const row = await rowFor();
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Unassign Olivia Organizer from Typed boundaries at scale",
      }),
    );

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      url: `/api/events/${eventId}/review/assignments/${assignmentId}`,
      method: "DELETE",
    });
    const status = await screen.findByText(/Olivia Organizer is no longer reviewing/);
    expect(status).toHaveAttribute("role", "status");
    // The consequence an organizer would never guess at: the lock this assignment held is the
    // reason the criteria could not be edited, and removing the last one releases it.
    expect(status).toHaveTextContent("the evaluation criteria unlock");
    expect(within(await rowFor()).getByText("Unassigned")).toBeInTheDocument();
    // (The setup panel is a closed <details>, so this asserts presence rather than visibility.)
    expect(screen.getByRole("button", { name: "Save rubric" })).toBeInTheDocument();
  });

  it("announces the server's reason rather than its envelope when the removal is refused", async () => {
    const sent = stubApi((url) => {
      if (url.includes("/review/organizer")) return jsonResponse(withAssignment());
      if (url.endsWith(`/review/assignments/${assignmentId}`))
        return jsonResponse(
          failure("VALIDATION_FAILED", "The review request is invalid.", {
            assignmentId: [
              "This reviewer has already completed their evaluation, and that score is counted in the abstract's aggregate.",
            ],
          }),
          400,
        );
      return undefined;
    });
    render(<OrganizerReviewWorkspace eventId={eventId} />);

    fireEvent.click(
      within(await rowFor()).getByRole("button", { name: /^Unassign Olivia Organizer/ }),
    );

    await waitFor(() => expect(sent).toHaveLength(1));
    const alert = await screen.findByRole("alert");
    // "The review request is invalid." is the envelope's own line and is not something an
    // organizer can act on; the sentence that is lives in the field errors.
    expect(alert).toHaveTextContent("already completed their evaluation");
    expect(alert).not.toHaveTextContent("The review request is invalid");
    // Nothing was removed, so the reviewer is still named on the row.
    expect(within(await rowFor()).getByText("Olivia Organizer")).toBeInTheDocument();
  });
});
