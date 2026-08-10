// @acceptance ACC-HARNESS
import { describe, expect, it } from "vitest";
import { runtimeAuth } from "../src/index";

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
