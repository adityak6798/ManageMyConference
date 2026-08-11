// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { runtimeAuth } from "../src/index";
import { clientAddress, FixedWindowThrottle } from "../src/transport/http/throttle";

describe("runtimeAuth", () => {
  it("requires explicit safe demo configuration", () => {
    expect(runtimeAuth({})).toEqual({ demoMode: false });
    expect(() => runtimeAuth({ DEMO_MODE: "true", ENVIRONMENT: "development" })).toThrow(
      "non-default SESSION_SECRET",
    );
    expect(() =>
      runtimeAuth({
        DEMO_MODE: "true",
        SESSION_SECRET: "local-development-secret",
        ENVIRONMENT: "development",
      }),
    ).toThrow("non-default SESSION_SECRET");
    expect(() =>
      runtimeAuth({
        DEMO_MODE: "true",
        SESSION_SECRET: "safe-unique-key",
        ENVIRONMENT: "production",
      }),
    ).toThrow("allowed only when ENVIRONMENT=development");
    expect(() => runtimeAuth({ DEMO_MODE: "true", SESSION_SECRET: "safe-unique-key" })).toThrow(
      "allowed only when ENVIRONMENT=development",
    );
    expect(() =>
      runtimeAuth({
        DEMO_MODE: "true",
        SESSION_SECRET: "safe-unique-key",
        ENVIRONMENT: "developmnt",
      }),
    ).toThrow("allowed only when ENVIRONMENT=development");
    expect(
      runtimeAuth({
        DEMO_MODE: "true",
        SESSION_SECRET: "safe-unique-key",
        ENVIRONMENT: "development",
      }),
    ).toEqual({ demoMode: true, sessionSecret: "safe-unique-key" });
  });
});

describe("submission throttle", () => {
  it("counts a fixed window per key, forgets it afterwards, and stays bounded", () => {
    const throttle = new FixedWindowThrottle(2, 1_000, 2);
    expect(throttle.check("a", 0).allowed).toBe(true);
    expect(throttle.check("a", 100).allowed).toBe(true);
    const refused = throttle.check("a", 200);
    expect(refused.allowed).toBe(false);
    // `Retry-After` is whole seconds until the window ends, never zero for a refusal.
    expect(refused.retryAfterSeconds).toBe(1);
    // A different key has its own budget, so one flooder cannot spend another's.
    expect(throttle.check("b", 200).allowed).toBe(true);
    // The window is fixed, not sliding: once it ends the count starts again.
    expect(throttle.check("a", 1_200).allowed).toBe(true);
    // A rotating key space cannot grow the table past its cap.
    const bounded = new FixedWindowThrottle(5, 1_000, 2);
    expect(bounded.check("one", 0).allowed).toBe(true);
    expect(bounded.check("two", 0).allowed).toBe(true);
    // Crucially the cap EVICTS rather than refuses. The submissions key embeds a caller-supplied
    // event id, so refusing newcomers on a full table would let one client rotating random UUIDs
    // lock every genuine submitter out for a whole window — the limiter would be the attack.
    expect(bounded.check("three", 0).allowed).toBe(true);
    // The evicted key starts a fresh window rather than inheriting a refusal.
    expect(bounded.check("one", 0).allowed).toBe(true);
    // Expired windows are still reclaimed first, so eviction is the fallback and not the norm.
    expect(bounded.check("four", 2_000).allowed).toBe(true);
  });

  it("keeps a flooder from spending a first-time submitter's budget", () => {
    // The end-to-end shape of the defect: 10k rotated keys must not refuse the 10,001st caller.
    const throttle = new FixedWindowThrottle(10, 60_000, 100);
    for (let index = 0; index < 500; index += 1)
      expect(throttle.check(`1.2.3.4:event-${index}`, 0).allowed).toBe(true);
    expect(throttle.check("198.51.100.7:real-event", 0)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it("prefers the address the edge wrote over anything the client can forge", () => {
    const headers = (values: Record<string, string>) => ({
      get: (name: string) => values[name] ?? null,
    });
    expect(
      clientAddress(headers({ "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "1.1.1.1" })),
    ).toBe("198.51.100.4");
    expect(clientAddress(headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" }))).toBe(
      "203.0.113.9",
    );
    // No address at all still yields a stable key rather than an unbounded one per request.
    expect(clientAddress(headers({}))).toBe("unknown");
  });
});
