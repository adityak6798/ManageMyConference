// @acceptance ACC-IDENTITY-EVENTS
import { describe, expect, it } from "vitest";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import {
  createEventToken,
  createLoginChallenge,
  createUserSession,
  exchangeLoginChallenge,
  resolveEventToken,
  resolveUserSession,
  sessionIdFrom,
} from "../src/application/identity/real-auth";

const secret = "production-test-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const sid = "11111111-2222-4333-8444-555555555555";
const resolveActor = async (userId: string) =>
  userId === "seed-organizer" ? resolveSeededDemoActor("organizer") : null;
/** A store in which the one session under test is live and nothing else exists. */
const liveSession = async (id: string) => (id === sid ? { userId: "seed-organizer" } : null);

/**
 * A session token in the shape this module minted before `sid` existed: the same two parts and
 * the same signature, with a payload that names no session record.
 *
 * Built here rather than kept as a fixture string, so it stays signed with this suite's secret
 * and cannot rot into "a token that fails for the wrong reason".
 */
async function signLegacy(claims: object): Promise<string> {
  const encoder = new TextEncoder();
  const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

const legacySessionToken = (userId: string, expiresAt: number) =>
  signLegacy({ kind: "session", userId, expiresAt });

const legacyEventToken = (userId: string, eventId: string, expiresAt: number) =>
  signLegacy({ kind: "event", userId, eventId, expiresAt });

describe("production authentication tokens", () => {
  it("exchanges an emailed code without exposing the code in the challenge", async () => {
    const issued = await createLoginChallenge("organizer@greenroom.test", secret, 2_000);
    const consumer = () => {
      let consumed = false;
      return async (_id: string, proof: string, now: number) => {
        if (consumed || now >= 2_000 || proof !== issued.codeProof) return null;
        consumed = true;
        return issued.email;
      };
    };
    expect(issued.challenge).not.toContain(issued.code);
    await expect(
      exchangeLoginChallenge(issued.challenge, "000000", secret, 1_000, consumer()),
    ).resolves.toBeNull();
    await expect(
      exchangeLoginChallenge(issued.challenge, issued.code, secret, 2_000, consumer()),
    ).resolves.toBeNull();
    let consumed = false;
    const consume = async (_id: string, proof: string, now: number) => {
      if (consumed || now >= 2_000 || proof !== issued.codeProof) return null;
      consumed = true;
      return issued.email;
    };
    await expect(
      exchangeLoginChallenge(issued.challenge, issued.code, secret, 1_000, consume),
    ).resolves.toBe(issued.email);
    await expect(
      exchangeLoginChallenge(issued.challenge, issued.code, secret, 1_000, consume),
    ).resolves.toBeNull();
  });

  it("rejects expired and tampered session cookies", async () => {
    const session = await createUserSession(sid, "seed-organizer", secret, 2_000);
    await expect(
      resolveUserSession(session, secret, 1_000, resolveActor, liveSession),
    ).resolves.toMatchObject({ id: "seed-organizer" });
    await expect(
      resolveUserSession(session, secret, 2_000, resolveActor, liveSession),
    ).resolves.toBeNull();
    await expect(
      resolveUserSession(`${session}x`, secret, 1_000, resolveActor, liveSession),
    ).resolves.toBeNull();
  });

  /**
   * The grammar `docs/architecture/authorization.md` relies on to let one cookie name carry a
   * persona cookie and a real session on the same deployment.
   *
   * A session token is exactly two dot-separated parts and a demo token exactly three, which is
   * what makes them mutually unparseable. Adding the `sid` claim put a field in the payload, not
   * a part in the token, and this is the assertion that says so — the same invariant is asserted
   * from the demo side in `demo-session.test.ts`.
   */
  it("keeps a session token to two parts after adding the session id", async () => {
    const session = await createUserSession(sid, "seed-organizer", secret, 2_000);
    expect(session.split(".")).toHaveLength(2);
    // And the id is a claim inside the signed payload rather than a third segment.
    await expect(sessionIdFrom(session, secret, 1_000)).resolves.toBe(sid);
  });

  /**
   * A dead credential is not an instrument.
   *
   * `sessionIdFrom` is what `/api/auth/signout` reads, and that route has no throttle. An HMAC
   * stays valid for as long as the secret does, so without the expiry check an expired cookie
   * could be replayed there indefinitely and each replay would reach D1 — writing nothing, but
   * costing a query every time. Refusing here takes nothing from the caller: a session past its
   * expiry is already over.
   */
  it("will not name a session id from an expired cookie", async () => {
    const session = await createUserSession(sid, "seed-organizer", secret, 2_000);
    await expect(sessionIdFrom(session, secret, 1_999)).resolves.toBe(sid);
    await expect(sessionIdFrom(session, secret, 2_000)).resolves.toBeNull();
    // A demo persona cookie is three parts and never verifies here at all.
    await expect(sessionIdFrom("organizer.2000.abc", secret, 1_000)).resolves.toBeNull();
  });

  /**
   * The bearer token's `sid` guard is asserted in its own right, not only through a store that
   * happens to answer null for `undefined`.
   */
  it("refuses an event bearer token that names no session", async () => {
    const legacy = await legacyEventToken("seed-organizer", eventId, 2_000);
    await expect(
      resolveEventToken(legacy, secret, 1_000, resolveActor, async () => ({
        userId: "seed-organizer",
      })),
    ).resolves.toBeNull();
  });

  /**
   * A token minted before durable sessions existed carries no `sid`, and is refused.
   *
   * That signs everybody out once, which is the intended cost: honouring a legacy token until it
   * expired would leave the pre-#12 property — a copy of a cookie that outlives its sign-out —
   * in place for a further eight hours, which is exactly what this change exists to remove.
   */
  it("refuses a session token minted before session records existed", async () => {
    const legacy = await legacySessionToken("seed-organizer", 2_000);
    expect(legacy.split(".")).toHaveLength(2);
    await expect(
      resolveUserSession(legacy, secret, 1_000, resolveActor, liveSession),
    ).resolves.toBeNull();
  });

  it("refuses a signed session whose record is gone, revoked, or belongs to somebody else", async () => {
    const session = await createUserSession(sid, "seed-organizer", secret, 2_000);
    const absent = async () => null;
    await expect(
      resolveUserSession(session, secret, 1_000, resolveActor, absent),
    ).resolves.toBeNull();
    // The record's `user_id` is compared with the signed payload's rather than followed. A row
    // naming somebody else is refused; it never resolves that somebody else.
    await expect(
      resolveUserSession(session, secret, 1_000, resolveActor, async () => ({
        userId: "seed-reviewer",
      })),
    ).resolves.toBeNull();
  });

  /**
   * Signature first, store second.
   *
   * A resolver that looked the session up before verifying would turn an unauthenticated flood
   * of forged cookies into a stream of database reads. Every refusal above the lookup — wrong
   * signature, wrong kind, expired, no `sid` — must cost no query at all.
   */
  it("verifies the signature before it reads the session store", async () => {
    const asked: string[] = [];
    const counting = async (id: string) => {
      asked.push(id);
      return { userId: "seed-organizer" };
    };
    const session = await createUserSession(sid, "seed-organizer", secret, 2_000);
    await expect(
      resolveUserSession(`${session}x`, secret, 1_000, resolveActor, counting),
    ).resolves.toBeNull();
    await expect(
      resolveUserSession(session, "a-different-secret", 1_000, resolveActor, counting),
    ).resolves.toBeNull();
    await expect(
      resolveUserSession(session, secret, 9_000, resolveActor, counting),
    ).resolves.toBeNull();
    expect(asked).toEqual([]);
    // And the store is asked exactly once when the signature does verify.
    await expect(
      resolveUserSession(session, secret, 1_000, resolveActor, counting),
    ).resolves.toMatchObject({ id: "seed-organizer" });
    expect(asked).toEqual([sid]);
  });

  it("reduces bearer identity to the token's one event", async () => {
    const bearer = await createEventToken(sid, "seed-organizer", eventId, secret, 2_000);
    const actor = await resolveEventToken(bearer, secret, 1_000, resolveActor, liveSession);
    expect(actor?.eventAccess.every((access) => access.eventId === eventId)).toBe(true);
    expect(actor?.eventAccess).toHaveLength(1);
    await expect(
      resolveEventToken(bearer, secret, 2_000, resolveActor, liveSession),
    ).resolves.toBeNull();
  });

  /**
   * The bearer token inherits its parent session's revocation, which is `ADR-005`'s deliberate
   * decision: signing out ends API access minted from that browser. A credential independent of
   * a browser session is issue #100.
   */
  it("refuses a bearer token once the session it was minted from is revoked", async () => {
    const bearer = await createEventToken(sid, "seed-organizer", eventId, secret, 2_000);
    await expect(
      resolveEventToken(bearer, secret, 1_000, resolveActor, liveSession),
    ).resolves.toMatchObject({ id: "seed-organizer" });
    await expect(
      resolveEventToken(bearer, secret, 1_000, resolveActor, async () => null),
    ).resolves.toBeNull();
  });
});
