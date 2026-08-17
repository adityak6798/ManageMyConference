/**
 * API origin baked into the production bundle by Vite.
 *
 * The empty default preserves the local Vite proxy and same-origin Worker deployment. A
 * separately hosted frontend can instead set `VITE_API_BASE_URL=https://api.example.com`.
 */
export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

function apiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input !== "string" || !input.startsWith("/")) return input;
  return `${apiBase}${input}`;
}

/** Fetch through the configured API origin while retaining the native fetch signature. */
export const apiFetch: typeof fetch = (input, init) =>
  init === undefined ? globalThis.fetch(apiUrl(input)) : globalThis.fetch(apiUrl(input), init);

import { apiErrorEnvelopeSchema, type ApiErrorEnvelope } from "@greenroom/contracts";
import type { z } from "zod";

/** A 2xx response that does not match the versioned browser contract. */
export class ResponseContractError extends Error {
  constructor(
    readonly correlationId: string,
    readonly issuePaths: readonly string[],
  ) {
    const paths = issuePaths.length > 0 ? issuePaths.join(", ") : "response";
    super(`The browser could not read the server response (${paths}). Reference: ${correlationId}`);
    this.name = "ResponseContractError";
  }
}

const responseReference = (response: Response) =>
  response.headers.get("x-correlation-id") ?? "unavailable";

/** A failure as a reader should see it: one sentence, and the reference they can quote. */
export type ApiFailure = { readonly message: string; readonly reference: string | null };

/**
 * A correlation id nobody can quote is not a reference.
 *
 * `ResponseContractError` uses this word when the response carried no `x-correlation-id`
 * header at all, and printing "Reference: unavailable" under a failure only asks the reader
 * to report a value that does not exist.
 */
const ABSENT_REFERENCE = "unavailable";

/** The trailing reference some helpers and servers already glued onto the sentence. */
const GLUED_REFERENCE = /\s*Reference:\s*\S+\.?$/;

const envelopeOf = (reason: unknown): { message: string; correlationId: string } | null => {
  if (typeof reason !== "object" || reason === null) return null;
  const envelope = (
    reason as { envelope?: { error?: { message?: unknown; correlationId?: unknown } } }
  ).envelope?.error;
  if (typeof envelope?.message === "string" && typeof envelope.correlationId === "string")
    return { message: envelope.message, correlationId: envelope.correlationId };
  const flat = reason as { message?: unknown; correlationId?: unknown };
  if (typeof flat.message === "string" && typeof flat.correlationId === "string")
    return { message: flat.message, correlationId: flat.correlationId };
  return null;
};

/**
 * One voice for every handled API failure, and one place the reference is separated from it.
 *
 * This replaces the ~20 hand-rolled `readableError` helpers that each glued a raw ULID onto
 * the end of a sentence: three different fallback sentences, two different reference
 * spellings, and a reference no reader could select without dragging through the message.
 * `Notice` renders `reference` as its own monospace line with a copy affordance, so the
 * message stays a sentence and the identifier stays a value.
 *
 * The two shapes are read structurally rather than by class, because the domain error
 * classes live in the modules that import this one — `IdentityApiError` carries the whole
 * `envelope`, `MembershipApiError` carries a flat `correlationId`, and both are handled
 * refusals a surface should quote. Anything else is an unhandled fault whose message was
 * written for a developer, so `fallback` is what the reader gets.
 *
 * `fallback` names what did not happen, in the reader's terms and ending in a full stop:
 * "The member list could not be loaded.", "Could not retry the delivery."
 */
export function describeApiFailure(reason: unknown, fallback: string): ApiFailure {
  const handled = envelopeOf(reason);
  if (!handled) return { message: fallback, reference: null };
  const message = handled.message.replace(GLUED_REFERENCE, "").trim();
  const reference =
    handled.correlationId.trim() === "" || handled.correlationId === ABSENT_REFERENCE
      ? null
      : handled.correlationId;
  return { message: message === "" ? fallback : message, reference };
}

/** Decode both halves of an HTTP contract without losing the request's trace reference. */
export async function decodeResponse<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  apiError: (envelope: ApiErrorEnvelope) => Error,
): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ResponseContractError(responseReference(response), ["response body"]);
  }
  if (!response.ok) {
    const parsed = apiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) throw apiError(parsed.data);
    throw new ResponseContractError(responseReference(response), ["error envelope"]);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ResponseContractError(
      responseReference(response),
      parsed.error.issues.map(({ path }) => (path.length > 0 ? path.join(".") : "response")),
    );
  return parsed.data;
}
