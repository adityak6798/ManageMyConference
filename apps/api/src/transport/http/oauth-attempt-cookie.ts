/**
 * The browser's half of the Google sign-in flow: which attempts this browser has outstanding.
 *
 * One cookie held one attempt id, so a second `GET /api/auth/google/start` overwrote the first
 * and the two tabs then refused each other — the newer one succeeded and cleared the shared
 * cookie, or the older one returned first, failed the `state` check against the attempt the
 * cookie now named, and cleared it anyway so both failed (issue #166). Two tabs is ordinary
 * behaviour, so the slot is per attempt rather than per browser.
 *
 * What the cookie is *for* is unchanged and is the reason it still exists at all: it binds the
 * callback to the browser that began the flow. A callback presented to a browser holding none of
 * these ids is refused however valid its `state` is, which is what stops an attacker completing
 * their own authorization in somebody else's browser. Carrying a set rather than one value
 * widens that binding to every attempt this browser actually started and to nothing else.
 *
 * The ids are opaque and the durable attempt is the authority on expiry: nothing here decides
 * whether an attempt is live, only which ids the browser may present. A stale id costs one
 * refused lookup and nothing more, because the row it names is already gone.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */

/**
 * How many sign-ins one browser may have in flight.
 *
 * Enough for the tabs a person actually opens, and bounded because the cookie travels on every
 * request to this origin. The oldest is dropped when the cap is reached, so the attempt most
 * likely to be abandoned is the one that loses its slot — and losing it costs a refused callback
 * on a tab whose sign-in the person restarts, never a wrong sign-in.
 */
export const MAX_OUTSTANDING_ATTEMPTS = 5;

/**
 * `~` rather than a comma or a space: `cookie-octet` (RFC 6265 §4.1.1) excludes both, and a
 * separator a value cannot contain is what keeps this parseable without quoting. Attempt ids are
 * UUIDs, so the separator can never appear inside one.
 */
const SEPARATOR = "~";

/** Ids the browser presents, oldest first, with anything malformed dropped rather than trusted. */
export function parseAttemptCookie(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const candidate of value.split(SEPARATOR)) {
    // Bounded and character-restricted: this string is interpolated into nothing, but it does
    // reach a bound parameter list, and a cookie is caller-controlled input.
    if (/^[A-Za-z0-9-]{1,64}$/.test(candidate)) seen.add(candidate);
  }
  return [...seen].slice(-MAX_OUTSTANDING_ATTEMPTS);
}

/** This browser's outstanding attempts, with `attemptId` newest and the oldest evicted at the cap. */
export function withAttempt(current: readonly string[], attemptId: string): string[] {
  return [...current.filter((id) => id !== attemptId), attemptId].slice(-MAX_OUTSTANDING_ATTEMPTS);
}

/** The same list without the attempt this callback spent. */
export function withoutAttempt(current: readonly string[], attemptId: string | null): string[] {
  return attemptId === null ? [...current] : current.filter((id) => id !== attemptId);
}

/**
 * The cookie value for a list of attempts. An empty list is the empty string, and the caller
 * clears the cookie rather than writing one — expressed there rather than as a `null` here,
 * because "set this value" and "stop holding anything" are different instructions to a browser.
 */
export function serializeAttemptCookie(attemptIds: readonly string[]): string {
  return attemptIds.join(SEPARATOR);
}
