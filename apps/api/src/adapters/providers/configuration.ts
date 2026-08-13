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
import type { AccelEventsRegistrationSource } from "../../application/communications/accelevents-sync";
import type { DeliveryProvider } from "../../application/communications/ports";
import {
  FixtureAccelEventsRegistrations,
  HttpAccelEventsRegistrations,
} from "./accelevents-registration";
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
  /**
   * Origin of the Accelevents API for the **inbound** registration read.
   *
   * Separate from `ACCELEVENTS_API_ENDPOINT` because the two directions need different things and
   * one binding cannot be both: the outbound projection POSTs to a complete endpoint URL verbatim,
   * while the inbound read appends the published attendee path to an origin.
   */
  ACCELEVENTS_API_ORIGIN?: string | undefined;
  /** The Accelevents event this deployment reads registrations from. */
  ACCELEVENTS_EVENT_REF?: string | undefined;
  /** The Greenroom event `ACCELEVENTS_EVENT_REF` corresponds to. */
  ACCELEVENTS_GREENROOM_EVENT_ID?: string | undefined;
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
        "Set the token bindings (EMAIL_API_TOKEN, AIRTABLE_TOKEN, ACCELEVENTS_TOKEN) as Worker " +
        "secrets and the rest as vars. See docs/engineering/communications-providers.md.",
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

/**
 * An endpoint that will carry a bearer token has to be an absolute HTTPS URL.
 *
 * Presence alone is not enough: a typo'd or `http:` endpoint is accepted as valid configuration
 * and then either burns three retries per delivery or transmits the credential in clear text.
 * Both are worth refusing at resolution rather than discovering per delivery.
 */
const demandHttpsUrl = (name: keyof ProviderEnvironment, value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // ERROR-INTENT: the parse failure's own message adds nothing an operator can act on; the
    // binding name and the requirement do.
    throw new ProviderConfigurationError(`${name} must be an absolute https:// URL`);
  }
  if (url.protocol !== "https:")
    throw new ProviderConfigurationError(
      `${name} must use https:; a bearer credential is sent with every request to it`,
    );
};

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
  demandHttpsUrl("EMAIL_API_ENDPOINT", environment.EMAIL_API_ENDPOINT as string);
  demandHttpsUrl("ACCELEVENTS_API_ENDPOINT", environment.ACCELEVENTS_API_ENDPOINT as string);
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

/**
 * The Accelevents registration source, chosen by the same switch and on the same terms.
 *
 * Separate from `resolveProviders` because it is read on a request rather than in the scheduled
 * drain — an organizer presses Preview and expects an answer — but the rule is identical:
 * `fixture` is the default and needs no credential, `live` requires the full Accelevents set and
 * throws naming what is missing rather than quietly answering from the fixture roster. A sync
 * that reports "3 registrants" from an in-repository list while the operator believes it read
 * their registration platform is the failure this refuses to produce.
 */
export function resolveRegistrationSource(
  environment: ProviderEnvironment,
): AccelEventsRegistrationSource {
  const mode = environment.COMMUNICATIONS_PROVIDERS ?? "fixture";
  if (mode !== "fixture" && mode !== "live")
    throw new ProviderConfigurationError(
      `COMMUNICATIONS_PROVIDERS must be "fixture" or "live", not "${mode}"`,
    );
  if (mode === "fixture") {
    if (PRODUCTION_NAMES.has((environment.ENVIRONMENT ?? "").trim().toLowerCase()))
      throw new ProviderConfigurationError(
        `The Accelevents fixture roster is refused when ENVIRONMENT names a production deployment (got "${environment.ENVIRONMENT}"). ` +
          "Set COMMUNICATIONS_PROVIDERS=live with real credentials, or do not run this build there.",
      );
    return new FixtureAccelEventsRegistrations();
  }
  demand(environment, [
    "ACCELEVENTS_API_ORIGIN",
    "ACCELEVENTS_TOKEN",
    "ACCELEVENTS_EVENT_REF",
    // Required, not optional: without it one deployment-wide Accelevents roster answers every
    // Greenroom event that asks, and an organizer authorized on their own event imports another
    // conference's attendees into it.
    "ACCELEVENTS_GREENROOM_EVENT_ID",
  ]);
  demandHttpsUrl("ACCELEVENTS_API_ORIGIN", environment.ACCELEVENTS_API_ORIGIN as string);
  return new HttpAccelEventsRegistrations({
    apiOrigin: environment.ACCELEVENTS_API_ORIGIN as string,
    token: environment.ACCELEVENTS_TOKEN as string,
    eventRef: environment.ACCELEVENTS_EVENT_REF as string,
    boundEventId: environment.ACCELEVENTS_GREENROOM_EVENT_ID as string,
  });
}
