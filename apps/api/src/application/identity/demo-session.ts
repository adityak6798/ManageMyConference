import type { Actor } from "./actor";

const encoder = new TextEncoder();
const demoOrganization = { id: "00000000-0000-4000-8000-000000000010" };
const primaryEventId = "00000000-0000-4000-8000-000000000001";
const secondaryEventId = "00000000-0000-4000-8000-000000000002";
const personas = {
  organizer: {
    id: "seed-organizer",
    name: "Olivia Organizer",
    persona: "organizer",
    organizations: [demoOrganization],
    eventAccess: [primaryEventId, secondaryEventId].map((eventId) => ({
      eventId,
      role: "organizer" as const,
      capabilities: [
        "events:read",
        "events:settings:read",
        "events:settings:update",
        "communications:manage",
        "agenda:manage",
        "crm:manage",
        "content:read",
        "content:manage",
        "review:manage",
      ] as const,
    })),
    capabilities: [
      "events:read",
      "events:create",
      "communications:manage",
      "agenda:manage",
      "crm:manage",
      "content:read",
      "content:manage",
      "review:manage",
    ] as const,
  },
  reviewer: {
    id: "seed-reviewer",
    name: "Ravi Reviewer",
    persona: "reviewer",
    organizations: [],
    eventAccess: [
      {
        eventId: primaryEventId,
        role: "reviewer" as const,
        capabilities: ["events:read", "review:evaluate"] as const,
      },
    ],
    capabilities: ["events:read", "review:evaluate"] as const,
  },
  speaker: {
    id: "seed-speaker",
    name: "Sam Speaker",
    persona: "speaker",
    organizations: [],
    eventAccess: [
      {
        eventId: primaryEventId,
        role: "speaker" as const,
        capabilities: ["events:read", "content:read"] as const,
      },
    ],
    capabilities: ["events:read", "content:read"] as const,
  },
  public: {
    id: "seed-public",
    name: "Pat Attendee",
    persona: "public",
    organizations: [],
    eventAccess: [{ eventId: primaryEventId, role: "public" as const, capabilities: [] as const }],
    capabilities: [] as const,
  },
} as const;

export type DemoPersona = keyof typeof personas;

/**
 * The four seeded user ids, derived from the `personas` object rather than listed beside it.
 *
 * Deriving is the point: a list would be a second place to edit, and the failure of forgetting
 * is silent — a persona whose id nobody guards becomes a valid target for real state. Every
 * seeded id is `seed-` + the persona key, and `findByPersona` pins exactly that
 * (`d1-identity-directory.ts`), so this set is the same four rows the demo door can reach.
 */
const demoPersonaIds = new Set(Object.keys(personas).map((persona) => `seed-${persona}`));

/**
 * Is this user id one of the seeded demo personas?
 *
 * The deployed demo runs `DEMO_MODE=true` against the same D1 database that would hold real
 * self-serve organizations if Google were configured there (`GAP-019`). The seeded personas have
 * real addresses in `seed/reset.sql`, so a real sign-in on such a deployment can resolve *to* a
 * seeded row by address — `findByEmail` and `findByProviderAccount` both return a full actor.
 * Nothing about that resolution is wrong on its own; what must never follow is a real session or
 * a real grant landing on a persona, because the demo landing page hands that persona to the
 * next visitor who presses **Continue as organizer**.
 *
 * So this is the predicate that refuses it, at issuance and at every membership write. See the
 * three rules in `docs/architecture/authorization.md`.
 */
export const isDemoPersonaId = (userId: string): boolean => demoPersonaIds.has(userId);

export const resolveSeededDemoActor = async (persona: DemoPersona): Promise<Actor> => {
  const seed = personas[persona];
  return {
    ...seed,
    capabilities: new Set(seed.capabilities),
    eventAccess: seed.eventAccess.map((access) => ({
      ...access,
      capabilities: new Set(access.capabilities),
    })),
  };
};

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
  resolveActor: (persona: DemoPersona) => Promise<Actor | null>,
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
  return resolveActor(persona as DemoPersona);
}
