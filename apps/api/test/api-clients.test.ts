// @acceptance ACC-HARNESS
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import type { Actor, Capability } from "../src/application/identity/actor";
import {
  type ApiClientRecord,
  type ApiClientRepository,
  ApiClientResolver,
  ApiClientService,
  hashApiClientSecret,
} from "../src/application/identity/api-clients";
import type { AuditContext } from "../src/application/identity/audit";
import { createUserSession } from "../src/application/identity/real-auth";
import { createHttpAppFrom } from "../src/transport/http/app";
import { memorySessionStore } from "./support/memory-session-store";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-000000000020";
const EVENT = "00000000-0000-4000-8000-000000000001";
const NOW = 1_760_000_000_000;
const PREFIX = "0123456789abcdef";
const ROTATED_PREFIX = "fedcba9876543210";
const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
const ROTATED_SECRET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const CREDENTIAL = `grn_${PREFIX}.${SECRET}`;
const audit: AuditContext = {
  correlationId: "correlation-test",
  actorUserId: "creator",
  source: "human",
};

const creator: Actor = {
  id: "creator",
  name: "Creator",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [
    {
      eventId: EVENT,
      role: "organizer",
      capabilities: new Set<Capability>(["events:read", "identity:manage"]),
    },
  ],
  capabilities: new Set<Capability>(["events:read", "events:create", "identity:manage"]),
};

class MemoryRepository implements ApiClientRepository {
  clients: ApiClientRecord[] = [];
  async findByPrefix(prefix: string) {
    return this.clients.find((client) => client.keyPrefix === prefix) ?? null;
  }
  async findKeyPrefix(organizationId: string, clientId: string) {
    return (
      this.clients.find(
        (client) => client.organizationId === organizationId && client.id === clientId,
      )?.keyPrefix ?? null
    );
  }
  async findRevocationState(organizationId: string, clientId: string) {
  async findRevocationState(organizationId: string, clientId: string) {
    const client = this.clients.find(
      (candidate) => candidate.id === clientId && candidate.organizationId === organizationId,
    );
    return client ? { revokedAt: client.revokedAt } : null;
  }
  async list(organizationId: string) {
    return this.clients.filter((client) => client.organizationId === organizationId);
  }
  async create(client: ApiClientRecord) {
    this.clients.push(client);
  }
  async rotate(input: {
    organizationId: string;
    clientId: string;
    secretHash: string;
    overlapExpiresAt: number;
  }) {
    const client = this.clients.find(
      (candidate) =>
        candidate.id === input.clientId &&
        candidate.organizationId === input.organizationId &&
        candidate.revokedAt === null,
    );
    if (!client) return 0;
    client.previousSecretHash = client.secretHash;
    client.previousSecretExpiresAt = input.overlapExpiresAt;
    client.secretHash = input.secretHash;
    return 1;
  }
  async revoke(input: { organizationId: string; clientId: string; now: number }) {
    const client = this.clients.find(
      (candidate) =>
        candidate.id === input.clientId &&
        candidate.organizationId === input.organizationId &&
        candidate.revokedAt === null,
    );
    if (!client) return 0;
    client.revokedAt = input.now;
    return 1;
  }
}

const events = {
  async listEventIdsInOrganization(organizationId: string, candidates: readonly string[]) {
    return organizationId === ORGANIZATION ? candidates.filter((id) => id === EVENT) : [];
  },
};

async function record(overrides: Partial<ApiClientRecord> = {}): Promise<ApiClientRecord> {
  return {
    id: "00000000-0000-4000-8000-000000000100",
    organizationId: ORGANIZATION,
    name: "Automation",
    keyPrefix: PREFIX,
    secretHash: await hashApiClientSecret(SECRET),
    previousSecretHash: null,
    previousSecretExpiresAt: null,
    createdBy: creator.id,
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    scopes: ["events:read"],
    eventIds: [EVENT],
    ...overrides,
  };
}

describe("API client credentials", () => {
  it("resolves the owning organization and only the event/capability intersection", async () => {
    const repository = new MemoryRepository();
    repository.clients.push(await record({ scopes: ["events:read", "crm:manage"] }));
    const resolver = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => NOW,
    });

    const actor = await resolver.resolve(CREDENTIAL);

    expect(actor?.id).toBe("00000000-0000-4000-8000-000000000100");
    expect(actor?.organizations).toEqual([{ id: ORGANIZATION }]);
    expect(actor ? [...actor.capabilities] : null).toEqual(["events:read"]);
    expect(actor?.eventAccess.map(({ eventId }) => eventId)).toEqual([EVENT]);
  });

  it("resolves organization-scoped creation and delegates the new organizer role to its creator", async () => {
    const repository = new MemoryRepository();
    repository.clients.push(await record({ scopes: ["events:create"] }));
    const resolver = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => NOW,
    });
    const machine = await resolver.resolve(CREDENTIAL);
    const grantOrganizer = vi.fn().mockResolvedValue(undefined);
    const service = new EventService({
      repository: new MemoryEventRepository(),
      newId: () => "00000000-0000-4000-8000-000000000110",
      now: () => new Date(NOW),
      grantOrganizer,
    });

    await expect(
      service.create(machine, {
        organizationId: ORGANIZATION,
        name: "Created by API",
        timezone: "UTC",
      }),
    ).resolves.toMatchObject({ name: "Created by API" });
    expect(grantOrganizer).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000110", creator.id);
  });

  it("makes unknown prefixes, wrong secrets, revocation, and expiry indistinguishable", async () => {
    const repository = new MemoryRepository();
    const client = await record();
    repository.clients.push(client);
    const resolver = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => NOW,
    });

    await expect(resolver.resolve(`grn_ffffffffffffffff.${SECRET}`)).resolves.toBeNull();
    await expect(
      resolver.resolve(`grn_${PREFIX}.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`),
    ).resolves.toBeNull();
    client.revokedAt = NOW;
    await expect(resolver.resolve(CREDENTIAL)).resolves.toBeNull();
    client.revokedAt = null;
    client.expiresAt = NOW;
    await expect(resolver.resolve(CREDENTIAL)).resolves.toBeNull();
  });

  it("accepts the previous digest only during the bounded rotation overlap", async () => {
    const repository = new MemoryRepository();
    const client = await record({
      secretHash: await hashApiClientSecret("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
      previousSecretHash: await hashApiClientSecret(SECRET),
      previousSecretExpiresAt: NOW + 1,
    });
    repository.clients.push(client);
    const before = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => NOW,
    });
    const after = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => NOW + 1,
    });

    await expect(before.resolve(CREDENTIAL)).resolves.not.toBeNull();
    await expect(after.resolve(CREDENTIAL)).resolves.toBeNull();
  });

  it("keeps the lookup prefix stable and accepts the old secret only during rotation overlap", async () => {
    const repository = new MemoryRepository();
    repository.clients.push(await record());
    let now = NOW;
    const service = new ApiClientService({
      repository,
      events,
      newId: () => crypto.randomUUID(),
      now: () => now,
      mintCredential: async () => ({
        credential: `grn_${ROTATED_PREFIX}.${ROTATED_SECRET}`,
        prefix: ROTATED_PREFIX,
        secretHash: await hashApiClientSecret(ROTATED_SECRET),
      }),
    });
    const resolver = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => now,
    });

    const rotated = await service.rotate(
      creator,
      ORGANIZATION,
      repository.clients[0]?.id ?? "",
      audit,
    );

    expect(rotated.credential).toBe(`grn_${PREFIX}.${ROTATED_SECRET}`);
    await expect(resolver.resolve(CREDENTIAL)).resolves.not.toBeNull();
    await expect(resolver.resolve(rotated.credential)).resolves.not.toBeNull();

    now = rotated.previousCredentialExpiresAt;
    await expect(resolver.resolve(CREDENTIAL)).resolves.toBeNull();
    await expect(resolver.resolve(rotated.credential)).resolves.not.toBeNull();
  });

  it("refuses cross-organization event grants at creation", async () => {
    const repository = new MemoryRepository();
    const service = new ApiClientService({
      repository,
      events,
      newId: () => "00000000-0000-4000-8000-000000000100",
      now: () => NOW,
      mintCredential: async () => ({
        credential: CREDENTIAL,
        prefix: PREFIX,
        secretHash: await hashApiClientSecret(SECRET),
      }),
    });

    await expect(
      service.create(
        creator,
        OTHER_ORGANIZATION,
        { name: "Bad", scopes: ["events:read"], eventIds: [EVENT] },
        audit,
      ),
    ).rejects.toThrow("Organization access denied");
  });

  it("returns a secret once while listings expose no digest", async () => {
    const repository = new MemoryRepository();
    const service = new ApiClientService({
      repository,
      events,
      newId: () => "00000000-0000-4000-8000-000000000100",
      now: () => NOW,
      mintCredential: async () => ({
        credential: CREDENTIAL,
        prefix: PREFIX,
        secretHash: await hashApiClientSecret(SECRET),
      }),
    });
    const created = await service.create(
      creator,
      ORGANIZATION,
      { name: "Automation", scopes: ["events:read"], eventIds: [EVENT] },
      audit,
    );

    expect(created.credential).toBe(CREDENTIAL);
    expect(await service.list(creator, ORGANIZATION)).toEqual([created.client]);
    expect(JSON.stringify(created.client)).not.toContain("secretHash");
  });

  it("administers clients only by session and observes revocation on the next bearer request", async () => {
    const repository = new MemoryRepository();
    const service = new ApiClientService({
      repository,
      events,
      newId: () => "00000000-0000-4000-8000-000000000100",
      now: () => NOW,
      mintCredential: async () => ({
        credential: CREDENTIAL,
        prefix: PREFIX,
        secretHash: await hashApiClientSecret(SECRET),
      }),
    });
    const resolver = new ApiClientResolver({
      repository,
      resolveCreator: async () => creator,
      events,
      now: () => NOW,
    });
    const sessions = memorySessionStore();
    sessions.seed({
      id: "session-1",
      userId: creator.id,
      issuedAt: NOW - 1,
      expiresAt: NOW + 1_000,
    });
    const eventRepository = new MemoryEventRepository();
    const otherEvent = "00000000-0000-4000-8000-000000000002";
    await eventRepository.create({
      id: EVENT,
      organizationId: ORGANIZATION,
      name: "Allowed event",
      timezone: "UTC",
      createdAt: new Date(NOW).toISOString(),
    });
    await eventRepository.create({
      id: otherEvent,
      organizationId: ORGANIZATION,
      name: "Not allowlisted",
      timezone: "UTC",
      createdAt: new Date(NOW).toISOString(),
    });
    const app = createHttpAppFrom({
      events: new EventService({
        repository: eventRepository,
        newId: () => crypto.randomUUID(),
        now: () => new Date(NOW),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      auth: {
        demoMode: false,
        sessionSecret: "api-client-http-secret",
        now: () => NOW,
        sessions,
        resolveActor: async () => creator,
        resolveEmail: async () => null,
        sendLoginCode: async () => undefined,
        saveLoginChallenge: async () => undefined,
        consumeLoginChallenge: async () => null,
        resolveApiClient: (credential) => resolver.resolve(credential),
      },
      apiClients: service,
    });
    const cookie = await createUserSession(
      "session-1",
      creator.id,
      "api-client-http-secret",
      NOW + 1_000,
    );
    const sessionHeaders = {
      cookie: `greenroom_session=${cookie}`,
      "content-type": "application/json",
    };
    const crossOrganization = await app.request(
      `/api/organizations/${OTHER_ORGANIZATION}/api-clients`,
      { headers: sessionHeaders },
    );
    expect(crossOrganization.status).toBe(403);
    expect(await crossOrganization.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const created = await app.request(`/api/organizations/${ORGANIZATION}/api-clients`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ name: "Automation", scopes: ["events:read"], eventIds: [EVENT] }),
    });
    expect(created.status).toBe(201);
    expect(
      (await app.request("/api/session", { headers: { authorization: `Bearer ${CREDENTIAL}` } }))
        .status,
    ).toBe(200);
    const eventList = await app.request("/api/events", {
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(eventList.status).toBe(200);
    await expect(eventList.json()).resolves.toMatchObject({ events: [{ id: EVENT }] });
    const deniedEvent = await app.request(`/api/events/${otherEvent}`, {
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(deniedEvent.status).toBe(404);
    const bearerMint = await app.request(`/api/organizations/${ORGANIZATION}/api-clients`, {
      method: "POST",
      headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Child", scopes: ["events:read"], eventIds: [EVENT] }),
    });
    expect(bearerMint.status).toBe(401);

    const revoked = await app.request(
      `/api/organizations/${ORGANIZATION}/api-clients/00000000-0000-4000-8000-000000000100`,
      { method: "DELETE", headers: sessionHeaders },
    );
    expect(revoked.status).toBe(204);
    const list = vi.spyOn(repository, "list");
    const replayed = await app.request(
      `/api/organizations/${ORGANIZATION}/api-clients/00000000-0000-4000-8000-000000000100`,
      { method: "DELETE", headers: sessionHeaders },
    );
    expect(replayed.status).toBe(204);
    expect(list).not.toHaveBeenCalled();
    expect(
      (await app.request("/api/session", { headers: { authorization: `Bearer ${CREDENTIAL}` } }))
        .status,
    ).toBe(401);
  });
});
