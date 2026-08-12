/**
 * `PORT-AI`: how review asks something to draft a suggestion, without knowing what answers.
 *
 * The shape mirrors the delivery providers exactly — a narrow interface here, a deterministic
 * fake and a credential-gated HTTP adapter behind it, and a resolver that refuses a half
 * configuration rather than falling back. What differs is the blast radius of getting it wrong:
 * a misconfigured mail provider sends nothing, while a misconfigured suggestion provider would
 * put a fabricated draft score in front of a reviewer. So the request carries the *masked*
 * proposal and the failure path is "the reviewer scores by hand", never "use a default".
 *
 * Two boundaries worth stating because they are easy to erode later:
 *
 * - **Nothing here writes.** The port returns a draft; the service decides whether to store it.
 *   An implementation that reached storage could not be swapped for the fake.
 * - **The submitter never crosses it.** `SuggestionRequest` has no field for a name or an
 *   address, which is what makes blind review survive a live provider: there is nowhere to put
 *   the identity even by accident.
 *
 * @spec PRD-AI-001 PRD-REV-001 PORT-AI ARC-DOM-001
 */
import type { ReviewCriterion } from "../../domain/review/review";
import type { SuggestedScore } from "../../domain/review/suggestion";

/**
 * What the provider is given.
 *
 * The abstract as a reviewer sees it, the rubric it must score against, and the round — nothing
 * else. In particular no reviewer identity: a provider cannot be asked to draft "what Ravi would
 * say", and a prompt cannot leak who is reviewing what to a third party.
 */
export interface SuggestionRequest {
  readonly title: string;
  readonly abstract: string;
  /** The published form's visible answers, already stripped of contact fields upstream. */
  readonly answers: readonly { readonly label: string; readonly value: string }[];
  readonly criteria: readonly ReviewCriterion[];
  readonly round: number;
  /** Milliseconds the caller is willing to wait. Implementations must not exceed it. */
  readonly timeoutMs: number;
}

/**
 * What the provider returns: a draft plus the two provenance facts only it can supply.
 *
 * `model` is the model that actually served the request rather than the one configuration named,
 * so a provider that silently substituted one is recorded truthfully. The service supplies the
 * timestamp and the proposal revision, because those are facts about *this* request rather than
 * about the provider, and a provider must not be able to backdate its own suggestion.
 */
export interface SuggestionDraft {
  readonly summary: string;
  readonly scores: readonly SuggestedScore[];
  readonly model: string;
  readonly promptVersion: string;
}

/**
 * The provider could not answer. Always retryable by the reviewer, never fatal to the request.
 *
 * `code` is a normalized token in the same spirit as `http-outcome.ts` — it reaches the reviewer's
 * screen and the Worker log, so it never carries a provider response body, a prompt, or an
 * abstract. The reviewer is told the assistant is unavailable and goes on scoring by hand; that
 * is the whole failure design, and it is asserted rather than described (see
 * `review-service.test.ts`, "a provider that times out leaves the reviewer scoring by hand").
 */
export class SuggestionUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`Suggestion provider unavailable: ${code}`);
  }
}

export interface ReviewSuggestionPort {
  /**
   * Draft one suggestion, or throw `SuggestionUnavailableError`.
   *
   * Implementations must honour `timeoutMs` themselves — the service races the call as a
   * backstop, but a race leaves the underlying request running, and on a Worker that means a
   * connection held open past the response. Both layers exist for the same reason the outbox has
   * both a lease and a ceiling: one of them is the cancellation, the other is the guarantee.
   */
  suggest(request: SuggestionRequest): Promise<SuggestionDraft>;
}
