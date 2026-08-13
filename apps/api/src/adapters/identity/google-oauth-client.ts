/**
 * The two network calls Google sign-in makes, and nothing else.
 *
 * Raw `fetch`, like the three delivery adapters and the suggestion adapter, rather than
 * `google-auth-library`: that package reaches for `node:fs` and `node:crypto` through its
 * credential chain, which resolves in a Worker only with the `nodejs_compat` flag — a
 * deployment-wide runtime change to serve one adapter. The reasoning is the same one recorded
 * for the Anthropic SDK in the wave ledger, and the protocol here is one POST and one GET.
 *
 * Everything cryptographic lives in `application/identity/google-oauth.ts`. This file knows two
 * URLs and how to report a bad response; it verifies nothing and decides nothing.
 *
 * @spec PRD-IAM-001 ARC-AUTH-001
 */
import {
  GOOGLE_JWKS_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleAuthenticationError,
  type GoogleConfiguration,
  type GoogleJsonWebKey,
  type GoogleTokenResponse,
} from "../../application/identity/google-oauth";

/**
 * How long a fetched key set is reused.
 *
 * Google rotates these on the order of days and publishes `Cache-Control` on the response; five
 * minutes is well inside that and turns the common case — a burst of sign-ins — into one request.
 * A `kid` this cache cannot satisfy is a refusal rather than a silent refetch: an attacker who
 * could force a refetch by naming an unknown key would have a cheap way to make every sign-in
 * pay a round trip to Google.
 */
const KEY_CACHE_MS = 300_000;

/** Bounded so a slow or hanging Google cannot hold a request open indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class GoogleOauthClient {
  private cachedKeys: { keys: readonly GoogleJsonWebKey[]; expiresAt: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Exchange an authorization code for tokens.
   *
   * The `redirect_uri` sent here is the configured one, and Google refuses the exchange unless it
   * matches the value the authorization request carried and the value registered in the console.
   * That is the second half of the open-redirect defence: even if something upstream accepted a
   * different URI, this exchange would fail rather than complete against an attacker's endpoint.
   */
  readonly exchange = async (request: {
    code: string;
    codeVerifier: string;
    configuration: GoogleConfiguration;
  }): Promise<GoogleTokenResponse> => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: request.code,
      code_verifier: request.codeVerifier,
      client_id: request.configuration.clientId,
      client_secret: request.configuration.clientSecret,
      redirect_uri: request.configuration.redirectUri,
    });
    const response = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!response.ok)
      // The status only. Google's error body echoes request parameters, and this message reaches
      // a log line rather than the browser.
      throw new GoogleAuthenticationError(`Google token endpoint returned ${response.status}`);
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object")
      throw new GoogleAuthenticationError("Google token endpoint returned a non-object");
    return parsed as GoogleTokenResponse;
  };

  /** Google's current signing keys, cached per isolate for `KEY_CACHE_MS`. */
  readonly keys = async (): Promise<readonly GoogleJsonWebKey[]> => {
    const cached = this.cachedKeys;
    if (cached && cached.expiresAt > this.now()) return cached.keys;
    const response = await fetchWithTimeout(GOOGLE_JWKS_ENDPOINT, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new GoogleAuthenticationError(`Google key set returned ${response.status}`);
    const parsed: unknown = await response.json();
    const keys =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { keys?: unknown }).keys)
        ? (parsed as { keys: GoogleJsonWebKey[] }).keys
        : null;
    if (!keys || keys.length === 0)
      throw new GoogleAuthenticationError("Google key set carried no keys");
    this.cachedKeys = { keys, expiresAt: this.now() + KEY_CACHE_MS };
    return keys;
  };
}
