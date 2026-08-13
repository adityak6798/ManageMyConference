import type { Actor } from "./actor";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The signing secret, or the pair a rotation is in flight across.
 *
 * A plain string is the ordinary case and stays writable as one, which is what keeps the ~30
 * configuration sites in the test suites unchanged. The pair exists for the window in which a
 * secret is being replaced: issuance always uses `current`, verification tries `current` and then
 * `previous`, so sessions minted before the rotation keep working until they expire instead of
 * everybody being signed out at the moment of the deploy.
 *
 * See `docs/engineering/security-operations.md` for the procedure and the window.
 */
export type SigningSecrets = string | { current: string; previous?: string | undefined };

/** What a new token is signed with. Never `previous`: a rotation moves forward only. */
export const issuingSecret = (secrets: SigningSecrets): string =>
  typeof secrets === "string" ? secrets : secrets.current;

/** What an existing token may have been signed with, newest first. */
export const verifyingSecrets = (secrets: SigningSecrets): readonly string[] => {
  if (typeof secrets === "string") return [secrets];
  return secrets.previous ? [secrets.current, secrets.previous] : [secrets.current];
};

async function sign(payload: string, secret: string) {
  return base64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload))),
  );
}

async function token(payload: object, secrets: SigningSecrets) {
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, issuingSecret(secrets))}`;
}

/**
 * Verify against each secret in turn, and report **which one matched**.
 *
 * The caller needs to know: an emailed code's proof was signed with the same secret as the
 * challenge that carries it, so re-deriving that proof under a different secret would refuse a
 * perfectly good code. Everything else ignores the second half of the answer.
 */
async function verifyWith<T>(
  value: string | undefined,
  secrets: SigningSecrets,
): Promise<{ payload: T; secret: string } | null> {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  for (const secret of verifyingSecrets(secrets)) {
    try {
      const valid = await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decode64url(signature),
        encoder.encode(payload),
      );
      if (!valid) continue;
      return { payload: JSON.parse(decoder.decode(decode64url(payload))) as T, secret };
    } catch {
      // ERROR-INTENT: malformed signed input is an invalid credential, not an operational
      // failure, and a malformed signature cannot verify under the other secret either — so this
      // returns rather than continuing to the next one.
      return null;
    }
  }
  return null;
}

const verify = async <T>(value: string | undefined, secrets: SigningSecrets): Promise<T | null> =>
  (await verifyWith<T>(value, secrets))?.payload ?? null;

export interface LoginChallenge {
  id: string;
  email: string;
  code: string;
  challenge: string;
  codeProof: string;
  expiresAt: number;
}

export async function createLoginChallenge(
  email: string,
  secrets: SigningSecrets,
  expiresAt: number,
): Promise<LoginChallenge> {
  const id = crypto.randomUUID();
  const randomValue = crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0;
  const code = String(randomValue % 1_000_000).padStart(6, "0");
  const codeProof = await sign(`${email}.${code}.${expiresAt}`, issuingSecret(secrets));
  return {
    id,
    email,
    code,
    codeProof,
    expiresAt,
    challenge: await token({ kind: "login", id, email, expiresAt }, secrets),
  };
}

export async function exchangeLoginChallenge(
  challenge: string,
  code: string,
  secrets: SigningSecrets,
  now: number,
  consume: (id: string, codeProof: string, now: number) => Promise<string | null>,
): Promise<string | null> {
  // The proof is re-derived under **the secret that verified the challenge**, not under the
  // current one. The two were minted together, so across a rotation window a challenge issued
  // before the change still yields the proof its stored row holds — deriving it under the new
  // secret would refuse a perfectly good code.
  const verified = await verifyWith<{
    kind: string;
    id: string;
    email: string;
    expiresAt: number;
  }>(challenge, secrets);
  if (!verified) return null;
  const payload = verified.payload;
  if (payload.kind !== "login" || payload.expiresAt <= now || !payload.id) return null;
  return consume(
    payload.id,
    await sign(`${payload.email}.${code}.${payload.expiresAt}`, verified.secret),
    now,
  );
}

/**
 * Look up the session a credential names, and say whether it is still live.
 *
 * Narrower than `SessionStore` on purpose: this layer may ask whether a session exists and it
 * may not revoke one, and the returned `userId` is compared against the signed payload rather
 * than used to resolve anybody.
 */
export type FindSession = (id: string, now: number) => Promise<{ userId: string } | null>;

/**
 * Sign a session cookie for one issued session record.
 *
 * `sid` names the row in `identity_sessions`. The token still has exactly **two**
 * dot-separated parts, which is load-bearing: the demo grammar is three parts and the two are
 * mutually unparseable, which is what lets one cookie name carry either
 * (`docs/architecture/authorization.md`). Adding a payload field does not change the part count,
 * and `real-auth.test.ts` asserts that it has not.
 */
export const createUserSession = (
  sid: string,
  userId: string,
  secrets: SigningSecrets,
  expiresAt: number,
) => token({ kind: "session", sid, userId, expiresAt }, secrets);

/**
 * Resolve a session cookie to its actor, refusing one whose record is gone, revoked or expired.
 *
 * **The signature is verified before D1 is read**, and the order is the point: a resolver that
 * looked the session up first would let an unauthenticated flood of forged cookies become a
 * stream of database reads. Every refusal above the `findSession` call costs no query at all.
 *
 * A token minted before durable sessions existed carries no `sid` and is refused here. That
 * signs everybody out once, which is the intended effect: honouring a legacy token until it
 * expired would reintroduce, for the length of a session lifetime, exactly the property this
 * exists to close.
 */
export async function resolveUserSession(
  value: string | undefined,
  secrets: SigningSecrets,
  now: number,
  resolveActor: (userId: string) => Promise<Actor | null>,
  findSession: FindSession,
) {
  const payload = await verify<{
    kind: string;
    sid?: string;
    userId: string;
    expiresAt: number;
  }>(value, secrets);
  if (payload?.kind !== "session" || payload.expiresAt <= now || !payload.sid) return null;
  const session = await findSession(payload.sid, now);
  // The record's `user_id` is compared, never followed: the actor comes from the signed payload
  // through `resolveActor`. A mismatch cannot happen without the signing key, and refusing it
  // costs one comparison.
  if (!session || session.userId !== payload.userId) return null;
  return resolveActor(payload.userId);
}

/**
 * The session id a cookie names, once its signature has been verified — and nothing else.
 *
 * Sign-out needs the `sid` of a credential whose *actor* may not have resolved: an already
 * revoked session, or one whose user has since been removed, still names a row somebody may be
 * asking us to revoke. Reading it from the signed payload is what lets the route act on the
 * cookie it was given without a second way to resolve an actor from it.
 *
 * **Expiry is checked**, and it is the one bound that keeps this from being a free write. A
 * signature stays valid for as long as the secret does, so without this an expired cookie could
 * be replayed at `/api/auth/signout` indefinitely; the route has no throttle, and each replay
 * would reach D1. Refusing here costs the caller nothing real — a session that has expired is
 * already over — and it means a dead credential stops being an instrument.
 *
 * A demo persona cookie has three parts and never verifies here, so it yields null and takes no
 * store lookup.
 */
export async function sessionIdFrom(
  value: string | undefined,
  secrets: SigningSecrets,
  now: number,
): Promise<string | null> {
  const payload = await verify<{ kind: string; sid?: string; expiresAt: number }>(value, secrets);
  if (payload?.kind !== "session" || payload.expiresAt <= now || !payload.sid) return null;
  return payload.sid;
}

/**
 * An event-scoped bearer token, carrying the `sid` of the session it was minted from.
 *
 * Signing out therefore kills API access minted from that browser. That is a deliberate
 * decision rather than a side effect — see `ADR-005`. A client credential that outlives a
 * browser session belongs to issue #100 ("Productize the REST API with scoped clients").
 */
export const createEventToken = (
  sid: string,
  userId: string,
  eventId: string,
  secrets: SigningSecrets,
  expiresAt: number,
) => token({ kind: "event", sid, userId, eventId, expiresAt }, secrets);

export async function resolveEventToken(
  value: string | undefined,
  secrets: SigningSecrets,
  now: number,
  resolveActor: (userId: string) => Promise<Actor | null>,
  findSession: FindSession,
) {
  const payload = await verify<{
    kind: string;
    sid?: string;
    userId: string;
    eventId: string;
    expiresAt: number;
  }>(value, secrets);
  if (payload?.kind !== "event" || payload.expiresAt <= now || !payload.sid) return null;
  const session = await findSession(payload.sid, now);
  if (!session || session.userId !== payload.userId) return null;
  const actor = await resolveActor(payload.userId);
  if (!actor) return null;
  const eventAccess = actor.eventAccess.filter(({ eventId }) => eventId === payload.eventId);
  if (eventAccess.length === 0) return null;
  return {
    ...actor,
    organizations: [],
    eventAccess,
    capabilities: new Set(eventAccess.flatMap(({ capabilities }) => [...capabilities])),
  };
}
