/**
 * Google sign-in, as protocol rather than as plumbing.
 *
 * Everything here is pure given its inputs: it mints an attempt, builds the authorization URL,
 * and verifies an `id_token` against a supplied key set. The two things that touch the network —
 * the token exchange and the JWKS read — are ports, implemented by
 * `adapters/identity/google-oauth-client.ts`, so this module can be driven end to end by a test
 * with no server and no credential.
 *
 * The security properties this file is responsible for, each asserted by a test that fails
 * without it:
 *
 * - **CSRF `state`** is 32 random bytes per attempt. Only its HMAC proof is stored, so a read of
 *   `identity_oauth_attempts` cannot forge a callback, and the attempt row is deleted on use.
 * - **PKCE S256.** The verifier never reaches the browser; the challenge does. An intercepted
 *   authorization code is worthless without the verifier.
 * - **The `nonce`** is minted per attempt and checked against the `id_token` claim, which is what
 *   stops a token minted for another session being replayed into this one.
 * - **The `id_token` is verified, not decoded**: RS256 signature against Google's published key
 *   for the `kid` in the header, then issuer, audience and expiry. An unverified JWT is a claim
 *   the client made about itself.
 * - **The redirect URI is configuration**, passed in, never read from a request. Google requires
 *   it to match the registered value, and taking it from a parameter is the open redirect.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Google's OpenID configuration, pinned rather than discovered. */
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
/**
 * Both spellings Google has ever issued. The bare host is the historical form and still appears;
 * accepting exactly these two is the check, and accepting anything else is not a check at all.
 */
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Only what the product uses: who you are and how to address you. No Google API scopes. */
export const GOOGLE_SCOPE = "openid email profile";
/** An attempt is a redirect and a return, not a session. Ten minutes is generous for that. */
export const ATTEMPT_LIFETIME_MS = 600_000;
/**
 * Tolerance for clock skew between this Worker and Google, applied to `exp` and `iat` only.
 * Deliberately small: the point of an expiry is that it expires.
 */
const CLOCK_SKEW_MS = 60_000;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decode64url = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );
};

const randomBase64url = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** The stored form of a `state` value. Never the value itself — see the file comment. */
export async function stateProof(state: string, secret: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(state))),
  );
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

export interface GoogleConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Fixed per deployment and registered with Google. Never derived from a request. */
  readonly redirectUri: string;
}

/** The half of an attempt that is stored; the browser is given only `state` and the URL. */
export interface OauthAttempt {
  readonly id: string;
  readonly stateProof: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface StartedAuthorization {
  readonly attempt: OauthAttempt;
  readonly authorizationUrl: string;
}

/**
 * Mint one authorization attempt.
 *
 * `prompt=select_account` rather than the default: a signed-in Google user with several accounts
 * would otherwise be silently reused, which reads as the product choosing their identity for them.
 */
export async function startGoogleAuthorization(
  configuration: GoogleConfiguration,
  secret: string,
  now: number,
): Promise<StartedAuthorization & { state: string }> {
  const state = randomBase64url(32);
  // 32 bytes base64url-encodes to 43 characters, the minimum RFC 7636 allows and the length it
  // recommends.
  const codeVerifier = randomBase64url(32);
  const nonce = randomBase64url(16);
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("redirect_uri", configuration.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await s256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return {
    state,
    authorizationUrl: url.toString(),
    attempt: {
      id: crypto.randomUUID(),
      stateProof: await stateProof(state, secret),
      codeVerifier,
      nonce,
      expiresAt: now + ATTEMPT_LIFETIME_MS,
    },
  };
}

/** What the token endpoint returns, narrowed to what is used. */
export interface GoogleTokenResponse {
  readonly id_token?: unknown;
}

/** Exchange an authorization code. Implemented in the adapter layer; stubbed in tests. */
export type GoogleTokenExchange = (request: {
  readonly code: string;
  readonly codeVerifier: string;
  readonly configuration: GoogleConfiguration;
}) => Promise<GoogleTokenResponse>;

/** One RSA verification key from Google's published set. */
export interface GoogleJsonWebKey {
  readonly kid?: unknown;
  readonly kty?: unknown;
  readonly alg?: unknown;
  readonly n?: unknown;
  readonly e?: unknown;
}

/** Read Google's current signing keys. Implemented in the adapter layer. */
export type GoogleKeySource = () => Promise<readonly GoogleJsonWebKey[]>;

/** The identity a verified `id_token` asserts. */
export interface GoogleIdentity {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
}

/**
 * A refusal the caller can report without leaking why to the browser.
 *
 * Every rejection in this flow is one of these, and the transport turns all of them into the same
 * response: naming which check failed would tell an attacker which half of a forgery worked.
 * The reason is for the log.
 */
export class GoogleAuthenticationError extends Error {}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
}

function jsonSegment(segment: string | undefined): Record<string, unknown> {
  if (!segment) throw new GoogleAuthenticationError("id_token segment is missing");
  try {
    const parsed: unknown = JSON.parse(decoder.decode(decode64url(segment)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new GoogleAuthenticationError("id_token segment is not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GoogleAuthenticationError) throw error;
    // ERROR-INTENT: a malformed token is an invalid credential, not an operational failure; the
    // parser's own message would only describe the attacker's input.
    throw new GoogleAuthenticationError("id_token is not valid JWT JSON");
  }
}

/**
 * Verify an `id_token` and return the identity it asserts.
 *
 * The order matters and is deliberate: signature first, then the claims. Reading a claim from an
 * unverified token and acting on it — even to choose which key to check — is how "validated" JWT
 * handling usually fails. The one header field read before verification is `kid`, which selects a
 * key from a set we fetched ourselves; a `kid` naming no such key is a refusal, never a fallback
 * to "try them all with alg from the header".
 */
export async function verifyGoogleIdToken(
  idToken: unknown,
  expected: { readonly clientId: string; readonly nonce: string; readonly now: number },
  keys: readonly GoogleJsonWebKey[],
): Promise<GoogleIdentity> {
  if (typeof idToken !== "string" || idToken.length === 0)
    throw new GoogleAuthenticationError("token response carried no id_token");
  const [headerSegment, payloadSegment, signatureSegment, extra] = idToken.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment || extra !== undefined)
    throw new GoogleAuthenticationError("id_token is not a three-part JWS");

  const header = jsonSegment(headerSegment);
  // `alg` is pinned to RS256 rather than read and honoured. Trusting the header's algorithm is
  // the `alg: none` family of attacks, and Google signs with RS256.
  if (header.alg !== "RS256")
    throw new GoogleAuthenticationError(`id_token alg is ${String(header.alg)}, not RS256`);
  const kid = header.kid;
  if (typeof kid !== "string")
    throw new GoogleAuthenticationError("id_token header names no key id");
  const key = keys.find((candidate) => candidate.kid === kid);
  if (!key)
    throw new GoogleAuthenticationError("id_token names a key Google's key set does not publish");
  if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string")
    throw new GoogleAuthenticationError("published key is not an RSA verification key");

  const verificationKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`${headerSegment}.${payloadSegment}`);
  let signatureValid: boolean;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      verificationKey,
      decode64url(signatureSegment),
      signed,
    );
  } catch {
    // ERROR-INTENT: an unparseable signature is an invalid credential; it is refused exactly as a
    // signature that simply does not match.
    signatureValid = false;
  }
  if (!signatureValid) throw new GoogleAuthenticationError("id_token signature does not verify");

  const claims = jsonSegment(payloadSegment) as IdTokenClaims;
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss))
    throw new GoogleAuthenticationError(`id_token issuer ${String(claims.iss)} is not Google`);
  // `aud` may be a string or an array; a token minted for another client must not be accepted
  // here even though Google signed it.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId))
    throw new GoogleAuthenticationError("id_token audience is another client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS <= expected.now)
    throw new GoogleAuthenticationError("id_token has expired");
  if (typeof claims.iat !== "number" || claims.iat * 1000 - CLOCK_SKEW_MS > expected.now)
    throw new GoogleAuthenticationError("id_token was issued in the future");
  if (claims.nonce !== expected.nonce)
    throw new GoogleAuthenticationError("id_token nonce does not match this attempt");

  const subject = claims.sub;
  const email = claims.email;
  if (typeof subject !== "string" || subject.length === 0)
    throw new GoogleAuthenticationError("id_token carries no subject");
  if (typeof email !== "string" || email.length === 0)
    throw new GoogleAuthenticationError("id_token carries no email address");
  const name = [claims.name, claims.given_name].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  return {
    subject,
    email: email.trim().toLowerCase(),
    // Google sends this as a boolean, and has historically sent the string "true". Anything else
    // is not a verified address, which is the only thing this product links an account on.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    // An address is a poor display name but a better one than an empty string, and the user can
    // change it. Splitting at "@" rather than showing the domain to everyone in the workspace.
    name: name?.trim() ?? email.split("@")[0] ?? "New organizer",
  };
}

/**
 * The whole callback, given the stored attempt: exchange the code, then verify what came back.
 *
 * Composed here rather than in the route so the ordering — never trust the token before its
 * signature — is a property of the domain flow rather than of one transport handler.
 */
export async function completeGoogleAuthorization(
  input: {
    readonly code: string;
    readonly attempt: Pick<OauthAttempt, "codeVerifier" | "nonce">;
    readonly configuration: GoogleConfiguration;
    readonly now: number;
  },
  ports: { readonly exchange: GoogleTokenExchange; readonly keys: GoogleKeySource },
): Promise<GoogleIdentity> {
  const tokens = await ports.exchange({
    code: input.code,
    codeVerifier: input.attempt.codeVerifier,
    configuration: input.configuration,
  });
  return verifyGoogleIdToken(
    tokens.id_token,
    {
      clientId: input.configuration.clientId,
      nonce: input.attempt.nonce,
      now: input.now,
    },
    await ports.keys(),
  );
}
