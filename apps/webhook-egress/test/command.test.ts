// @acceptance ACC-INTEGRATION
import { describe, expect, it, vi } from "vitest";
import { executeCommand, parseCommand } from "../src/command.js";
import type { AddressResolver } from "../src/resolver.js";
import { pinnedRequestOptions, targetHeaders } from "../src/target.js";

const resolver: AddressResolver = {
  async resolve4() {
    return ["93.184.216.34"];
  },
  async resolve6() {
    return [];
  },
};

const dispatch = () =>
  parseCommand({
    operation: "dispatch",
    url: "https://receiver.example.com/hooks?version=1",
    headers: {
      "content-type": "application/json",
      "Greenroom-Signature": "t=1,v1=probe",
      "Greenroom-Delivery-Id": "delivery-1",
    },
    body: "{}",
    timeoutMs: 1_000,
  });

describe("webhook egress command", () => {
  it("re-resolves, selects from the validated set, and returns normalized status only", async () => {
    const send = vi.fn(async () => 204);
    await expect(executeCommand(dispatch(), { resolver, send })).resolves.toEqual({
      result: "delivered",
      targetStatus: 204,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { address: "93.184.216.34", family: 4 },
        body: "{}",
      }),
    );
  });

  it("refuses a send-time rebind without invoking target transport", async () => {
    const send = vi.fn(async () => 204);
    await expect(
      executeCommand(dispatch(), {
        resolver: {
          async resolve4() {
            return ["127.0.0.1"];
          },
          async resolve6() {
            return [];
          },
        },
        send,
      }),
    ).rejects.toMatchObject({ code: "DNS_NOT_GLOBAL" });
    expect(send).not.toHaveBeenCalled();
  });

  it("pins the socket lookup while preserving the original hostname for SNI and Host", () => {
    const command = dispatch();
    if (command.operation !== "dispatch") throw new Error("expected dispatch");
    const options = pinnedRequestOptions({
      url: new URL(command.url),
      address: { address: "93.184.216.34", family: 4 },
      headers: command.headers,
      body: command.body,
      timeoutMs: command.timeoutMs,
    });
    expect(options.hostname).toBe("receiver.example.com");
    expect(options.servername).toBe("receiver.example.com");
    expect(options.path).toBe("/hooks?version=1");
    expect(options.lookup).toBeTypeOf("function");
    const callback = vi.fn();
    options.lookup?.("receiver.example.com", { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("allows only Greenroom-owned target headers and never authorization", () => {
    expect(targetHeaders({ "Greenroom-Signature": "t=1,v1=probe" }, "{}")).toEqual({
      "greenroom-signature": "t=1,v1=probe",
      "content-length": "2",
    });
    expect(() => targetHeaders({ authorization: "Bearer must-not-leak" }, "{}")).toThrow(
      "TARGET_HEADER_REFUSED",
    );
  });

  it.each([
    [302, { result: "terminal", code: "TARGET_REDIRECT", targetStatus: 302 }],
    [429, { result: "retryable", code: "TARGET_429", targetStatus: 429 }],
    [503, { result: "retryable", code: "TARGET_503", targetStatus: 503 }],
    [409, { result: "terminal", code: "TARGET_409", targetStatus: 409 }],
  ])("normalizes target status %i", async (status, expected) => {
    await expect(
      executeCommand(dispatch(), { resolver, send: async () => status }),
    ).resolves.toEqual(expected);
  });
});
