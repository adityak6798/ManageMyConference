// @acceptance ACC-HARNESS
import {
  API_CONTRACT_VERSION,
  API_VERSION_HEADER,
  communicationsHistoryParamsSchema,
  communicationsHistoryResponseSchema,
  cursorPage,
  cursorPageParams,
} from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import openApiDocument from "../../../packages/contracts/openapi.json";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { createHttpApp } from "../src/transport/http/app";

const createTestApp = () =>
  createHttpApp(
    new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    }),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { demoMode: false },
  );

describe("API compatibility contract", () => {
  it("uses one declared version in OpenAPI and on success, refusal, and not-found responses", async () => {
    expect(openApiDocument.info.version).toBe(API_CONTRACT_VERSION);

    for (const path of ["/health", "/api/session", "/api/does-not-exist"]) {
      const response = await createTestApp().request(path);
      expect(response.headers.get(API_VERSION_HEADER)).toBe(API_CONTRACT_VERSION);
    }
  });

  it("bounds and coerces shared opaque cursor queries", () => {
    const params = cursorPageParams({ max: 50, default: 25 });
    expect(params.parse({})).toEqual({ limit: 25 });
    expect(params.parse({ limit: "50", cursor: "opaque" })).toEqual({
      limit: 50,
      cursor: "opaque",
    });
    expect(params.safeParse({ limit: 51 }).success).toBe(false);
    expect(params.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("keeps communications history wire-compatible while adopting the shared page helpers", () => {
    expect(
      communicationsHistoryParamsSchema.parse({
        organizationId: "00000000-0000-4000-8000-000000000010",
        eventId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ limit: 25 });
    expect(communicationsHistoryResponseSchema.parse({ history: [], nextCursor: null })).toEqual({
      history: [],
      nextCursor: null,
    });
    expect(cursorPage(z.string()).parse({ items: ["one"], nextCursor: "next" })).toEqual({
      items: ["one"],
      nextCursor: "next",
    });
  });
});
