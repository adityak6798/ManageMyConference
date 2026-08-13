// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { resolveGoogleConfiguration, runtimeAuth } from "../src/index";
import { clientAddress, FixedWindowThrottle } from "../src/transport/http/throttle";

describe("runtimeAuth", () => {
  it("requires explicit safe demo configuration", () => {
    expect(() => runtimeAuth({})).toThrow("non-default SESSION_SECRET");
    expect(() => runtimeAuth({ SESSION_SECRET: "safe-unique-key" })).toThrow(
      "AUTH_EMAIL_ENDPOINT and AUTH_EMAIL_TOKEN",
    );
    expect(() =>
      runtimeAuth({
        SESSION_SECRET: "safe-unique-key",
        AUTH_EMAIL_ENDPOINT: "https://email.example.test/send",
      }),
    ).toThrow("AUTH_EMAIL_ENDPOINT and AUTH_EMAIL_TOKEN");
    expect(
      runtimeAuth({
        SESSION_SECRET: "safe-unique-key",
        AUTH_EMAIL_ENDPOINT: "https://email.example.test/send",
        AUTH_EMAIL_TOKEN: "provider-token",
      }),
    ).toEqual({
      demoMode: false,
      sessionSecret: "safe-unique-key",
    });
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

describe("resolveGoogleConfiguration", () => {
  const bindings = {
    GOOGLE_CLIENT_ID: "greenroom-test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "a-client-secret-that-belongs-in-a-worker-secret",
    GOOGLE_REDIRECT_URI: "https://greenroom.test/api/auth/google/callback",
  } as const;
  type Binding = keyof typeof bindings;
  const names = Object.keys(bindings) as Binding[];
  const only = (present: readonly Binding[]) =>
    Object.fromEntries(present.map((name) => [name, bindings[name]])) as Parameters<
      typeof resolveGoogleConfiguration
    >[0];

  it("is all three bindings or none, and names the ones it is missing", () => {
    // Not configured is a supported deployment: the door is simply not offered.
    expect(resolveGoogleConfiguration({})).toBeNull();
    expect(resolveGoogleConfiguration(only([]))).toBeNull();

    // Every partial combination, because each one is a deployment that would otherwise fail
    // after the user had already been sent to Google and back.
    for (const missing of names)
      expect(() =>
        resolveGoogleConfiguration(only(names.filter((name) => name !== missing))),
      ).toThrow(missing);
    for (const supplied of names)
      expect(() => resolveGoogleConfiguration(only([supplied]))).toThrow(
        names.filter((name) => name !== supplied).join(", "),
      );
    // A message that names a binding it is not missing sends an operator to the wrong file.
    expect(() => resolveGoogleConfiguration(only(["GOOGLE_CLIENT_ID"]))).not.toThrow(
      /GOOGLE_CLIENT_ID,/,
    );
    // And it names bindings, never values: this message reaches a deployment log.
    expect(() => resolveGoogleConfiguration(only(["GOOGLE_CLIENT_SECRET"]))).not.toThrow(
      bindings.GOOGLE_CLIENT_SECRET,
    );

    // A relative redirect cannot be what Google has registered, and failing here names the
    // binding rather than producing an authorization request Google refuses. Each of these is
    // non-empty on purpose: an empty string is *falsy*, so it is caught earlier as a missing
    // binding and would pass this assertion without the absolute-URL guard ever running.
    for (const GOOGLE_REDIRECT_URI of [
      "/api/auth/google/callback",
      "greenroom.test/callback",
      "ftp://greenroom.test/callback",
    ])
      expect(() => resolveGoogleConfiguration({ ...bindings, GOOGLE_REDIRECT_URI })).toThrow(
        "GOOGLE_REDIRECT_URI must be an absolute http(s) URL",
      );
    // The empty case belongs with the missing bindings, and is asserted as that.
    expect(() => resolveGoogleConfiguration({ ...bindings, GOOGLE_REDIRECT_URI: "" })).toThrow(
      "missing GOOGLE_REDIRECT_URI",
    );

    expect(resolveGoogleConfiguration(bindings)).toEqual({
      clientId: bindings.GOOGLE_CLIENT_ID,
      clientSecret: bindings.GOOGLE_CLIENT_SECRET,
      redirectUri: bindings.GOOGLE_REDIRECT_URI,
    });
    expect(
      resolveGoogleConfiguration({
        ...bindings,
        GOOGLE_REDIRECT_URI: "http://localhost:8787/api/auth/google/callback",
      }),
    ).toMatchObject({ redirectUri: "http://localhost:8787/api/auth/google/callback" });
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
    // The end-to-end shape of the defect: rotated keys must not refuse the next caller.
    const throttle = new FixedWindowThrottle(10, 60_000, 100);
    for (let index = 0; index < 500; index += 1)
      expect(throttle.check(`1.2.3.4:event-${index}`, 0).allowed).toBe(true);
    expect(throttle.check("198.51.100.7", 0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("gives one caller exactly one window, so its own traffic can never reset its counter", () => {
    // Eviction and key-minting together would defeat the limiter: spend the budget, rotate
    // enough keys to evict your own exhausted counter, start again. That is why the submissions
    // route keys on the caller's address ALONE — nothing a caller supplies enters the key — and
    // this asserts the property that makes eviction safe.
    const throttle = new FixedWindowThrottle(2, 60_000, 4);
    const flooder = "203.0.113.5";
    expect(throttle.check(flooder, 0).allowed).toBe(true);
    expect(throttle.check(flooder, 0).allowed).toBe(true);
    // However hard it keeps trying, it occupies one key and stays refused for the window.
    for (let attempt = 0; attempt < 50; attempt += 1)
      expect(throttle.check(flooder, 0).allowed).toBe(false);
    expect(throttle.check(flooder, 60_001).allowed).toBe(true);
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
