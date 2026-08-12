/**
 * Turning what an HTTP provider did into the four outcomes the outbox understands.
 *
 * Every live adapter normalizes through here, so "the provider was rate limited" means the same
 * thing — a bounded retry — whether it came from the mail API, Airtable or Accelevents, and an
 * operator reading `error_code` in the delivery history is reading one vocabulary rather than
 * three.
 *
 * Nothing from the provider's response body ever reaches an outcome code. A body can contain a
 * recipient address, a record's contents, or a token echoed back in an error message, and
 * `error_code` is stored on an immutable attempt and rendered in the organizer's history. The
 * status is enough to act on; the body is not ours to keep.
 *
 * @spec PORT-EMAIL PORT-AIRTABLE PORT-ACCELEVENTS PRD-INT-001
 */
import type { ProviderResult } from "../../application/communications/ports";

/** Default ceiling on a single provider call. The lease is five minutes; this is well inside it. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Map a response status onto an outcome.
 *
 * Retryable: the request was well formed and the provider could not serve it *now* — it was
 * throttled (429), timed out upstream (408), or is unavailable (5xx). Terminal: the provider
 * understood the request and refused it, which repeating cannot fix — a rejected recipient, a
 * missing Airtable column, a revoked token. A 401 or 403 is deliberately terminal: retrying with
 * the same credential three times only delays the operator finding out.
 */
export function outcomeForStatus(status: number): ProviderResult | null {
  if (status >= 200 && status < 300) return null;
  if (status === 408) return { kind: "retryable", code: "PROVIDER_TIMEOUT" };
  if (status === 429) return { kind: "retryable", code: "PROVIDER_RATE_LIMITED" };
  if (status >= 500) return { kind: "retryable", code: `PROVIDER_UNAVAILABLE:${status}` };
  if (status === 401 || status === 403)
    return { kind: "terminal", code: `PROVIDER_UNAUTHORIZED:${status}` };
  return { kind: "terminal", code: `PROVIDER_REJECTED:${status}` };
}

/**
 * A 2xx whose body is not the shape the adapter needs is malformed, and malformed is terminal.
 *
 * The provider has already acted — the mail may well have been sent — so retrying risks a
 * duplicate external effect to fix a parsing problem on our side. Better to stop, keep the
 * attempt, and let an operator look.
 */
export const MALFORMED: ProviderResult = {
  kind: "terminal",
  code: "MALFORMED_PROVIDER_RESPONSE",
};

/**
 * A request that never got an answer: DNS, TLS, a dropped connection, or our own timeout.
 *
 * Retryable, and deliberately indistinguishable from one another in the code — the distinction
 * doesn't change what an operator does, and the underlying message can name internal hosts.
 */
export const UNREACHABLE: ProviderResult = { kind: "retryable", code: "PROVIDER_UNREACHABLE" };

/** Read a JSON body without letting a parse failure escape as an exception. */
export async function readJsonBody(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    // ERROR-INTENT: an unparsable body is normalized into MALFORMED by the caller; the parser's
    // own message is untrusted provider text and is never stored or logged.
    return null;
  }
}
