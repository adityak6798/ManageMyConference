// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { runtimeAuth } from "../src/index";

describe("runtimeAuth", () => {
  it("requires explicit safe demo configuration", () => {
    expect(runtimeAuth({})).toEqual({ demoMode: false });
    expect(() => runtimeAuth({ DEMO_MODE: "true" })).toThrow("non-default SESSION_SECRET");
    expect(() =>
      runtimeAuth({ DEMO_MODE: "true", SESSION_SECRET: "local-development-secret" }),
    ).toThrow("non-default SESSION_SECRET");
    expect(() =>
      runtimeAuth({
        DEMO_MODE: "true",
        SESSION_SECRET: "safe-unique-key",
        ENVIRONMENT: "production",
      }),
    ).toThrow("disabled in production");
  });
});
