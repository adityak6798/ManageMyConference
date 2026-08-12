// @acceptance ACC-INTEGRATION
// @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS PRD-INT-001
import { describe, expect, it } from "vitest";
import { AccelEventsProjectionProvider } from "../src/adapters/providers/accelevents-provider";
import { AirtableProjectionProvider } from "../src/adapters/providers/airtable-provider";
import {
  ProviderConfigurationError,
  resolveProviders,
} from "../src/adapters/providers/configuration";
import { DeterministicProvider } from "../src/adapters/providers/deterministic-provider";
import { HttpEmailProvider } from "../src/adapters/providers/email-provider";

const LIVE = {
  COMMUNICATIONS_PROVIDERS: "live",
  EMAIL_API_ENDPOINT: "https://mail.test/send",
  EMAIL_API_TOKEN: "email-token",
  EMAIL_SENDER: "events@greenroom.test",
  AIRTABLE_BASE_ID: "app1",
  AIRTABLE_TABLE_ID: "tbl1",
  AIRTABLE_TOKEN: "airtable-token",
  ACCELEVENTS_API_ENDPOINT: "https://accelevents.test/projections",
  ACCELEVENTS_TOKEN: "accelevents-token",
};

describe("provider selection", () => {
  it("defaults to the deterministic providers so a fresh clone needs no credentials", () => {
    const providers = resolveProviders({});

    expect(providers.email).toBeInstanceOf(DeterministicProvider);
    expect(providers.airtable).toBeInstanceOf(DeterministicProvider);
    expect(providers.accelevents).toBeInstanceOf(DeterministicProvider);
  });

  it("builds every live adapter when the configuration is complete", () => {
    const providers = resolveProviders(LIVE);

    expect(providers.email).toBeInstanceOf(HttpEmailProvider);
    expect(providers.airtable).toBeInstanceOf(AirtableProjectionProvider);
    expect(providers.accelevents).toBeInstanceOf(AccelEventsProjectionProvider);
  });

  it.each([
    ["EMAIL_API_TOKEN", "EMAIL_API_TOKEN"],
    ["AIRTABLE_TOKEN", "AIRTABLE_TOKEN"],
    ["ACCELEVENTS_TOKEN", "ACCELEVENTS_TOKEN"],
  ])("refuses to start when %s is missing rather than falling back to a fake", (name) => {
    // The failure mode this exists to prevent: a deployment that believes it is mailing
    // speakers while appending to an in-memory array.
    expect(() => resolveProviders({ ...LIVE, [name]: undefined })).toThrow(
      ProviderConfigurationError,
    );
    expect(() => resolveProviders({ ...LIVE, [name]: undefined })).toThrow(name);
  });

  it("names the missing binding without printing any configured value", () => {
    let message = "";
    try {
      resolveProviders({ ...LIVE, EMAIL_API_TOKEN: undefined });
    } catch (error) {
      // ERROR-INTENT: the message is the assertion subject; it is inspected, not swallowed.
      message = (error as Error).message;
    }

    expect(message).toContain("EMAIL_API_TOKEN");
    expect(message).not.toContain("airtable-token");
    expect(message).not.toContain("accelevents-token");
  });

  it.each(["production", "prod", "Production", " production ", "live"])(
    "refuses deterministic providers when ENVIRONMENT is %o",
    (environment) => {
      // Keying on one exact lowercase string made the guard depend on spelling: a Worker
      // deployed with ENVIRONMENT=prod would send every speaker a `fake:` reference and show
      // all green.
      expect(() => resolveProviders({ ENVIRONMENT: environment })).toThrow(
        ProviderConfigurationError,
      );
    },
  );

  it("names every missing binding at once, not one deploy cycle at a time", () => {
    let message = "";
    try {
      resolveProviders({
        COMMUNICATIONS_PROVIDERS: "live",
        EMAIL_API_ENDPOINT: LIVE.EMAIL_API_ENDPOINT,
        EMAIL_SENDER: LIVE.EMAIL_SENDER,
        AIRTABLE_BASE_ID: LIVE.AIRTABLE_BASE_ID,
        AIRTABLE_TABLE_ID: LIVE.AIRTABLE_TABLE_ID,
        ACCELEVENTS_API_ENDPOINT: LIVE.ACCELEVENTS_API_ENDPOINT,
      });
    } catch (error) {
      // ERROR-INTENT: the message is the assertion subject; it is inspected, not swallowed.
      message = (error as Error).message;
    }

    expect(message).toContain("EMAIL_API_TOKEN");
    expect(message).toContain("AIRTABLE_TOKEN");
    expect(message).toContain("ACCELEVENTS_TOKEN");
  });

  it.each([
    ["EMAIL_API_ENDPOINT", "http://mail.test/send"],
    ["ACCELEVENTS_API_ENDPOINT", "http://accelevents.test/projections"],
  ])("refuses to send a bearer token to %s over plaintext http", (name, value) => {
    expect(() => resolveProviders({ ...LIVE, [name]: value })).toThrow(ProviderConfigurationError);
    expect(() => resolveProviders({ ...LIVE, [name]: value })).toThrow("https:");
  });

  it.each(["EMAIL_API_ENDPOINT", "ACCELEVENTS_API_ENDPOINT"])(
    "refuses %s that is not an absolute URL, rather than burning retries on it",
    (name) => {
      expect(() => resolveProviders({ ...LIVE, [name]: "/send" })).toThrow(
        ProviderConfigurationError,
      );
    },
  );

  it("rejects a mode it does not recognize instead of guessing", () => {
    expect(() => resolveProviders({ COMMUNICATIONS_PROVIDERS: "real" })).toThrow(
      ProviderConfigurationError,
    );
  });
});
