// @acceptance ACC-CFP
/*
 * The HTTP contract of the account-bound proposal routes.
 *
 * These are the assertions that belong at the transport rather than in the service: which status
 * code each refusal is, that authorization happens before an attacker-controlled body is parsed,
 * and that a second submitter's 404 is byte-for-byte the answer an unknown id gets. A service test
 * can prove the rule; only this can prove the answer a client is handed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { CfpService } from "../src/application/cfp/cfp-service";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";
import { submissionThrottle } from "../src/transport/http/throttle";

const eventId = "00000000-0000-4000-8000-000000000001";
const secret = "cfp-submitter-secret";
const unknownProposal = "00000000-0000-4000-8000-0000000000ff";

const fields = [
  { id: "title", type: "short_text", label: "Talk title", required: true },
  { id: "abstract", type: "long_text", label: "Abstract", required: true },
];
const complete = { title: "Reliable submissions", abstract: "How to make retries converge." };

async function setup() {
  let clock = new Date("2026-08-10T12:00:00.000Z");
  let sequence = 0;
  const cfp = new CfpService(
    new MemoryCfpRepository(),
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    () => clock,
  );
  const eventRepository = new MemoryEventRepository();
  await eventRepository.create({
    id: eventId,
    organizationId: "00000000-0000-4000-8000-000000000010",
    name: "Account-bound CFP Event",
    timezone: "America/Los_Angeles",
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  const app = createHttpApp(
    new EventService({
      repository: eventRepository,
      newId: crypto.randomUUID,
      now: () => new Date(),
    }),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    cfp,
  );
  const session = async (persona: "organizer" | "public" | "speaker") => ({
    cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
    "content-type": "application/json",
  });
  const organizer = await session("organizer");
  // `seed-public` and `seed-speaker` hold no capability on this event's settings, which is exactly
  // what a submitter is: an account with no role on the conference.
  const pat = await session("public");
  const sam = await session("speaker");
  const publish = async () => {
    expect(
      (
        await app.request(`/api/events/${eventId}/cfp`, {
          method: "PUT",
          headers: organizer,
          body: JSON.stringify({ title: "Speak", description: "", fields, expectedVersion: 0 }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/events/${eventId}/cfp/state`, {
          method: "POST",
          headers: organizer,
          body: JSON.stringify({ state: "publish" }),
        })
      ).status,
    ).toBe(200);
  };
  return {
    app,
    organizer,
    pat,
    sam,
    publish,
    at: (instant: string) => {
      clock = new Date(instant);
    },
  };
}

const proposals = `/api/events/${eventId}/cfp/proposals`;

describe("the submitter's proposal routes", () => {
  beforeEach(() => submissionThrottle.reset());

  it("refuses every one of them without a session, before reading any body", async () => {
    const { app, publish } = await setup();
    await publish();
    for (const [method, path, body] of [
      ["GET", proposals, undefined],
      ["POST", proposals, { idempotencyKey: "anon-key", answers: complete }],
      ["GET", `${proposals}/${unknownProposal}`, undefined],
      ["PUT", `${proposals}/${unknownProposal}`, { answers: complete, expectedRevision: 1 }],
      [
        "POST",
        `${proposals}/${unknownProposal}/submit`,
        { answers: complete, expectedRevision: 1 },
      ],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect({ path, method, status: response.status }).toEqual({ path, method, status: 401 });
    }
  });

  it("creates, resumes, revises and submits one proposal for its owner", async () => {
    const { app, pat, publish } = await setup();
    await publish();

    const created = await app.request(proposals, {
      method: "POST",
      headers: pat,
      body: JSON.stringify({ idempotencyKey: "pat-draft-1", answers: { title: "Just a title" } }),
    });
    expect(created.status).toBe(201);
    const draft = (await created.json()).proposal as { id: string; revision: number };
    expect(draft).toMatchObject({ lifecycle: "draft", state: "draft", submittedAt: null });

    const listed = await app.request(proposals, { headers: pat });
    expect(listed.status).toBe(200);
    expect((await listed.json()).proposals).toHaveLength(1);

    const revised = await app.request(`${proposals}/${draft.id}`, {
      method: "PUT",
      headers: pat,
      body: JSON.stringify({ answers: complete, expectedRevision: draft.revision }),
    });
    expect(revised.status).toBe(200);
    const afterEdit = (await revised.json()).proposal as { revision: number };
    expect(afterEdit.revision).toBe(draft.revision + 1);

    const submitted = await app.request(`${proposals}/${draft.id}/submit`, {
      method: "POST",
      headers: pat,
      body: JSON.stringify({ answers: complete, expectedRevision: afterEdit.revision }),
    });
    expect(submitted.status).toBe(200);
    await expect(submitted.json()).resolves.toMatchObject({
      proposal: { lifecycle: "submitted", state: "under_consideration" },
    });
  });

  it("answers a second submitter with the same 404 an unknown id gets", async () => {
    const { app, pat, sam, publish } = await setup();
    await publish();
    const created = await app.request(proposals, {
      method: "POST",
      headers: pat,
      body: JSON.stringify({ idempotencyKey: "pat-draft-1", answers: complete }),
    });
    const mine = (await created.json()).proposal as { id: string; revision: number };

    // Byte-for-byte, apart from the correlation id: a difference of any kind here is an oracle for
    // enumerating another submitter's proposal ids.
    const forbidden = await app.request(`${proposals}/${mine.id}`, { headers: sam });
    const missing = await app.request(`${proposals}/${unknownProposal}`, { headers: sam });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const shape = async (response: Response) => {
      const body = (await response.json()) as { error: { correlationId: string } };
      return { ...body, error: { ...body.error, correlationId: "<any>" } };
    };
    expect(await shape(forbidden)).toEqual(await shape(missing));

    // Writes too, not only the read.
    for (const [method, path] of [
      ["PUT", `${proposals}/${mine.id}`],
      ["POST", `${proposals}/${mine.id}/submit`],
    ] as const)
      expect(
        (
          await app.request(path, {
            method,
            headers: sam,
            body: JSON.stringify({ answers: complete, expectedRevision: mine.revision }),
          })
        ).status,
      ).toBe(404);
  });

  it("is a 409 for a stale revision and a 409 for a call that has closed", async () => {
    const { app, organizer, pat, publish, at } = await setup();
    await publish();
    const created = await app.request(proposals, {
      method: "POST",
      headers: pat,
      body: JSON.stringify({ idempotencyKey: "pat-draft-1", answers: { title: "Original" } }),
    });
    const draft = (await created.json()).proposal as { id: string; revision: number };
    const write = (body: unknown) =>
      app.request(`${proposals}/${draft.id}`, {
        method: "PUT",
        headers: pat,
        body: JSON.stringify(body),
      });

    expect(
      (await write({ answers: { title: "Winner" }, expectedRevision: draft.revision })).status,
    ).toBe(200);
    const stale = await write({ answers: { title: "Loser" }, expectedRevision: draft.revision });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });

    // A closed call is a 409 too, and for the same reason: the request is well formed and the
    // resource exists — its state is what refuses. A 404 would read as "your form is broken".
    expect(
      (
        await app.request(`/api/events/${eventId}/cfp/window`, {
          method: "PUT",
          headers: organizer,
          body: JSON.stringify({ opensAt: null, closesAt: "2026-09-30T23:59:00.000Z" }),
        })
      ).status,
    ).toBe(200);
    at("2026-10-01T00:00:00.000Z");
    const late = await write({ answers: { title: "Late" }, expectedRevision: 2 });
    expect(late.status).toBe(409);
    await expect(late.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", message: expect.stringContaining("closed") },
    });
    // Reading still works after the deadline: the dashboard is a record.
    expect((await app.request(proposals, { headers: pat })).status).toBe(200);
  });

  it("keeps the window an organizer-only control and validates its order", async () => {
    const { app, organizer, pat } = await setup();
    const path = `/api/events/${eventId}/cfp/window`;
    const window = { opensAt: null, closesAt: "2026-09-30T23:59:00.000Z" };

    expect((await app.request(path, { method: "PUT", body: JSON.stringify(window) })).status).toBe(
      401,
    );
    expect(
      (await app.request(path, { method: "PUT", headers: pat, body: JSON.stringify(window) }))
        .status,
    ).toBe(403);

    // Authorization runs before the body is parsed, so a submitter posting nonsense is refused for
    // being a submitter rather than told which field was malformed.
    expect((await app.request(path, { method: "PUT", headers: pat, body: "{" })).status).toBe(403);

    expect(
      (
        await app.request(path, {
          method: "PUT",
          headers: organizer,
          body: JSON.stringify({
            opensAt: "2026-09-30T00:00:00.000Z",
            closesAt: "2026-09-01T00:00:00.000Z",
          }),
        })
      ).status,
    ).toBe(400);

    const saved = await app.request(path, {
      method: "PUT",
      headers: organizer,
      body: JSON.stringify(window),
    });
    expect(saved.status).toBe(404);
    await expect(saved.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("Create the CFP") },
    });
  });

  it("tells the public form the window and the state it resolves to", async () => {
    const { app, organizer, publish, at } = await setup();
    await publish();
    await app.request(`/api/events/${eventId}/cfp/window`, {
      method: "PUT",
      headers: organizer,
      body: JSON.stringify({
        opensAt: "2026-09-01T00:00:00.000Z",
        closesAt: "2026-09-30T23:59:00.000Z",
      }),
    });
    const publicPath = `/api/public/events/${eventId}/cfp`;

    // `effectiveStatus` is on the wire because a browser must not decide from its own clock
    // whether a deadline has passed.
    await expect((await app.request(publicPath)).json()).resolves.toMatchObject({
      cfp: {
        opensAt: "2026-09-01T00:00:00.000Z",
        closesAt: "2026-09-30T23:59:00.000Z",
        effectiveStatus: "scheduled",
      },
    });
    at("2026-09-15T09:00:00.000Z");
    await expect((await app.request(publicPath)).json()).resolves.toMatchObject({
      cfp: { effectiveStatus: "open" },
    });
    at("2026-10-02T09:00:00.000Z");
    await expect((await app.request(publicPath)).json()).resolves.toMatchObject({
      cfp: { effectiveStatus: "closed" },
    });
    // And the anonymous door is shut by the schedule as well, with the same 409.
    const late = await app.request(`/api/public/events/${eventId}/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ idempotencyKey: "late-guest", answers: complete }),
    });
    expect(late.status).toBe(409);
  });
});
