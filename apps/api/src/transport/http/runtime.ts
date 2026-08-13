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
import type { SigningSecrets } from "../../application/identity/real-auth";
import type { SessionStore } from "../../application/identity/session-store";

export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type Variables = {
  correlationId: string;
  actor: Actor | null;
  authentication: "none" | "session" | "bearer" | "demo";
  operation: string;
};

/** The Hono context every route handler in this transport receives. */
export type HttpContext = Context<{ Variables: Variables }>;

export type ActorResolver = (
  persona: "organizer" | "reviewer" | "speaker" | "public",
) => Promise<Actor | null>;

/**
 * The Google sign-in door, composed in `index.ts` and absent when the deployment is not
 * configured for it.
 *
 * Behaviour rather than credentials: the client secret never reaches this type, so nothing in
 * the transport can log or echo it. The route module can only *start* an attempt and *complete*
 * one, which is the whole surface it needs.
 *
 * `resolveUserActor` is here rather than beside the demo resolver because of what it is for: a
 * demo-mode deployment resolves persona cookies, and a real Google session on that same
 * deployment is a *different kind of credential* that also has to resolve. Its presence in this
 * object is what makes the two doors coexist, and its absence is what keeps a deployment with no
 * Google configuration behaving exactly as it did before.
 */
export interface GoogleAuthProvider {
  /** Mint one single-use attempt; the browser is redirected to `authorizationUrl`. */
  start(now: number): Promise<{ authorizationUrl: string; attemptId: string }>;
  /**
   * Spend the attempt and sign the caller in. `null` is every refusal — an unknown attempt, a
   * `state` that does not match, an expired or already-spent attempt, a token that does not
   * verify — deliberately indistinguishable to the browser.
   */
  complete(input: {
    attemptId: string;
    state: string;
    code: string;
    now: number;
    /** Carried so a failure inside the flow can be found from the caller's report of it. */
    correlationId: string;
  }): Promise<{ actor: Actor; provisioned: boolean } | null>;
  /** Resolve a signed user-session cookie back to its actor. */
  resolveUserActor(userId: string): Promise<Actor | null>;
}

/**
 * Which auth configurations carry a session store, expressed so the type system enforces it.
 *
 * A demo-mode deployment issues persona cookies, which name no session record, so it needs a
 * store only when Google is *also* configured — the one case where a demo deployment can hold a
 * real user session. Pairing the two means the ~24 plain `demoMode: true` harness configurations
 * across `apps/api/test/*-http.test.ts` compile unchanged, and it means a deployment that can
 * mint a real session cannot be composed without somewhere to record it.
 */
interface DemoAuthBase {
  demoMode: true;
  /**
   * The signing secret, or the pair a rotation is in flight across. A plain string is the
   * ordinary case; see `SigningSecrets`.
   */
  sessionSecret: SigningSecrets;
  now?: () => number;
  resolveActor: ActorResolver;
}

export type RuntimeAuthConfig =
  | (DemoAuthBase & { google: GoogleAuthProvider; sessions: SessionStore })
  | (DemoAuthBase & { google?: undefined; sessions?: undefined })
  // No signing secret at all: nothing can be issued, so no door is open and `google` is
  // structurally absent rather than merely unset.
  | {
      demoMode: false;
      sessionSecret?: undefined;
      now?: () => number;
      google?: undefined;
      sessions?: undefined;
    }
  | {
      demoMode: false;
      sessionSecret: SigningSecrets;
      now?: () => number;
      /**
       * Required, not optional. This variant is the one that signs people in, and a signed
       * session with nowhere to be recorded is the pre-#12 bearer this lane exists to replace.
       */
      sessions: SessionStore;
      resolveActor: (userId: string) => Promise<Actor | null>;
      resolveEmail: (email: string) => Promise<Actor | null>;
      sendLoginCode: (email: string, code: string) => Promise<void>;
      saveLoginChallenge: (challenge: {
        id: string;
        email: string;
        codeProof: string;
        expiresAt: number;
      }) => Promise<void>;
      consumeLoginChallenge: (id: string, codeProof: string, now: number) => Promise<string | null>;
      /** Resolve the distinct `grn_` machine-credential grammar against durable D1 state. */
      resolveApiClient?: ((credential: string) => Promise<Actor | null>) | undefined;
      google?: GoogleAuthProvider;
    };

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
  // 502 and 503 are refusals that are nobody in this conversation's fault: either a third-party
  // system was unreachable or a fail-closed optional capability is not configured. Every other
  // member is a 4xx because every other translated error is something the caller can act on.
  status: 400 | 401 | 403 | 404 | 409 | 502 | 503;
  fields?: Record<string, string[]>;
}

export type ErrorTranslator = (error: unknown) => ErrorTranslation | null;
