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
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseUnseededCounts,
  seededFixtureIds,
  unseededCountQuery,
} from "../../../tools/remote-demo-reset.mjs";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";
import {
  D1IdentityDirectory,
  type IdentityDatabasePort,
  preparedOrganizerGrant,
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
const SEED_FILE = new URL("../seed/reset.sql", import.meta.url);

/** The composition `index.ts` builds for a request, over whichever database the case made. */
function signupStack(database: unknown) {
  const directory = new D1IdentityDirectory(database as IdentityDatabasePort);
  const events = new EventService({
    repository: new D1EventRepository(database as D1DatabasePort, preparedOrganizerGrant),
    newId: () => crypto.randomUUID(),
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });
  const signup = new SignupService({
    directory,
    workspace: {
      provisionOrganization: (command) => events.provisionOrganization(command),
      createFirstEvent: (actor, command) => events.provisionFirstEvent(actor, command),
      eventsInOrganization: async (actor, organizationId) =>
        (await events.list(actor)).filter((event) => event.organizationId === organizationId),
      discardUnusedOrganization: (organizationId) =>
        events.discardUnusedOrganization(organizationId),
    },
    newId: () => crypto.randomUUID(),
    now: () => linkedAt,
  });
  return { directory, events, signup };
}

/**
 * What this database holds beyond the seeded fixture, counted by the demo restore's own guard.
 *
 * Borrowed rather than re-implemented, and the borrowing is the point: the rows a signup leaves
 * behind are exactly the rows `npm run reset:demo` refuses on (`GAP-019`), so asserting them with
 * that guard's query says something about the deployment rather than only about this test. It
 * also keeps the SQL in the domains that own those tables, which is why the tool composes it from
 * their statement modules instead of writing it.
 */
async function unseededRows(database: unknown) {
  const ids = seededFixtureIds(await readFile(SEED_FILE, "utf8"));
  const result = await (database as D1DatabasePort).prepare(unseededCountQuery(ids)).all();
  if (!result.success) throw new Error(`count failed: ${result.error ?? "unknown error"}`);
  return parseUnseededCounts(JSON.stringify([{ results: result.results, success: true }]));
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
      directory.consumeOauthAttempt([attempt.id], attempt.stateProof, 1_000_000),
    ).resolves.toEqual({
      id: attempt.id,
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      // Defaulted by the column and by the adapter: an attempt minted without a door is the
      // front one, which is the behaviour that predates migration `1005`.
      workspaceIntent: "organizer",
    });
    // A replayed callback — the same id, the same valid `state` — finds nothing to spend. This
    // is the property a read-then-delete could not promise under two racing callbacks.
    await expect(
      directory.consumeOauthAttempt([attempt.id], attempt.stateProof, 1_000_000),
    ).resolves.toBeNull();

    await directory.saveOauthAttempt({ ...attempt, id: "attempt-wrong-proof" });
    await expect(
      directory.consumeOauthAttempt(["attempt-wrong-proof"], "a-forged-proof", 1_000_000),
    ).resolves.toBeNull();
    // Refusing a forged `state` must not spend the attempt the real browser still holds.
    await expect(
      directory.consumeOauthAttempt(["attempt-wrong-proof"], attempt.stateProof, 1_000_000),
    ).resolves.toEqual({
      id: "attempt-wrong-proof",
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      workspaceIntent: "organizer",
    });

    await directory.saveOauthAttempt({ ...attempt, id: "attempt-expired" });
    await expect(
      directory.consumeOauthAttempt(["attempt-expired"], attempt.stateProof, attempt.expiresAt),
    ).resolves.toBeNull();
    await expect(
      directory.consumeOauthAttempt(["attempt-unknown"], attempt.stateProof, 1_000_000),
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
      directory.consumeOauthAttempt(["attempt-raced"], attempt.stateProof, 1_000_000),
      directory.consumeOauthAttempt(["attempt-raced"], attempt.stateProof, 1_000_000),
      directory.consumeOauthAttempt(["attempt-raced"], attempt.stateProof, 1_000_000),
    ]);
    expect(raced.filter((outcome) => outcome !== null)).toEqual([
      {
        id: "attempt-raced",
        codeVerifier: attempt.codeVerifier,
        nonce: attempt.nonce,
        workspaceIntent: "organizer",
      },
    ]);

    /*
     * Several attempts in flight in one browser, which is what a person with two tabs open
     * actually has (issue #166). The proof picks exactly one of the ids presented, the others
     * survive it, and an id the browser is *not* holding cannot be spent however valid its
     * proof — that last one is the browser binding this cookie exists for.
     */
    await directory.saveOauthAttempt({ ...attempt, id: "attempt-tab-one" });
    await directory.saveOauthAttempt({
      ...attempt,
      id: "attempt-tab-two",
      stateProof: "the-proof-of-the-other-tabs-state",
    });
    await expect(
      directory.consumeOauthAttempt(
        ["attempt-tab-one", "attempt-tab-two"],
        attempt.stateProof,
        1_000_000,
      ),
    ).resolves.toMatchObject({ id: "attempt-tab-one" });
    // The other tab's sign-in is untouched, and completes on its own proof afterwards.
    await expect(
      directory.consumeOauthAttempt(
        ["attempt-tab-two"],
        "the-proof-of-the-other-tabs-state",
        1_000_000,
      ),
    ).resolves.toMatchObject({ id: "attempt-tab-two" });
    /*
     * Another browser's attempt, with a proof this browser can produce, is still refused: the id
     * is not in the list this caller presented. That is the browser binding the cookie exists
     * for, and it is the one property widening the list must not cost.
     */
    await directory.saveOauthAttempt({ ...attempt, id: "attempt-another-browser" });
    await expect(
      directory.consumeOauthAttempt(["attempt-tab-one"], attempt.stateProof, 1_000_000),
    ).resolves.toBeNull();
    await expect(
      directory.consumeOauthAttempt([], attempt.stateProof, 1_000_000),
    ).resolves.toBeNull();
    // And it survives: refusing this caller spent nothing that belonged to the other browser.
    await expect(
      directory.consumeOauthAttempt(["attempt-another-browser"], attempt.stateProof, 1_000_000),
    ).resolves.toMatchObject({ id: "attempt-another-browser" });
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
        [started.attempt.id],
        await stateProof(`${started.state}-tampered`, secret),
        1_000_100,
      ),
    ).resolves.toBeNull();
    // A proof of the right state under the wrong secret is equally worthless.
    await expect(
      directory.consumeOauthAttempt(
        [started.attempt.id],
        await stateProof(started.state, "a-different-session-secret"),
        1_000_100,
      ),
    ).resolves.toBeNull();
    // And the genuine one spends it, returning the verifier that never left this server.
    await expect(
      directory.consumeOauthAttempt(
        [started.attempt.id],
        await stateProof(started.state, secret),
        1_000_100,
      ),
    ).resolves.toEqual({
      id: started.attempt.id,
      codeVerifier: started.attempt.codeVerifier,
      nonce: started.attempt.nonce,
      workspaceIntent: "organizer",
    });
  });

  it("carries the door a sign-in was started from through the redirect", async () => {
    /*
     * The context has to outlive a round trip through Google, and it cannot ride on the callback
     * URL — that is fixed configuration registered with Google, and deriving it from a request is
     * the open redirect this flow refuses by construction. So it rides on the attempt row, which
     * is already the per-attempt state the callback spends exactly once (migration `1005`).
     */
    const migrated = await createMigratedDatabase({ label: "identity-oauth-intent", seed: true });
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
      "submitter",
    );
    await directory.saveOauthAttempt(started.attempt);

    await expect(
      directory.consumeOauthAttempt(
        [started.attempt.id],
        await stateProof(started.state, secret),
        1_000_100,
      ),
    ).resolves.toMatchObject({ workspaceIntent: "submitter" });
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

  /**
   * Two callbacks at once, against real D1 — issue #164's acceptance criterion.
   *
   * A person with two tabs open produces exactly this (issue #166), and before the fix it
   * produced two of everything: a stagger sweep of two concurrent `signInWithGoogle` calls for
   * one new subject created two events and two organizer roles at 25 of 45 tested offsets, and
   * left the loser's organization row behind. Neither mark is repairable through the product —
   * no route deletes an event and none deletes an organization — so the assertions here are
   * about what storage refused, not about what a service remembered to check.
   *
   * The `Promise.all` is genuinely overlapping rather than staggered: every call in it is an
   * HTTP round trip to workerd, so both readers see an empty directory before either writes.
   * Against the pre-fix code this case fails on the very first assertion.
   */
  it("converges two concurrent first sign-ins on one workspace", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-signup-race", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { signup, events, directory } = signupStack(database);

    const [first, second] = await Promise.all([
      signup.signInWithGoogle(newcomer),
      signup.signInWithGoogle(newcomer),
    ]);

    // One person, one workspace: both callbacks resolve the same user, and both hold the role.
    expect(first.actor.id).toBe(second.actor.id);
    expect(first.actor.eventAccess).toHaveLength(1);
    expect(second.actor.eventAccess).toEqual(first.actor.eventAccess);
    const organizationId = first.actor.organizations[0]?.id as string;
    const eventId = first.actor.eventAccess[0]?.eventId as string;
    expect(second.actor.organizations).toEqual([{ id: organizationId }]);

    // Exactly one of everything, counted in the tables rather than inferred from the actors:
    // one organization, one user, one event beyond the seeded fixture — no duplicate first
    // event, and **no orphaned organization** from the callback that lost. The orphan matters
    // beyond tidiness: it is precisely the row a data-aware demo reset refuses on, and nothing
    // in the product would ever remove it, so one would make every later reset refuse forever
    // (`GAP-019`).
    await expect(unseededRows(database)).resolves.toEqual({
      organizations: 1,
      events: 1,
      users: 1,
    });
    // And the one event is the one both actors hold the organizer role on.
    await expect(events.listEventIdsForOrganization(organizationId)).resolves.toEqual([eventId]);
    await expect(directory.listAssignableOwnersForEvent(eventId)).resolves.toEqual([
      { id: first.actor.id, name: newcomer.name },
    ]);
  });

  it("completes a submitter-door account's workspace, membership and persona together", async () => {
    /*
     * The one path that reaches `joinOrganization`, and until this case nothing executed its SQL.
     *
     * `completeWorkspace` calls it only for an account holding no organization, which the
     * organizer door never produces — `createSelfServeIdentity` writes that membership itself.
     * Only the submitter door leaves an account in that state, so every earlier case in this file
     * goes past the branch. The unit suite covers the rule against a fake that reimplements it in
     * TypeScript, which is exactly the coverage that cannot see a bind-order slip.
     *
     * What is proved here is one batch: the membership insert is conditional on the account
     * holding none, and the persona lift is gated on the row that insert writes — a gate that
     * means nothing unless the second statement sees the first's uncommitted write.
     */
    const migrated = await createMigratedDatabase({
      label: "identity-submitter-promote",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { signup, directory } = signupStack(database);

    // Through the public call for proposals: an identity, and deliberately no conference.
    const submitter = await signup.signInWithGoogle(newcomer, "submitter");
    expect(submitter.actor.organizations).toEqual([]);
    expect(submitter.actor.eventAccess).toEqual([]);
    await expect(unseededRows(database)).resolves.toEqual({
      organizations: 0,
      events: 0,
      users: 1,
    });
    const personaOf = async () =>
      (
        await database
          .prepare("SELECT persona FROM users WHERE id = ?")
          .bind(submitter.actor.id)
          .first<{ persona: string }>()
      )?.persona;
    expect(await personaOf()).toBe("public");

    // And then the front door, which is that person asking for a conference of their own.
    const promoted = await signup.signInWithGoogle(newcomer);

    expect(promoted.actor.id).toBe(submitter.actor.id);
    expect(promoted.actor.organizations).toHaveLength(1);
    expect(promoted.actor.eventAccess).toHaveLength(1);
    // The persona moved with the membership, in the same batch. The console picks the workspaces
    // it offers from this whenever no event is selected, so an account left `public` here holds a
    // conference it cannot open.
    expect(await personaOf()).toBe("organizer");
    await expect(unseededRows(database)).resolves.toEqual({
      organizations: 1,
      events: 1,
      users: 1,
    });

    // Idempotent: signing in again finds the event role and writes nothing further.
    await signup.signInWithGoogle(newcomer);
    await expect(unseededRows(database)).resolves.toEqual({
      organizations: 1,
      events: 1,
      users: 1,
    });
    await expect(
      directory.listAssignableOwnersForEvent(promoted.actor.eventAccess[0]?.eventId as string),
    ).resolves.toEqual([{ id: promoted.actor.id, name: newcomer.name }]);
  });

  /**
   * The workspace owner's event is not handed to somebody who merely joins the organization.
   *
   * Every organization a self-serve signup created carries a provisioned first event for ever, so
   * a provisioning key naming only the organization would answer "yes, provisioned" to any later
   * member — and completing their workspace would grant them organizer on the owner's event. Two
   * ways to reach that membership-with-no-event-role state exist today: an organization-level
   * invitation, and an organizer revoking somebody's only event role. Driven here against real
   * D1, because a fake would agree with whichever key the implementation chose.
   */
  it("never grants a later member the workspace owner's provisioned event", async () => {
    const migrated = await createMigratedDatabase({
      label: "identity-first-event-owner",
      seed: true,
    });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { signup, directory, events } = signupStack(database);

    const owner = await signup.signInWithGoogle(newcomer);
    const organizationId = owner.actor.organizations[0]?.id as string;
    const ownerEvent = owner.actor.eventAccess[0]?.eventId as string;

    // A second person in the owner's organization, with a membership and no event role.
    await directory.createSelfServeIdentity({
      userId: "later-member",
      name: "Later Member",
      email: "later@example.test",
      provider: "google",
      subject: "later-member-subject",
      linkedAt,
      organizationId,
    });

    const later = await signup.signInWithGoogle({
      subject: "later-member-subject",
      email: "later@example.test",
      emailVerified: true,
      name: "Later Member",
    });

    // Nothing granted, and nothing invented: an organizer of that organization grants access
    // deliberately or it does not exist.
    expect(later.actor.eventAccess).toEqual([]);
    await expect(events.listEventIdsForOrganization(organizationId)).resolves.toEqual([ownerEvent]);
    await expect(directory.listAssignableOwnersForEvent(ownerEvent)).resolves.toEqual([
      { id: owner.actor.id, name: newcomer.name },
    ]);
  });

  /**
   * The same rule from the other side: an organization that is somebody else's and merely *empty*.
   *
   * "No events" alone would read as "a fresh workspace" and provision one — making the newcomer
   * its organizer, and with it `identity:manage` over an organization they were only added to,
   * while the actual owner's own next sign-in would find their organization no longer empty and
   * come away with nothing. The second half of the condition is the membership count, which only
   * identity-access can answer.
   */
  it("provisions nothing into an empty organization that already has another member", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-empty-foreign", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { signup, directory, events } = signupStack(database);

    // An organization with a member and no events: the state a signup that stopped before its
    // event leaves, seen by somebody who is not the person it belongs to.
    const organization = await events.provisionOrganization({ name: "Somebody else's" });
    await directory.createSelfServeIdentity({
      userId: "the-owner",
      name: "The Owner",
      email: "owner@example.test",
      provider: "google",
      subject: "owner-subject",
      linkedAt,
      organizationId: organization.id,
    });
    await directory.createSelfServeIdentity({
      userId: "the-newcomer",
      name: "The Newcomer",
      email: "newcomer@example.test",
      provider: "google",
      subject: "newcomer-subject",
      linkedAt,
      organizationId: organization.id,
    });

    const newcomerSignIn = await signup.signInWithGoogle({
      subject: "newcomer-subject",
      email: "newcomer@example.test",
      emailVerified: true,
      name: "The Newcomer",
    });

    expect(newcomerSignIn.actor.eventAccess).toEqual([]);
    await expect(events.listEventIdsForOrganization(organization.id)).resolves.toEqual([]);
  });

  /**
   * The discard is refused by the database when the organization is in use, not merely by the
   * predicate this domain can express.
   *
   * `discardUnusedOrganization` guards on the events domain's own references, because it cannot
   * read another domain's tables. What stops it removing an organization somebody is already a
   * member of — the state a batch that committed and lost its response leaves — is
   * `organization_memberships.organization_id REFERENCES organizations(id)`. That is the argument
   * the interface doc makes, and this is the assertion behind it.
   */
  it("refuses to discard an organization a membership already references", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-discard-guard", seed: true });
    runtime = migrated.runtime;
    const { directory, events } = signupStack(migrated.database);
    const organization = await events.provisionOrganization({ name: "Committed anyway" });
    await directory.createSelfServeIdentity({
      userId: "committed-user",
      name: "Committed User",
      email: "committed@example.test",
      provider: "google",
      subject: "committed-subject",
      linkedAt,
      organizationId: organization.id,
    });

    await expect(events.discardUnusedOrganization(organization.id)).rejects.toThrow();
    // And the member is still a member of an organization that still exists.
    await expect(directory.findByUserId("committed-user")).resolves.toMatchObject({
      organizations: [{ id: organization.id }],
    });
  });

  /**
   * The event row and the organizer role commit together, or neither does.
   *
   * They were two unbatched writes, so a failure between them left an event whose creator held
   * no role on it — an event nobody can open and no route can delete. The failure is provoked
   * by the batch's own constraint: a second create under the same provisioning key.
   */
  it("never leaves an event without the role that opens it", async () => {
    const migrated = await createMigratedDatabase({ label: "identity-first-event", seed: true });
    runtime = migrated.runtime;
    const database = migrated.database;
    const { signup, events, directory } = signupStack(database);

    const outcome = await signup.signInWithGoogle(newcomer);
    const organizationId = outcome.actor.organizations[0]?.id as string;
    const eventId = outcome.actor.eventAccess[0]?.eventId as string;

    // A second provisioning of the same organization adopts rather than creating, and the
    // adopted event is the one that already exists.
    await expect(
      events.provisionFirstEvent(outcome.actor, {
        organizationId,
        name: "Another first event",
        timezone: "UTC",
      }),
    ).resolves.toMatchObject({ id: eventId });
    await expect(events.listEventIdsForOrganization(organizationId)).resolves.toEqual([eventId]);
    // The refused insert took its organizer grant down with it: still one role, not two rows
    // and not a role on an event that was never written.
    await expect(directory.listAssignableOwnersForEvent(eventId)).resolves.toEqual([
      { id: outcome.actor.id, name: newcomer.name },
    ]);
    await expect(unseededRows(database)).resolves.toEqual({
      organizations: 1,
      events: 1,
      users: 1,
    });
  });
});
