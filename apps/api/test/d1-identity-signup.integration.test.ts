// @acceptance ACC-IDENTITY-EVENTS
/**
 * Self-serve signup against a real, migrated, seeded D1 database.
 *
 * Two things are only true here and nowhere else. The first is single use: `consumeOauthAttempt`
 * is one `DELETE … RETURNING`, and whether that really admits exactly one caller is a property of
 * SQLite rather than of the TypeScript around it. The second is isolation, and it is the reason
 * this file exists: the demo persona and a self-serve signup share one deployment, one database
 * and one cookie name, and the claim that neither can see the other's workspace has to be proved
 * against the same storage and the same authorization derivation production uses. The in-memory
 * demo fixture cannot prove it — it hard-codes the persona's access and so agrees with itself.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";
import {
  D1IdentityDirectory,
  type IdentityDatabasePort,
} from "../src/adapters/persistence/d1-identity-directory";
import { EventService } from "../src/application/events/event-service";
import {
  type GoogleIdentity,
  startGoogleAuthorization,
  stateProof,
} from "../src/application/identity/google-oauth";
import { SignupService } from "../src/application/identity/signup";
import { createMigratedDatabase } from "./support/seeded-d1";

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const DEMO_WORKSHOP = "00000000-0000-4000-8000-000000000002";
const DEMO_ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const linkedAt = 1_760_000_000_000;

/** The composition `index.ts` builds for a request, over whichever database the case made. */
function signupStack(database: unknown) {
  const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
  const events = new EventService({
    repository: new D1EventRepository(database as D1DatabasePort),
    newId: () => crypto.randomUUID(),
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    grantOrganizer: (eventId, userId) => directory.grantOrganizer(eventId, userId),
  });
  const signup = new SignupService({
    directory,
    workspace: {
      provisionOrganization: (command) => events.provisionOrganization(command),
      createFirstEvent: (actor, command) => events.create(actor, command),
      eventsInOrganization: async (actor, organizationId) =>
        (await events.list(actor)).filter((event) => event.organizationId === organizationId),
    },
    newId: () => crypto.randomUUID(),
    now: () => linkedAt,
  });
  return { directory, events, signup };
}

const newcomer: GoogleIdentity = {
  subject: "104729183746501928374",
  email: "nadia@example.test",
  emailVerified: true,
  name: "Nadia Newcomer",
};

describe("Google signup against migrated D1", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  it("spends an authorization attempt exactly once, and only on its own proof", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-oauth-attempts", seed: true });
    runtime = migrated.runtime;
    const { directory } = signupStack(migrated.database);
    const attempt = {
      id: "attempt-single-use",
      stateProof: "the-proof-of-this-attempts-state",
      codeVerifier: "the-verifier-google-never-saw",
      nonce: "attempt-nonce",
      expiresAt: 2_000_000,
    };

    await directory.saveOauthAttempt(attempt);
    await expect(
      directory.consumeOauthAttempt(attempt.id, attempt.stateProof, 1_000_000),
    ).resolves.toEqual({ codeVerifier: attempt.codeVerifier, nonce: attempt.nonce });
    // A replayed callback — the same id, the same valid `state` — finds nothing to spend. This
    // is the property a read-then-delete could not promise under two racing callbacks.
    await expect(
      directory.consumeOauthAttempt(attempt.id, attempt.stateProof, 1_000_000),
    ).resolves.toBeNull();

    await directory.saveOauthAttempt({ ...attempt, id: "attempt-wrong-proof" });
    await expect(
      directory.consumeOauthAttempt("attempt-wrong-proof", "a-forged-proof", 1_000_000),
    ).resolves.toBeNull();
    // Refusing a forged `state` must not spend the attempt the real browser still holds.
    await expect(
      directory.consumeOauthAttempt("attempt-wrong-proof", attempt.stateProof, 1_000_000),
    ).resolves.toEqual({ codeVerifier: attempt.codeVerifier, nonce: attempt.nonce });

    await directory.saveOauthAttempt({ ...attempt, id: "attempt-expired" });
    await expect(
      directory.consumeOauthAttempt("attempt-expired", attempt.stateProof, attempt.expiresAt),
    ).resolves.toBeNull();
    await expect(
      directory.consumeOauthAttempt("attempt-unknown", attempt.stateProof, 1_000_000),
    ).resolves.toBeNull();

    /*
     * The assertion that separates the shipped statement from a plausible rewrite of it.
     *
     * Everything above is await-then-await, and a `SELECT` whose result guards a separate
     * `DELETE` satisfies every line of it — measured, not assumed: replayed against this same
     * Miniflare D1, the sequential assertions pass for both implementations. Only overlapping
     * callers tell them apart, and then decisively: one winner for `DELETE … RETURNING`, three
     * for read-then-delete. Two callbacks carrying the same `state` arriving together is exactly
     * the replay this table exists to refuse, so it is worth asserting rather than describing.
     */
    await directory.saveOauthAttempt({ ...attempt, id: "attempt-raced" });
    const raced = await Promise.all([
      directory.consumeOauthAttempt("attempt-raced", attempt.stateProof, 1_000_000),
      directory.consumeOauthAttempt("attempt-raced", attempt.stateProof, 1_000_000),
      directory.consumeOauthAttempt("attempt-raced", attempt.stateProof, 1_000_000),
    ]);
    expect(raced.filter((outcome) => outcome !== null)).toEqual([
      { codeVerifier: attempt.codeVerifier, nonce: attempt.nonce },
    ]);
  });

  /**
   * The `state` binding itself, minted and spent the way the Worker does it.
   *
   * The case above uses literal proofs, so it pins single use but says nothing about *what* a
   * proof is. This closes that: the attempt is minted by `startGoogleAuthorization` and spent
   * with a proof derived from the `state` value the browser carried, which is the arrangement
   * `index.ts` wires and the only thing standing between a callback and a forged one. Without
   * it, a `stateProof` that ignored its input — or a `consumeOauthAttempt` that ignored the
   * proof — would pass every other test in this file.
   */
  it("spends an attempt only for the state value it issued", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-oauth-state", seed: true });
    runtime = migrated.runtime;
    const { directory } = signupStack(migrated.database);
    const secret = "a-session-secret-for-this-test";
    const started = await startGoogleAuthorization(
      {
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "unused-here",
        redirectUri: "https://greenroom.test/api/auth/google/callback",
      },
      secret,
      1_000_000,
    );
    await directory.saveOauthAttempt(started.attempt);

    // The state travels through Google in the URL; only its proof is ever stored, so a database
    // read cannot forge this call.
    expect(started.attempt.stateProof).not.toBe(started.state);
    await expect(
      directory.consumeOauthAttempt(
        started.attempt.id,
        await stateProof(`${started.state}-tampered`, secret),
        1_000_100,
      ),
    ).resolves.toBeNull();
    // A proof of the right state under the wrong secret is equally worthless.
    await expect(
      directory.consumeOauthAttempt(
        started.attempt.id,
        await stateProof(started.state, "a-different-session-secret"),
        1_000_100,
      ),
    ).resolves.toBeNull();
    // And the genuine one spends it, returning the verifier that never left this server.
    await expect(
      directory.consumeOauthAttempt(
        started.attempt.id,
        await stateProof(started.state, secret),
        1_000_100,
      ),
    ).resolves.toEqual({
      codeVerifier: started.attempt.codeVerifier,
      nonce: started.attempt.nonce,
    });
  });

  it("writes the whole identity of a self-serve signup, and resolves it back", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-self-serve", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { directory, events } = signupStack(database);
    const organization = await events.provisionOrganization({ name: "Nadia Newcomer" });

    await directory.createSelfServeIdentity({
      userId: "self-serve-user",
      name: newcomer.name,
      email: "Nadia@Example.test",
      provider: "google",
      subject: newcomer.subject,
      linkedAt,
      organizationId: organization.id,
    });

    const rows = async (sql: string, value: string) => {
      const result = await database.prepare(sql).bind(value).all<{ total: number }>();
      return result.results?.[0]?.total;
    };
    await expect(
      rows("SELECT count(*) AS total FROM users WHERE id = ?", "self-serve-user"),
    ).resolves.toBe(1);
    await expect(
      rows("SELECT count(*) AS total FROM identity_emails WHERE user_id = ?", "self-serve-user"),
    ).resolves.toBe(1);
    await expect(
      rows(
        "SELECT count(*) AS total FROM identity_provider_accounts WHERE user_id = ?",
        "self-serve-user",
      ),
    ).resolves.toBe(1);
    await expect(
      rows(
        "SELECT count(*) AS total FROM organization_memberships WHERE user_id = ?",
        "self-serve-user",
      ),
    ).resolves.toBe(1);

    await expect(directory.findByProviderAccount("google", newcomer.subject)).resolves.toEqual({
      id: "self-serve-user",
      name: newcomer.name,
      persona: "organizer",
      organizations: [{ id: organization.id }],
      eventAccess: [],
      // A membership alone confers the workspace-level capabilities and no event access, which
      // is exactly the state signup then completes with a first event.
      capabilities: new Set([
        "events:read",
        "events:create",
        "communications:manage",
        "agenda:manage",
      ]),
    });
    // The address is normalized on the way in, so the emailed-code door resolves the same user.
    await expect(directory.findByEmail("nadia@example.test")).resolves.toMatchObject({
      id: "self-serve-user",
    });
    await expect(directory.findByProviderAccount("google", "another-subject")).resolves.toBeNull();
  });

  it("keeps the demo persona and a self-serve organizer blind to each other", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-isolation", seed: true });
    runtime = migrated.runtime;
    const { directory, events, signup } = signupStack(migrated.database);

    const outcome = await signup.signInWithGoogle(newcomer);

    expect(outcome.provisioned).toBe(true);
    const selfServeOrganization = outcome.actor.organizations[0]?.id as string;
    const selfServeEvent = outcome.actor.eventAccess[0]?.eventId as string;
    expect(selfServeOrganization).toBeTruthy();
    expect(selfServeEvent).toBeTruthy();
    expect(selfServeOrganization).not.toBe(DEMO_ORGANIZATION);

    /*
     * Resolved the way a request resolves it — through the directory, against the rows — rather
     * than from the in-memory persona fixture, which has drifted narrower than D1 and would
     * agree with any answer.
     */
    const demoOrganizer = await directory.findByPersona("organizer");
    expect(demoOrganizer?.organizations).toEqual([{ id: DEMO_ORGANIZATION }]);
    expect(demoOrganizer?.organizations.map(({ id }) => id)).not.toContain(selfServeOrganization);
    expect(demoOrganizer?.eventAccess.map(({ eventId }) => eventId)).not.toContain(selfServeEvent);
    expect(await directory.isReviewerForEvent("seed-organizer", selfServeEvent)).toBe(false);

    // And the newcomer holds nothing on the seeded demo event, which every persona can reach.
    expect(outcome.actor.eventAccess.map(({ eventId }) => eventId)).toEqual([selfServeEvent]);
    expect(outcome.actor.eventAccess.map(({ eventId }) => eventId)).not.toContain(DEMO_EVENT);
    expect(outcome.actor.organizations).toEqual([{ id: selfServeOrganization }]);

    /*
     * The same claim one layer up, where a user would notice it: what each actor's console
     * lists, and what it can open by id. `get` answering null rather than refusing is the
     * scoped read — an id you hold no access to is indistinguishable from one that does not
     * exist, which is what keeps the console from enumerating other workspaces.
     */
    const demoList = (await events.list(demoOrganizer)).map(({ id }) => id);
    expect(demoList).toEqual([DEMO_EVENT, DEMO_WORKSHOP]);
    expect(demoList).not.toContain(selfServeEvent);
    await expect(events.get(demoOrganizer, selfServeEvent)).resolves.toBeNull();

    const selfServeList = (await events.list(outcome.actor)).map(({ id }) => id);
    expect(selfServeList).toEqual([selfServeEvent]);
    await expect(events.get(outcome.actor, DEMO_EVENT)).resolves.toBeNull();
    await expect(events.get(outcome.actor, DEMO_WORKSHOP)).resolves.toBeNull();
  });
});
