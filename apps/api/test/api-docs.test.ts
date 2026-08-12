// @acceptance ACC-HARNESS
import openApiDocument from "../../../packages/contracts/openapi.json";
// ERROR-INTENT: jsdom is provided transitively by the web test harness without its optional types.
// @ts-expect-error the runtime dependency is present, and this test supplies the narrow window type it uses.
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import { createHttpApp } from "../src/transport/http/app";

const createTestApp = () =>
  createHttpApp(
    new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    }),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { demoMode: false },
  );

describe("API documentation routes", () => {
  it("serves the checked-in generated OpenAPI document", async () => {
    const response = await createTestApp().request("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual(openApiDocument);
  });

  it("serves a self-contained browsable API reference", async () => {
    const response = await createTestApp().request("/docs");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(html).toContain("Greenroom API reference");
    expect(html).toContain('fetch("/openapi.json")');
    expect(html).not.toMatch(/https?:\/\//);

    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window: Window & typeof globalThis) {
        Object.defineProperty(window, "fetch", {
          value: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => openApiDocument,
          }),
        });
      },
    });
    const operationCount = Object.values(openApiDocument.paths).reduce(
      (count, methods) => count + Object.keys(methods).length,
      0,
    );

    await vi.waitFor(() => {
      expect(dom.window.document.querySelectorAll("main > article")).toHaveLength(
        operationCount + 1,
      );
    });
    const detailLabels = [...dom.window.document.querySelectorAll("details > summary")].map(
      (summary) => summary.textContent,
    );
    expect(detailLabels).toContain("Authentication");
    expect(detailLabels).toContain("Parameters");
    expect(detailLabels).toContain("Request body");
    expect(detailLabels).toContain("Responses");
    expect(dom.window.document.body.textContent).toContain(
      "Reusable schemas and security definitions",
    );
    expect(dom.window.document.body.textContent).toContain("sessionCookie");
  });
});
