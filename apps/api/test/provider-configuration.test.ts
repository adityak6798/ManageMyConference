// @acceptance ACC-INTEGRATION
// @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS PRD-INT-001
import { describe, expect, it } from "vitest";
import { AccelEventsProjectionProvider } from "../src/adapters/providers/accelevents-provider";
import { AirtableProjectionProvider } from "../src/adapters/providers/airtable-provider";
import {
  FixtureAccelEventsRegistrations,
  HttpAccelEventsRegistrations,
} from "../src/adapters/providers/accelevents-registration";
import {
  ProviderConfigurationError,
  resolveProviders,
  resolveRegistrationSource,
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

/** The inbound half, which needs its own origin and the Greenroom event it is bound to. */
const INBOUND = {
  ACCELEVENTS_API_ORIGIN: "https://accelevents.test/api",
  ACCELEVENTS_EVENT_REF: "ae-event-1",
  ACCELEVENTS_GREENROOM_EVENT_ID: "00000000-0000-4000-8000-000000000001",
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

  describe("the inbound registration source", () => {
    it("defaults to the fixture roster so a fresh clone can sync with no credential", () => {
      expect(resolveRegistrationSource({})).toBeInstanceOf(FixtureAccelEventsRegistrations);
    });

    it("builds the live client when the Accelevents configuration is complete", () => {
      expect(resolveRegistrationSource({ ...LIVE, ...INBOUND })).toBeInstanceOf(
        HttpAccelEventsRegistrations,
      );
    });

    it.each([
      "ACCELEVENTS_API_ORIGIN",
      "ACCELEVENTS_TOKEN",
      "ACCELEVENTS_EVENT_REF",
      // The one that is a data-exposure control rather than a connectivity one: without it a
      // single roster answers every Greenroom event that asks.
      "ACCELEVENTS_GREENROOM_EVENT_ID",
    ])("refuses live mode missing %s rather than answering from the fixture roster", (missing) => {
      const environment = { ...LIVE, ...INBOUND, [missing]: undefined };
      // The failure that matters is not the throw but what it prevents: a sync reporting
      // "3 registrants" from an in-repository list while the operator believes it read their
      // registration platform.
      expect(() => resolveRegistrationSource(environment)).toThrow(ProviderConfigurationError);
      expect(() => resolveRegistrationSource(environment)).toThrow(missing);
    });

    it("refuses the fixture roster where ENVIRONMENT names production", () => {
      for (const name of ["production", "prod", "Live"])
        expect(() => resolveRegistrationSource({ ENVIRONMENT: name })).toThrow(
          ProviderConfigurationError,
        );
    });

    it("names the missing binding without ever quoting its value", () => {
      // Every configuration failure is read by whoever holds the credentials; none of them may
      // echo one back into a log or a stack trace.
      try {
        resolveRegistrationSource({ ...LIVE, ...INBOUND, ACCELEVENTS_EVENT_REF: undefined });
      } catch (error) {
        // ERROR-INTENT: the refusal is the assertion subject; it is inspected, not swallowed.
        expect(String(error)).toContain("ACCELEVENTS_EVENT_REF");
        expect(String(error)).not.toContain("accelevents-token");
      }
    });
  });
});
