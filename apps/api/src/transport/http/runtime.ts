/**
 * The vocabulary every HTTP route module shares: the request context's shape, the error
 * envelope, and the two helpers that turn untrusted input into either a value or a typed
 * refusal.
 *
 * This exists so that a domain's route module needs nothing from any other domain's. Before
 * it, all of that lived as closure state inside one `createHttpApp`, which is why adding a
 * route to any domain meant editing the file every other domain also had to edit.
 *
 * @spec ARC-001 ARC-ERR-001
 */
import type { ApiErrorEnvelope } from "@greenroom/contracts";
import type { Context } from "hono";
import type { Actor } from "../../application/identity/actor";

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type Variables = { correlationId: string; actor: Actor | null; operation: string };

/** The Hono context every route handler in this transport receives. */
export type HttpContext = Context<{ Variables: Variables }>;

export type ActorResolver = (
  persona: "organizer" | "reviewer" | "speaker" | "public",
) => Promise<Actor | null>;

export type RuntimeAuthConfig =
  | { demoMode: true; sessionSecret: string; now?: () => number; resolveActor: ActorResolver }
  | { demoMode: false; now?: () => number };

/**
 * Which checkout started this Worker, and at which commit. Supplied by the local launcher and
 * absent everywhere else, so a test run can tell its own server from a stranger's.
 */
export interface BuildIdentity {
  root: string;
  commit: string;
}

export class MalformedJsonError extends Error {}

/**
 * The caching policy for a public representation: any cache may keep it, none may use it
 * without asking first. See the middleware in `app.ts` that applies it.
 */
export const PUBLIC_CACHE_CONTROL = "public, no-cache";

export const envelope = (
  code: ApiErrorEnvelope["error"]["code"],
  message: string,
  correlationId: string,
  fieldErrors?: Record<string, string[]>,
): ApiErrorEnvelope => ({
  error: { code, message, correlationId, ...(fieldErrors ? { fieldErrors } : {}) },
});

export const validationFields = (issues: { path: PropertyKey[]; message: string }[]) => {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "request";
    fields[key] = [...(fields[key] ?? []), issue.message];
  }
  return fields;
};

export async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MalformedJsonError("Request body is not valid JSON");
  }
}

/**
 * A domain's answer to "is this error mine, and what does the caller see?".
 *
 * Returning `null` means "not mine, ask the next domain". The alternative — one central
 * `onError` chain naming every domain's error classes — is what made adding a domain a change
 * to a file nine other domains own.
 */
export interface ErrorTranslation {
  code: ApiErrorEnvelope["error"]["code"];
  message: string;
  status: 400 | 401 | 403 | 404 | 409;
  fields?: Record<string, string[]>;
}

export type ErrorTranslator = (error: unknown) => ErrorTranslation | null;
