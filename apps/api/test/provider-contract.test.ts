// @acceptance ACC-INTEGRATION
// @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS PRD-INT-001
//
// One suite, run against every live adapter, because the outbox's guarantees only hold if all of
// them normalize the same way: a throttled provider must be retryable everywhere, a rejected
// request terminal everywhere, and a 2xx nobody can parse must never look like a success.
//
// These tests exercise our normalization against a stubbed `fetch`. They say nothing about
// whether the request shape matches what a live API wants — no credential for any of these three
// exists in this repository, and none was used to write the adapters. That verification is the
// staging smoke documented in docs/engineering/communications-providers.md, and it has not run.
import { describe, expect, it } from "vitest";
import { AccelEventsProjectionProvider } from "../src/adapters/providers/accelevents-provider";
import { HttpAccelEventsRegistrations } from "../src/adapters/providers/accelevents-registration";
import { AirtableProjectionProvider } from "../src/adapters/providers/airtable-provider";
import { HttpEmailProvider } from "../src/adapters/providers/email-provider";
import type { DeliveryProvider } from "../src/application/communications/ports";
import type { Delivery } from "../src/domain/communications/delivery";

const TOKEN = "super-secret-token-value";
/** The one Greenroom event this deployment's Accelevents binding is mapped to. */
const GREENROOM_EVENT = "00000000-0000-4000-8000-000000000001";

const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  id: "delivery-1",
  organizationId: "org-1",
  eventId: "event-1",
  idempotencyKey: "speaker-welcome:event-1:profile-1",
  triggerType: "speaker.invited",
  channel: "email",
  templateId: "template-1",
  templateVersion: 1,
  recipientRef: "ada@example.test",
  recipientTrust: "account" as const,
  payload: { speakerName: "Ada" },
  renderedSubject: "You're speaking",
  renderedBody: "Hello Ada",
  projectionVersion: null,
  state: "queued",
  attemptCount: 0,
  nextAttemptAt: "2026-08-10T12:00:00.000Z",
  leaseToken: "lease-1",
  createdAt: "2026-08-10T12:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
  ...overrides,
});

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A `fetch` that records the request and answers with a canned status and body. */
const stub = (status: number, body: unknown, recorded: Recorded[] = []) => {
  const fetch = async (url: string, init: RequestInit) => {
    recorded.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, recorded };
};

const failing = (reason: Error) => async () => {
  throw reason;
};

interface AdapterCase {
  readonly name: string;
  readonly build: (
    fetch: (url: string, init: RequestInit) => Promise<Response>,
  ) => DeliveryProvider;
  /** A 2xx body this adapter accepts, and the reference it should derive from it. */
  readonly successBody: unknown;
  readonly successReference: string;
  readonly projection: boolean;
}

const ADAPTERS: readonly AdapterCase[] = [
  {
    name: "email",
    build: (fetch) =>
      new HttpEmailProvider(
        { endpoint: "https://mail.test/send", token: TOKEN, sender: "events@greenroom.test" },
        fetch,
      ),
    successBody: { id: "msg-77" },
    successReference: "email:msg-77",
    projection: false,
  },
  {
    name: "airtable",
    build: (fetch) =>
      new AirtableProjectionProvider(
        { baseId: "app123", tableId: "tbl456", token: TOKEN, apiOrigin: "https://airtable.test" },
        fetch,
      ),
    successBody: { records: [{ id: "rec-88" }] },
    successReference: "airtable:rec-88",
    projection: true,
  },
  {
    name: "accelevents",
    build: (fetch) =>
      new AccelEventsProjectionProvider(
        { endpoint: "https://accelevents.test/projections", token: TOKEN },
        fetch,
      ),
    successBody: { id: "ae-99" },
    successReference: "accelevents:ae-99",
    projection: true,
  },
];

const subject = (adapter: AdapterCase) =>
  adapter.projection
    ? delivery({ channel: "airtable", projectionVersion: 3, recipientRef: "session:99" })
    : delivery();

describe.each(ADAPTERS)("$name provider contract", (adapter) => {
  it("reports a provider reference on success", async () => {
    const { fetch } = stub(200, adapter.successBody);

    const result = await adapter.build(fetch).deliver(subject(adapter));

    expect(result).toEqual({ kind: "success", providerReference: adapter.successReference });
  });

  it.each([
    [408, "PROVIDER_TIMEOUT"],
    [429, "PROVIDER_RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE:503"],
  ])("treats %i as a bounded retry", async (status, code) => {
    const { fetch } = stub(status, { error: "slow down" });

    const result = await adapter.build(fetch).deliver(subject(adapter));

    expect(result).toEqual({ kind: "retryable", code });
  });

  it("retries when the request never reached the provider", async () => {
    const result = await adapter
      .build(failing(new Error("connect ETIMEDOUT 10.0.0.7:443")))
      .deliver(subject(adapter));

    expect(result).toEqual({ kind: "retryable", code: "PROVIDER_UNREACHABLE" });
  });

  it.each([
    [422, "PROVIDER_REJECTED:422"],
    [401, "PROVIDER_UNAUTHORIZED:401"],
  ])("makes %i terminal rather than retrying a refusal", async (status, code) => {
    const { fetch } = stub(status, { error: "no" });

    const result = await adapter.build(fetch).deliver(subject(adapter));

    expect(result).toEqual({ kind: "terminal", code });
  });

  it("makes an unparsable success terminal instead of claiming it worked", async () => {
    const { fetch } = stub(200, "<html>maintenance</html>");

    const result = await adapter.build(fetch).deliver(subject(adapter));

    expect(result).toEqual({ kind: "terminal", code: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("makes a 2xx with no provider reference terminal", async () => {
    const { fetch } = stub(200, { ok: true });

    const result = await adapter.build(fetch).deliver(subject(adapter));

    expect(result).toEqual({ kind: "terminal", code: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("authorizes with the provider's documented credential header and never returns it", async () => {
    const { fetch, recorded } = stub(401, { error: TOKEN });

    const result = await adapter.build(fetch).deliver(subject(adapter));

    const headers = recorded[0]?.init.headers as Record<string, string>;
    if (adapter.name === "accelevents") {
      expect(headers.AUTHENTICATION).toBe(TOKEN);
      expect(headers.authorization).toBeUndefined();
    } else expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The provider echoed the credential back in its error body. Nothing from a response body
    // reaches a normalized code, which is what keeps it out of the stored attempt and the
    // organizer's history.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("provider request shapes", () => {
  it("sends the rendered message to the resolved address under an idempotency key", async () => {
    const { fetch, recorded } = stub(200, { id: "msg-1" });

    await new HttpEmailProvider(
      { endpoint: "https://mail.test/send", token: TOKEN, sender: "events@greenroom.test" },
      fetch,
    ).deliver(delivery({ recipientRef: "mailto:ada@example.test" }));

    const request = recorded[0];
    if (!request) throw new Error("the adapter made no request");
    expect(request.init.method).toBe("POST");
    expect(request.url).toBe("https://mail.test/send");
    expect((request.init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "speaker-welcome:event-1:profile-1",
    );
    expect(JSON.parse(String(request.init.body))).toEqual({
      from: "events@greenroom.test",
      to: "ada@example.test",
      subject: "You're speaking",
      text: "Hello Ada",
    });
  });

  it("refuses a recipient reference no mail server could accept, without calling out", async () => {
    const { fetch, recorded } = stub(200, { id: "msg-1" });

    const result = await new HttpEmailProvider(
      { endpoint: "https://mail.test/send", token: TOKEN, sender: "events@greenroom.test" },
      fetch,
    ).deliver(delivery({ recipientRef: "speaker:queued" }));

    expect(result).toEqual({ kind: "terminal", code: "RECIPIENT_NOT_ADDRESSABLE" });
    expect(recorded).toHaveLength(0);
  });

  it("refuses to send a delivery that carries no rendered message", async () => {
    const { fetch, recorded } = stub(200, { id: "msg-1" });

    const result = await new HttpEmailProvider(
      { endpoint: "https://mail.test/send", token: TOKEN, sender: "events@greenroom.test" },
      fetch,
    ).deliver(delivery({ renderedBody: null, renderedSubject: null }));

    expect(result).toEqual({ kind: "terminal", code: "MESSAGE_NOT_RENDERED" });
    expect(recorded).toHaveLength(0);
  });

  it("upserts Airtable on the Greenroom reference so a repeated projection converges", async () => {
    const { fetch, recorded } = stub(200, { records: [{ id: "rec-1" }] });

    await new AirtableProjectionProvider(
      { baseId: "app 1", tableId: "tbl/2", token: TOKEN, apiOrigin: "https://airtable.test" },
      fetch,
    ).deliver(
      delivery({
        channel: "airtable",
        recipientRef: "session:99",
        recipientTrust: "account" as const,
        projectionVersion: 4,
        payload: { Title: "Opening Keynote", Tracks: ["Platform"] },
      }),
    );

    const [request] = recorded;
    expect(request?.init.method).toBe("PATCH");
    // Identifiers are path segments, so they are encoded rather than interpolated raw.
    expect(request?.url).toBe("https://airtable.test/v0/app%201/tbl%2F2");
    expect(JSON.parse(String(request?.init.body))).toEqual({
      performUpsert: { fieldsToMergeOn: ["Greenroom Ref"] },
      records: [
        {
          fields: {
            "Greenroom Ref": "session:99",
            "Greenroom Version": 4,
            Title: "Opening Keynote",
            // A cell holds a scalar, so a list is serialized rather than silently dropped.
            Tracks: '["Platform"]',
          },
        },
      ],
    });
  });

  it("does not let a projection payload choose which Airtable record it overwrites", async () => {
    const { fetch, recorded } = stub(200, { records: [{ id: "rec-1" }] });

    await new AirtableProjectionProvider(
      { baseId: "app1", tableId: "tbl1", token: TOKEN, apiOrigin: "https://airtable.test" },
      fetch,
    ).deliver(
      delivery({
        channel: "airtable",
        recipientRef: "session:99",
        recipientTrust: "account" as const,
        projectionVersion: 4,
        // A payload carrying the merge column. Airtable matches `fieldsToMergeOn` against the
        // value in the submitted record, so if this won, this projection would upsert over a
        // different session's row — and an Airtable write cannot be un-sent.
        payload: { "Greenroom Ref": "session:1", "Greenroom Version": 999, Title: "Keynote" },
      }),
    );

    const fields = JSON.parse(String(recorded[0]?.init.body)).records[0].fields;
    expect(fields["Greenroom Ref"]).toBe("session:99");
    expect(fields["Greenroom Version"]).toBe(4);
    expect(fields.Title).toBe("Keynote");
  });

  it("sends the Accelevents projection with its version and external reference", async () => {
    const { fetch, recorded } = stub(200, { id: "ae-1" });

    await new AccelEventsProjectionProvider(
      { endpoint: "https://accelevents.test/projections", token: TOKEN },
      fetch,
    ).deliver(
      delivery({ channel: "accelevents", recipientRef: "session:99", projectionVersion: 2 }),
    );

    const [request] = recorded;
    expect(request?.init.method).toBe("POST");
    expect(JSON.parse(String(request?.init.body))).toMatchObject({
      externalRef: "session:99",
      version: 2,
      eventRef: "event-1",
    });
  });

  /*
   * The calendar part, which is what makes an email an invitation.
   *
   * A mail client shows Accept/Decline for a `text/calendar; method=REQUEST` part and not for a
   * link or a plain attachment, so the adapter has to carry the method through to the provider.
   */
  const email = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
    new HttpEmailProvider(
      { endpoint: "https://mail.test/send", token: TOKEN, sender: "events@greenroom.test" },
      fetch,
    );
  const invite = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n";

  it("sends an invitation as a calendar part carrying its method", async () => {
    const { fetch, recorded } = stub(200, { id: "msg-1" });

    const result = await email(fetch).deliver(
      delivery({
        triggerType: "speaker.calendar_invite",
        payload: {
          speakerName: "Ada",
          calendarInvite: { method: "REQUEST", filename: "invite.ics", content: invite },
        },
      }),
    );

    expect(result).toEqual({ kind: "success", providerReference: "email:msg-1" });
    expect(JSON.parse(String(recorded[0]?.init.body))).toMatchObject({
      to: "ada@example.test",
      subject: "You're speaking",
      text: "Hello Ada",
      calendar: { method: "REQUEST", filename: "invite.ics", content: invite },
    });
  });

  it("sends an ordinary email exactly as it did before invitations existed", async () => {
    const withoutInvite = stub(200, { id: "msg-2" });
    await email(withoutInvite.fetch).deliver(delivery());
    const body = JSON.parse(String(withoutInvite.recorded[0]?.init.body));

    // Absent, not null: an existing delivery's request is unchanged by this feature, which is the
    // property that lets the field be added without touching any other trigger's behaviour.
    expect("calendar" in body).toBe(false);
    expect(body).toEqual({
      from: "events@greenroom.test",
      to: "ada@example.test",
      subject: "You're speaking",
      text: "Hello Ada",
    });
  });

  /*
   * The inbound registration client (#58). Same normalization table as the delivery adapters,
   * because an operator reading a failed sync should be reading the same vocabulary.
   */
  const registrations = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
    new HttpAccelEventsRegistrations(
      {
        apiOrigin: "https://accelevents.test/api",
        token: TOKEN,
        eventRef: "ae-event-1",
        boundEventId: GREENROOM_EVENT,
      },
      fetch,
    );

  it("reads registrants and never puts its credential in the URL", async () => {
    const { fetch, recorded } = stub(200, {
      attendees: [
        {
          attendeeId: "ae-1",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.test",
          ticketType: "Speaker",
          barcode: "one",
        },
        {
          attendeeId: "ae-2",
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace@example.test",
          barcode: "two",
        },
      ],
      recordsFiltered: 2,
      recordsTotal: 2,
    });

    expect(await registrations(fetch).listRegistrants(GREENROOM_EVENT)).toEqual([
      { sourceRef: "ae-1", name: "Ada Lovelace", email: "ada@example.test", ticketType: "Speaker" },
      { sourceRef: "ae-2", name: "Grace Hopper", email: "grace@example.test" },
    ]);
    expect(recorded[0]?.url).toBe(
      "https://accelevents.test/api/rest/events/ae-event-1/staff/allAttendees?page=0&size=100&dataType=TICKET",
    );
    expect(recorded[0]?.url).not.toContain(TOKEN);
    expect(recorded[0]?.init.method).toBe("GET");
    const headers = recorded[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.AUTHENTICATION).toBe(TOKEN);
    expect(headers?.authorization).toBeUndefined();
  });

  it("refuses to answer an event it is not bound to, rather than serving another one's roster", async () => {
    const { fetch, recorded } = stub(200, {
      attendees: [
        { attendeeId: "ae-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
      ],
      recordsFiltered: 1,
      recordsTotal: 1,
    });

    // One deployment maps one Greenroom event to one Accelevents event. Answering any other event
    // with the configured roster would import a different conference's attendee names and
    // addresses as speaker profiles — reachable by an organizer who is legitimately authorized on
    // *their* event, because the capability check upstream cannot know what the roster contains.
    await expect(
      registrations(fetch).listRegistrants("00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toMatchObject({ code: "ACCELEVENTS_EVENT_NOT_MAPPED" });
    // Refused before the request, so the wrong roster is never even fetched.
    expect(recorded).toHaveLength(0);
  });

  it("drops an incomplete registrant rather than importing a person nobody can reach", async () => {
    const { fetch } = stub(200, {
      attendees: [
        { attendeeId: "ae-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
        { attendeeId: "ae-2", firstName: "No", lastName: "Address" },
        { firstName: "No", lastName: "id", email: "x@example.test" },
        null,
      ],
      recordsFiltered: 4,
      recordsTotal: 4,
    });
    expect(await registrations(fetch).listRegistrants(GREENROOM_EVENT)).toHaveLength(1);
  });

  it("reads every filtered page and stops before the unfiltered attendee total", async () => {
    const recorded: Recorded[] = [];
    const pages = [
      {
        attendees: Array.from({ length: 100 }, (_, index) => ({
          attendeeId: `ae-${index}`,
          firstName: "Ada",
          lastName: String(index),
          email: `ada-${index}@example.test`,
        })),
        recordsFiltered: 101,
        recordsTotal: 500,
      },
      {
        attendees: [
          {
            attendeeId: "ae-100",
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.test",
          },
        ],
        recordsFiltered: 101,
        recordsTotal: 500,
      },
    ];
    const fetch = async (url: string, init: RequestInit) => {
      recorded.push({ url, init });
      return new Response(JSON.stringify(pages[recorded.length - 1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(registrations(fetch).listRegistrants(GREENROOM_EVENT)).resolves.toHaveLength(101);
    expect(recorded.map(({ url }) => new URL(url).searchParams.get("page"))).toEqual(["0", "1"]);
  });

  it("refuses pagination totals that change between pages", async () => {
    let page = 0;
    const fetch = async () => {
      const recordsFiltered = page++ === 0 ? 101 : 102;
      return new Response(
        JSON.stringify({
          attendees: Array.from({ length: 100 }, (_, index) => ({
            attendeeId: `${page}-${index}`,
            firstName: "Ada",
            lastName: String(index),
            email: `${page}-${index}@example.test`,
          })),
          recordsFiltered,
          recordsTotal: 500,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(registrations(fetch).listRegistrants(GREENROOM_EVENT)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
  });

  it("refuses an empty page before the filtered roster is complete", async () => {
    const { fetch } = stub(200, {
      attendees: [],
      recordsFiltered: 1,
      recordsTotal: 1,
    });

    await expect(registrations(fetch).listRegistrants(GREENROOM_EVENT)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
  });

  it("bounds requests when a provider-controlled total cannot be satisfied", async () => {
    let requests = 0;
    const fetch = async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          attendees: [
            {
              attendeeId: `ae-${requests}`,
              firstName: "Ada",
              lastName: String(requests),
              email: `ada-${requests}@example.test`,
            },
          ],
          recordsFiltered: 100_001,
          recordsTotal: 100_001,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(registrations(fetch).listRegistrants(GREENROOM_EVENT)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
    expect(requests).toBe(1_000);
  });

  it("normalizes an unreadable platform without ever storing its message", async () => {
    for (const [status, code] of [
      [429, "PROVIDER_RATE_LIMITED"],
      [503, "PROVIDER_UNAVAILABLE:503"],
      [401, "PROVIDER_UNAUTHORIZED:401"],
    ] as const) {
      // The error body echoes the credential back, the way a careless API does.
      const { fetch } = stub(status, { message: `rejected token ${TOKEN}` });
      await expect(registrations(fetch).listRegistrants(GREENROOM_EVENT)).rejects.toMatchObject({
        code,
      });
      await expect(registrations(fetch).listRegistrants(GREENROOM_EVENT)).rejects.not.toMatchObject(
        {
          message: expect.stringContaining(TOKEN),
        },
      );
    }
    // A 2xx that is not the documented shape is malformed, not an empty roster: reporting "0
    // registrants" for an unparsable answer would look like a successful, empty sync.
    const unparsable = stub(200, { items: [] });
    await expect(
      registrations(unparsable.fetch).listRegistrants(GREENROOM_EVENT),
    ).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_RESPONSE",
    });
    await expect(
      registrations(failing(new Error("dns"))).listRegistrants(GREENROOM_EVENT),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
    });
  });

  it("refuses a malformed invitation rather than sending the covering note alone", async () => {
    // A speaker who receives "here is your invitation" and no invitation has been told a meeting
    // exists and given no way to accept it. No retry can repair a payload already stored.
    for (const calendarInvite of [
      { method: "REQUEST" },
      { method: "SHOUT", content: invite },
      { content: invite },
      "not an object",
    ]) {
      const { fetch, recorded } = stub(200, { id: "msg-3" });
      expect(await email(fetch).deliver(delivery({ payload: { calendarInvite } }))).toEqual({
        kind: "terminal",
        code: "CALENDAR_INVITE_MALFORMED",
      });
      expect(recorded).toHaveLength(0);
    }
  });
});
