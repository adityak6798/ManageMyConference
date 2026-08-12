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

async function sign(payload: string, secret: string) {
  return base64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload))),
  );
}

async function token(payload: object, secret: string) {
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, secret)}`;
}

async function verify<T>(value: string | undefined, secret: string): Promise<T | null> {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      decode64url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    return JSON.parse(decoder.decode(decode64url(payload))) as T;
  } catch {
    // ERROR-INTENT: malformed signed input is an invalid credential, not an operational failure.
    return null;
  }
}

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
  secret: string,
  expiresAt: number,
): Promise<LoginChallenge> {
  const id = crypto.randomUUID();
  const randomValue = crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0;
  const code = String(randomValue % 1_000_000).padStart(6, "0");
  const codeProof = await sign(`${email}.${code}.${expiresAt}`, secret);
  return {
    id,
    email,
    code,
    codeProof,
    expiresAt,
    challenge: await token({ kind: "login", id, email, expiresAt }, secret),
  };
}

export async function exchangeLoginChallenge(
  challenge: string,
  code: string,
  secret: string,
  now: number,
  consume: (id: string, codeProof: string, now: number) => Promise<string | null>,
): Promise<string | null> {
  const payload = await verify<{
    kind: string;
    id: string;
    email: string;
    expiresAt: number;
  }>(challenge, secret);
  if (payload?.kind !== "login" || payload.expiresAt <= now || !payload.id) return null;
  return consume(
    payload.id,
    await sign(`${payload.email}.${code}.${payload.expiresAt}`, secret),
    now,
  );
}

export const createUserSession = (userId: string, secret: string, expiresAt: number) =>
  token({ kind: "session", userId, expiresAt }, secret);

export async function resolveUserSession(
  value: string | undefined,
  secret: string,
  now: number,
  resolveActor: (userId: string) => Promise<Actor | null>,
) {
  const payload = await verify<{ kind: string; userId: string; expiresAt: number }>(value, secret);
  if (payload?.kind !== "session" || payload.expiresAt <= now) return null;
  return resolveActor(payload.userId);
}

export const createEventToken = (
  userId: string,
  eventId: string,
  secret: string,
  expiresAt: number,
) => token({ kind: "event", userId, eventId, expiresAt }, secret);

export async function resolveEventToken(
  value: string | undefined,
  secret: string,
  now: number,
  resolveActor: (userId: string) => Promise<Actor | null>,
) {
  const payload = await verify<{
    kind: string;
    userId: string;
    eventId: string;
    expiresAt: number;
  }>(value, secret);
  if (payload?.kind !== "event" || payload.expiresAt <= now) return null;
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
