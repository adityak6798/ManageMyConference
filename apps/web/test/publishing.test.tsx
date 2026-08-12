// @acceptance ACC-PUBLIC
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PublishingWorkspace } from "../src/PublishingWorkspace";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const organizationId = "00000000-0000-4000-8000-000000000010";
const slug = "greenroom-summit-123e4567-e89b-12d3-a456-426614174000";
const origin = window.location.origin;

const projection = {
  event: {
    eventId,
    slug,
    name: "Greenroom Summit",
    summary: "One day on running better events.",
    startsOn: "2026-09-18",
    endsOn: "2026-09-18",
    timezone: "America/Los_Angeles",
    venue: "Bay Pavilion",
  },
  cfp: {
    title: "Call for proposals",
    description: "Tell us what you would talk about.",
    status: "open" as const,
    publishedAt: "2026-08-01T12:00:00.000Z",
    submissionUrl: `/events/${slug}/cfp`,
  },
  sessions: [
    {
      slug: "opening-keynote",
      title: "Opening keynote",
      abstract: "Why the room matters.",
      format: "keynote",
      track: "Main stage",
      speakerSlugs: ["ada-lovelace"],
      startsAt: "2026-09-18T16:00:00.000Z",
      endsAt: "2026-09-18T17:00:00.000Z",
      room: "Grand Hall",
    },
  ],
  speakers: [
    {
      slug: "ada-lovelace",
      name: "Ada Lovelace",
      bio: "Analytical engines and their programmes.",
      organization: "Greenroom Labs",
    },
  ],
};

/** A draft that has moved on since the snapshot was taken. */
const movedDraft = {
  ...projection,
  sessions: [
    ...projection.sessions,
    {
      slug: "closing-panel",
      title: "Closing panel",
      abstract: "What we learned.",
      format: "panel",
      track: "Main stage",
      speakerSlugs: [],
    },
  ],
};

function publication(overrides: Record<string, unknown> = {}) {
  return {
    publication: {
      eventId,
      slug,
      state: "published",
      draft: projection,
      published: projection,
      publishedAt: "2026-08-10T18:30:00.000Z",
      ...overrides,
    },
  };
}

const unpublished = publication({ state: "draft", published: null, publishedAt: null });

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

/** Records every request so a test can assert that Preview never mutates. */
function stubPublishing(responses: {
  preview?: unknown;
  publish?: unknown;
  unpublish?: unknown;
  settings?: unknown;
}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/publish")) return jsonResponse(responses.publish ?? publication());
    if (url.endsWith("/unpublish"))
      return jsonResponse(
        responses.unpublish ??
          publication({ state: "unpublished", published: null, publishedAt: null }),
      );
    if (url.endsWith("/settings"))
      return responses.settings instanceof Response
        ? Promise.resolve(responses.settings.clone())
        : jsonResponse(responses.settings ?? publication());
    if (url.endsWith("/preview")) return jsonResponse(responses.preview ?? publication());
    return jsonResponse({}, init?.method === "POST" ? 200 : 200);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderWorkspace() {
  return render(<PublishingWorkspace eventId={eventId} eventName="Greenroom Summit" canPublish />);
}

/** jsdom has no clipboard; every copy path is driven through this stub. */
function stubClipboard<T extends (text: string) => Promise<unknown>>(writeText: T) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

/** The `.publishing-embed` section a control belongs to — the panel that owns it. */
function embedPanelOf(control: HTMLElement) {
  const panel = control.closest(".publishing-embed");
  if (!(panel instanceof HTMLElement)) throw new Error("the control is not inside an embed panel");
  return panel;
}

describe("PublishingWorkspace", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers the live public URL and both embed addresses as real links", async () => {
    stubPublishing({});
    renderWorkspace();

    const publicLink = await screen.findByRole("link", { name: `${origin}/events/${slug}` });
    expect(publicLink).toHaveAttribute("href", `/events/${slug}`);

    for (const view of ["schedule", "speakers"]) {
      const link = screen.getByRole("link", { name: `${origin}/embed/events/${slug}/${view}` });
      expect(link).toHaveAttribute("href", `/embed/events/${slug}/${view}`);
    }
  });

  it("renders a copyable iframe snippet and a live preview frame per embed view", async () => {
    stubPublishing({});
    const { container } = renderWorkspace();

    const snippet = await screen.findByLabelText<HTMLTextAreaElement>(
      "Paste this into the host page",
      { selector: "#snippet-schedule" },
    );
    expect(snippet).toHaveAttribute("readonly");
    expect(snippet.value).toBe(
      `<iframe src="${origin}/embed/events/${slug}/schedule" title="Greenroom Summit schedule" width="100%" height="640" loading="lazy" style="border:0"></iframe>`,
    );

    const frames = [...container.querySelectorAll("iframe")].map((frame) =>
      frame.getAttribute("src"),
    );
    // Four widget types, which is what issue #95 asks the share tooling to cover: the two
    // programme views and the two readings of the speaker directory.
    expect(frames).toEqual([
      `/embed/events/${slug}/schedule`,
      `/embed/events/${slug}/sessions`,
      `/embed/events/${slug}/speakers`,
      `/embed/events/${slug}/gallery`,
    ]);
  });

  it("writes the chosen options into every snippet it hands out", async () => {
    stubPublishing({});
    renderWorkspace();
    await screen.findByLabelText("Paste this into the host page", {
      selector: "#snippet-schedule",
    });

    fireEvent.change(screen.getByLabelText("Limit to one track"), {
      target: { value: "Main stage" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Times" }));

    // The configuration lives in the URL rather than on the server, so the organizer can
    // hand out two differently configured snippets without this screen remembering either.
    const snippet = screen.getByLabelText<HTMLTextAreaElement>("Paste this into the host page", {
      selector: "#snippet-sessions",
    });
    expect(snippet.value).toContain("track=Main+stage");
    expect(snippet.value).toContain("fields=time");
    expect(screen.getByText("The cards print only: time.")).toBeVisible();
  });

  it("copies the schedule snippet to the clipboard and announces it", async () => {
    stubPublishing({});
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    renderWorkspace();

    // Each embed view names its own control, so this cannot silently target the other one.
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy snippet for the Schedule embed" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).toContain(
      `src="${origin}/embed/events/${slug}/schedule"`,
    );
    expect(
      await screen.findByText("Schedule embed snippet copied to the clipboard."),
    ).toHaveAttribute("role", "status");
  });

  /*
   * The embed controls sit at the bottom of a long page while the panel's other live
   * region sits in the Publication card at the top: in the browser the confirmation
   * rendered 967px above the button that produced it, off screen, and so did "copying was
   * blocked". jsdom cannot measure pixels, so these pin the structural property that
   * distance was made of — the message belongs to the section that owns the control — plus
   * the change under the pointer that makes a copy legible without reading anything.
   */
  it("announces a copy inside the panel that owns the button, not in the card at the top", async () => {
    stubPublishing({});
    stubClipboard(vi.fn(() => Promise.resolve()));
    const { container } = renderWorkspace();

    const button = await screen.findByRole("button", {
      name: "Copy snippet for the Schedule embed",
    });
    const panel = embedPanelOf(button);
    fireEvent.click(button);

    const message = await within(panel).findByText(
      "Schedule embed snippet copied to the clipboard.",
    );
    expect(message).toHaveAttribute("role", "status");
    // Not in the Publication card, which is where it used to land.
    expect(container.querySelector(".publishing-foot")?.textContent).not.toContain("copied");
    // And not in the other embed panel either: the two sections do not share a region.
    const speakers = embedPanelOf(
      screen.getByRole("button", { name: "Copy snippet for the Speakers embed" }),
    );
    expect(within(speakers).queryByText(/copied to the clipboard/)).toBeNull();
    // The button under the pointer says so itself, for as long as it takes to read.
    expect(button).toHaveTextContent("Copied");
    expect(button).toHaveAccessibleName("Copied the Schedule embed snippet");
  });

  it("announces a copied embed URL in its own panel too", async () => {
    stubPublishing({});
    const writeText = stubClipboard(vi.fn((_text: string) => Promise.resolve()));
    renderWorkspace();

    const button = await screen.findByRole("button", { name: "Copy URL for the Speakers embed" });
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(`${origin}/embed/events/${slug}/speakers`);
    expect(
      await within(embedPanelOf(button)).findByText("Speakers embed URL copied to the clipboard."),
    ).toHaveAttribute("role", "status");
    expect(button).toHaveTextContent("Copied");
  });

  it("keeps a refused copy beside the button and hands over the selected snippet", async () => {
    stubPublishing({});
    // Any non-secure origin, or a denied permission, rejects exactly like this.
    stubClipboard(vi.fn(() => Promise.reject(new Error("Write permission denied."))));
    const { container } = renderWorkspace();

    const button = await screen.findByRole("button", {
      name: "Copy snippet for the Schedule embed",
    });
    const panel = embedPanelOf(button);
    fireEvent.click(button);

    const refusal = await within(panel).findByRole("alert");
    expect(refusal).toHaveTextContent("Copying was blocked by the browser.");
    expect(container.querySelector(".publishing-foot")?.textContent).not.toContain("blocked");
    // A copy that failed must not be indistinguishable from one that worked.
    expect(button).toHaveTextContent("Copy snippet");
    expect(within(panel).queryByRole("button", { name: /^Copied/ })).toBeNull();
    // The refusal is actionable rather than merely stated: the field is focused, and
    // focusing it selects the whole snippet, so one keystroke still copies it.
    const snippet = within(panel).getByLabelText<HTMLTextAreaElement>(
      "Paste this into the host page",
    );
    expect(document.activeElement).toBe(snippet);
    expect([snippet.selectionStart, snippet.selectionEnd]).toEqual([0, snippet.value.length]);
  });

  it("composes the publication payload on Preview without publishing anything", async () => {
    const fetchMock = stubPublishing({ preview: unpublished });
    renderWorkspace();

    await screen.findByRole("button", { name: "Preview" });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      await screen.findByText(
        "Preview recomposed from the current draft. Nothing has been published.",
      ),
    ).toHaveAttribute("role", "status");
    // The composed payload is on screen — the event facts and the programme.
    expect(screen.getAllByText("Opening keynote").length).toBeGreaterThan(0);
    expect(screen.getByText("Bay Pavilion")).toBeInTheDocument();
    // Preview is a GET. Nothing may have been mutated to render it.
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("publishes, reveals the public URL, and states that later edits stay invisible", async () => {
    const fetchMock = stubPublishing({ preview: unpublished });
    renderWorkspace();

    const publish = await screen.findByRole("button", { name: "Publish" });
    // Nothing is live yet, so the address is shown as reserved rather than as a link.
    expect(screen.queryByRole("link", { name: `${origin}/events/${slug}` })).toBeNull();
    fireEvent.click(publish);

    expect(
      await screen.findByText(/later draft edits stay invisible until you publish again/),
    ).toHaveAttribute("role", "status");
    const publishCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(publishCall?.[0])).toBe(`/api/publishing/events/${eventId}/publish`);
    expect(
      await screen.findByRole("link", { name: `${origin}/events/${slug}` }),
    ).toBeInTheDocument();
    // Focus lands on the state the action changed, not on a button whose label flipped.
    expect(document.activeElement).toHaveClass("publishing-status");
  });

  it("unpublishes and stops offering the public page", async () => {
    const fetchMock = stubPublishing({});
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Unpublish" }));

    expect(await screen.findByText(/now return the not-published response/)).toHaveAttribute(
      "role",
      "status",
    );
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(call?.[0])).toBe(`/api/publishing/events/${eventId}/unpublish`);
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: `${origin}/events/${slug}` })).toBeNull(),
    );
    expect(screen.getByText(/Reserved public URL/)).toBeInTheDocument();
  });

  it("names the parts of the draft that have moved ahead of the immutable snapshot", async () => {
    stubPublishing({ preview: publication({ draft: movedDraft }) });
    renderWorkspace();

    const alerts = await screen.findAllByText(/stay invisible until you publish again/);
    expect(alerts[0]).toHaveTextContent("sessions");
    expect(screen.getByText("Draft ahead of the published snapshot")).toBeInTheDocument();

    // The published tab shows the frozen copy, which does not contain the new session.
    fireEvent.click(screen.getByRole("tab", { name: "Published snapshot" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByText("Closing panel")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Draft preview" }));
    expect(within(screen.getByRole("tabpanel")).getByText("Closing panel")).toBeInTheDocument();
  });

  it("refuses publishing controls to a role that may read but not update settings", async () => {
    stubPublishing({});
    render(
      <PublishingWorkspace eventId={eventId} eventName="Greenroom Summit" canPublish={false} />,
    );

    expect(await screen.findByRole("button", { name: "Publish changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  /*
   * The public details form. Before it existed, `summary` and `venue` had no writer
   * anywhere in the product, so every organizer-created event published an empty summary
   * and a nameless venue (issue #37).
   */
  describe("public details", () => {
    const settingsForm = async () => {
      await screen.findByLabelText("Summary");
      // The form renders before the publication it is populated from has arrived, and a late
      // response resets the fields. Waiting for the server copy to be *in* a field is what makes
      // a subsequent edit a real edit: without it, a change can be reverted before the assertion,
      // leaving Save disabled — so the click does nothing and no request is ever sent.
      await waitFor(() =>
        expect(screen.getByLabelText<HTMLInputElement>("Venue")).toHaveValue("Bay Pavilion"),
      );
      return {
        summary: screen.getByLabelText<HTMLTextAreaElement>("Summary"),
        venue: screen.getByLabelText<HTMLInputElement>("Venue"),
        startsOn: screen.getByLabelText<HTMLInputElement>("First day"),
        endsOn: screen.getByLabelText<HTMLInputElement>("Last day"),
        slug: screen.getByLabelText<HTMLInputElement>("Public address"),
        save: screen.getByRole("button", { name: "Save public details" }),
      };
    };

    it("sends only the fields the organizer changed", async () => {
      const fetchMock = stubPublishing({});
      renderWorkspace();
      const form = await settingsForm();

      // The dates on screen may be composed from the agenda rather than typed, so sending
      // them back unchanged would store a derived value as an organizer-set one and stop
      // the public page tracking the agenda. Only `venue` moved, so only `venue` is sent.
      fireEvent.change(form.venue, { target: { value: "Harbor Conference Center" } });
      fireEvent.click(form.save);

      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
        expect(patch).toBeDefined();
        expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
          venue: "Harbor Conference Center",
        });
      });
    });

    it("saves to the draft and says the live page is unchanged until republished", async () => {
      stubPublishing({});
      renderWorkspace();
      const form = await settingsForm();

      fireEvent.change(form.summary, { target: { value: "A day on running better events." } });
      fireEvent.click(form.save);

      expect(await screen.findByText(/Publish again to put them on the live page/)).toBeVisible();
    });

    it("cannot be submitted until something changes, and discards back to the server copy", async () => {
      stubPublishing({});
      renderWorkspace();
      const form = await settingsForm();

      expect(form.save).toBeDisabled();
      fireEvent.change(form.venue, { target: { value: "Somewhere else" } });
      expect(form.save).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(form.venue).toHaveValue("Bay Pavilion");
      expect(screen.getByRole("button", { name: "Save public details" })).toBeDisabled();
    });

    it("puts a refused public address on the address field", async () => {
      stubPublishing({
        settings: new Response(
          JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "That public address is already taken.",
              correlationId: "trace-4",
              fieldErrors: { slug: ["That public address is already taken."] },
            },
          }),
          { status: 409 },
        ),
      });
      renderWorkspace();
      const form = await settingsForm();

      fireEvent.change(form.slug, { target: { value: "already-taken" } });
      fireEvent.click(form.save);

      const message = await screen.findByText("That public address is already taken.", {
        selector: ".publishing-field-error",
      });
      expect(message).toBeVisible();
      // Named by the input, so a screen reader reaches the refusal from the field it is about
      // rather than only from the announcement at the end of the form.
      expect(form.slug).toHaveAccessibleDescription("That public address is already taken.");
    });

    it("is read-only for a role that may read but not update settings", async () => {
      stubPublishing({});
      render(
        <PublishingWorkspace eventId={eventId} eventName="Greenroom Summit" canPublish={false} />,
      );
      const form = await settingsForm();

      for (const field of [form.summary, form.venue, form.startsOn, form.endsOn, form.slug])
        expect(field).toBeDisabled();
      expect(form.save).toBeDisabled();
    });
  });

  it("keeps the panel readable when the publication cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse(
          { error: { code: "NOT_FOUND", message: "Not found.", correlationId: "trace-9" } },
          404,
        ),
      ),
    );
    renderWorkspace();

    expect(await screen.findByRole("alert")).toHaveTextContent("Reference: trace-9");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});

describe("Publishing route", () => {
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

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("resolves the sidebar Publishing item to a real route with exactly one h1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/session")) return jsonResponse(organizerSession);
        if (url.endsWith("/api/events/assigned")) return jsonResponse({ events: [event] });
        if (url.endsWith("/preview")) return jsonResponse(publication());
        // Every other workspace fetch is irrelevant here; the surfaces render their
        // own failure states rather than rejecting.
        return jsonResponse({});
      }),
    );
    render(<App />);

    const navItem = await screen.findByRole("link", { name: /Publishing/ });
    fireEvent.click(navItem);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Publishing" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(window.location.pathname).toBe("/publishing");
    expect(
      await screen.findByRole("link", { name: `${origin}/events/${slug}` }),
    ).toBeInTheDocument();
  });
});
