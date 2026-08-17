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

/** The server's name for the audience above; the panel sends it back with a broadcast. */
const audience = "3-fixture";

const reachable = recipients.filter((recipient) => recipient.address !== null);

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/**
 * The substitution the server does, done here too.
 *
 * The fixture renders rather than echoing the template because the preview's whole claim is that
 * what the organizer approves is the message: a stub that returned `{{speakerName}}` unresolved
 * would let a panel that previewed the instructions instead of the mail keep passing.
 */
const renderBody = (body: string, name: string) => body.replaceAll("{{speakerName}}", name);

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
      // The server allocates the version, so the fixture does too: the panel names none, and
      // what comes back is the number storage chose. A stub that echoed a version the panel
      // sent would have kept passing after allocation moved to the server.
      const version =
        Math.max(
          0,
          ...stored.filter((held) => held.key === body.key).map((held) => held.version as number),
        ) + 1;
      stored = [...stored, { ...template, ...body, version, id: `template-${stored.length + 1}` }];
      return json({ template: stored.at(-1) }, 201);
    }
    if (url.includes("/api/communications/templates")) return json({ templates: stored });
    if (url.includes("/api/communications/recipients"))
      return json({ recipients, audienceVersion: audience });
    if (url.includes("/api/communications/merge-fields"))
      return json({ fields: [{ token: "speakerName", describes: "The speaker's own name" }] });
    /*
     * The preview the Send control asks for before it offers a confirmation.
     *
     * Answered before the send branch below, which it would otherwise match: the preview's path
     * extends the broadcast's, so a fixture that tested the shorter one first would count every
     * preview as a send and report a delivery nobody confirmed.
     */
    if (url.includes("/api/communications/broadcasts/preview")) {
      const body = JSON.parse(String(init?.body));
      const held =
        stored.find(
          (candidate) =>
            candidate.key === body.templateKey && candidate.version === body.templateVersion,
        ) ?? template;
      const chosen = body.recipientIds
        ? reachable.filter((recipient) => body.recipientIds.includes(recipient.userId))
        : reachable;
      return json({
        entries: chosen.map((recipient) => ({
          userId: recipient.userId,
          name: recipient.name,
          address: recipient.address,
          subject: held.subject,
          body: renderBody(held.body, recipient.name),
        })),
        audienceVersion: audience,
      });
    }
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

    // The confirmation waits on the server rendering each message, so it is not on screen the
    // instant the button is pressed.
    const confirmation = await screen.findByRole("group", { name: "Confirm send" });
    // Nothing has been sent yet: the confirmation names the template version and the count.
    expect(sends).toHaveLength(0);
    // Named the way a speaker sees it, not by the key storage happens to use.
    expect(confirmation).toHaveTextContent("You're speaking at Summit");
    expect(confirmation).toHaveTextContent("2 speakers");
    // And what is being approved is the message rather than the template it came from: the
    // placeholder is already filled in, per recipient, by the code that will send it.
    expect(screen.getByRole("article", { name: "Message for Ada Lovelace" })).toHaveTextContent(
      "Hi Ada Lovelace, your session is confirmed.",
    );

    fireEvent.click(within(confirmation).getByRole("button", { name: /^Yes, send/ }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      organizationId,
      eventId,
      templateKey: "speaker-welcome",
      templateVersion: 1,
      // The audience the confirmation described, carried back so the server can refuse a send
      // whose speakers changed between the count and the click.
      audienceVersion: audience,
    });
  });

  it("reports what was queued and who was left out, and shows the new delivery", async () => {
    harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Yes, send/ }));

    const compose = screen.getByRole("region", { name: "Send to speakers" });
    await waitFor(() =>
      expect(within(compose).getByRole("status")).toHaveTextContent(
        "Queued 2 deliveries for “You're speaking at Summit”. The outbox sends them on its next run. 1 speaker had no address and was not sent to.",
      ),
    );
    // The outbox beside it re-reads, so the delivery the organizer just created is on screen
    // rather than waiting for a manual refresh. Scoped to the outbox because the same address
    // is listed in the audience above, where it names somebody this send *would* reach rather
    // than a delivery it made.
    const outbox = screen.getByRole("region", { name: "Delivery history" });
    expect(await within(outbox).findByText("ada@example.test")).toBeInTheDocument();
  });

  it("shows the message a speaker actually received, not just the template it came from", async () => {
    harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Yes, send/ }));
    // The outbox's copy of the address, not the audience list's, is what says the send landed.
    await within(screen.getByRole("region", { name: "Delivery history" })).findByText(
      "ada@example.test",
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /attempt history for ada@example.test/ }),
    );

    const message = screen.getByRole("article", { name: "Message sent to ada@example.test" });
    expect(message).toHaveTextContent("Hi Ada Lovelace, your session is confirmed.");
    // The placeholder was substituted: the row holds the text, not the instructions for it.
    expect(message).not.toHaveTextContent("{{speakerName}}");
  });

  it("names a new message by its subject, and derives the key writing it no longer asks for", async () => {
    const { created } = harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Write a message" }));

    // Writing an email begins with the sentence a speaker reads, not with a primary key.
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Schedule correction" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Sorry {{speakerName}}, the previous note was wrong." },
    });
    // The key is still real and still what a delivery records, so it is derived and shown.
    expect(screen.getByLabelText<HTMLInputElement>("Template name")).toHaveValue(
      "schedule-correction",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save this message" }));

    await waitFor(() => expect(created).toHaveLength(1));
    // The request names no version at all. The panel used to compute one from the list it last
    // read, which is what made two organizers publishing the same key collide; allocation is
    // the server's, next to the constraint that arbitrates it (issue #52's review follow-up).
    expect(created[0]).toMatchObject({ key: "schedule-correction", channel: "email" });
    expect(created[0]).not.toHaveProperty("version");
    const compose = screen.getByRole("region", { name: "Send to speakers" });
    await waitFor(() =>
      expect(within(compose).getByRole("status")).toHaveTextContent(
        "Saved “Schedule correction” as version 1. Earlier versions stay readable.",
      ),
    );
  });

  it("publishes the next version of a template rather than editing the one already sent", async () => {
    const { created } = harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Write a message" }));

    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Correction" } });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Sorry {{speakerName}}, the previous note was wrong." },
    });
    // Overriding the derived key is how a correction becomes the next version of a message
    // already sent, and the disclosure says so before it is saved.
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "speaker-welcome" },
    });
    expect(screen.getByText(/Saving publishes version 2 of this template/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save this message" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ key: "speaker-welcome", channel: "email" });
    expect(created[0]).not.toHaveProperty("version");
  });

  it("writes a merge token into the message at the caret", async () => {
    harness();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Write a message" }));
    const body = screen.getByLabelText<HTMLTextAreaElement>("Message");
    fireEvent.change(body, { target: { value: "Hi , welcome." } });
    body.setSelectionRange(3, 3);

    // The tokens used to be a list to read and retype, and a token typed one character wrong is
    // a send the renderer refuses rather than a message with a gap in it.
    fireEvent.click(screen.getByRole("button", { name: /Insert speakerName/ }));

    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>("Message")).toHaveValue(
        "Hi {{speakerName}}, welcome.",
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
    fireEvent.click(await screen.findByRole("button", { name: /^Yes, send/ }));

    // The placeholder that could not be filled is named, so the organizer can fix the template
    // rather than guess why nothing sent.
    expect(await screen.findByRole("alert")).toHaveTextContent("{{eventName}}");
    // The reference is its own selectable value rather than a ULID glued to the end of a
    // sentence, so it keeps a copy control of its own.
    expect(screen.getByRole("alert")).toHaveTextContent("send-trace");
    expect(screen.getByRole("button", { name: "Copy the reference" })).toBeInTheDocument();
  });

  it("says nothing was sent when every speaker already has this version", async () => {
    harness();
    render(<App />);
    // First send queues; the second writes nothing because the idempotency key is the same.
    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Yes, send/ }));
    const compose = screen.getByRole("region", { name: "Send to speakers" });
    await waitFor(() => expect(within(compose).getByRole("status")).toHaveTextContent("Queued 2"));

    fireEvent.click(await screen.findByRole("button", { name: "Send to 2 speakers" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Yes, send/ }));

    // Not "Queued 2 deliveries". Nothing was written and nothing will be sent; saying otherwise
    // promises mail that never goes, to an organizer who pressed Send because they were unsure.
    await waitFor(() =>
      expect(within(compose).getByRole("status")).toHaveTextContent(
        "Nothing new to send: every reachable speaker already has version 1 of “You're speaking at Summit”. Save a new version to send a correction.",
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
      // Answered, so the recipients read is the only one that failed and the reference below
      // cannot be whichever of two failures happened to reject first.
      if (url.includes("/api/communications/merge-fields")) return json({ fields: [] });
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
        return json({
          recipients: [{ userId: "u", name: "Alan Turing", address: null }],
          audienceVersion: "1-unreachable",
        });
      if (url.includes("/api/communications/history"))
        return json({ history: [], nextCursor: null });
      if (url.includes("/api/communications/merge-fields")) return json({ fields: [] });
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
