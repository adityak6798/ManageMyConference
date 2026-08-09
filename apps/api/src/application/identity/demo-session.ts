import type { Actor } from "./actor";

const encoder = new TextEncoder();
const personas = {
  organizer: {
    id: "seed-organizer",
    persona: "organizer",
    capabilities: ["events:read", "events:create"],
  },
  reviewer: { id: "seed-reviewer", persona: "reviewer", capabilities: [] },
  speaker: { id: "seed-speaker", persona: "speaker", capabilities: [] },
} as const;

export type DemoPersona = keyof typeof personas;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signature(value: string, secret: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(value)));
}

export async function createDemoSession(
  persona: DemoPersona,
  secret: string,
  expiresAt: number,
): Promise<string> {
  const payload = `${persona}.${expiresAt}`;
  return `${payload}.${await signature(payload, secret)}`;
}

export async function resolveDemoSession(
  token: string | undefined,
  secret: string,
  now: number,
): Promise<Actor | null> {
  if (!token) return null;
  const [persona, expiryText, suppliedSignature, extra] = token.split(".");
  if (extra || !persona || !expiryText || !suppliedSignature || !(persona in personas)) return null;
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  if (!/^[0-9a-f]{64}$/.test(suppliedSignature)) return null;
  const suppliedBytes = new Uint8Array(
    suppliedSignature.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    suppliedBytes,
    encoder.encode(`${persona}.${expiresAt}`),
  );
  if (!valid) return null;
  const seed = personas[persona as DemoPersona];
  return { ...seed, capabilities: new Set(seed.capabilities) };
}
