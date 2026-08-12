// @acceptance ACC-HARNESS
import { afterEach, describe, expect, it, vi } from "vitest";

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
