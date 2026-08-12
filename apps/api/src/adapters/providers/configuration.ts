/**
 * Which providers this Worker sends through, decided once at startup.
 *
 * Two modes, and the gap between them is the point:
 *
 * - `fixture` — the deterministic providers. No network, no credentials, identical results on
 *   every run. This is the default, which is what keeps `npm run check`, Playwright and the demo
 *   reset working offline on a fresh clone.
 * - `live` — the HTTP adapters, each requiring its full credential set.
 *
 * **There is no third state.** A partially configured `live` mode throws at startup rather than
 * quietly sending through a fake: a deployment that believes it is mailing speakers and is
 * actually appending to an in-memory array is the worst outcome available here, and it is the
 * one a silent fallback produces. For the same reason `fixture` is refused outright when
 * `ENVIRONMENT=production` — nobody chooses fakes in production on purpose.
 *
 * The failure message names the missing *variables*, never their values, and this module never
 * logs. Credentials pass through it into an adapter and stop there.
 *
 * @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS PRD-INT-001
 */
import type { DeliveryProvider } from "../../application/communications/ports";
import { AccelEventsProjectionProvider } from "./accelevents-provider";
import { AirtableProjectionProvider } from "./airtable-provider";
import { DeterministicProvider } from "./deterministic-provider";
import { HttpEmailProvider } from "./email-provider";

export type DeliveryProviders = Record<"email" | "airtable" | "accelevents", DeliveryProvider>;

/** Startup refused because the provider configuration is incoherent. Never carries a secret. */
export class ProviderConfigurationError extends Error {}

export interface ProviderEnvironment {
  COMMUNICATIONS_PROVIDERS?: string | undefined;
  ENVIRONMENT?: string | undefined;
  EMAIL_API_ENDPOINT?: string | undefined;
  EMAIL_API_TOKEN?: string | undefined;
  EMAIL_SENDER?: string | undefined;
  AIRTABLE_BASE_ID?: string | undefined;
  AIRTABLE_TABLE_ID?: string | undefined;
  AIRTABLE_TOKEN?: string | undefined;
  AIRTABLE_REFERENCE_FIELD?: string | undefined;
  ACCELEVENTS_API_ENDPOINT?: string | undefined;
  ACCELEVENTS_TOKEN?: string | undefined;
}

const demand = (
  environment: ProviderEnvironment,
  names: readonly (keyof ProviderEnvironment)[],
) => {
  const missing = names.filter((name) => !environment[name]);
  if (missing.length)
    throw new ProviderConfigurationError(
      `COMMUNICATIONS_PROVIDERS=live requires ${missing.join(", ")}. ` +
        "Set the missing binding(s) as Worker secrets, or leave COMMUNICATIONS_PROVIDERS unset " +
        "to use the deterministic providers.",
    );
};

export function resolveProviders(environment: ProviderEnvironment): DeliveryProviders {
  const mode = environment.COMMUNICATIONS_PROVIDERS ?? "fixture";
  if (mode !== "fixture" && mode !== "live")
    throw new ProviderConfigurationError(
      `COMMUNICATIONS_PROVIDERS must be "fixture" or "live", not "${mode}"`,
    );
  if (mode === "fixture") {
    if (environment.ENVIRONMENT === "production")
      throw new ProviderConfigurationError(
        "Deterministic providers are refused when ENVIRONMENT=production. Set " +
          "COMMUNICATIONS_PROVIDERS=live with real credentials, or do not run this build there.",
      );
    const provider = new DeterministicProvider();
    return { email: provider, airtable: provider, accelevents: provider };
  }

  demand(environment, ["EMAIL_API_ENDPOINT", "EMAIL_API_TOKEN", "EMAIL_SENDER"]);
  demand(environment, ["AIRTABLE_BASE_ID", "AIRTABLE_TABLE_ID", "AIRTABLE_TOKEN"]);
  demand(environment, ["ACCELEVENTS_API_ENDPOINT", "ACCELEVENTS_TOKEN"]);
  return {
    email: new HttpEmailProvider({
      endpoint: environment.EMAIL_API_ENDPOINT as string,
      token: environment.EMAIL_API_TOKEN as string,
      sender: environment.EMAIL_SENDER as string,
    }),
    airtable: new AirtableProjectionProvider({
      baseId: environment.AIRTABLE_BASE_ID as string,
      tableId: environment.AIRTABLE_TABLE_ID as string,
      token: environment.AIRTABLE_TOKEN as string,
      ...(environment.AIRTABLE_REFERENCE_FIELD
        ? { referenceField: environment.AIRTABLE_REFERENCE_FIELD }
        : {}),
    }),
    accelevents: new AccelEventsProjectionProvider({
      endpoint: environment.ACCELEVENTS_API_ENDPOINT as string,
      token: environment.ACCELEVENTS_TOKEN as string,
    }),
  };
}
