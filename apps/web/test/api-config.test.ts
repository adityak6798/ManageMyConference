// @acceptance ACC-HARNESS
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("API origin configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps local API requests relative by default", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubEnv("VITE_API_BASE_URL", "");

    const { apiFetch } = await import("../src/api/config");
    await apiFetch("/api/session");

    expect(nativeFetch).toHaveBeenCalledWith("/api/session");
  });

  it("prefixes API paths and normalizes a configured trailing slash", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubEnv("VITE_API_BASE_URL", "https://api.greenroom.example///");

    const { apiFetch } = await import("../src/api/config");
    await apiFetch("/api/events");

    expect(nativeFetch).toHaveBeenCalledWith("https://api.greenroom.example/api/events");
  });
});

describe("response contract decoding", () => {
  it("reports correlation and invalid field paths for a drifted success payload", async () => {
    const { decodeResponse, ResponseContractError } = await import("../src/api/config");
    const response = new Response(JSON.stringify({ cfp: { title: "Open CFP" } }), {
      headers: { "x-correlation-id": "contract-drift-123" },
    });

    await expect(
      decodeResponse(
        response,
        z.object({ cfp: z.object({ title: z.string(), fields: z.array(z.unknown()) }) }),
        () => new Error("unexpected API refusal"),
      ),
    ).rejects.toMatchObject({
      name: ResponseContractError.name,
      correlationId: "contract-drift-123",
      issuePaths: ["cfp.fields"],
      message: expect.stringContaining("could not read the server response"),
    });
  });

  it("turns a malformed body into the same traceable contract error", async () => {
    const { decodeResponse } = await import("../src/api/config");
    const response = new Response("not json", {
      headers: { "x-correlation-id": "invalid-json-123" },
    });

    await expect(
      decodeResponse(response, z.object({ ok: z.boolean() }), () => new Error("unused")),
    ).rejects.toMatchObject({
      correlationId: "invalid-json-123",
      issuePaths: ["response body"],
    });
  });
});
