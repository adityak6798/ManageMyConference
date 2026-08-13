/**
 * The degradation rule every platform composition shares.
 *
 * Three outcomes, not two. `unauthorized` is a fact about the caller and never an outage: a
 * reviewer cannot read the CRM, and reporting that as a failure would describe a working system
 * as broken. Only a genuine rejection is `failed`, and it carries the rejection itself rather
 * than a rendered message — turning one into caller-facing words, with a correlation id and a
 * log line, belongs to the transport and not to this layer.
 *
 * Written once because search, the inbox and the audit timeline must degrade identically. Two
 * copies of this rule is how one surface ends up refusing where the other omits.
 *
 * @spec PRD-OPS-001
 */
import { AuthenticationRequiredError, CapabilityDeniedError } from "../identity/actor";

export type SourceOutcome<T> =
  | { readonly state: "ok"; readonly value: T }
  | { readonly state: "unauthorized" }
  | { readonly state: "failed"; readonly reason: unknown };

/**
 * Run one source and classify whatever it does.
 *
 * Nothing rethrows, so one broken source can never take the others with it.
 */
export async function readSource<T>(read: () => Promise<T>): Promise<SourceOutcome<T>> {
  try {
    return { state: "ok", value: await read() };
  } catch (error) {
    // ERROR-INTENT: classified, never dropped — a refusal becomes `unauthorized`, and every
    // other rejection leaves here in `reason` for the transport to log and render.
    if (error instanceof AuthenticationRequiredError || error instanceof CapabilityDeniedError)
      return { state: "unauthorized" };
    return { state: "failed", reason: error };
  }
}

/**
 * A source this deployment did not wire.
 *
 * Distinct from `unauthorized`: the caller may well be allowed to read it, and the reason they
 * cannot is a composition bug. It degrades the one section rather than the request, and the
 * transport logs it, so a partially wired harness stays usable while still reporting that
 * something is missing.
 */
export class PlatformSourceUnavailableError extends Error {}

export function requireSource<T>(source: T | undefined, name: string): T {
  if (!source) throw new PlatformSourceUnavailableError(`${name} is not configured`);
  return source;
}
