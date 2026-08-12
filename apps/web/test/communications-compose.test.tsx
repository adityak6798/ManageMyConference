// @acceptance ACC-INTEGRATION
/*
 * Composing and sending from the console.
 *
 * The point of these tests is that an organizer can produce a delivery without hand-crafting a
 * POST: the template is written here, the recipient count comes from the server rather than from
 * a number typed into the form, and the confirmation says how many people are about to be
 * mailed.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";

const session = {
  actor: { id: "seed-organizer", name: "Olivia Organizer", persona: "organizer" },
  organizations: [{ id: organizationId }],
  eventAccess: [{ eventId, role: "organizer", capabilities: ["events:read"] }],
  capabilities: ["events:read", "communications:manage"],
};

const events = [
  {
    id: eventId,
    organizationId,
    name: "Summit",
    timezone: "UTC",
    createdAt: "2026-08-10T12:00:00.000Z",
  },
];

const template = {
  id: "template-1",
  organizationId,
  key: "speaker-welcome",
  version: 1,
  channel: "email" as const,
  subject: "You're speaking at Summit",
  body: "Hi {{speakerName}}, your session is confirmed.",
  createdAt: "2026-08-10T12:00:00.000Z",
};

const recipients = [
  { userId: "user-ada", name: "Ada Lovelace", address: "ada@example.test" },
  { userId: "user-grace", name: "Grace Hopper", address: "grace@example.test" },
  { userId: "user-alan", name: "Alan Turing", address: null },
];

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

interface HarnessOptions {
  templates?: (typeof template)[];
  sendFails?: { message: string; correlationId: string } | undefined;
}

function harness({ templates = [template], sendFails }: HarnessOptions = {}) {
  const sends: unknown[] = [];
  const created: unknown[] = [];
  let history: unknown[] = [];
  let stored = [...templates];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/session")) return json(session);
    if (url.endsWith("/api/events/assigned")) return json({ events });
    if (url.includes("/api/communications/templates") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      created.push(body);
      stored = [...stored, { ...template, ...body, id: `template-${stored.length + 1}` }];
      return json({ template: stored.at(-1) }, 201);
    }
    if (url.includes("/api/communications/templates")) return json({ templates: stored });
    if (url.includes("/api/communications/recipients")) return json({ recipients });
    if (url.includes("/api/communications/broadcasts")) {
      if (sendFails) return json({ error: { code: "VALIDATION_FAILED", ...sendFails } }, 400);
      sends.push(JSON.parse(String(init?.body)));
      history = [
        {
          delivery: {
            id: "delivery-ada",
            organizationId,
            eventId,
            idempotencyKey: "broadcast:speaker-welcome:v1:e:ada",
            triggerType: "speaker.invited",
            channel: "email",
            templateId: "template-1",
            templateVersion: 1,
            recipientRef: "ada@example.test",
            payload: { speakerName: "Ada Lovelace" },
            renderedSubject: "You're speaking at Summit",
            renderedBody: "Hi Ada Lovelace, your session is confirmed.",
            projectionVersion: null,
            state: "succeeded",
            attemptCount: 1,
            nextAttemptAt: "2026-08-10T12:00:00.000Z",
            leaseToken: null,
            createdAt: "2026-08-10T12:00:00.000Z",
            updatedAt: "2026-08-10T12:00:01.000Z",
          },
          attempts: [
            {
              id: "attempt-1",
              deliveryId: "delivery-ada",
              sequence: 1,
              startedAt: "2026-08-10T12:00:00.000Z",
              completedAt: "2026-08-10T12:00:01.000Z",
              outcome: "succeeded",
              providerReference: "fake:email:delivery-ada",
              errorCode: null,
            },
          ],
        },
      ];
      return json(
        {
          enqueued: sends.length > 1 ? 0 : 2,
          alreadySent: sends.length > 1 ? 2 : 0,
          unreachable: [recipients[2]],
          deliveries: [],
        },
        202,
      );
    }
    if (url.includes("/api/communications/history")) return json({ history, nextCursor: null });
    return json({ error: { code: "NOT_FOUND", message: "no fixture", correlationId: "x" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sends, created };
}

describe("sending a message to speakers from the console", () => {
  beforeEach(() => window.history.replaceState(null, "", "/communications"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("counts the reachable speakers and confirms before sending to them", async () => {
    const { sends } = harness();
    render(<App />);

    // The count is the server's answer, not a number typed into this form.
    expect(await screen.findByText("2 of 3 speakers can be reached by email")).toBeInTheDocument();
    // And the speaker who cannot be reached is named rather than quietly dropped.
    expect(
      screen.getByText(/Alan Turing has no email address on their identity/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send to 2 speakers" }));

    // Nothing has been sent yet: the confirmation names the template version and the count.
    expect(sends).toHaveLength(0);
    const confirmation = screen.getByRole("group", { name: "Confirm send" });
    expect(confirmation).toHaveTextContent("speaker-welcome");
    expect(confirmation).toHaveTextContent("2 speakers");

    fireEvent.click(within(confirmation).getByRole("button", { name: /^Yes, send/ }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
      templateVersion: 1,
    });
  });

  it("reports what was queued and who was left out, and shows the new delivery", async () => {
    harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, send/ }));

    const compose = screen.getByRole("region", { name: "Send to speakers" });
    await waitFor(() =>
      expect(within(compose).getByRole("status")).toHaveTextContent(
        "Queued 2 deliveries for speaker-welcome version 1. The outbox sends them on its next run. 1 speaker had no address and was not sent to.",
      ),
    );
    // The outbox beside it re-reads, so the delivery the organizer just created is on screen
    // rather than waiting for a manual refresh.
    expect(await screen.findByText("ada@example.test")).toBeInTheDocument();
  });

  it("shows the message a speaker actually received, not just the template it came from", async () => {
    harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, send/ }));
    await screen.findByText("ada@example.test");

    fireEvent.click(
      await screen.findByRole("button", { name: /attempt history for ada@example.test/ }),
    );

    const message = screen.getByRole("article", { name: "Message sent to ada@example.test" });
    expect(message).toHaveTextContent("Hi Ada Lovelace, your session is confirmed.");
    // The placeholder was substituted: the row holds the text, not the instructions for it.
    expect(message).not.toHaveTextContent("{{speakerName}}");
  });

  it("publishes the next version of a template rather than editing the one already sent", async () => {
    const { created } = harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));

    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "speaker-welcome" },
    });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Correction" } });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Sorry {{speakerName}}, the previous note was wrong." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save template version" }));

    await waitFor(() => expect(created).toHaveLength(1));
    // Version 2 of the same key: the message that already went out stays readable.
    expect(created[0]).toMatchObject({ key: "speaker-welcome", version: 2, channel: "email" });
    const compose = screen.getByRole("region", { name: "Send to speakers" });
    await waitFor(() =>
      expect(within(compose).getByRole("status")).toHaveTextContent(
        "Saved speaker-welcome version 2. Earlier versions stay readable.",
      ),
    );
  });

  it("puts a refused send next to the control that asked for it", async () => {
    harness({
      sendFails: {
        message: "Template placeholder {{eventName}} has no value in the delivery payload.",
        correlationId: "send-trace",
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, send/ }));

    // The placeholder that could not be filled is named, so the organizer can fix the template
    // rather than guess why nothing sent.
    expect(await screen.findByRole("alert")).toHaveTextContent("{{eventName}}");
    expect(screen.getByRole("alert")).toHaveTextContent("send-trace");
  });

  it("says nothing was sent when every speaker already has this version", async () => {
    harness();
    render(<App />);
    // First send queues; the second writes nothing because the idempotency key is the same.
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, send/ }));
    const compose = screen.getByRole("region", { name: "Send to speakers" });
    await waitFor(() => expect(within(compose).getByRole("status")).toHaveTextContent("Queued 2"));

    fireEvent.click(screen.getByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, send/ }));

    // Not "Queued 2 deliveries". Nothing was written and nothing will be sent; saying otherwise
    // promises mail that never goes, to an organizer who pressed Send because they were unsure.
    await waitFor(() =>
      expect(within(compose).getByRole("status")).toHaveTextContent(
        "Nothing new to send: every reachable speaker already has speaker-welcome version 1. Save a new version to send a correction.",
      ),
    );
  });

  it("explains a failed read in place of the controls it could not populate", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return json(session);
      if (url.endsWith("/api/events/assigned")) return json({ events });
      if (url.includes("/api/communications/history"))
        return json({ history: [], nextCursor: null });
      if (url.includes("/api/communications/recipients"))
        return json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Recipients could not be read.",
              correlationId: "recipients-trace",
            },
          },
          500,
        );
      if (url.includes("/api/communications/templates")) return json({ templates: [] });
      return json({ error: { code: "NOT_FOUND", message: "no", correlationId: "x" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    // Sending without knowing the recipients is impossible, so the panel says why rather than
    // offering a Send button that cannot mean anything.
    const compose = await screen.findByRole("region", { name: "Send to speakers" });
    expect(await within(compose).findByRole("alert")).toHaveTextContent("recipients-trace");
    expect(within(compose).queryByRole("button", { name: /^Send to/ })).toBeNull();
    expect(within(compose).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("offers no send at all when no speaker can be reached", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return json(session);
      if (url.endsWith("/api/events/assigned")) return json({ events });
      if (url.includes("/api/communications/templates")) return json({ templates: [template] });
      if (url.includes("/api/communications/recipients"))
        return json({ recipients: [{ userId: "u", name: "Alan Turing", address: null }] });
      if (url.includes("/api/communications/history"))
        return json({ history: [], nextCursor: null });
      return json({ error: { code: "NOT_FOUND", message: "no", correlationId: "x" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const send = await screen.findByRole("button", {
      name: "No speaker can be reached by email",
    });
    expect(send).toBeDisabled();
  });
});
