/**
 * Which providers this Worker sends through, decided once at startup.
 *
 * Two modes, and the gap between them is the point:
 *
 * - `fixture` — the deterministic providers. No network, no credentials, identical results on
 *   every run. This is the default, which is what keeps `npm run check`, Playwright and the demo
 *   reset working offline on a fresh clone.
 * - `live` — the HTTP adapters, **per channel**, each requiring its full credential set.
 *
 * ## The switch is per channel, and that is a change worth reading
 *
 * `live` used to demand all eight bindings at once, so a deployment that wanted real email had to
 * hold Airtable and Accelevents credentials as well — which the deployment this repository
 * actually runs has no use for and no way to obtain. It could therefore send nothing at all.
 * Each channel is now decided on its own bindings.
 *
 * **A channel is still all-or-nothing.** Three of email's three bindings or none of them; a
 * partial set throws, exactly as `resolveGoogleConfiguration` refuses two Google bindings of
 * three. Every channel is checked before anything throws, so an operator learns every missing
 * binding in one deploy cycle rather than one per cycle.
 *
 * **A channel nobody configured does not become a silent fake on a deployment that believes it
 * is live.** Two cases, and they are the same rule the whole-`fixture` mode has always had:
 *
 * - `ENVIRONMENT` names a **development** deployment (`DEVELOPMENT_NAMES`) — the unconfigured
 *   channel gets `DeterministicProvider`, which is what a deployment running the demo beside a
 *   real conference needs: mail goes out for real while the Airtable and Accelevents projections
 *   nobody has credentials for keep answering the demo.
 * - **anything else, including a name nobody recognizes** — the unconfigured channel gets
 *   `UnconfiguredProvider`, which refuses every delivery terminally and names the bindings that
 *   would make it real. Nothing is reported as sent. Refusing *at resolution* was the other option
 *   and is worse: it would take the whole drain down, so the configured channel would stop sending
 *   too.
 *
 * The question is "is this a development environment?" rather than "is this production?" because
 * the second fails open on a typo: `ENVIRONMENT=production-eu` matched no production name, and an
 * unconfigured channel there answered `fake:` and wrote projection state saying it had pushed.
 * Under the all-or-nothing switch this replaced, that configuration refused to resolve at all — so
 * asking the question the other way round was the one case where the split made a deployment
 * quietly worse.
 *
 * So a channel is quietly deterministic **only** where somebody wrote down that this is a
 * development deployment. With `fixture` a production name is refused at resolution; with `live`
 * anything not named as development is refused per delivery.
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
import { UnconfiguredProvider } from "./unconfigured-provider";

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
 * One channel's bindings, and what counts as having asked for it.
 *
 * `required` is the whole set — a channel is live only with all of it. `distinctive` is the
 * subset whose presence means somebody meant to configure *this* channel, and it exists because
 * `ACCELEVENTS_TOKEN` belongs to two of them: the outbound projection and the inbound
 * registration read. Treating the shared token as a request would make configuring the outbound
 * channel demand the inbound one's origin and event reference as well, which is precisely the
 * all-or-nothing coupling this split removes.
 */
interface ChannelBindings {
  readonly channel: string;
  readonly required: readonly (keyof ProviderEnvironment)[];
  readonly distinctive: readonly (keyof ProviderEnvironment)[];
}

const EMAIL: ChannelBindings = {
  channel: "email",
  required: ["EMAIL_API_ENDPOINT", "EMAIL_API_TOKEN", "EMAIL_SENDER"],
  distinctive: ["EMAIL_API_ENDPOINT", "EMAIL_API_TOKEN", "EMAIL_SENDER"],
};
const AIRTABLE: ChannelBindings = {
  channel: "airtable",
  // `AIRTABLE_REFERENCE_FIELD` is genuinely optional — the adapter has a default for it — so it
  // is in neither list. Every other binding here is required.
  required: ["AIRTABLE_BASE_ID", "AIRTABLE_TABLE_ID", "AIRTABLE_TOKEN"],
  distinctive: ["AIRTABLE_BASE_ID", "AIRTABLE_TABLE_ID", "AIRTABLE_TOKEN"],
};
const ACCELEVENTS: ChannelBindings = {
  channel: "accelevents",
  required: ["ACCELEVENTS_API_ENDPOINT", "ACCELEVENTS_TOKEN"],
  distinctive: ["ACCELEVENTS_API_ENDPOINT"],
};
const REGISTRATIONS: ChannelBindings = {
  channel: "accelevents registrations",
  required: [
    "ACCELEVENTS_API_ORIGIN",
    "ACCELEVENTS_TOKEN",
    "ACCELEVENTS_EVENT_REF",
    // Required, not optional: without it one deployment-wide Accelevents roster answers every
    // Greenroom event that asks, and an organizer authorized on their own event imports another
    // conference's attendees into it.
    "ACCELEVENTS_GREENROOM_EVENT_ID",
  ],
  distinctive: [
    "ACCELEVENTS_API_ORIGIN",
    "ACCELEVENTS_EVENT_REF",
    "ACCELEVENTS_GREENROOM_EVENT_ID",
  ],
};

const isConfigured = (environment: ProviderEnvironment, spec: ChannelBindings) =>
  spec.distinctive.some((name) => environment[name]);

/**
 * Every missing binding at once, across every channel somebody asked for.
 *
 * Reporting one group at a time would cost an operator a deploy-and-wait cycle per missing
 * credential to discover the next one, so all the requested channels are checked before anything
 * throws. A channel nobody asked for contributes nothing here: it is not missing bindings, it is
 * simply not configured, and `resolveProviders` decides what it gets instead.
 */
const demand = (environment: ProviderEnvironment, specs: readonly ChannelBindings[]) => {
  const partial = specs
    .filter((spec) => isConfigured(environment, spec))
    .map((spec) => ({
      spec,
      missing: spec.required.filter((name) => !environment[name]),
    }))
    .filter(({ missing }) => missing.length > 0);
  if (!partial.length) return;
  throw new ProviderConfigurationError(
    `COMMUNICATIONS_PROVIDERS=live is partly configured: ${partial
      .map(({ spec, missing }) => `the ${spec.channel} channel requires ${missing.join(", ")}`)
      .join("; ")}. Each channel is all-or-nothing — set every binding it needs or none of them, ` +
      "and a channel with none of them set falls back to the deterministic provider. Set the " +
      "token bindings (EMAIL_API_TOKEN, AIRTABLE_TOKEN, ACCELEVENTS_TOKEN) as Worker secrets and " +
      "the rest as vars. See docs/engineering/communications-providers.md.",
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
 * The environments a deterministic fake is *allowed* on, named positively.
 *
 * The first version of the per-channel split asked the opposite question — "is this production?" —
 * and gave every other spelling a deterministic fake. That is fail-open on a typo: a Worker
 * deployed with `ENVIRONMENT=production-eu` and `COMMUNICATIONS_PROVIDERS=live` matched none of
 * the three production names, so an unconfigured Airtable channel answered `fake:` for every
 * projection *and* wrote projection state recording it as pushed. The console showed green and
 * nothing had left the machine. Under the code this replaced, that same configuration refused to
 * resolve at all, so the split had made one configuration quietly worse.
 *
 * Asking "is this a development environment?" fails the safe way instead: an unrecognized value
 * gets the provider that refuses, and an operator who wants fakes says so in a word this set
 * contains. `PRODUCTION_NAMES` still exists because `fixture` mode needs the other question — it
 * refuses outright there, which an unrecognized name must not do to a whole deployment.
 */
const DEVELOPMENT_NAMES = new Set(["development", "dev", "local", "test", "ci", "preview"]);

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

/** Whether this deployment says it is the real one, by any of the names an operator types. */
const namesProduction = (environment: ProviderEnvironment) =>
  PRODUCTION_NAMES.has((environment.ENVIRONMENT ?? "").trim().toLowerCase());

const mustNotFake = (environment: ProviderEnvironment, what: string) => {
  if (namesProduction(environment))
    throw new ProviderConfigurationError(
      `${what} are refused when ENVIRONMENT names a production deployment (got "${environment.ENVIRONMENT}"). ` +
        "Set COMMUNICATIONS_PROVIDERS=live with real credentials, or do not run this build there.",
    );
};

/** Whether this deployment has said, in a word the allow-list contains, that it is not real. */
const namesDevelopment = (environment: ProviderEnvironment) =>
  DEVELOPMENT_NAMES.has((environment.ENVIRONMENT ?? "").trim().toLowerCase());

/**
 * The same refusal as `mustNotFake`, asked the safe way round, for the `live` paths.
 *
 * `mustNotFake` is the whole-deployment question and stays a production deny-list on purpose: it
 * refuses `fixture` mode outright, and refusing a whole deployment on a name nobody recognized
 * would take the demo down for anybody who spelled their environment unusually. Under `live` the
 * question is per channel and the cost of the strict answer is one channel refusing, so an
 * unrecognized name gets the safe answer here instead.
 */
const mustBeDevelopment = (environment: ProviderEnvironment, what: string) => {
  if (!namesDevelopment(environment))
    throw new ProviderConfigurationError(
      `${what} are refused under COMMUNICATIONS_PROVIDERS=live unless ENVIRONMENT names a ` +
        `development deployment (got "${environment.ENVIRONMENT ?? ""}"). Configure the real ` +
        "bindings, or accept that this channel is not in use. Renaming ENVIRONMENT is not the " +
        "fix: it also hands every other unconfigured channel a deterministic fake, on the same " +
        "deployment, which is what this refusal exists to prevent.",
    );
};

/**
 * What a channel nobody configured gets under `live`.
 *
 * The deterministic fake **only** on a deployment that names itself a development one; everything
 * else — production, and every spelling nobody recognizes — gets the provider that refuses. See
 * `DEVELOPMENT_NAMES` for why the question is asked that way round, and this module's header for
 * why refusing here rather than at resolution is what lets the channels an operator *did*
 * configure keep sending.
 */
const unconfiguredChannel = (
  environment: ProviderEnvironment,
  spec: ChannelBindings,
): DeliveryProvider =>
  namesDevelopment(environment)
    ? new DeterministicProvider()
    : new UnconfiguredProvider(spec.channel, spec.required);

export function resolveProviders(environment: ProviderEnvironment): DeliveryProviders {
  const mode = environment.COMMUNICATIONS_PROVIDERS ?? "fixture";
  if (mode !== "fixture" && mode !== "live")
    throw new ProviderConfigurationError(
      `COMMUNICATIONS_PROVIDERS must be "fixture" or "live", not "${mode}"`,
    );
  if (mode === "fixture") {
    mustNotFake(environment, "Deterministic providers");
    const provider = new DeterministicProvider();
    return { email: provider, airtable: provider, accelevents: provider };
  }

  demand(environment, [EMAIL, AIRTABLE, ACCELEVENTS]);
  if (isConfigured(environment, EMAIL))
    demandHttpsUrl("EMAIL_API_ENDPOINT", environment.EMAIL_API_ENDPOINT as string);
  if (isConfigured(environment, ACCELEVENTS))
    demandHttpsUrl("ACCELEVENTS_API_ENDPOINT", environment.ACCELEVENTS_API_ENDPOINT as string);
  return {
    email: isConfigured(environment, EMAIL)
      ? new HttpEmailProvider({
          endpoint: environment.EMAIL_API_ENDPOINT as string,
          token: environment.EMAIL_API_TOKEN as string,
          sender: environment.EMAIL_SENDER as string,
        })
      : unconfiguredChannel(environment, EMAIL),
    airtable: isConfigured(environment, AIRTABLE)
      ? new AirtableProjectionProvider({
          baseId: environment.AIRTABLE_BASE_ID as string,
          tableId: environment.AIRTABLE_TABLE_ID as string,
          token: environment.AIRTABLE_TOKEN as string,
          ...(environment.AIRTABLE_REFERENCE_FIELD
            ? { referenceField: environment.AIRTABLE_REFERENCE_FIELD }
            : {}),
        })
      : unconfiguredChannel(environment, AIRTABLE),
    accelevents: isConfigured(environment, ACCELEVENTS)
      ? new AccelEventsProjectionProvider({
          endpoint: environment.ACCELEVENTS_API_ENDPOINT as string,
          token: environment.ACCELEVENTS_TOKEN as string,
        })
      : unconfiguredChannel(environment, ACCELEVENTS),
  };
}

/**
 * The Accelevents registration source, chosen by the same switch and on the same terms.
 *
 * Separate from `resolveProviders` because it is read on a request rather than in the scheduled
 * drain — an organizer presses Preview and expects an answer — but the rule is the same one, and
 * it is a channel of its own under the split: `fixture` is the default and needs no credential;
 * a `live` deployment that has configured the inbound bindings reads the real roster; a `live`
 * deployment that has not configured *any* of them keeps the fixture roster, because it is a
 * channel nobody asked for rather than one half set up.
 *
 * The one refusal that never softens is the fake on a deployment nobody has said is a development
 * one. A sync reporting "3 registrants" from an in-repository list while the operator believes it
 * read their registration platform is the failure this exists to prevent — and here, unlike in the
 * drain, throwing is exactly right: this runs on a request, so the refusal reaches the organizer
 * who pressed the button instead of taking a scheduled job down.
 *
 * **The `live` branch asks `mustBeDevelopment`, and that is a repair.** It used to ask the
 * production deny-list, so `ENVIRONMENT=production-eu` with `live` and no inbound bindings
 * answered from the fixture roster while `index.ts` reported the mode as `live` to the organizer
 * — and an apply then wrote an invented roster into a real event's content. On the code the
 * per-channel split replaced, `live` demanded all four bindings unconditionally and threw, so this
 * was one configuration the split made quietly worse. `fixture` keeps the deny-list, because that
 * refusal takes a whole deployment down and an unrecognized name must not do that.
 */
export function resolveRegistrationSource(
  environment: ProviderEnvironment,
): AccelEventsRegistrationSource {
  const mode = environment.COMMUNICATIONS_PROVIDERS ?? "fixture";
  if (mode !== "fixture" && mode !== "live")
    throw new ProviderConfigurationError(
      `COMMUNICATIONS_PROVIDERS must be "fixture" or "live", not "${mode}"`,
    );
  if (mode === "live") demand(environment, [REGISTRATIONS]);
  if (mode === "fixture" || !isConfigured(environment, REGISTRATIONS)) {
    if (mode === "live") mustBeDevelopment(environment, "The Accelevents fixture roster");
    else mustNotFake(environment, "The Accelevents fixture roster");
    return new FixtureAccelEventsRegistrations();
  }
  demandHttpsUrl("ACCELEVENTS_API_ORIGIN", environment.ACCELEVENTS_API_ORIGIN as string);
  return new HttpAccelEventsRegistrations({
    apiOrigin: environment.ACCELEVENTS_API_ORIGIN as string,
    token: environment.ACCELEVENTS_TOKEN as string,
    eventRef: environment.ACCELEVENTS_EVENT_REF as string,
    boundEventId: environment.ACCELEVENTS_GREENROOM_EVENT_ID as string,
  });
}
