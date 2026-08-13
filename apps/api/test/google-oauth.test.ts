// @acceptance ACC-IDENTITY-EVENTS
/**
 * The protocol half of Google sign-in, driven with real signatures.
 *
 * Every token here is minted by this file against an RSA key pair generated in `beforeAll`, so
 * the verifier is exercised with the same primitive Google uses rather than with a stub that
 * agrees with it. That matters because almost every way JWT handling fails in practice is a
 * check that was never reached: a key chosen from the token, an algorithm read from the header,
 * a claim trusted before the signature. Each of those is a case below, and each is written so
 * that removing the guard makes the token *verify* rather than fail differently.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  ATTEMPT_LIFETIME_MS,
  completeGoogleAuthorization,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_SCOPE,
  type GoogleConfiguration,
  GoogleAuthenticationError,
  type GoogleJsonWebKey,
  startGoogleAuthorization,
  stateProof,
  verifyGoogleIdToken,
} from "../src/application/identity/google-oauth";

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const segment = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

/** A key pair that can publish itself as a JWK and sign tokens with an arbitrary header. */
interface Signer {
  readonly published: GoogleJsonWebKey;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  /** A genuine signature over segments that are not necessarily JSON. */
  signRaw(headerSegment: string, payloadSegment: string): Promise<string>;
}

async function signer(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const signRaw = async (headerSegment: string, payloadSegment: string) => {
    const signed = `${headerSegment}.${payloadSegment}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      encoder.encode(signed),
    );
    return `${signed}.${base64url(new Uint8Array(signature))}`;
  };
  return {
    published: { kid, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e },
    sign: (claims, header = {}) =>
      signRaw(segment({ alg: "RS256", kid, ...header }), segment(claims)),
    signRaw,
  };
}

const clientId = "greenroom-test.apps.googleusercontent.com";
const now = 1_760_000_000_000;
const seconds = Math.floor(now / 1000);
const nonce = "attempt-nonce-b4c1";
const expected = { clientId, nonce, now };
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: clientId,
  exp: seconds + 3_600,
  iat: seconds - 30,
  nonce,
  sub: "104729183746501928374",
  email: "New.Organizer@Example.test",
  email_verified: true,
  name: "Nadia Newcomer",
  ...overrides,
});

describe("Google id_token verification", () => {
  let google: Signer;
  let stranger: Signer;
  beforeAll(async () => {
    google = await signer("google-key-1");
    // Deliberately the same `kid`: the key set lookup succeeds and the signature is the only
    // thing left that can refuse this token.
    stranger = await signer("google-key-1");
  });

  const verify = (token: string, keys?: readonly GoogleJsonWebKey[]) =>
    verifyGoogleIdToken(token, expected, keys ?? [google.published]);

  it("returns the identity a well-formed token asserts", async () => {
    await expect(verify(await google.sign(claims()))).resolves.toEqual({
      subject: "104729183746501928374",
      // Normalized on the way in, so the address that reaches account linking is the one
      // `identity_emails` stores.
      email: "new.organizer@example.test",
      emailVerified: true,
      name: "Nadia Newcomer",
    });
  });

  it("refuses a token signed by a key that is not the published one", async () => {
    const forged = await stranger.sign(claims());
    await expect(verify(forged)).rejects.toBeInstanceOf(GoogleAuthenticationError);
    await expect(verify(forged)).rejects.toThrow(/signature does not verify/);
    // The same claims, signed by the key Google publishes, are accepted — so the refusal above
    // is about the signature and nothing else.
    await expect(verify(await google.sign(claims()))).resolves.toMatchObject({
      subject: "104729183746501928374",
    });
  });

  it("refuses an unsigned or symmetrically signed token however well formed it is", async () => {
    // Three parts, a real RS256 signature over them, and a header claiming there is none. A
    // verifier that honours `alg` skips the check it would otherwise have passed.
    await expect(verify(await google.sign(claims(), { alg: "none" }))).rejects.toThrow(
      /alg is none, not RS256/,
    );

    // The key-confusion attack: HS256 keyed with the published modulus, which an attacker has.
    // A verifier that reads `alg` and hands the published key to an HMAC check accepts this.
    const signed = `${segment({ alg: "HS256", kid: "google-key-1" })}.${segment(claims())}`;
    const hmac = await crypto.subtle.importKey(
      "raw",
      encoder.encode(String(google.published.n)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(signed)));
    await expect(verify(`${signed}.${base64url(mac)}`)).rejects.toThrow(/alg is HS256, not RS256/);
  });

  it("refuses a key id the published set does not name, rather than trying every key", async () => {
    // Signed by the key that is published — under a `kid` that is not. A verifier that falls
    // back to "try them all" accepts this, which is what makes key rotation meaningless.
    await expect(verify(await google.sign(claims(), { kid: "rotated-away" }))).rejects.toThrow(
      /key set does not publish/,
    );
    await expect(verify(await google.sign(claims()), [])).rejects.toThrow(
      /key set does not publish/,
    );
    // A header with no `kid` at all names no key either.
    const headerless = await google.sign(claims(), { kid: undefined });
    await expect(verify(headerless)).rejects.toThrow(/names no key id/);
  });

  it("refuses a token minted for another client", async () => {
    await expect(
      verify(await google.sign(claims({ aud: "another-app.apps.googleusercontent.com" }))),
    ).rejects.toThrow(/audience is another client/);
    await expect(verify(await google.sign(claims({ aud: ["one", "two"] })))).rejects.toThrow(
      /audience is another client/,
    );
    // `aud` may legitimately be an array, and this client appearing in it is acceptance.
    await expect(
      verify(await google.sign(claims({ aud: ["another-app", clientId] }))),
    ).resolves.toMatchObject({ subject: "104729183746501928374" });
  });

  it("accepts both spellings Google issues and nothing else", async () => {
    for (const iss of ["https://accounts.google.com", "accounts.google.com"])
      await expect(verify(await google.sign(claims({ iss })))).resolves.toMatchObject({
        emailVerified: true,
      });
    for (const iss of [
      "https://accounts.google.com.attacker.test",
      "https://accounts.google.co",
      "https://login.microsoftonline.com/common/v2.0",
      "",
    ])
      await expect(verify(await google.sign(claims({ iss })))).rejects.toThrow(/is not Google/);
  });

  it("refuses a token that has expired or that claims to be from the future", async () => {
    // One minute of skew is tolerated on each side, so the boundary is asserted rather than a
    // value so far out that a broken comparison would still refuse it.
    await expect(verify(await google.sign(claims({ exp: seconds - 61 })))).rejects.toThrow(
      /has expired/,
    );
    await expect(verify(await google.sign(claims({ exp: seconds - 30 })))).resolves.toMatchObject({
      emailVerified: true,
    });
    await expect(verify(await google.sign(claims({ iat: seconds + 3_600 })))).rejects.toThrow(
      /issued in the future/,
    );
    await expect(verify(await google.sign(claims({ exp: "soon" })))).rejects.toThrow(/has expired/);
  });

  it("refuses a token minted for a different attempt", async () => {
    // The replay this stops: a token Google genuinely signed, for this client, unexpired — and
    // bound to somebody else's sign-in.
    await expect(
      verify(await google.sign(claims({ nonce: "another-attempts-nonce" }))),
    ).rejects.toThrow(/nonce does not match/);
    const { nonce: _omitted, ...withoutNonce } = claims();
    await expect(verify(await google.sign(withoutNonce))).rejects.toThrow(/nonce does not match/);
  });

  it("reports an unverified address as unverified rather than refusing it here", async () => {
    // Refusal is signup's decision (`UnverifiedProviderEmailError`), not the verifier's: the
    // token itself is genuine and says so, and this is where that fact survives intact.
    await expect(
      verify(await google.sign(claims({ email_verified: false }))),
    ).resolves.toMatchObject({ emailVerified: false });
    await expect(
      verify(await google.sign(claims({ email_verified: "false" }))),
    ).resolves.toMatchObject({ emailVerified: false });
    await expect(
      verify(await google.sign(claims({ email_verified: "true" }))),
    ).resolves.toMatchObject({ emailVerified: true });
  });

  it("falls back through given_name to the address for a display name", async () => {
    const { name: _dropped, ...anonymous } = claims();
    await expect(
      verify(await google.sign({ ...anonymous, given_name: "Nadia" })),
    ).resolves.toMatchObject({ name: "Nadia" });
    await expect(verify(await google.sign(anonymous))).resolves.toMatchObject({
      // The local part, never the domain, which everyone in the workspace would otherwise read
      // — and spelled as the token spelled it, unlike `email`, which is normalized because it
      // is matched against stored addresses and a display name is not.
      name: "New.Organizer",
    });
  });

  it("refuses malformed input as a credential rather than letting a parser throw", async () => {
    // Every one of these has to become a `GoogleAuthenticationError`, because that is what the
    // callback turns into one indistinguishable redirect. A `TypeError` escaping from a decoder
    // instead is a 500, which both tells the caller they found something and is not a refusal.
    const header = segment({ alg: "RS256", kid: "google-key-1" });
    const payload = (await google.sign(claims())).split(".")[1] ?? "";
    for (const token of [
      "",
      "not-a-token",
      "a.b",
      "a.b.c.d",
      42,
      null,
      // A signature that is not base64 at all.
      `${header}.${payload}.!not-base64!`,
      // Segments that decode but are not a JSON object, each behind a genuine signature so the
      // parse is actually reached.
      await google.signRaw(segment([1, 2]), payload),
      await google.signRaw(header, base64url(encoder.encode("{"))),
      await google.signRaw(header, segment("a string, not an object")),
    ])
      await expect(verifyGoogleIdToken(token, expected, [google.published])).rejects.toBeInstanceOf(
        GoogleAuthenticationError,
      );
  });
});

const configuration: GoogleConfiguration = {
  clientId,
  clientSecret: "a-client-secret-that-must-never-be-sent-to-a-browser",
  redirectUri: "https://greenroom.test/api/auth/google/callback",
};
const secret = "session-signing-secret";

describe("startGoogleAuthorization", () => {
  it("builds a PKCE S256 authorization request whose challenge matches the verifier it kept", async () => {
    const started = await startGoogleAuthorization(configuration, secret, now);
    const url = new URL(started.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: clientId,
      // Configuration, never a request parameter: this is the field that decides where an
      // authorization code is delivered.
      redirect_uri: configuration.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      state: started.state,
      nonce: started.attempt.nonce,
      code_challenge_method: "S256",
      prompt: "select_account",
    });

    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(started.attempt.codeVerifier),
    );
    expect(url.searchParams.get("code_challenge")).toBe(base64url(new Uint8Array(digest)));
    // The verifier is the half that must not reach the browser, and neither must the secret it
    // is proved with.
    expect(started.authorizationUrl).not.toContain(started.attempt.codeVerifier);
    expect(started.authorizationUrl).not.toContain(started.attempt.stateProof);
    expect(started.authorizationUrl).not.toContain(configuration.clientSecret);

    // What is stored is the proof, so a read of the attempt row cannot forge a callback.
    expect(started.attempt.stateProof).toBe(await stateProof(started.state, secret));
    expect(started.attempt.stateProof).not.toBe(await stateProof(started.state, "another-secret"));
    expect(started.attempt.expiresAt).toBe(now + ATTEMPT_LIFETIME_MS);
  });

  it("mints a fresh state, verifier and nonce for every attempt", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => startGoogleAuthorization(configuration, secret, now)),
    );
    for (const field of ["state", "codeVerifier", "nonce", "id"] as const) {
      const values = attempts.map((attempt) =>
        field === "state" ? attempt.state : attempt.attempt[field],
      );
      expect(new Set(values).size).toBe(attempts.length);
    }
    // 32 bytes base64url is RFC 7636's minimum verifier length.
    expect(attempts[0]?.attempt.codeVerifier).toHaveLength(43);
  });
});

describe("completeGoogleAuthorization", () => {
  it("spends the attempt's verifier and verifies the token against the attempt's nonce", async () => {
    const google = await signer("google-key-1");
    const attempt = { codeVerifier: "the-verifier-google-never-saw", nonce };
    const exchanges: unknown[] = [];
    const ports = (idToken: unknown) => ({
      exchange: async (request: unknown) => {
        exchanges.push(request);
        return { id_token: idToken };
      },
      keys: async () => [google.published],
    });

    await expect(
      completeGoogleAuthorization(
        { code: "authorization-code", attempt, configuration, now },
        ports(await google.sign(claims())),
      ),
    ).resolves.toMatchObject({ email: "new.organizer@example.test" });
    expect(exchanges).toEqual([
      { code: "authorization-code", codeVerifier: attempt.codeVerifier, configuration },
    ]);

    // The exchange succeeding is not the sign-in succeeding: a token for another attempt still
    // fails here, after the code has already been spent.
    await expect(
      completeGoogleAuthorization(
        { code: "authorization-code", attempt, configuration, now },
        ports(await google.sign(claims({ nonce: "another-attempts-nonce" }))),
      ),
    ).rejects.toThrow(/nonce does not match/);
    await expect(
      completeGoogleAuthorization(
        { code: "authorization-code", attempt, configuration, now },
        ports(undefined),
      ),
    ).rejects.toThrow(/carried no id_token/);
  });
});
