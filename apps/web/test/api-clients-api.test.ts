// @acceptance ACC-HARNESS
import { describe, expect, it, vi } from "vitest";
import { createApiClient, revokeApiClient, rotateApiClient } from "../src/api/api-clients";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const EVENT = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000100";
const credential = "grn_0123456789abcdef.abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";
const client = {
  id: CLIENT,
  organizationId: ORGANIZATION,
  name: "Automation",
  keyPrefix: "0123456789abcdef", // gitleaks:allow — public deterministic prefix fixture.
  createdBy: "organizer",
  createdAt: "2026-08-13T12:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  scopes: ["events:read"],
  eventIds: [EVENT],
};

describe("API-client browser requests", () => {
  it("does not advertise Idempotency-Key semantics the API-client contract cannot honor", async () => {
    const responses = [
      new Response(JSON.stringify({ client, credential }), { status: 201 }),
      new Response(
        JSON.stringify({
          credential,
          previousCredentialExpiresAt: "2026-08-14T12:00:00.000Z",
        }),
      ),
      new Response(null, { status: 204 }),
    ];
    const requests: Array<RequestInit | undefined> = [];
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init);
      return responses.shift() as Response;
    });

    await createApiClient(
      ORGANIZATION,
      { name: "Automation", scopes: ["events:read"], eventIds: [EVENT] },
      fetcher,
    );
    await rotateApiClient(ORGANIZATION, CLIENT, fetcher);
    await revokeApiClient(ORGANIZATION, CLIENT, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const init of requests) {
      const headers = new Headers(init?.headers);
      expect(headers.has("Idempotency-Key")).toBe(false);
    }
  });
});
