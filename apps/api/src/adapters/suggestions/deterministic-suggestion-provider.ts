/**
 * The credential-free suggestion provider every local run, test, demo and CI request goes through.
 *
 * It is the default for the same reason `DeterministicProvider` is the default for deliveries: a
 * fresh clone with no secrets must be able to exercise the whole journey, and a suite that needs a
 * network call to pass is a suite that fails for reasons unrelated to the change under review.
 *
 * "Deterministic" here means the strong version — the same abstract and the same rubric produce
 * byte-identical output on every machine and every run, because every number is derived from a
 * hash of the text rather than from a clock, a counter or a random source. That is what lets a
 * browser test assert the drafted score itself rather than merely that *some* number appeared.
 *
 * What it does **not** do is pretend to be intelligent. The scores are a function of the text, not
 * a judgement about it, and the rationale says so in as many words. A fixture that produced
 * plausible-sounding reasoning would invite somebody to read a demo as evidence the feature
 * works — which is exactly the overclaim `GAP-011` exists to prevent.
 *
 * @spec PRD-AI-001 PORT-AI
 */
import type {
  ReviewSuggestionPort,
  SuggestionDraft,
  SuggestionRequest,
} from "../../application/review/suggestion-port";
import { SuggestionUnavailableError } from "../../application/review/suggestion-port";
import type { SuggestedScore } from "../../domain/review/suggestion";

/**
 * The prompt this repository sends, versioned.
 *
 * Stored on every suggestion so a wording change is visible in the record rather than inferred
 * from a date. The fake carries the same version as the live adapter deliberately: they answer
 * the same question, and a reviewer comparing two suggestions should be told which *model*
 * differed, not be left guessing whether the question did.
 */
export const SUGGESTION_PROMPT_VERSION = "review-suggestion/v1";

/** The model name the fake reports. Never mistakable for a real one. */
export const FIXTURE_SUGGESTION_MODEL = "fixture-suggester-v1";

export type FakeSuggestionBehavior = "success" | "timeout" | "error";

/**
 * Field separator for the hashed key.
 *
 * ASCII unit separator, so a title ending in the first words of an abstract cannot hash the
 * same as the pair - written as an escape so the file stays readable text.
 */
const SEPARATOR = "\u001f";

/** FNV-1a over a string, so a score is a pure function of the text that produced it. */
const digest = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * The first sentence of the abstract, bounded.
 *
 * Bounded rather than complete because the summary is rendered inside a card beside the abstract
 * it summarises: a "summary" as long as its source is noise on the screen, and an unbounded one
 * from a live model is a layout hazard.
 */
const openingSentence = (abstract: string): string => {
  const trimmed = abstract.trim();
  if (!trimmed) return "This abstract has no body text.";
  const stop = trimmed.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  return sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence;
};

export class DeterministicSuggestionProvider implements ReviewSuggestionPort {
  /** Every request this provider was given, for tests that assert what crossed the port. */
  readonly calls: SuggestionRequest[] = [];
  constructor(private readonly behavior: FakeSuggestionBehavior = "success") {}

  async suggest(request: SuggestionRequest): Promise<SuggestionDraft> {
    this.calls.push(request);
    // The two failure modes a reviewer can meet, reachable without a network. Both leave the
    // manual path untouched, which is the property `review-service.test.ts` asserts.
    if (this.behavior === "timeout") throw new SuggestionUnavailableError("PROVIDER_TIMEOUT");
    if (this.behavior === "error") throw new SuggestionUnavailableError("PROVIDER_UNAVAILABLE");

    // The separator is an escape, never a literal control byte: a raw NUL in source turns the
    // file into a binary blob that `git diff` reports as a byte count and no reviewer can read.
    // That is issue #131, and its gate is what caught two of them here.
    const seed = digest(
      `${request.title}${SEPARATOR}${request.abstract}${SEPARATOR}r${request.round}${SEPARATOR}${request.persona ?? ""}`,
    );
    const scores: SuggestedScore[] = request.criteria.map((criterion) => {
      const local = digest(`${criterion.id}${SEPARATOR}${seed}`);
      if (criterion.type === "dropdown") {
        const option = criterion.options[local % criterion.options.length] as string;
        return {
          criterionId: criterion.id,
          value: option,
          rationale: `Fixture provider: “${option}” chosen from the configured options by a hash of the abstract, not by reading it.`,
        };
      }
      if (criterion.type === "text") {
        const value =
          `Fixture note on ${criterion.name}: ${openingSentence(request.abstract)}`.slice(
            0,
            criterion.maxLength,
          );
        return {
          criterionId: criterion.id,
          value,
          rationale:
            "Fixture provider: this text restates the abstract's opening line. It is not an assessment.",
        };
      }
      // Numeric, including the untyped default. Spread across the criterion's own range so a
      // rubric of 1–5 and a rubric of 0–10 both look like the rubric they are.
      const span = criterion.maxScore - criterion.minScore + 1;
      const value = criterion.minScore + (local % span);
      return {
        criterionId: criterion.id,
        value,
        rationale: `Fixture provider: ${value} of ${criterion.maxScore} is derived from a hash of the abstract, not from judging “${criterion.name}”.`,
      };
    });

    return {
      summary: `${openingSentence(request.abstract)} (Drafted by the deterministic fixture provider — no model read this abstract.)`,
      scores,
      model: FIXTURE_SUGGESTION_MODEL,
      promptVersion: SUGGESTION_PROMPT_VERSION,
    };
  }
}
