/**
 * The live suggestion adapter: the Anthropic Messages API, over HTTPS.
 *
 * Credential-gated and never the default. Nothing in `npm run check`, the D1 suite, Playwright or
 * the demo constructs this class — `resolveSuggestionProvider` hands back the deterministic fake
 * unless an operator has set `REVIEW_AI_PROVIDER=live` and supplied a key.
 *
 * **Why raw `fetch` and not `@anthropic-ai/sdk`.** The official SDK is the better default for an
 * ordinary Node service, and it was the first thing tried here. It pulls `node:fs` and `node:path`
 * into the bundle for its credential-chain support, which a Worker resolves only with the
 * `nodejs_compat` compatibility flag — a runtime change affecting every route in the deployment,
 * decided from inside one domain's pull request, to serve one adapter that is off by default. The
 * other three live adapters in this repository already speak raw `fetch` and normalize through a
 * shared outcome table, the adapters layer has an enforced external-package allowlist, and
 * `provider-contract.test.ts` proves those adapters by stubbing `fetch`. Matching that shape keeps
 * the deployed Worker's compatibility surface untouched and makes this adapter testable the same
 * way its three siblings are. Revisit if the Worker ever needs `nodejs_compat` for its own reasons.
 *
 * Three further decisions, each a place a later edit could quietly do harm:
 *
 * 1. **The prompt carries no identity.** `SuggestionRequest` has no field for a submitter, and
 *    this adapter adds none. Blind review is a promise made to reviewers about a proposal's
 *    author; sending that author's name to a third party to get a draft score would break it in
 *    the one direction nobody would notice.
 * 2. **The response shape is constrained, not parsed hopefully.** `output_config.format` pins a
 *    JSON schema, so the reply either matches or the request fails — there is no regex, no
 *    retry-on-parse loop, and no half-read draft reaching a reviewer.
 * 3. **A failure is a failure.** Every error path throws `SuggestionUnavailableError` with a
 *    normalized code and no provider text, and the reviewer goes on scoring by hand. There is no
 *    fallback to the fixture: a deployment that believed a model was drafting suggestions while a
 *    hash function actually was would be the review-side twin of the delivery failure
 *    `providers/configuration.ts` exists to prevent.
 *
 * **The deployed adapter has been smoke-tested.** The 2026-08-13 staging run recorded in
 * `docs/engineering/review-suggestions.md` covered schema-valid generation from `claude-opus-5`,
 * persistence, accept-as-draft, separate completion, missing and revoked credentials, a live
 * safety refusal, and inspection of the identity-free outbound request. No credential exists in
 * this repository, and the contract test still stubs `fetch` so ordinary CI remains deterministic.
 *
 * @spec PRD-AI-001 PORT-AI PRD-REV-001
 */
import type {
  ReviewSuggestionPort,
  SuggestionDraft,
  SuggestionRequest,
} from "../../application/review/suggestion-port";
import { SuggestionUnavailableError } from "../../application/review/suggestion-port";
import type { ReviewCriterion } from "../../domain/review/review";
import type { SuggestedScore } from "../../domain/review/suggestion";
import { SUGGESTION_PROMPT_VERSION } from "./deterministic-suggestion-provider";

/**
 * The default model.
 *
 * Overridable with `REVIEW_AI_MODEL` so an operator can pin a version without a deploy of this
 * file, but the recorded provenance always names the model the API says served the request — not
 * this constant and not the binding — so a substitution upstream is visible in the record.
 */
export const DEFAULT_SUGGESTION_MODEL = "claude-opus-5";

/** The Messages API endpoint and the version header it requires. */
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export interface AnthropicSuggestionConfiguration {
  /** Bearer credential. Held only here and never logged, stored, or returned. */
  readonly apiKey: string;
  readonly model?: string;
  /** Full endpoint URL. Present for the contract suite; a deployment never sets it. */
  readonly endpoint?: string;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The response shape, pinned.
 *
 * `value` is a string for every criterion type, including numeric ones, and this adapter converts.
 * A union would be one more thing for the schema compiler and the model to agree about on a path
 * that has never met the real API; a string that fails to parse becomes a value the plan
 * validation refuses at acceptance time, which is a visible, recoverable state rather than a
 * malformed number sitting in a draft.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences describing what the abstract proposes.",
    },
    scores: {
      type: "array",
      description: "Exactly one entry per criterion, in the order the criteria were given.",
      items: {
        type: "object",
        properties: {
          criterionId: { type: "string" },
          value: {
            type: "string",
            description:
              "For a numeric criterion, the number as digits and nothing else. For a dropdown, exactly one of its options, verbatim.",
          },
          rationale: {
            type: "string",
            description: "One or two sentences justifying this value from the abstract's text.",
          },
        },
        required: ["criterionId", "value", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "scores"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  "You draft review suggestions for a conference programme committee.",
  "A human reviewer reads what you produce and decides whether to accept any of it; nothing you write is recorded as a score until they do. Draft accordingly: say what the abstract supports and say plainly where it is thin, rather than hedging toward the middle of every scale.",
  "Score only against the criteria you are given, using each criterion's own scale. Judge the abstract as written — never speculate about who submitted it, and never treat the absence of an author as a reason to discount the work.",
  "Give the reason for each value in terms a reviewer can check against the text in front of them.",
].join("\n\n");

/** The rubric, as text the model can score against. */
const describeCriterion = (criterion: ReviewCriterion): string => {
  if (criterion.type === "dropdown")
    return `- ${criterion.id} — ${criterion.name}: ${criterion.description}. Choose exactly one of: ${criterion.options.join(", ")}.`;
  if (criterion.type === "text")
    return `- ${criterion.id} — ${criterion.name}: ${criterion.description}. Free text, at most ${criterion.maxLength} characters.`;
  return `- ${criterion.id} — ${criterion.name}: ${criterion.description}. A whole number from ${criterion.minScore} to ${criterion.maxScore}.`;
};

const buildPrompt = (request: SuggestionRequest): string =>
  [
    `This is review round ${request.round}.`,
    "",
    "Abstract under review:",
    `Title: ${request.title}`,
    "",
    request.abstract,
    ...(request.answers.length
      ? [
          "",
          "Further answers from the submission form:",
          ...request.answers.map(({ label, value }) => `${label}: ${value}`),
        ]
      : []),
    "",
    "Criteria:",
    ...request.criteria.map(describeCriterion),
  ].join("\n");

/** A numeric criterion's value as a number, or the raw string when it will not parse. */
const valueFor = (criterion: ReviewCriterion | undefined, raw: string): number | string => {
  if (criterion && criterion.type !== "dropdown" && criterion.type !== "text") {
    const parsed = Number(raw.trim());
    // ERROR-INTENT: an unparsable number is carried through as the string the model returned,
    // where the plan validation refuses it at acceptance time and names the criterion. Coercing
    // it to a default here would put a score nobody chose in front of a reviewer.
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
};

/**
 * A status onto a normalized code.
 *
 * The same vocabulary and the same reasoning as `providers/http-outcome.ts` — 401/403 terminal
 * because retrying with a dead credential only delays the operator finding out, 429 and 5xx worth
 * another press — but a deliberately separate table, because these codes reach a *reviewer's*
 * screen rather than an organizer's delivery history, and joining the two would make one
 * vocabulary answer to two audiences.
 */
const codeForStatus = (status: number): string => {
  if (status === 408) return "PROVIDER_TIMEOUT";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  if (status === 401 || status === 403) return "PROVIDER_UNAUTHORIZED";
  return "PROVIDER_REJECTED";
};

/** A JSON object, as opposed to null, an array, or a scalar the `as` cast would have hidden. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface MessagesResponse {
  model?: string;
  stop_reason?: string | null;
  content?: { type?: string; text?: string }[];
}

export class AnthropicSuggestionProvider implements ReviewSuggestionPort {
  private readonly model: string;
  private readonly endpoint: string;

  constructor(
    private readonly configuration: AnthropicSuggestionConfiguration,
    private readonly fetch: Fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.model = configuration.model ?? DEFAULT_SUGGESTION_MODEL;
    this.endpoint = configuration.endpoint ?? ENDPOINT;
  }

  async suggest(request: SuggestionRequest): Promise<SuggestionDraft> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          "x-api-key": this.configuration.apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          // Low effort with thinking left on, rather than thinking disabled: this is a short,
          // well-specified drafting task with a person waiting, and disabling thinking on this
          // model tier trades the latency saving for output that can carry internal markup into
          // the visible text. `max_tokens` covers thinking and answer together, hence the headroom.
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: RESPONSE_SCHEMA },
          },
          messages: [{ role: "user", content: buildPrompt(request) }],
        }),
        // The port's contract: the implementation owns the deadline. The service races it as a
        // backstop, but only this abort actually releases the connection.
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      // ERROR-INTENT: a transport failure carries an untrusted message that can name internal
      // hosts, and this code reaches a reviewer's screen — so only the *kind* of failure crosses.
      // The deadline is separated from the rest because a reviewer acts on it differently and the
      // documented code table already distinguishes it: `AbortSignal.timeout` rejects with a
      // `TimeoutError`, which folded into `PROVIDER_UNREACHABLE` would have told somebody to check
      // their network when the model was simply slow.
      if ((error as { name?: string })?.name === "TimeoutError")
        throw new SuggestionUnavailableError("PROVIDER_TIMEOUT");
      throw new SuggestionUnavailableError("PROVIDER_UNREACHABLE");
    }

    if (response.status < 200 || response.status >= 300)
      throw new SuggestionUnavailableError(codeForStatus(response.status));

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      // ERROR-INTENT: an unparsable body is untrusted provider text and is never stored or logged;
      // the normalized code is what an operator acts on.
      throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");
    }
    // Checked rather than cast. A 2xx carrying `null`, or a `content` that is not an array, is a
    // malformed *response* — casting it and reading through would throw a TypeError that escapes
    // as a 500, turning the provider's bad day into our internal error.
    if (!isRecord(decoded)) throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");
    const body = decoded as MessagesResponse;
    if (!Array.isArray(body.content))
      throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");

    // A safety decline is a 200 with no usable content, so it is checked before the content is
    // read rather than surfacing later as an unexplained parse failure.
    if (body.stop_reason === "refusal") throw new SuggestionUnavailableError("PROVIDER_REFUSED");

    const text = body.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");
    let parsed: { summary?: unknown; scores?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      // ERROR-INTENT: `output_config.format` is supposed to make this unreachable; if it is not,
      // the body is untrusted provider text and the code is the whole report.
      throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");
    }
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.scores))
      throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");

    const byId = new Map(request.criteria.map((criterion) => [criterion.id, criterion]));
    const scores: SuggestedScore[] = [];
    for (const entry of parsed.scores as unknown[]) {
      // ERROR-INTENT: a `null` or a bare string in the array is dropped rather than destructured.
      // Reading through it throws a TypeError that leaves as a 500, which would report a provider
      // returning junk as a fault in this Worker.
      if (!isRecord(entry)) continue;
      const { criterionId, value, rationale } = entry;
      // ERROR-INTENT: an entry naming a criterion this rubric does not have, or missing its value
      // or reason, is dropped rather than stored — the plan validation then refuses acceptance and
      // names the criterion left without a draft, which is what the reviewer needs to know.
      if (typeof criterionId !== "string" || !byId.has(criterionId)) continue;
      if (typeof value !== "string" || typeof rationale !== "string") continue;
      scores.push({ criterionId, value: valueFor(byId.get(criterionId), value), rationale });
    }

    // Required, not defaulted. Falling back to the model this deployment *asked* for would write
    // a provenance line claiming something the API never said — and provenance nobody can trust
    // is the one thing this feature cannot ship with.
    if (typeof body.model !== "string" || !body.model)
      throw new SuggestionUnavailableError("MALFORMED_PROVIDER_RESPONSE");
    return {
      summary: parsed.summary,
      scores,
      // The model the API says served the request, so a substitution upstream is recorded rather
      // than hidden behind the model this deployment asked for.
      model: body.model,
      promptVersion: SUGGESTION_PROMPT_VERSION,
    };
  }
}
