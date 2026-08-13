// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import {
  type ApiClientDatabasePort,
  D1ApiClientRepository,
} from "../src/adapters/persistence/d1-api-clients";
import type { ApiClientRecord } from "../src/application/identity/api-clients";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const EVENT = "00000000-0000-4000-8000-000000000001";

function client(id: string, createdAt: number): ApiClientRecord {
  return {
    id,
    organizationId: ORGANIZATION,
    name: `Client ${id}`,
    keyPrefix: id,
    secretHash: "hash",
    previousSecretHash: null,
    previousSecretExpiresAt: null,
    createdBy: "organizer",
    createdAt,
    expiresAt: null,
    revokedAt: null,
    scopes: ["events:read"],
    eventIds: [EVENT],
  };
}

describe("D1ApiClientRepository", () => {
  it("hydrates a listing with two batched relation reads instead of two reads per client", async () => {
    const clients = [client("client-a", 2), client("client-b", 1)];
    const queries: string[] = [];
    const database = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind() {
            return this;
          },
          async all() {
            if (query.includes("FROM api_clients")) {
              return {
                success: true,
                results: clients.map((entry) => ({
                  id: entry.id,
                  organization_id: entry.organizationId,
                  name: entry.name,
                  key_prefix: entry.keyPrefix,
                  secret_hash: entry.secretHash,
                  previous_secret_hash: entry.previousSecretHash,
                  previous_secret_expires_at: entry.previousSecretExpiresAt,
                  created_by: entry.createdBy,
                  created_at: entry.createdAt,
                  expires_at: entry.expiresAt,
                  revoked_at: entry.revokedAt,
                })),
              };
            }
            if (query.includes("FROM api_client_scopes"))
              return {
                success: true,
                results: clients.map(({ id }) => ({ client_id: id, capability: "events:read" })),
              };
            return {
              success: true,
              results: clients.map(({ id }) => ({ client_id: id, event_id: EVENT })),
            };
          },
        };
      },
    } as unknown as ApiClientDatabasePort;

    await expect(new D1ApiClientRepository(database).list(ORGANIZATION)).resolves.toEqual(clients);
    expect(queries).toHaveLength(3);
    expect(queries.filter((query) => query.includes("api_client_scopes"))).toHaveLength(1);
    expect(queries.filter((query) => query.includes("api_client_events"))).toHaveLength(1);
  });

  it("retains the first D1 batch error", async () => {
    const database = {
      prepare() {
        return {
          bind() {
            return this;
          },
        };
      },
      async batch() {
        return [
          { success: false, error: "constraint failed", meta: { changes: 0 } },
          { success: false, error: "later failure", meta: { changes: 0 } },
        ];
      },
    } as unknown as ApiClientDatabasePort;

    await expect(
      new D1ApiClientRepository(database).create(client("client-a", 1), {
        correlationId: "correlation-test",
        actorUserId: "organizer",
        source: "human",
      }),
    ).rejects.toThrow("D1 failed to create an API client: constraint failed");
  });
});
