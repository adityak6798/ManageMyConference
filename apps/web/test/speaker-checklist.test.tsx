// @acceptance ACC-SPEAKER
/*
 * The speaker checklist's console surface (issue #176).
 *
 * `speaker_task_templates` shipped with commands, routes, contracts, a seed and a template slice
 * that clones it, and no way for anybody using the product to create one. What is asserted here
 * is the part a screenshot cannot hold anybody to: that declaring a line is not assigning it,
 * that the surface renders the checklist the *server* answered with rather than one it derived
 * from the row it just edited, and that an empty checklist tells an organizer what to do rather
 * than looking like something that failed to load.
 */
import type { ContentWorkspaceDto, SpeakerTaskTemplateDto } from "@greenroom/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecklistEditor, dueOffsetLabel } from "../src/content/ChecklistEditor";

const eventId = "123e4567-e89b-12d3-a456-426614174000";
const profileId = "223e4567-e89b-42d3-a456-426614174001";
const lineId = "323e4567-e89b-42d3-a456-426614174002";

const line = (overrides: Partial<SpeakerTaskTemplateDto> = {}): SpeakerTaskTemplateDto => ({
  id: lineId,
  eventId,
  title: "Upload a headshot",
  description: "A square image, at least 800px.",
  sortOrder: 0,
  dueOffsetDays: -14,
  createdAt: "2026-08-10T12:00:00.000Z",
  ...overrides,
});

const workspace = (): ContentWorkspaceDto => ({
  sessions: [],
  speakers: [
    {
      id: profileId,
      eventId,
      userId: "user-1",
      sourcePersonId: "crm-email:ada@example.test",
      name: "Ada Speaker",
      email: "ada@example.test",
      bio: "",
      pronouns: "",
      jobTitle: "",
      organization: "",
      version: 0,
      workflowStatus: "onboarding",
      logistics: {},
      customFields: {},
    },
  ],
  tasks: [],
  assets: [],
  messages: [],
  resources: [],
  comments: [],
  revisions: [],
  actorDirectory: [],
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

/** `run` as the workspace supplies it: awaits, and reports only success or failure. */
const run = async (action: () => Promise<unknown>) => {
  try {
    await action();
    return { ok: true as const };
  } catch (error) {
    // ERROR-INTENT: mirrors the workspace's own runner, which converts a rejection into a
    // reported failure rather than letting it escape a click handler.
    return { ok: false as const, error };
  }
};

/**
 * Every checklist route, with what each write answers with under the test's control.
 *
 * The write responses matter as much as the reads: each one answers with the *whole* checklist,
 * and the surface is required to render that rather than to patch its own copy.
 */
function stubChecklist(
  options: {
    initial?: readonly SpeakerTaskTemplateDto[];
    onWrite?: (
      url: string,
      init: RequestInit | undefined,
    ) => { body: unknown; status?: number } | undefined;
  } = {},
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const written =
      init?.method && init.method !== "GET" ? options.onWrite?.(url, init) : undefined;
    if (written) return json(written.body, written.status ?? 200);
    if (init?.method && init.method !== "GET") return json({ templates: options.initial ?? [] });
    return json({ templates: options.initial ?? [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const mount = () =>
  render(<ChecklistEditor eventId={eventId} workspace={workspace()} busy={false} run={run} />);

const bodyOf = (fetchMock: ReturnType<typeof stubChecklist>, predicate: (url: string) => boolean) =>
  JSON.parse(
    String(
      fetchMock.mock.calls.find(([input, init]) => predicate(String(input)) && init?.body)?.[1]
        ?.body ?? "null",
    ),
  );

describe("speaker checklist authoring", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says a signed day count in the words somebody would use for it", () => {
    // "-14" is not a sentence. The column stores a distance because an event carries no dates of
    // its own, and this is the difference between reading it and decoding it.
    expect(dueOffsetLabel(-14)).toBe("14 days before");
    expect(dueOffsetLabel(1)).toBe("1 day after");
    expect(dueOffsetLabel(0)).toBe("On the anchor date");
  });

  it("teaches rather than reporting a failure when nothing is declared yet", async () => {
    stubChecklist();
    mount();

    // A new event has no checklist because nobody has written one, which is the normal state —
    // so the empty state says what a checklist is for and where the first line comes from.
    expect(await screen.findByText("No checklist yet")).toBeInTheDocument();
    expect(screen.getByText(/every speaker at this event is asked for/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New checklist line" })).toBeEnabled();
  });

  it("adds a line and renders the checklist the server answered with", async () => {
    const added = line({ title: "Send your slides", dueOffsetDays: -7 });
    const fetchMock = stubChecklist({
      // Deliberately *not* the line the form submitted: the surface has to render the server's
      // answer, because a reorder moves lines the request never named.
      onWrite: () => ({ body: { templates: [line(), added] }, status: 201 }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New checklist line" }));
    fireEvent.change(screen.getByLabelText(/What the speaker is asked for/), {
      target: { value: "Send your slides" },
    });
    fireEvent.change(screen.getByLabelText(/^Due/), { target: { value: "-7" } });
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));

    // Both lines, in the order the server gave them — including the one this request never
    // mentioned, which is the half a client patching its own copy would have lost.
    await waitFor(() =>
      expect(
        screen.getAllByRole("listitem").map((item) => item.textContent?.split("A square")[0]),
      ).toEqual(["Upload a headshot", "Send your slides"]),
    );
    expect(
      bodyOf(fetchMock, (url) => url.endsWith("/speaker-task-template-entries")),
    ).toMatchObject({ title: "Send your slides", dueOffsetDays: -7 });
  });

  it("renames a line through the route that can, and says so where it is typed", async () => {
    const fetchMock = stubChecklist({
      initial: [line()],
      onWrite: () => ({ body: { templates: [line({ title: "Upload a portrait" })] } }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Edit Upload a headshot/ }));
    /*
     * The title is the line's identity for a clone and for work already assigned, and neither
     * fact is guessable — so the form says it beside the box rather than in a doc nobody opens.
     */
    expect(
      screen.getByText(/cloning this event's checklist elsewhere matches on the title/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/What the speaker is asked for/), {
      target: { value: "Upload a portrait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save line" }));

    await waitFor(() =>
      expect(screen.getByRole("listitem").textContent).toContain("Upload a portrait"),
    );
    const patched = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    // Addressed by row: the bulk declaration writes at `(event_id, title)`, so through it the
    // corrected title would create a second line and leave the mistyped one behind for ever.
    expect(String(patched?.[0])).toContain(`/api/speaker-task-templates/${lineId}`);
  });

  it("says what a removal does not touch", async () => {
    stubChecklist({ initial: [line()], onWrite: () => ({ body: { templates: [] } }) });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Remove Upload a headshot/ }));

    // Work already assigned from a line is that speaker's, and stays. An organizer deciding
    // whether to remove a line needs to know that before they press it, not after.
    expect(
      await screen.findByText(/Tasks already assigned from it are untouched/),
    ).toBeInTheDocument();
  });

  it("keeps declaring separate from assigning, and says how many people it wrote to", async () => {
    const fetchMock = stubChecklist({
      initial: [line()],
      onWrite: (url) =>
        url.endsWith("/speaker-checklist-assignments")
          ? {
              body: {
                tasks: [
                  {
                    id: "423e4567-e89b-42d3-a456-426614174003",
                    eventId,
                    speakerProfileId: profileId,
                    title: "Upload a headshot",
                    dueAt: "2026-09-01T00:00:00.000Z",
                    status: "open",
                  },
                ],
              },
              status: 201,
            }
          : undefined,
    });
    mount();
    await screen.findByRole("listitem");

    // Nobody selected, so there is nobody to write to and the control says so by being inert.
    expect(screen.getByRole("button", { name: /Assign 1 line to 0 speakers/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: profileId } });
    fireEvent.click(screen.getByRole("button", { name: /Assign 1 line to 1 speaker/ }));

    expect(await screen.findByText(/1 task assigned across 1 speaker/)).toBeInTheDocument();
    expect(bodyOf(fetchMock, (url) => url.endsWith("/speaker-checklist-assignments"))).toEqual({
      profileIds: [profileId],
    });
  });

  it("reports nothing assigned as the correct answer it is", async () => {
    stubChecklist({
      initial: [line()],
      onWrite: (url) =>
        url.endsWith("/speaker-checklist-assignments")
          ? { body: { tasks: [] }, status: 201 }
          : undefined,
    });
    mount();
    await screen.findByRole("listitem");
    fireEvent.change(screen.getByLabelText("Assign to"), { target: { value: profileId } });
    fireEvent.click(screen.getByRole("button", { name: /Assign 1 line to 1 speaker/ }));

    // Idempotent per speaker and line: an empty result means everybody already has everything,
    // which is not a failure and must not read as work that quietly vanished.
    expect(await screen.findByText(/already has every line/)).toBeInTheDocument();
  });

  it("says a checklist it could not read is unread, not empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "The speaker checklist could not be read.",
              correlationId: "abc-123",
            },
          },
          500,
        ),
      ),
    );
    mount();

    // An empty list and a list that could not be read look identical, and only one of them
    // means "declare a line". The correlation id travels with the refusal.
    await waitFor(() => expect(screen.getByText(/abc-123/)).toBeInTheDocument());
    expect(screen.queryByText("No checklist yet")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
