// @acceptance ACC-INTEGRATION
import { describe, expect, it, vi } from "vitest";
import { handleEgress } from "../src/http.js";

const request = (body: unknown, token = "correct-token") =>
  new Request("https://egress.example/api", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("egress HTTP boundary", () => {
  it("authenticates before parsing a command", async () => {
    const response = await handleEgress(request("not-json-object", "wrong-token"), [
      "correct-token",
    ]);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "UNAUTHORIZED" });
  });

  it("returns a bounded refusal for a private literal", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await handleEgress(
      request({ operation: "validate", url: "https://169.254.169.254/latest/meta-data" }),
      ["correct-token"],
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "refused", code: "DNS_NOT_GLOBAL" });
  });

  it("refuses invalid commands and absent service configuration", async () => {
    expect((await handleEgress(request({ operation: "unknown" }), ["correct-token"])).status).toBe(
      400,
    );
    expect(
      (await handleEgress(request({ operation: "validate", url: "https://example.com" }), []))
        .status,
    ).toBe(503);
  });

  it("accepts the previous bearer only during an explicit rotation overlap", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const command = { operation: "validate", url: "https://169.254.169.254/" };
    expect(
      (await handleEgress(request(command, "old-token"), ["new-token", "old-token"])).status,
    ).toBe(200);
    expect((await handleEgress(request(command, "old-token"), ["new-token"])).status).toBe(401);
  });
});
