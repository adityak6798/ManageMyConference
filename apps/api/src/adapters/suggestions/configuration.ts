/**
 * Which suggestion provider this Worker drafts through, and why there is no third state.
 *
 * The same two-mode switch the delivery providers use, on its own binding because it is a
 * different domain with a different credential:
 *
 * - `fixture` (the default) — `DeterministicSuggestionProvider`. No network, no key, identical
 *   output on every run. This is what keeps `npm run check`, the D1 suite, Playwright and the
 *   demo working on a fresh clone.
 * - `live` — `AnthropicSuggestionProvider`, requiring `REVIEW_AI_API_KEY`.
 *
 * **A half-configured `live` throws.** It never falls back to the fixture, for the review-side
 * version of the reason `resolveProviders` gives: a deployment that believes a model is drafting
 * suggestions while a hash function actually is would put fabricated draft scores in front of
 * reviewers with a provenance line saying a model wrote them. The fixture names itself in the
 * provenance precisely so that lie is not available — and refusing the misconfiguration means
 * nobody has to notice.
 *
 * For the same reason `fixture` is refused when `ENVIRONMENT` names a production deployment.
 * Nobody chooses a hash function over a model on purpose in production.
 *
 * **Where the throw lands.** This resolves on the request that asks for a suggestion, not at
 * module load — so a misconfigured deployment deploys cleanly, serves every other route, and
 * fails only the Draft button. That is the right blast radius: review works without this port at
 * all, and a broken assistant must not take a reviewer's queue down with it. The route reports it
 * as an unavailable assistant with the manual path intact, and the binding name is in the Worker
 * log rather than the response.
 *
 * @spec PRD-AI-001 PORT-AI
 */
import type { ReviewSuggestionPort } from "../../application/review/suggestion-port";
import { AnthropicSuggestionProvider } from "./anthropic-suggestion-provider";
import { DeterministicSuggestionProvider } from "./deterministic-suggestion-provider";

/** Refused because the suggestion configuration is incoherent. Never carries a secret. */
export class SuggestionConfigurationError extends Error {}

export interface SuggestionEnvironment {
  /** `fixture` (the default), `live`, or `off`. */
  REVIEW_AI_PROVIDER?: string | undefined;
  ENVIRONMENT?: string | undefined;
  /** Anthropic API key. A Worker **secret**, never a var and never committed. */
  REVIEW_AI_API_KEY?: string | undefined;
  /** Pin a model version without redeploying the adapter. Non-secret. */
  REVIEW_AI_MODEL?: string | undefined;
}

/** The same set `resolveProviders` refuses fakes for, for the same reason. */
const PRODUCTION_NAMES = new Set(["production", "prod", "live"]);

/**
 * The port, or `null` when the operator has switched the assistant off.
 *
 * `off` is a first-class mode rather than an absence, because "the whole review workflow still
 * works with the port switched off" is an acceptance criterion of issue #110 and a mode nobody
 * can select is a claim nobody can check. With `off` the reviewer's queue never offers a Draft
 * button and every other review route behaves exactly as it did before this feature existed.
 */
export function resolveSuggestionProvider(
  environment: SuggestionEnvironment,
): ReviewSuggestionPort | null {
  const mode = environment.REVIEW_AI_PROVIDER ?? "fixture";
  if (mode !== "fixture" && mode !== "live" && mode !== "off")
    throw new SuggestionConfigurationError(
      `REVIEW_AI_PROVIDER must be "fixture", "live" or "off", not "${mode}"`,
    );
  if (mode === "off") return null;
  if (mode === "fixture") {
    if (PRODUCTION_NAMES.has((environment.ENVIRONMENT ?? "").trim().toLowerCase()))
      throw new SuggestionConfigurationError(
        `The deterministic suggestion provider is refused when ENVIRONMENT names a production deployment (got "${environment.ENVIRONMENT}"). ` +
          "Set REVIEW_AI_PROVIDER=live with a credential, or REVIEW_AI_PROVIDER=off to withdraw the assistant.",
      );
    return new DeterministicSuggestionProvider();
  }
  if (!environment.REVIEW_AI_API_KEY)
    throw new SuggestionConfigurationError(
      "REVIEW_AI_PROVIDER=live requires REVIEW_AI_API_KEY. Set it as a Worker secret " +
        "(`npx wrangler secret put REVIEW_AI_API_KEY`). See docs/engineering/review-suggestions.md.",
    );
  return new AnthropicSuggestionProvider({
    apiKey: environment.REVIEW_AI_API_KEY,
    ...(environment.REVIEW_AI_MODEL ? { model: environment.REVIEW_AI_MODEL } : {}),
  });
}
