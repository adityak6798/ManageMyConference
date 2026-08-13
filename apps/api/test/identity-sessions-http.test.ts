// @acceptance ACC-IDENTITY-EVENTS
/**
 * Sign-out as revocation, and "sign out everywhere", at the transport.
 *
 * The store here is in memory; that the record and its audit row land in one D1 batch is proved
 * against real D1 in `d1-identity-sessions.integration.test.ts`. What this suite owns is what the
 * *routes* do with a store: which of them look a session up, which of them refuse a persona, and
 * what each of them tells the caller.
 */
import { signOutResponseSchema } from "@greenroom/contracts";
import { describe, expect, it, vi } from "vitest";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createUserSession } from "../src/application/identity/real-auth";
import { createHttpApp, type GoogleAuthProvider } from "../src/transport/http/app";
import { memorySessionStore, type MemorySessionStore } from "./support/memory-session-store";

const secret = "session-revocation-test-secret";
const NOW = 1_000;
const EXPIRES = NOW + 28_800_000;

const events = () =>
  new EventService({
    repository: new MemoryEventRepository(),
    newId: () => crypto.randomUUID(),
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A production deployment: emailed-code sign-in, real sessions, and a store to record them. */
function productionApp(
  sessions: MemorySessionStore,
  actors: Record<string, Awaited<ReturnType<typeof resolveSeededDemoActor>>>,
) {
  return createHttpApp(events(), logger(), {
    demoMode: false,
    sessionSecret: secret,
    now: () => NOW,
    sessions,
    resolveActor: async (userId) => actors[userId] ?? null,
    resolveEmail: async () => null,
    sendLoginCode: async () => undefined,
    saveLoginChallenge: async () => undefined,
    consumeLoginChallenge: async () => null,
  });
}

const cookieHeader = (token: string) => ({ cookie: `greenroom_session=${token}` });

/**
 * Every response header, sorted, minus the one that is per-request by construction.
 *
 * `x-correlation-id` is a fresh UUID on each request and must differ; every other header has to
 * be identical across the three sign-out answers, which is the property being asserted.
 */
function collectHeaders(response: Response): [string, string][] {
  const collected: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name !== "x-correlation-id") collected.push([name, value]);
  });
  return collected.sort();
}

describe("session revocation over HTTP", () => {
  /**
   * The property the whole lane exists for: a cookie that worked a moment ago stops working,
   * server-side, because somebody signed out — not because it expired and not because this
   * browser forgot it.
   */
  it("refuses the same session cookie on the request after sign-out", async () => {
    const actor = await resolveSeededDemoActor("organizer");
    const sessions = memorySessionStore();
    sessions.seed({ id: "sid-1", userId: actor.id, issuedAt: NOW, expiresAt: EXPIRES });
    const app = productionApp(sessions, { [actor.id]: actor });
    const cookie = cookieHeader(await createUserSession("sid-1", actor.id, secret, EXPIRES));

    expect((await app.request("/api/session", { headers: cookie })).status).toBe(200);
    const signedOut = await app.request("/api/auth/signout", { method: "POST", headers: cookie });
    expect(signedOut.status).toBe(200);
    expect(signOutResponseSchema.parse(await signedOut.json())).toEqual({ signedOut: true });
    // The *same* cookie, held by anybody, anywhere.
    expect((await app.request("/api/session", { headers: cookie })).status).toBe(401);
    expect(sessions.rows.get("sid-1")?.revokedAt).toBe(NOW);
    expect(sessions.audit.map((entry) => entry.action)).toContain("session.signed_out");
  });

  /**
   * Sign-out must not become an oracle for "did this cookie name a real session?".
   *
   * Same status, same body, same cookie clearing, whether the caller held a session, held a
   * forged one, or held nothing at all.
   */
  it("answers sign-out identically with and without a session", async () => {
    const actor = await resolveSeededDemoActor("organizer");
    const sessions = memorySessionStore();
    sessions.seed({ id: "sid-1", userId: actor.id, issuedAt: NOW, expiresAt: EXPIRES });
    const app = productionApp(sessions, { [actor.id]: actor });
    const valid = cookieHeader(await createUserSession("sid-1", actor.id, secret, EXPIRES));
    const forged = cookieHeader("bm90LWEtdG9rZW4.bm90LWEtc2ln");

    const answers = [];
    for (const headers of [valid, forged, {}]) {
      const response = await app.request("/api/auth/signout", { method: "POST", headers });
      answers.push({
        status: response.status,
        body: await response.json(),
        // Every header, not a substring test on `set-cookie`. The claim in the scorecard is that
        // the three answers are indistinguishable, and a response that grew, say,
        // `x-session-revoked: 1` on the hit path would satisfy a narrower assertion while
        // breaking exactly the property this test exists for. `x-correlation-id` is per-request
        // by construction and is the one field that must differ.
        headers: collectHeaders(response),
      });
    }
    expect(answers[0]?.headers.map(([name]) => name)).toContain("set-cookie");
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  /**
   * A seeded demo persona can never be handed a real session, even when a real sign-in resolves
   * to one.
   *
   * This is the crossing `docs/architecture/authorization.md` rule 3 exists for, and it is not
   * hypothetical: `seed/reset.sql` gives the personas real addresses, account linking matches a
   * **verified** address, and the demo deployment is exactly the one that can have Google
   * configured beside its personas. Without the guard, signing in as `organizer@greenroom.test`
   * mints a real `identity_sessions` row for `seed-organizer` — the identity the landing page
   * hands to the next visitor who presses "Continue as organizer".
   *
   * Both doors are asserted, because they resolve the address by different functions.
   */
  it("refuses to issue a real session to a seeded demo persona, by either door", async () => {
    const persona = await resolveSeededDemoActor("organizer");
    const sessions = memorySessionStore();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // The emailed-code door, on a production deployment whose directory answers with a seeded id.
    const emailed = createHttpApp(events(), logger, {
      demoMode: false,
      sessionSecret: secret,
      now: () => NOW,
      sessions,
      resolveActor: async () => persona,
      resolveEmail: async () => persona,
      sendLoginCode: async () => undefined,
      saveLoginChallenge: async () => undefined,
      consumeLoginChallenge: async () => "organizer@greenroom.test",
      // A challenge this suite can complete: the route only needs `exchangeLoginChallenge` to
      // yield an address, and `consumeLoginChallenge` above is what decides that.
    });
    const requested = await emailed.request("/api/auth/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "organizer@greenroom.test" }),
    });
    const { challenge } = (await requested.json()) as { challenge: string };
    const verified = await emailed.request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, code: "000000" }),
    });
    // The same 401 an unknown address gets: which of the two it was is not the caller's business.
    expect(verified.status).toBe(401);
    expect(verified.headers.get("set-cookie")).toBeNull();

    // The Google door, on the demo deployment that is the actual risk.
    const google: GoogleAuthProvider = {
      start: async () => ({ authorizationUrl: "https://accounts.google.com/", attemptId: "a" }),
      complete: async () => ({ actor: persona, provisioned: false }),
      resolveUserActor: async () => persona,
    };
    const withGoogle = createHttpApp(events(), logger, {
      demoMode: true,
      sessionSecret: secret,
      now: () => NOW,
      resolveActor: resolveSeededDemoActor,
      google,
      sessions,
    });
    const callback = await withGoogle.request("/api/auth/google/callback?code=c&state=s", {
      headers: { cookie: "greenroom_oauth=a" },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/signin?auth=failed");
    expect(callback.headers.get("set-cookie") ?? "").not.toContain("greenroom_session=");

    // Neither door recorded anything, which is the point: no session row, no audit row.
    expect(sessions.rows.size).toBe(0);
    expect(sessions.audit).toEqual([]);
  });

  /**
   * The demo population never touches the session store, and never reaches revoke-all.
   *
   * A persona cookie is three parts, so it never verifies as a session and yields no `sid` to
   * look up; and `authentication` resolves as `demo`, which the revoke-all guard refuses. Both
   * halves are asserted because either one alone would let a demo caller reach real state.
   */
  it("takes no session lookup for a demo persona, and refuses it revoke-all", async () => {
    const sessions = memorySessionStore();
    const google: GoogleAuthProvider = {
      start: async () => ({ authorizationUrl: "https://accounts.google.com/", attemptId: "a" }),
      complete: async () => null,
      resolveUserActor: async () => null,
    };
    const app = createHttpApp(events(), logger(), {
      demoMode: true,
      sessionSecret: secret,
      now: () => NOW,
      resolveActor: resolveSeededDemoActor,
      google,
      sessions,
    });
    const persona = cookieHeader(await createDemoSession("organizer", secret, EXPIRES));

    expect((await app.request("/api/session", { headers: persona })).status).toBe(200);
    const signedOut = await app.request("/api/auth/signout", { method: "POST", headers: persona });
    expect(signedOut.status).toBe(200);
    const revokeAll = await app.request("/api/auth/sessions/revoke-all", {
      method: "POST",
      headers: persona,
    });
    expect(revokeAll.status).toBe(401);
    // Not one read, across all three requests. A persona resolves from `findByPersona` and from
    // nowhere else.
    expect(sessions.lookups).toEqual([]);
    expect(sessions.audit).toEqual([]);
  });

  it("ends every session of the caller and no session of anybody else", async () => {
    const organizer = await resolveSeededDemoActor("organizer");
    const reviewer = await resolveSeededDemoActor("reviewer");
    const sessions = memorySessionStore();
    for (const id of ["sid-laptop", "sid-phone"])
      sessions.seed({ id, userId: organizer.id, issuedAt: NOW, expiresAt: EXPIRES });
    sessions.seed({ id: "sid-other", userId: reviewer.id, issuedAt: NOW, expiresAt: EXPIRES });
    const app = productionApp(sessions, { [organizer.id]: organizer, [reviewer.id]: reviewer });
    const laptop = cookieHeader(
      await createUserSession("sid-laptop", organizer.id, secret, EXPIRES),
    );
    const phone = cookieHeader(await createUserSession("sid-phone", organizer.id, secret, EXPIRES));
    const other = cookieHeader(await createUserSession("sid-other", reviewer.id, secret, EXPIRES));

    const response = await app.request("/api/auth/sessions/revoke-all", {
      method: "POST",
      headers: laptop,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 2 });
    for (const headers of [laptop, phone])
      expect((await app.request("/api/session", { headers })).status).toBe(401);
    // The reviewer was signed in the whole time and is still signed in.
    expect((await app.request("/api/session", { headers: other })).status).toBe(200);
    expect(sessions.audit.at(-1)).toMatchObject({
      action: "session.revoked_all",
      outcome: "succeeded",
      subjectUserId: organizer.id,
      context: { actorUserId: organizer.id, source: "human" },
    });
  });

  /**
   * The in-memory store records what the D1 writer records, and nothing more.
   *
   * A double that is more generous than production is worse than no double: it lets an HTTP test
   * pass over behaviour the real adapter refuses. That is not hypothetical here — an audit row
   * written for a revocation that changed nothing is exactly the defect two review passes found,
   * once in the session store and once in the membership repository, and this suite would have
   * been green through both.
   */
  it("records no audit row when a revocation changes nothing, as D1 does not", async () => {
    const actor = await resolveSeededDemoActor("organizer");
    const sessions = memorySessionStore();
    sessions.seed({ id: "sid-1", userId: actor.id, issuedAt: NOW, expiresAt: EXPIRES });
    const app = productionApp(sessions, { [actor.id]: actor });
    const cookie = cookieHeader(await createUserSession("sid-1", actor.id, secret, EXPIRES));

    // Sign out three times with the same cookie. The first ends the session; the rest change
    // nothing and must record nothing.
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(
        (await app.request("/api/auth/signout", { method: "POST", headers: cookie })).status,
      ).toBe(200);
    expect(sessions.audit.filter((entry) => entry.action === "session.signed_out")).toHaveLength(1);

    // And a revoke-all with nothing left live records nothing either.
    sessions.audit.length = 0;
    await sessions.revokeAllForUser(actor.id, NOW, {
      correlationId: "c",
      actorUserId: actor.id,
      source: "human",
    });
    expect(sessions.audit).toEqual([]);
  });

  it("refuses revoke-all without a session, and does not offer it where nothing is recorded", async () => {
    const actor = await resolveSeededDemoActor("organizer");
    const sessions = memorySessionStore();
    const app = productionApp(sessions, { [actor.id]: actor });
    expect((await app.request("/api/auth/sessions/revoke-all", { method: "POST" })).status).toBe(
      401,
    );

    // A demo deployment with no Google door records no session at all, so the route is one this
    // deployment does not have rather than one having a bad day.
    const demoOnly = createHttpApp(events(), logger(), {
      demoMode: true,
      sessionSecret: secret,
      now: () => NOW,
      resolveActor: resolveSeededDemoActor,
    });
    expect(
      (await demoOnly.request("/api/auth/sessions/revoke-all", { method: "POST" })).status,
    ).toBe(404);
  });
});
