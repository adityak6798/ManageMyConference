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
 * **There is no third state.** A partially configured `live` mode throws rather than quietly
 * sending through a fake: a deployment that believes it is mailing speakers and is actually
 * appending to an in-memory array is the worst outcome available here, and it is the one a
 * silent fallback produces. For the same reason `fixture` is refused when `ENVIRONMENT` names a
 * production deployment — nobody chooses fakes in production on purpose.
 *
 * This resolves inside `drainOutbox`, on the scheduled trigger, rather than at module load. A
 * misconfigured deployment therefore deploys cleanly and serves requests; what it does not do is
 * send. Deliveries accumulate as `queued`, the drain throws once a minute, and everything drains
 * normally once configuration is fixed. Quiet, but it never invents a successful send.
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

/**
 * Every missing binding at once.
 *
 * Reporting one group at a time would cost an operator a deploy-and-wait cycle per missing
 * credential to discover the next one, so all three channels are checked before anything throws.
 */
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

/**
 * Anything an operator plausibly types for "this is the real one".
 *
 * Matching the single exact string `production` made the guard depend on spelling: a Worker
 * deployed with `ENVIRONMENT=prod` or `Production` got deterministic fakes, every send
 * "succeeded" with a `fake:` reference, and the history showed all green — precisely the
 * outcome this module exists to prevent.
 */
const PRODUCTION_NAMES = new Set(["production", "prod", "live"]);

export function resolveProviders(environment: ProviderEnvironment): DeliveryProviders {
  const mode = environment.COMMUNICATIONS_PROVIDERS ?? "fixture";
  if (mode !== "fixture" && mode !== "live")
    throw new ProviderConfigurationError(
      `COMMUNICATIONS_PROVIDERS must be "fixture" or "live", not "${mode}"`,
    );
  if (mode === "fixture") {
    if (PRODUCTION_NAMES.has((environment.ENVIRONMENT ?? "").trim().toLowerCase()))
      throw new ProviderConfigurationError(
        `Deterministic providers are refused when ENVIRONMENT names a production deployment (got "${environment.ENVIRONMENT}"). ` +
          "Set COMMUNICATIONS_PROVIDERS=live with real credentials, or do not run this build there.",
      );
    const provider = new DeterministicProvider();
    return { email: provider, airtable: provider, accelevents: provider };
  }

  demand(environment, [
    "EMAIL_API_ENDPOINT",
    "EMAIL_API_TOKEN",
    "EMAIL_SENDER",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_ID",
    "AIRTABLE_TOKEN",
    "ACCELEVENTS_API_ENDPOINT",
    "ACCELEVENTS_TOKEN",
  ]);
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
