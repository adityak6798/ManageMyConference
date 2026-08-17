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

  it("separates a handled refusal's sentence from the reference, in both client shapes", async () => {
    const { describeApiFailure } = await import("../src/api/config");
    // The envelope shape (IdentityApiError, CfpApiError, ReviewApiError, …).
    expect(
      describeApiFailure(
        { envelope: { error: { message: "That round is closed.", correlationId: "01JABC" } } },
        "The queue could not be loaded.",
      ),
    ).toEqual({ message: "That round is closed.", reference: "01JABC" });
    // The flat shape (MembershipApiError, CrmApiError, SiteApiError, …).
    expect(
      describeApiFailure(
        Object.assign(new Error("That member is already invited."), { correlationId: "01JDEF" }),
        "The member list could not be loaded.",
      ),
    ).toEqual({ message: "That member is already invited.", reference: "01JDEF" });
  });

  it("does not quote a fault the reader cannot act on", async () => {
    const { describeApiFailure } = await import("../src/api/config");
    // An unhandled fault's message was written for a developer, so the caller's sentence wins.
    expect(
      describeApiFailure(new TypeError("Failed to fetch"), "The agenda could not be loaded."),
    ).toEqual({ message: "The agenda could not be loaded.", reference: null });
    expect(describeApiFailure(undefined, "The agenda could not be loaded.").reference).toBeNull();
    // "unavailable" is what ResponseContractError says when the response carried no
    // correlation header; printing it would ask somebody to quote a value that does not exist.
    expect(
      describeApiFailure(
        { message: "The browser could not read it.", correlationId: "unavailable" },
        "x",
      ).reference,
    ).toBeNull();
  });

  it("does not print the reference twice when a message already carries one", async () => {
    const { describeApiFailure, ResponseContractError } = await import("../src/api/config");
    expect(describeApiFailure(new ResponseContractError("01JGHI", ["cfp.fields"]), "x")).toEqual({
      message: "The browser could not read the server response (cfp.fields).",
      reference: "01JGHI",
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
