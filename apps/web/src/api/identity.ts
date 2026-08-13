/**
 * The browser's identity client: who this document is, which doors the deployment offers, and
 * the four ways through them.
 *
 * These endpoints used to live in `api/events.ts`, which made the events domain's client the
 * home of `/api/session` and `/api/auth/*` for no reason other than that the console needed
 * them first. That was invisible while one signed-in shell was the only caller. It stopped
 * being invisible when the landing page — which is not the events domain and must not import
 * it — needed the same three calls, so identity's client is now its own file, alongside every
 * other domain's.
 *
 * The probe at the bottom is what the signed-out surfaces boot from. Two facts decide what "/"
 * renders: whether this browser already holds a session — which only the API can answer,
 * because the session cookie is `httpOnly` and the document cannot read it — and which doors
 * this deployment offers, because a sign-in button for a door that is not configured is a 404
 * with a nice label on it. They are asked together rather than one behind the other: the second
 * answer is the one that puts the demo buttons on screen, and an evaluator with ten minutes
 * should not spend a round trip of it waiting to find that out.
 */

import {
  type ApiErrorEnvelope,
  authConfigResponseSchema,
  demoSessionResponseSchema,
  loginCodeRequestResponseSchema,
  loginCodeVerifyResponseSchema,
  type SessionDto,
  sessionResponseSchema,
  signOutResponseSchema,
} from "@greenroom/contracts";
import type { z } from "zod";
import { decodeResponse, apiFetch as fetch } from "./config";

/** This client's refusal, carrying the envelope every surface reports the reference from. */
export class IdentityApiError extends Error {
  constructor(readonly envelope: ApiErrorEnvelope) {
    super(envelope.error.message);
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return decodeResponse(response, schema, (envelope) => new IdentityApiError(envelope));
}

export async function getSession(fetcher: typeof fetch = fetch): Promise<SessionDto> {
  return decode(await fetcher("/api/session"), sessionResponseSchema);
}

/** The ways into this deployment, as `/api/auth/config` reports them. */
export type AuthDoors = { demoMode: boolean; google: boolean };

/**
 * The contract shape with `google` relaxed to optional, for reading across a version boundary.
 * Derived from `authConfigResponseSchema` rather than rewritten, so a field added to the
 * contract later cannot be silently dropped here.
 */
const legacyTolerantAuthConfigSchema = authConfigResponseSchema.partial({ google: true });

/**
 * Tolerates every API this frontend can find itself talking to, which is more than one.
 *
 * A frontend and its API do not roll atomically — `VITE_API_BASE_URL` allows them to be hosted
 * separately, and even same-origin a stacked deploy has a window — so this client meets three
 * shapes and must not lose its doors to any of them:
 *
 * - **404**, an API old enough not to serve the route at all. Demo mode, no Google.
 * - **200 without `google`**, the API immediately before this change. It served
 *   `{ demoMode }` and nothing else. This is the case a `status === 404` guard alone misses,
 *   and missing it is worse than not having the guard: the strict parse throws, `doors` is
 *   null, and the sign-in surface renders *no* doors — the exact outcome the fallback exists
 *   to prevent. `google` is false there because that API has no such route.
 * - **200 with both**, this API.
 *
 * Parsed leniently rather than by loosening `authConfigResponseSchema`, which is the contract
 * every current caller is entitled to rely on: the server always sends both fields, and it is
 * only this one client, reading across a version boundary, that has to be forgiving.
 */
export async function getAuthConfig(fetcher: typeof fetch = fetch): Promise<AuthDoors> {
  const response = await fetcher("/api/auth/config");
  if (response.status === 404) return { demoMode: true, google: false };
  const doors = await decode(response, legacyTolerantAuthConfigSchema);
  return { demoMode: doors.demoMode, google: doors.google ?? false };
}

export async function startDemoSession(
  persona: "organizer" | "reviewer" | "speaker" | "public",
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/demo-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  await decode(response, demoSessionResponseSchema);
}

export async function requestLoginCode(email: string, fetcher: typeof fetch = fetch) {
  return decode(
    await fetcher("/api/auth/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    loginCodeRequestResponseSchema,
  );
}

export async function verifyLoginCode(
  challenge: string,
  code: string,
  fetcher: typeof fetch = fetch,
) {
  await decode(
    await fetcher("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, code }),
    }),
    loginCodeVerifyResponseSchema,
  );
}

/**
 * End this browser's session.
 *
 * The response says only that the cookie was cleared, and it says so whether or not there was
 * one — see `signOutResponseSchema`, which is deliberately not called "revoke". Leaving the
 * console afterwards is the caller's, because only the caller knows what it is mounted around.
 */
export async function signOut(fetcher: typeof fetch = fetch): Promise<void> {
  await decode(await fetcher("/api/auth/signout", { method: "POST" }), signOutResponseSchema);
}

export type LandingBootstrap = {
  /** The session this browser already holds; null when nobody is signed in here. */
  session: SessionDto | null;
  /** Which doors to render; null when the deployment did not answer at all. */
  doors: AuthDoors | null;
  /** Why a read did not answer, when the reason was something other than "not signed in". */
  failure: unknown;
};

const isUnauthorized = (reason: unknown) =>
  reason instanceof IdentityApiError && reason.envelope.error.code === "UNAUTHORIZED";

/**
 * Both reads, in flight from the same tick, resolved into the one shape the landing renders.
 *
 * Neither read rejects out of here. A 401 is the expected answer for a visitor rather than a
 * failure, and every other reason is carried in the resolved value, so the surface can say that
 * something happened instead of the reason being dropped on the floor.
 */
export async function probeIdentity(fetcher: typeof fetch = fetch): Promise<LandingBootstrap> {
  const [session, doors] = await Promise.allSettled([getSession(fetcher), getAuthConfig(fetcher)]);
  const sessionFailure =
    session.status === "rejected" && !isUnauthorized(session.reason) ? session.reason : null;
  const doorsFailure = doors.status === "rejected" ? doors.reason : null;
  return {
    session: session.status === "fulfilled" ? session.value : null,
    doors: doors.status === "fulfilled" ? doors.value : null,
    // The session is the more consequential of the two, so its reason is the one reported when
    // both failed — which they usually do together, for the same reason.
    failure: sessionFailure ?? doorsFailure,
  };
}

/**
 * The sentence a signed-out surface shows for a failure, including the correlation reference
 * when the API supplied one.
 *
 * Kept here rather than imported from `App.tsx`: the landing surfaces are loaded *instead of*
 * the console, and importing one symbol from it would pull the entire workspace bundle into the
 * page that exists to avoid exactly that.
 */
export function describeIdentityFailure(reason: unknown): string {
  if (reason instanceof IdentityApiError)
    return `${reason.message} Reference: ${reason.envelope.error.correlationId}`;
  return "Something went wrong. Please retry; if it continues, contact support.";
}
