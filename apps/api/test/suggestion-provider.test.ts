// @acceptance ACC-REVIEW
// @spec PRD-AI-001 PORT-AI
//
// The two suggestion adapters and the switch between them.
//
// The live half stubs `fetch`, exactly as `provider-contract.test.ts` does for the three delivery
// adapters — so what it proves is this adapter's normalization and request shape, **not** the
// Anthropic API. No credential exists in this repository and none is needed to run this file.
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicSuggestionProvider,
  DEFAULT_SUGGESTION_MODEL,
} from "../src/adapters/suggestions/anthropic-suggestion-provider";
import {
  resolveSuggestionProvider,
  SuggestionConfigurationError,
} from "../src/adapters/suggestions/configuration";
import { DeterministicSuggestionProvider } from "../src/adapters/suggestions/deterministic-suggestion-provider";
import type { SuggestionRequest } from "../src/application/review/suggestion-port";
import { SuggestionUnavailableError } from "../src/application/review/suggestion-port";

/** The rejection itself, so a test can assert on the typed error's own fields. */
const refusalOf = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

const request = (overrides: Partial<SuggestionRequest> = {}): SuggestionRequest => ({
  title: "Streaming joins without a state store",
  abstract: "Watermarks are enough. The rest is bookkeeping nobody needs.",
  answers: [{ label: "Session format", value: "Workshop" }],
  criteria: [
    { id: "fit", name: "Fit", description: "Audience fit", minScore: 1, maxScore: 5 },
    {
      id: "novelty",
      name: "Novelty",
      description: "How new",
      type: "dropdown",
      options: ["Low", "Medium", "High"],
    },
    { id: "notes", name: "Notes", description: "Free text", type: "text", maxLength: 200 },
  ],
  round: 1,
  timeoutMs: 1_000,
  ...overrides,
});

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A well-formed Messages reply carrying the JSON the pinned schema asks for. */
const modelReply = (payload: unknown, model = "claude-opus-5") =>
  response({
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

const DRAFT = {
  summary: "A talk about watermark-only stream joins.",
  scores: [
    { criterionId: "fit", value: "4", rationale: "Squarely on topic." },
    { criterionId: "novelty", value: "High", rationale: "Uncommon approach." },
    { criterionId: "notes", value: "Ask for a demo.", rationale: "The claim needs showing." },
  ],
};

describe("the deterministic suggestion provider", () => {
  it("produces the same draft twice for the same abstract", async () => {
    const first = await new DeterministicSuggestionProvider().suggest(request());
    const second = await new DeterministicSuggestionProvider().suggest(request());

    // Byte-identical, not merely similar: a browser test asserts the drafted value itself, which
    // is only possible while this holds on every machine and every run.
    expect(first).toEqual(second);
  });

  it("draws a different draft from a different abstract", async () => {
    const first = await new DeterministicSuggestionProvider().suggest(request());
    const second = await new DeterministicSuggestionProvider().suggest(
      request({ abstract: "Something else entirely, on a different subject." }),
    );

    expect(first.scores).not.toEqual(second.scores);
  });

  it("answers every criterion within its own scale", async () => {
    const draft = await new DeterministicSuggestionProvider().suggest(request());

    const byId = new Map(draft.scores.map(({ criterionId, value }) => [criterionId, value]));
    expect(byId.get("fit")).toBeGreaterThanOrEqual(1);
    expect(byId.get("fit")).toBeLessThanOrEqual(5);
    expect(["Low", "Medium", "High"]).toContain(byId.get("novelty"));
    expect(String(byId.get("notes")).length).toBeLessThanOrEqual(200);
    // It says what it is. A fixture that sounded like a judgement would invite a demo to be read
    // as evidence the feature works.
    expect(draft.model).toBe("fixture-suggester-v1");
    expect(draft.summary).toContain("no model read this abstract");
  });

  it("reaches both failure modes without a network", async () => {
    await expect(new DeterministicSuggestionProvider("timeout").suggest(request())).rejects.toThrow(
      SuggestionUnavailableError,
    );
    await expect(new DeterministicSuggestionProvider("error").suggest(request())).rejects.toThrow(
      SuggestionUnavailableError,
    );
  });
});

describe("suggestion provider selection", () => {
  it("defaults to the fixture so a fresh clone needs no credential", () => {
    expect(resolveSuggestionProvider({})).toBeInstanceOf(DeterministicSuggestionProvider);
  });

  it("withdraws the assistant entirely when switched off", () => {
    expect(resolveSuggestionProvider({ REVIEW_AI_PROVIDER: "off" })).toBeNull();
  });

  it("refuses to start live without a credential rather than falling back to the fixture", () => {
    // The failure this exists to prevent: a deployment that believes a model is drafting
    // suggestions while a hash function actually is, with provenance saying otherwise.
    expect(() => resolveSuggestionProvider({ REVIEW_AI_PROVIDER: "live" })).toThrow(
      SuggestionConfigurationError,
    );
    expect(() => resolveSuggestionProvider({ REVIEW_AI_PROVIDER: "live" })).toThrow(
      /REVIEW_AI_API_KEY/,
    );
  });

  it("never puts the credential into the failure message", () => {
    const refusal = (() => {
      try {
        resolveSuggestionProvider({ REVIEW_AI_PROVIDER: "live" });
        return "";
      } catch (error) {
        // ERROR-INTENT: the refusal is the assertion — this test exists to read its message and
        // prove the credential is not in it.
        return (error as Error).message;
      }
    })();

    expect(refusal).not.toContain("sk-");
  });

  it("builds the live adapter when the credential is present", () => {
    expect(
      resolveSuggestionProvider({ REVIEW_AI_PROVIDER: "live", REVIEW_AI_API_KEY: "sk-test" }),
    ).toBeInstanceOf(AnthropicSuggestionProvider);
  });

  it("refuses the fixture when ENVIRONMENT names a production deployment", () => {
    for (const environment of ["production", "Prod", "LIVE"])
      expect(() => resolveSuggestionProvider({ ENVIRONMENT: environment })).toThrow(
        SuggestionConfigurationError,
      );
  });

  it("refuses a mode it does not recognize", () => {
    expect(() => resolveSuggestionProvider({ REVIEW_AI_PROVIDER: "maybe" })).toThrow(
      SuggestionConfigurationError,
    );
  });
});

describe("the live suggestion adapter", () => {
  it("sends the rubric and the masked abstract, and nothing else", async () => {
    const fetch = vi.fn().mockResolvedValue(modelReply(DRAFT));
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    await provider.suggest(request());

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_SUGGESTION_MODEL);
    // The response shape is pinned rather than parsed hopefully.
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content).toContain("Streaming joins without a state store");
    expect(body.messages[0].content).toContain("A whole number from 1 to 5");
    // There is nowhere in the request to put a submitter, and this proves none arrived anyway.
    expect(init.body).not.toContain("Robin");
  });

  it("honours the caller's deadline on the request itself", async () => {
    const fetch = vi.fn().mockResolvedValue(modelReply(DRAFT));
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    await provider.suggest(request({ timeoutMs: 1_234 }));

    // The service races the call as a backstop, but only this abort releases the connection.
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("converts numeric values and reports the model that actually served the request", async () => {
    const fetch = vi.fn().mockResolvedValue(modelReply(DRAFT, "claude-opus-5-substituted"));
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const draft = await provider.suggest(request());

    expect(draft.scores).toEqual([
      { criterionId: "fit", value: 4, rationale: "Squarely on topic." },
      { criterionId: "novelty", value: "High", rationale: "Uncommon approach." },
      { criterionId: "notes", value: "Ask for a demo.", rationale: "The claim needs showing." },
    ]);
    // Recorded from the response, so an upstream substitution is visible in the provenance rather
    // than hidden behind the model this deployment asked for.
    expect(draft.model).toBe("claude-opus-5-substituted");
  });

  it("pins the model when one is configured", async () => {
    const fetch = vi.fn().mockResolvedValue(modelReply(DRAFT));
    const provider = new AnthropicSuggestionProvider(
      { apiKey: "sk-test", model: "claude-sonnet-5" },
      fetch,
    );

    await provider.suggest(request());

    expect(JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string).model).toBe(
      "claude-sonnet-5",
    );
  });

  it("drops an entry naming a criterion the rubric does not have", async () => {
    const fetch = vi.fn().mockResolvedValue(
      modelReply({
        summary: "Summary",
        scores: [
          ...DRAFT.scores,
          { criterionId: "invented", value: "3", rationale: "For a criterion nobody configured." },
        ],
      }),
    );
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const draft = await provider.suggest(request());

    // Kept out of storage rather than rendered against a criterion the reviewer's form has no row
    // for. A criterion left *without* a draft is the visible half, and acceptance names it.
    expect(draft.scores.map(({ criterionId }) => criterionId)).toEqual(["fit", "novelty", "notes"]);
  });

  it("keeps an unparsable number as text so acceptance refuses it rather than inventing a score", async () => {
    const fetch = vi.fn().mockResolvedValue(
      modelReply({
        summary: "Summary",
        scores: [{ criterionId: "fit", value: "very good", rationale: "Not a number." }],
      }),
    );
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const draft = await provider.suggest(request());

    expect(draft.scores[0]?.value).toBe("very good");
  });

  it.each([
    [408, "PROVIDER_TIMEOUT"],
    [429, "PROVIDER_RATE_LIMITED"],
    [500, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"],
    [401, "PROVIDER_UNAUTHORIZED"],
    [403, "PROVIDER_UNAUTHORIZED"],
    [400, "PROVIDER_REJECTED"],
  ])("normalizes HTTP %i to %s", async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(response({ error: "secret detail" }, status));
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect(refusal).toBeInstanceOf(SuggestionUnavailableError);
    expect((refusal as SuggestionUnavailableError).code).toBe(code);
    // No provider body ever reaches a code a reviewer sees.
    expect((refusal as Error).message).not.toContain("secret detail");
  });

  it("treats a transport failure as unreachable without quoting it", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:443"));
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect((refusal as SuggestionUnavailableError).code).toBe("PROVIDER_UNREACHABLE");
    expect((refusal as Error).message).not.toContain("10.0.0.5");
  });

  it("reports an abort from its own deadline as a timeout, not as unreachable", async () => {
    // `AbortSignal.timeout` rejects with a `TimeoutError`. Folded into PROVIDER_UNREACHABLE it
    // told the reviewer to suspect the network when the model was simply slow — and the code
    // table in the engineering doc already promised otherwise.
    const abort = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const fetch = vi.fn().mockRejectedValue(abort);
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect((refusal as SuggestionUnavailableError).code).toBe("PROVIDER_TIMEOUT");
  });

  it("refuses a success that will not say which model served it", async () => {
    // Defaulting to the configured model would write a provenance line claiming something the API
    // never said, which is worse than having no suggestion.
    const fetch = vi.fn().mockResolvedValue(
      response({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(DRAFT) }],
      }),
    );
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect((refusal as SuggestionUnavailableError).code).toBe("MALFORMED_PROVIDER_RESPONSE");
  });

  it.each([
    ["a null envelope", response(null)],
    ["a content field that is not an array", response({ model: "m", content: "nope" })],
  ])("normalizes %s instead of throwing through it", async (_label, stubbed) => {
    // Each of these used to read straight through an `as` cast and raise a TypeError, which left
    // as a 500 — reporting the provider's bad response as a fault in this Worker.
    const fetch = vi.fn().mockResolvedValue(stubbed);
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect(refusal).toBeInstanceOf(SuggestionUnavailableError);
    expect((refusal as SuggestionUnavailableError).code).toBe("MALFORMED_PROVIDER_RESPONSE");
  });

  it("drops a score entry that is not an object rather than throwing through it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        modelReply({ summary: "Summary", scores: [null, "nope", DRAFT.scores[0]] }),
      );
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const draft = await provider.suggest(request());

    expect(draft.scores).toEqual([
      { criterionId: "fit", value: 4, rationale: "Squarely on topic." },
    ]);
  });

  it("reports a safety decline as its own outcome rather than a parse failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ model: "claude-opus-5", stop_reason: "refusal", content: [] }));
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect((refusal as SuggestionUnavailableError).code).toBe("PROVIDER_REFUSED");
  });

  it.each([
    ["a body that is not JSON", new Response("not json", { status: 200 })],
    ["a reply with no text block", response({ model: "m", content: [] })],
    ["text that is not the pinned shape", modelReply({ summary: 12, scores: "nope" })],
  ])("treats %s as malformed and terminal", async (_label, stubbed) => {
    const fetch = vi.fn().mockResolvedValue(stubbed);
    const provider = new AnthropicSuggestionProvider({ apiKey: "sk-test" }, fetch);

    const refusal = await refusalOf(provider.suggest(request()));

    expect((refusal as SuggestionUnavailableError).code).toBe("MALFORMED_PROVIDER_RESPONSE");
  });
});
