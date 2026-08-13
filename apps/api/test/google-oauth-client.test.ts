// @acceptance ACC-IDENTITY-EVENTS
// @spec PRD-IAM-001 ARC-AUTH-001
//
// The fetch boundary of Google sign-in, against a stubbed `fetch`, in the shape
// `provider-contract.test.ts` uses for the three delivery adapters.
//
// What this proves and what it cannot: it pins the *request we send* and how we normalize what
// comes back — the grant type, the PKCE verifier, the credential in the body rather than a query
// string, the fixed redirect URI, a non-2xx becoming a typed refusal that carries no provider
// prose, and the key cache actually caching. It says nothing about whether Google accepts that
// request, because no credential exists in this repository and the shape comes from Google's
// documentation rather than from observation. First contact is where it is most likely to be
// wrong, which is exactly why the shape is pinned here rather than left implicit.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleOauthClient } from "../src/adapters/identity/google-oauth-client";
import {
  GOOGLE_JWKS_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleAuthenticationError,
} from "../src/application/identity/google-oauth";

const configuration = {
  clientId: "greenroom.apps.googleusercontent.com",
  clientSecret: "a-secret-that-must-never-reach-a-url-or-a-message",
  redirectUri: "https://greenroom.test/api/auth/google/callback",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const key = { kid: "abc", kty: "RSA", alg: "RS256", n: "modulus", e: "AQAB" };

afterEach(() => vi.unstubAllGlobals());

describe("the Google token exchange", () => {
  it("sends the grant Google documents, and keeps the secret out of the URL", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return Promise.resolve(json({ id_token: "a.b.c" }));
      }),
    );

    await new GoogleOauthClient().exchange({
      code: "the-authorization-code",
      codeVerifier: "the-verifier-google-never-saw",
      configuration,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call?.init) throw new Error("the adapter made no request to inspect");
    expect(call.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(call.init.method).toBe("POST");
    // Form encoding, not JSON: the token endpoint accepts nothing else.
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(call.init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "the-authorization-code",
      code_verifier: "the-verifier-google-never-saw",
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      // The configured URI, never one derived from a request — the open-redirect defence's
      // second half, since Google refuses an exchange whose URI does not match the one the
      // authorization request carried.
      redirect_uri: configuration.redirectUri,
    });
    // The credential travels in the body. A query string reaches proxy logs and browser history.
    expect(call.url).not.toContain(configuration.clientSecret);
  });

  it("turns a refusal into a typed error carrying the status and nothing Google said", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          json({ error: "invalid_grant", error_description: "Code was already redeemed" }, 400),
        ),
      ),
    );

    const exchange = new GoogleOauthClient().exchange({
      code: "spent",
      codeVerifier: "v",
      configuration,
    });

    await expect(exchange).rejects.toBeInstanceOf(GoogleAuthenticationError);
    // The status, so an operator can correlate; not the body, which echoes request parameters
    // back and reaches a shared log sink.
    await expect(exchange).rejects.toThrow("400");
    await expect(exchange).rejects.not.toThrow(/invalid_grant|already redeemed/);
  });

  it("refuses a 2xx that is not an object rather than reading fields off it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json("a string", 200))),
    );
    await expect(
      new GoogleOauthClient().exchange({ code: "c", codeVerifier: "v", configuration }),
    ).rejects.toBeInstanceOf(GoogleAuthenticationError);
  });
});

describe("the Google key set", () => {
  it("reads the published keys and reuses them until the cache expires", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn((url: string) => {
      requested.push(String(url));
      return Promise.resolve(json({ keys: [key] }));
    });
    vi.stubGlobal("fetch", fetcher);
    let clock = 1_000_000;
    const client = new GoogleOauthClient(() => clock);

    expect(await client.keys()).toEqual([key]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requested).toEqual([GOOGLE_JWKS_ENDPOINT]);

    // The property the adapter documents and the composition root exists to preserve: a burst of
    // sign-ins on one isolate is one request, not one each.
    await client.keys();
    await client.keys();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // And it is a cache rather than a one-shot read: past the window it asks again, so a rotated
    // Google key is picked up without a deploy.
    clock += 300_001;
    await client.keys();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses an unreadable or empty key set instead of verifying against nothing", async () => {
    for (const answer of [json({ keys: [] }), json({}), json({ keys: "not-an-array" })]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(answer.clone())),
      );
      await expect(new GoogleOauthClient().keys()).rejects.toBeInstanceOf(
        GoogleAuthenticationError,
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ keys: [key] }, 503))),
    );
    await expect(new GoogleOauthClient().keys()).rejects.toThrow("503");
  });

  it("does not cache a failure, so one bad response is not a five-minute outage", async () => {
    let answer = json({}, 500);
    const fetcher = vi.fn(() => Promise.resolve(answer.clone()));
    vi.stubGlobal("fetch", fetcher);
    const client = new GoogleOauthClient(() => 1_000_000);

    await expect(client.keys()).rejects.toBeInstanceOf(GoogleAuthenticationError);
    answer = json({ keys: [key] });
    expect(await client.keys()).toEqual([key]);
  });

  it("abandons a request that hangs rather than holding the callback open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            // The adapter's own AbortController is the only thing that can end this.
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    vi.useFakeTimers();
    try {
      const pending = new GoogleOauthClient().keys();
      const assertion = expect(pending).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
