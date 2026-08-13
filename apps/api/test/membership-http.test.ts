// @acceptance ACC-IDENTITY-EVENTS
/**
 * Membership administration at the transport: status codes, shapes, and who gets through.
 *
 * The refusals are what this suite is mostly for. An invitation that cannot be used answers 404
 * whatever is wrong with it, acceptance requires a real session rather than merely a capability,
 * and a deployment composed without the service says the routes do not exist rather than failing
 * on them.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import type { Actor, Capability } from "../src/application/identity/actor";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import {
  type MembershipRepository,
  MembershipService,
  mintInvitationToken,
} from "../src/application/identity/membership";
import { createUserSession } from "../src/application/identity/real-auth";
import { createHttpAppFrom } from "../src/transport/http/app";
import { memorySessionStore } from "./support/memory-session-store";

const secret = "membership-http-secret";
const NOW = 1_000;
const EXPIRES = NOW + 28_800_000;
const ORGANIZATION = "00000000-0000-4000-8000-0000000000a0";
const EVENT = "00000000-0000-4000-8000-0000000000a1";
const USER = "11111111-1111-4111-8111-111111111111";

const organizer: Actor = {
  id: USER,
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [
    {
      eventId: EVENT,
      role: "organizer",
      capabilities: new Set<Capability>(["events:read", "identity:manage"]),
    },
  ],
  capabilities: new Set<Capability>(["events:read", "identity:manage"]),
};

function harness(over: { accept?: MembershipRepository["acceptInvitation"] } = {}) {
  const sessions = memorySessionStore();
  sessions.seed({ id: "sid-1", userId: USER, issuedAt: NOW, expiresAt: EXPIRES });
  const repository = {
    listMembers: vi.fn(async () => [
      { userId: USER, name: "Odele Organizer", email: "odele@example.test", eventRoles: [] },
    ]),
    listInvitations: vi.fn(async () => []),
    createInvitation: vi.fn(
      async (
        _invitation: Parameters<MembershipRepository["createInvitation"]>[0],
        _context: Parameters<MembershipRepository["createInvitation"]>[1],
      ) => undefined,
    ),
    revokeInvitation: vi.fn(async () => 1),
    acceptInvitation:
      over.accept ??
      vi.fn(async () => ({
        organizationId: ORGANIZATION,
        eventId: null,
        role: "organizer" as const,
      })),
    removeMember: vi.fn(async () => 1),
    setEventRole: vi.fn(async () => 1),
    revokeEventRole: vi.fn(async () => 1),
    listAuditEvents: vi.fn(async () => [
      {
        id: "audit-1",
        occurredAt: NOW,
        action: "membership.invited",
        outcome: "succeeded",
        source: "human",
        actorUserId: USER,
        subjectUserId: null,
        eventId: null,
        correlationId: "c",
        detail: null,
      },
    ]),
    recordRefusal: vi.fn(async () => undefined),
    isMember: vi.fn(async () => true),
  };
  const app = createHttpAppFrom({
    events: new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: {
      demoMode: false,
      sessionSecret: secret,
      now: () => NOW,
      sessions,
      resolveActor: async (userId) => (userId === USER ? organizer : null),
      resolveEmail: async () => null,
      sendLoginCode: async () => undefined,
      saveLoginChallenge: async () => undefined,
      consumeLoginChallenge: async () => null,
    },
    membership: new MembershipService({
      repository,
      events: {
        belongsToOrganization: async () => true,
        listEventIdsInOrganization: async (_organizationId, candidates) => [...candidates],
        listEventIdsForOrganization: async () => [EVENT],
      },
      newId: () => "invitation-1",
      now: () => NOW,
      mintToken: mintInvitationToken,
    }),
  });
  return { app, repository, sessions };
}

const signedIn = async () => ({
  cookie: `greenroom_session=${await createUserSession("sid-1", USER, secret, EXPIRES)}`,
});
const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("membership administration over HTTP", () => {
  it("lists members and invitations for an authorized organizer", async () => {
    const { app } = harness();
    const response = await app.request(`/api/organizations/${ORGANIZATION}/members`, {
      headers: await signedIn(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      members: [
        { userId: USER, name: "Odele Organizer", email: "odele@example.test", eventRoles: [] },
      ],
      invitations: [],
    });
  });

  it("creates an invitation and answers its token exactly once", async () => {
    const { app, repository } = harness();
    const response = await app.request(`/api/organizations/${ORGANIZATION}/invitations`, {
      ...asJson({ email: "new@example.test", role: "reviewer", eventId: EVENT }),
      headers: { ...(await signedIn()), "content-type": "application/json" },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { token: string; invitation: { email: string } };
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(created.invitation.email).toBe("new@example.test");
    // The stored form is a digest, and the token never reaches the database.
    const stored = repository.createInvitation.mock.calls[0]?.[0] as unknown as {
      tokenHash: string;
    };
    expect(stored.tokenHash).not.toBe(created.token);
    // A listing of the same organization never carries a token or a digest.
    const listed = await app.request(`/api/organizations/${ORGANIZATION}/members`, {
      headers: await signedIn(),
    });
    expect(await listed.text()).not.toContain(created.token);
  });

  it("refuses an invitation whose body is malformed, naming the field", async () => {
    const { app } = harness();
    const response = await app.request(`/api/organizations/${ORGANIZATION}/invitations`, {
      ...asJson({ email: "not-an-address", role: "reviewer", eventId: EVENT }),
      headers: { ...(await signedIn()), "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(
      (await response.json()) as { error: { fieldErrors: Record<string, string[]> } },
    ).toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { email: expect.any(Array) } },
    });
  });

  /**
   * Rule 1 at the transport: acceptance requires a *real session*, not merely an authorized
   * actor, and a demo persona is refused before the service is reached.
   */
  it("refuses acceptance without a real session", async () => {
    const { app, repository } = harness();
    const anonymous = await app.request("/api/invitations/accept", asJson({ token: "t" }));
    expect(anonymous.status).toBe(401);

    const persona = `greenroom_session=${await createDemoSession("organizer", secret, EXPIRES)}`;
    const asPersona = await app.request("/api/invitations/accept", {
      ...asJson({ token: "t" }),
      headers: { cookie: persona, "content-type": "application/json" },
    });
    expect(asPersona.status).toBe(401);
    expect(repository.acceptInvitation).not.toHaveBeenCalled();
  });

  it("answers one indistinguishable 404 for every unusable invitation", async () => {
    const { app } = harness({ accept: vi.fn(async () => null) });
    const response = await app.request("/api/invitations/accept", {
      ...asJson({ token: "spent-or-expired-or-imaginary" }),
      headers: { ...(await signedIn()), "content-type": "application/json" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "That invitation is not valid." },
    });
  });

  it("grants and revokes an event role, answering the rows changed", async () => {
    const { app, repository } = harness();
    const address = `/api/organizations/${ORGANIZATION}/events/${EVENT}/roles/${USER}`;
    const granted = await app.request(address, {
      method: "PUT",
      headers: { ...(await signedIn()), "content-type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ changed: 1 });
    expect(repository.setEventRole).toHaveBeenCalledWith(
      EVENT,
      USER,
      "reviewer",
      NOW,
      expect.anything(),
    );

    const revoked = await app.request(address, {
      method: "DELETE",
      headers: { ...(await signedIn()), "content-type": "application/json" },
      body: JSON.stringify({ role: "reviewer" }),
    });
    expect(await revoked.json()).toEqual({ changed: 1 });
  });

  it("refuses every membership route to an unauthenticated caller", async () => {
    const { app } = harness();
    for (const [method, path] of [
      ["GET", `/api/organizations/${ORGANIZATION}/members`],
      ["GET", `/api/organizations/${ORGANIZATION}/audit-events`],
      ["DELETE", `/api/organizations/${ORGANIZATION}/members/${USER}`],
    ] as const)
      expect({ path, status: (await app.request(path, { method })).status }).toEqual({
        path,
        status: 401,
      });
  });

  it("serves the organizer audit log with instants as ISO strings", async () => {
    const { app } = harness();
    const response = await app.request(`/api/organizations/${ORGANIZATION}/audit-events`, {
      headers: await signedIn(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      events: [{ action: "membership.invited", occurredAt: new Date(NOW).toISOString() }],
    });
  });

  /**
   * A deployment composed without the service has no such doors, rather than 500ing on them.
   * `createHttpAppFrom` makes every domain service optional so a test can compose only what it
   * exercises, and this asserts the answer that choice implies.
   */
  it("answers 404 where membership administration is not composed", async () => {
    const { app } = harness();
    const bare = createHttpAppFrom({
      events: new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      auth: { demoMode: false },
    });
    expect((await bare.request(`/api/organizations/${ORGANIZATION}/members`)).status).toBe(404);
    // And the composed app does answer, so the 404 above is the absence and not the address.
    expect(
      (
        await app.request(`/api/organizations/${ORGANIZATION}/members`, {
          headers: await signedIn(),
        })
      ).status,
    ).toBe(200);
  });
});
