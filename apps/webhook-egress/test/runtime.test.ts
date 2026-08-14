// @acceptance ACC-INTEGRATION
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeTarget } from "../src/probe-target.js";
import { routeRequest } from "../src/runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("Cloudflare container runtime", () => {
  it("routes only the enforcement endpoint to the container", async () => {
    const fetch = vi.fn(async () => new Response("proxied"));
    const request = new Request("https://egress.example/egress", { method: "POST" });
    await expect(routeRequest(request, { fetch })).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledWith(request);
    expect((await routeRequest(new Request("https://egress.example/nope"), { fetch })).status).toBe(
      404,
    );
  });

  it("serves a bounded health response without starting the container", async () => {
    const fetch = vi.fn(async () => new Response());
    const response = await routeRequest(new Request("https://egress.example/health"), { fetch });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "greenroom-webhook-egress",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the service bearer out of the public probe target", async () => {
    expect(
      (
        await probeTarget(
          new Request("https://egress.example/probe-target", {
            method: "POST",
            headers: {
              authorization: "Bearer must-not-leak",
              "greenroom-signature": `t=1,v1=${"0".repeat(64)}`,
            },
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await probeTarget(
          new Request("https://egress.example/probe-target", {
            method: "POST",
            headers: { "greenroom-signature": `t=1,v1=${"0".repeat(64)}` },
          }),
        )
      ).status,
    ).toBe(204);
  });

  it("provides redirect and status fixtures without retaining a request body", async () => {
    expect(
      (
        await probeTarget(
          new Request("https://egress.example/probe-target?case=redirect", { method: "POST" }),
        )
      ).status,
    ).toBe(302);
    expect(
      (
        await probeTarget(
          new Request("https://egress.example/probe-target?case=malformed", { method: "POST" }),
        )
      ).status,
    ).toBe(431);
  });
});
