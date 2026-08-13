// @acceptance ACC-OPS
/*
 * Who an audit record says did the thing, and the two ways that answer used to be able to go
 * quietly wrong.
 *
 * Both were true-by-accident rather than true-by-construction, and neither had a test: attribution
 * held because `platformRoutes` happened to be first in the route registry (issue #178), and
 * because every service happened to be constructed inside `fetch` (issue #179). A reordered array
 * and a hoisted `const` are changes anybody would make without suspecting them, and the symptom of
 * either is a record naming the wrong person — or nobody — which nothing else in the system
 * refuses.
 *
 * So these tests are written against the failure rather than the arrangement: an app whose
 * registry deliberately puts platform last, and a composition deliberately shared across two
 * concurrent requests.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditRecordStore } from "../src/adapters/persistence/d1-audit-repository";
import { MemoryInboxDismissalStore } from "../src/adapters/persistence/d1-platform-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { EventService } from "../src/application/events/event-service";
import type { Actor } from "../src/application/identity/actor";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import {
  AuditRecorder,
  createRequestIdentity,
  PlatformOperationsService,
  type PlatformSources,
} from "../src/application/platform/public";
import { createHttpAppFrom, type StructuredLogger } from "../src/transport/http/app";
import type { HttpApp, HttpDependencies, RouteModule } from "../src/transport/http/routes/contract";
import { platformRoutes } from "../src/transport/http/routes/platform";
import { routeModules } from "../src/transport/http/routes/registry";

const secret = "test-session-secret";
const EVENT = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";

const sources: PlatformSources = { events: { organizationOf: async () => ORGANIZATION } };

const organizerOf = (id: string, name: string): Actor => ({
  id,
  name,
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [
    {
      eventId: EVENT,
      role: "organizer",
      capabilities: new Set(["events:read", "events:settings:read"] as const),
    },
  ],
  capabilities: new Set(["events:read", "events:settings:read"] as const),
});

/**
 * A domain that changes something and records it, standing in for the eight that do.
 *
 * Deliberately not one of the real modules: what is under test is the transport's guarantee to
 * *any* module, and using review's or content's would tie the assertion to whichever of them
 * happens to be listed above platform today.
 */
function mutatingModule(
  audit: AuditRecorder,
  sequence: { next: number },
  /**
   * The durable write the record describes, awaited before recording as every real caller does.
   *
   * It matters that this is awaited: the recorder reads the identity holder synchronously while
   * preparing the record, so a handler that records without ever yielding cannot observe another
   * request's actor even on a shared holder. Every actual writer resolves a session, commits a
   * row or sends a message first, which is precisely the window this stands in for.
   */
  beforeRecord: () => Promise<void> = async () => undefined,
): RouteModule {
  return {
    domain: "test-downstream",
    routes: ["POST /api/events/:eventId/downstream-mutations"],
    register(app: HttpApp) {
      app.post("/api/events/:eventId/downstream-mutations", async (context) => {
        sequence.next += 1;
        // Taken before the await: two concurrent requests each describe their own target, and a
        // shared counter read afterwards would give both the same key and therefore one row.
        const target = `thing-${sequence.next}`;
        await beforeRecord();
        await audit.record({
          organizationId: ORGANIZATION,
          eventId: context.req.param("eventId") ?? EVENT,
          action: "test.mutated",
          targetType: "thing",
          targetId: target,
          idempotencyKey: `audit:test.mutated:${target}`,
        });
        return context.json({ ok: true }, 201);
      });
    },
  };
}

function composition() {
  const store = new MemoryAuditRecordStore();
  const report = vi.fn();
  const identity = createRequestIdentity({ report });
  let issued = 0;
  const audit = new AuditRecorder({
    store,
    identity,
    newId: () => {
      issued += 1;
      return `record-${issued}`;
    },
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    report,
  });
  const logger: StructuredLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const dependencies: HttpDependencies = {
    events: new EventService({
      repository: new MemoryEventRepository(),
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    }),
    logger,
    auth: {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    platformOps: new PlatformOperationsService({
      sources,
      dismissals: new MemoryInboxDismissalStore(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      audit,
      identity,
    }),
  };
  return { store, report, identity, audit, dependencies };
}

const cookie = async (persona: "organizer" | "reviewer") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
});

/**
 * Holds each arrival until every expected one has arrived.
 *
 * Two requests being "concurrent" cannot be left to whichever `await` the runtime happens to
 * suspend on: that is how the first version of this test passed against the very design it was
 * written to refuse. The barrier makes the overlap a property of the test rather than of the
 * scheduler.
 */
function barrier(expected: number) {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= expected) release();
    await open;
  };
}

describe("attribution and route registration order", () => {
  it("attributes a mutation in a module registered before platform's own", async () => {
    const { store, dependencies, audit } = composition();
    /*
     * Platform last, which is the arrangement the old design could not survive: its middleware
     * was mounted inside `register`, and Hono applies middleware only to handlers registered
     * after it, so the route below would have run with nobody set and the record would have said
     * "System". Nothing about that would have failed — which is the defect.
     */
    const modules = [mutatingModule(audit, { next: 0 }), platformRoutes];
    const app = createHttpAppFrom(dependencies, modules);

    const response = await app.request(`/api/events/${EVENT}/downstream-mutations`, {
      method: "POST",
      headers: { ...(await cookie("organizer")), "x-correlation-id": "downstream-first" },
    });

    expect(response.status).toBe(201);
    const page = await store.page(EVENT, { limit: 10 });
    expect(page.items).toEqual([
      expect.objectContaining({
        actorId: "seed-organizer",
        actorName: "Olivia Organizer",
        source: "human",
        correlationId: "downstream-first",
        action: "test.mutated",
      }),
    ]);
  });

  it("mounts platform's request scope before every module's routes, in the real registry too", () => {
    /*
     * The registry's order is still deliberate for route *matching* — publishing's
     * `/api/public/events/:slug` against cfp's `/api/public/events/:eventId/cfp` — so this asserts
     * what the order no longer has to carry rather than pinning the order itself. `platform` is
     * the only module declaring a request scope today; a second one would be a deliberate
     * addition and this names it.
     */
    const scoped = routeModules.filter((module) => module.registerRequestScope);
    expect(scoped.map(({ domain }) => domain)).toEqual(["platform"]);
  });

  it("empties the holder when the request ends, so a later consequence names nobody", async () => {
    const { store, dependencies, audit, identity } = composition();
    const app = createHttpAppFrom(dependencies, [
      mutatingModule(audit, { next: 0 }),
      platformRoutes,
    ]);

    await app.request(`/api/events/${EVENT}/downstream-mutations`, {
      method: "POST",
      headers: await cookie("organizer"),
    });
    // The one-minute tick, or anything else with no request behind it, after that request is over.
    expect(identity.actor()).toBeNull();
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "test.swept",
      targetType: "thing",
      targetId: "thing-swept",
      idempotencyKey: "audit:test.swept:thing-swept",
    });

    const swept = (await store.page(EVENT, { limit: 10 })).items.find(
      ({ action }) => action === "test.swept",
    );
    expect(swept).toMatchObject({ actorId: null, actorName: "System", source: "system" });
  });
});

describe("attribution and service lifetime", () => {
  it("refuses to attribute while two requests share one holder, and reports it", async () => {
    const { store, report, identity, audit } = composition();

    // Exactly what a hoisted composition looks like from in here: request A opens a scope, request
    // B opens one before A has finished, and the holder can no longer say whose actor it holds.
    const first = identity.begin({
      actor: organizerOf("organizer-a", "Ada Organizer"),
      correlationId: "corr-a",
    });
    const second = identity.begin({
      actor: organizerOf("organizer-b", "Bo Organizer"),
      correlationId: "corr-b",
    });
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "test.overlapped",
      targetType: "thing",
      targetId: "thing-overlapped",
      idempotencyKey: "audit:test.overlapped:thing-overlapped",
    });

    const overlapped = (await store.page(EVENT, { limit: 10 })).items[0];
    // Nobody, rather than "Bo Organizer" — who did not do this and whose name on an append-only
    // record could never afterwards be corrected.
    expect(overlapped).toMatchObject({ actorId: null, actorName: "System", source: "system" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("sharing one platform") }),
      expect.objectContaining({ openScopes: 2 }),
    );

    // And it recovers: once both requests are over, the next one attributes normally.
    second.end();
    first.end();
    identity.begin({
      actor: organizerOf("organizer-c", "Cass Organizer"),
      correlationId: "corr-c",
    });
    await audit.record({
      organizationId: ORGANIZATION,
      eventId: EVENT,
      action: "test.after",
      targetType: "thing",
      targetId: "thing-after",
      idempotencyKey: "audit:test.after:thing-after",
    });
    expect(
      (await store.page(EVENT, { limit: 10 })).items.find(({ action }) => action === "test.after"),
    ).toMatchObject({ actorId: "organizer-c", correlationId: "corr-c" });
  });

  it("never names the wrong actor when concurrent requests are driven through one app", async () => {
    const { store, report, dependencies, audit } = composition();
    const bothInFlight = barrier(2);
    const app = createHttpAppFrom(dependencies, [
      mutatingModule(audit, { next: 0 }, bothInFlight),
      platformRoutes,
    ]);

    /*
     * One app, one composition, two requests in flight at once — the shape a deployment reaches
     * by hoisting service construction out of `fetch`. The point is not that this arrangement
     * works; it is that it cannot silently produce a record naming somebody who did not act.
     */
    const [organizer, reviewer] = [await cookie("organizer"), await cookie("reviewer")];
    await Promise.all([
      app.request(`/api/events/${EVENT}/downstream-mutations`, {
        method: "POST",
        headers: organizer,
      }),
      app.request(`/api/events/${EVENT}/downstream-mutations`, {
        method: "POST",
        headers: reviewer,
      }),
    ]);

    const written = (await store.page(EVENT, { limit: 10 })).items;
    expect(written).toHaveLength(2);
    // A misattributed pair looks like two records naming one person. Neither of these names
    // anybody, and the report says why.
    expect(new Set(written.map(({ actorId }) => actorId))).toEqual(new Set([null]));
    expect(report).toHaveBeenCalled();
  });

  it("attributes both requests correctly when each is composed per request, as the Worker does", async () => {
    const bothInFlight = barrier(2);
    const perRequest = async (persona: "organizer" | "reviewer") => {
      const built = composition();
      const app = createHttpAppFrom(built.dependencies, [
        mutatingModule(built.audit, { next: 0 }, bothInFlight),
        platformRoutes,
      ]);
      await app.request(`/api/events/${EVENT}/downstream-mutations`, {
        method: "POST",
        headers: await cookie(persona),
      });
      return { ...built, records: (await built.store.page(EVENT, { limit: 10 })).items };
    };

    // `fetch` builds a composition per invocation, so concurrency is isolated by construction.
    const [organizer, reviewer] = await Promise.all([
      perRequest("organizer"),
      perRequest("reviewer"),
    ]);

    expect(organizer.records[0]).toMatchObject({ actorId: "seed-organizer", source: "human" });
    expect(reviewer.records[0]).toMatchObject({ actorId: "seed-reviewer", source: "human" });
    expect(organizer.report).not.toHaveBeenCalled();
    expect(reviewer.report).not.toHaveBeenCalled();
  });
});
