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
} from "../src/application/identity/real-auth";

const secret = "production-test-secret";
const eventId = "00000000-0000-4000-8000-000000000001";
const resolveActor = async (userId: string) =>
  userId === "seed-organizer" ? resolveSeededDemoActor("organizer") : null;

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
    const session = await createUserSession("seed-organizer", secret, 2_000);
    await expect(resolveUserSession(session, secret, 1_000, resolveActor)).resolves.toMatchObject({
      id: "seed-organizer",
    });
    await expect(resolveUserSession(session, secret, 2_000, resolveActor)).resolves.toBeNull();
    await expect(
      resolveUserSession(`${session}x`, secret, 1_000, resolveActor),
    ).resolves.toBeNull();
  });

  it("reduces bearer identity to the token's one event", async () => {
    const bearer = await createEventToken("seed-organizer", eventId, secret, 2_000);
    const actor = await resolveEventToken(bearer, secret, 1_000, resolveActor);
    expect(actor?.eventAccess.every((access) => access.eventId === eventId)).toBe(true);
    expect(actor?.eventAccess).toHaveLength(1);
    await expect(resolveEventToken(bearer, secret, 2_000, resolveActor)).resolves.toBeNull();
  });
});
