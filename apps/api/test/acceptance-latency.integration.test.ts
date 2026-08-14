// @acceptance ACC-REVIEW
/**
 * Where the seconds go when an organizer confirms a speaker acceptance (issue #207).
 *
 * A person using the deployed demo reported "confirming acceptance of a speaker takes a few
 * seconds", and the issue's first instruction is to **measure before changing anything**. This
 * is the measurement, and it is a test rather than a one-off script for two reasons: the numbers
 * in the pull request body have to be reproducible against the same fixture, and an assertion is
 * the only thing that stops the cost creeping back the way `D10`'s bundle budget does.
 *
 * **What is measured, and why it is round trips.** Acceptance is composed at the transport: one
 * request records the decision, creates the session in the content domain, and enqueues the
 * notifications. Every one of those steps talks to D1. Locally D1 is a SQLite file inside
 * Miniflare, so a statement costs tens of microseconds and the local wall-clock says almost
 * nothing about a deployment; in the Worker each `prepare().run()`, `prepare().all()` and
 * `batch()` is a request to the D1 service, and a chain of them serialized behind one another
 * costs its own length in latencies. So the number that explains "a few seconds" is **how many
 * times the request waited for the database, in sequence** — `criticalPath` — and that number is
 * the same here as it is in production.
 *
 * The composition below mirrors `apps/api/src/index.ts`: the real review, content, events,
 * communications and audit services over real repositories against a migrated, seeded database,
 * with the two lifecycle ports assembled the way the composition root assembles them, including
 * the `organizationOf` lookup each one makes. Nothing is stubbed that costs a round trip.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { D1SpeakerConversion } from "../src/adapters/content/d1-speaker-conversion";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import { D1AuditRecordStore } from "../src/adapters/persistence/d1-audit-repository";
import { D1CommunicationsRepository } from "../src/adapters/persistence/d1-communications-repository";
import {
  type ContentDatabasePort,
  D1ContentRepository,
} from "../src/adapters/persistence/d1-content-repository";
import { D1EventRepository } from "../src/adapters/persistence/d1-event-repository";
import { D1IdentityDirectory } from "../src/adapters/persistence/d1-identity-directory";
import {
  type D1ReviewDatabasePort,
  D1ReviewRepository,
} from "../src/adapters/persistence/d1-review-repository";
import {
  type D1ProposalDatabasePort,
  D1SubmittedProposalAdapter,
} from "../src/adapters/persistence/d1-submitted-proposal-adapter";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { CommunicationsService } from "../src/application/communications/communications-service";
import type { DeliveryRequest } from "../src/application/communications/public";
import {
  ContentService,
  type SpeakerNotificationPort,
} from "../src/application/content/content-service";
import { EventService } from "../src/application/events/event-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import {
  AuditRecorder,
  createRequestIdentity,
  lifecycleAuditKey,
} from "../src/application/platform/audit-service";
import {
  type ReviewNotificationPort,
  ReviewService,
} from "../src/application/review/review-service";
import { criticalPath, recordRoundTrips, summarize } from "./support/d1-round-trips";
import { createMigratedDatabase } from "./support/seeded-d1";

/**
 * Print a measurement.
 *
 * `process.stdout` rather than `console`, which the lint policy forbids and which `tools/`
 * already avoids for the same reason. A measurement nobody can read is not one, so this is
 * emitted on a passing run as well as a failing one.
 */
const report = (lines: string) => process.stdout.write(`\n${lines}\n\n`);

const eventId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000010";
/** A seeded submission with a contact address, so acceptance reaches the whole path. */
const proposalId = "10000000-0000-4000-8000-000000000002";

describe("the cost of confirming a speaker acceptance", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => runtime?.dispose());

  async function fixture(label: string) {
    const migrated = await createMigratedDatabase({ label, seed: true });
    runtime = migrated.runtime;
    const { database, log } = recordRoundTrips(
      migrated.database as unknown as ContentDatabasePort & Record<string, unknown>,
    );
    const now = () => new Date("2026-08-13T12:00:00.000Z");
    let id = 0;
    const newId = () => `e0000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
    const store = database as never;

    const identities = new D1IdentityDirectory(store);
    const events = new EventService({ repository: new D1EventRepository(store), newId, now });
    const contentRepository = new D1ContentRepository(database as ContentDatabasePort);
    const deliveries = new D1CommunicationsRepository(store);
    const communications = new CommunicationsService({
      repository: deliveries,
      eventDirectory: { belongsToOrganization: async () => true },
      newId,
      now,
    });
    const auditRecorder = new AuditRecorder({
      store: new D1AuditRecordStore(store),
      identity: createRequestIdentity({ report: () => undefined }),
      newId,
      now,
      report: () => undefined,
    });

    /*
     * The composition root's helpers, reproduced call for call — including its per-request memo
     * of "which organization runs this event", because the domains reporting these facts are
     * event-scoped and each announcement therefore resolves it for itself. Every one of these is
     * a D1 read, and the count of them is what this measures.
     */
    const owningOrganizations = new Map<string, Promise<string | null>>();
    const organizationOf = (id: string) => {
      const known = owningOrganizations.get(id);
      if (known) return known;
      const resolving = events.organizationOf(id).catch((error: unknown) => {
        owningOrganizations.delete(id);
        // ERROR-INTENT: re-raised to the helper below, which reports it. Only the entry is
        // evicted, so one transient failure does not poison the rest of the request.
        throw error;
      });
      owningOrganizations.set(id, resolving);
      return resolving;
    };
    const recordLifecycle = async (
      factEventId: string,
      entry: { action: string; targetType: string; targetId: string; occurrence?: string },
    ) => {
      const owner = await organizationOf(factEventId);
      if (!owner) return;
      await auditRecorder.record({
        organizationId: owner,
        eventId: factEventId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        idempotencyKey: lifecycleAuditKey({ ...entry, eventId: factEventId }),
      });
    };
    const notifyLifecycle = async (
      factEventId: string,
      request: (owner: string) => Omit<DeliveryRequest, "organizationId" | "eventId">,
    ) => {
      const owner = await organizationOf(factEventId);
      if (!owner) return;
      const enqueued = await communications.enqueue({
        organizationId: owner,
        eventId: factEventId,
        ...request(owner),
      });
      await auditRecorder.record({
        organizationId: owner,
        eventId: factEventId,
        action: "communications.delivery_enqueued",
        targetType: "delivery",
        targetId: enqueued.id,
        idempotencyKey: lifecycleAuditKey({
          action: "communications.delivery_enqueued",
          eventId: factEventId,
          targetId: enqueued.id,
        }),
      });
    };

    const speakerNotifications: SpeakerNotificationPort = {
      speakerAccepted: async (fact) => {
        await recordLifecycle(fact.eventId, {
          action: "content.speaker_accepted",
          targetType: "speaker-profile",
          targetId: fact.profileId,
        });
        await notifyLifecycle(fact.eventId, () => ({
          idempotencyKey: `speaker-invite:${fact.eventId}:${fact.profileId}`,
          triggerType: "speaker.invited",
          channel: "email",
          recipientRef: fact.speakerEmail,
          payload: { speakerName: fact.speakerName, sessionTitle: fact.sessionTitle },
          templateKey: "speaker-invite",
        }));
      },
      taskAssigned: async (fact) => {
        await recordLifecycle(fact.eventId, {
          action: "content.task_assigned",
          targetType: "speaker-task",
          targetId: fact.taskId,
        });
        await notifyLifecycle(fact.eventId, () => ({
          idempotencyKey: `speaker-task:${fact.taskId}`,
          triggerType: "speaker.task_assigned",
          channel: "email",
          recipientRef: fact.speakerEmail,
          payload: {
            speakerName: fact.speakerName,
            taskTitle: fact.taskTitle,
            dueAt: fact.dueAt,
          },
          templateKey: "speaker-task",
        }));
      },
    };
    const reviewNotifications: ReviewNotificationPort = {
      reviewerAssigned: async () => undefined,
      decisionRecorded: async (fact) => {
        await recordLifecycle(fact.eventId, {
          action: `review.decision_${fact.outcome}`,
          targetType: "proposal",
          targetId: fact.proposalId,
          occurrence: `r${fact.revision}`,
        });
        if (!fact.submitterEmail) return;
        await notifyLifecycle(fact.eventId, () => ({
          idempotencyKey: `decision:${fact.eventId}:${fact.proposalId}:${fact.outcome}:r${fact.revision}`,
          triggerType: "decision.recorded",
          channel: "email",
          recipientRef: fact.submitterEmail as string,
          payload: { submitterName: fact.submitterName, proposalTitle: fact.proposalTitle },
          templateKey: fact.outcome === "accepted" ? "decision-accepted" : "decision-declined",
        }));
      },
    };

    const reviewService = new ReviewService({
      repository: new D1ReviewRepository(database as unknown as D1ReviewDatabasePort),
      proposals: new D1SubmittedProposalAdapter(database as unknown as D1ProposalDatabasePort),
      identities,
      events,
      notifications: reviewNotifications,
      newId,
      now,
    });
    const contentService = new ContentService({
      repository: contentRepository,
      assetStorage: new DeterministicAssetStorage(),
      proposals: reviewService,
      agenda: new AgendaService(new D1AgendaRepository(store, now), now, contentRepository),
      speakerConversion: new D1SpeakerConversion(store, newId, identities),
      speakerNotifications,
      newId,
      now,
    });
    return { log, reviewService, contentService, deliveries };
  }

  /**
   * The end-to-end cost of one acceptance, phase by phase.
   *
   * The ceilings are budgets in the sense `D10` established: they are set at what the path costs
   * today, so a change that adds a serialized read to this path fails here and has to say why.
   * They are deliberately *not* set at an aspirational number — a budget nothing meets is a
   * budget everybody raises.
   */
  it("accepts one proposal within its round-trip budget, and says where the trips go", async () => {
    const { log, reviewService, contentService } = await fixture("acceptance-latency");
    const organizer = await resolveSeededDemoActor("organizer");

    const decided = await log.measure("decide", () =>
      reviewService.decide(organizer, eventId, [proposalId], "accepted", "Yes"),
    );
    // `acceptSession`, because that is what the composed decision route calls. Measuring
    // `accept` instead would measure a projection this path does not produce.
    const accepted = await log.measure("accept", () =>
      contentService.acceptSession(organizer, { eventId, proposalId }, "acceptance-latency"),
    );

    // The third leg: the console's refresh of the triage workspace after the decision. Measured
    // because the organizer used to wait through it before being told anything, and because
    // "the reload is free" is the kind of claim that needs a number.
    const reloaded = await log.measure("console reload", () =>
      reviewService.organizerWorkspace(organizer, eventId),
    );

    expect(decided.result.decisions).toHaveLength(1);
    expect(accepted.result).toEqual(expect.any(String));
    expect(reloaded.result.decisions.some((entry) => entry.proposalId === proposalId)).toBe(true);

    const sequential = {
      decide: criticalPath(decided.trips),
      accept: criticalPath(accepted.trips),
      reload: criticalPath(reloaded.trips),
      request: criticalPath([...decided.trips, ...accepted.trips]),
    };
    // Printed rather than only asserted: the pull request body quotes these, and a number nobody
    // can reproduce is not a measurement.
    report(
      `${summarize(log.entries)}\nsequential waits in the acceptance request: ${sequential.request}`,
    );

    // The budgets. Raise one only with the measurement that justifies it, in the same commit.
    expect(sequential.decide).toBeLessThanOrEqual(DECIDE_SEQUENTIAL_BUDGET);
    expect(sequential.accept).toBeLessThanOrEqual(ACCEPT_SEQUENTIAL_BUDGET);
    expect(sequential.reload).toBeLessThanOrEqual(RELOAD_SEQUENTIAL_BUDGET);
    expect(sequential.request).toBeLessThanOrEqual(
      DECIDE_SEQUENTIAL_BUDGET + ACCEPT_SEQUENTIAL_BUDGET,
    );
  });

  /**
   * Repeating the same acceptance costs less, and still delivers nothing twice.
   *
   * Both halves matter to #207. The cost matters because the repeat path is what an organizer
   * hits when they retry a `decision_only` row, and it must not be the expensive one. The
   * deliveries matter because every reduction above touches either a read the notifications
   * depend on or the order they are issued in, and the acceptance criteria is explicit: exactly
   * one delivery per acceptance, still idempotent on repeat.
   */
  it("adds no delivery and little cost when the same acceptance is repeated", async () => {
    const { log, reviewService, contentService, deliveries } = await fixture("acceptance-repeat");
    const organizer = await resolveSeededDemoActor("organizer");

    // Compared against a baseline rather than counted outright: the demo seed already carries
    // deliveries on this event, so a bare count would be asserting the fixture.
    const before = new Set((await deliveries.list(organizationId, eventId)).map(({ id }) => id));
    const added = async () =>
      (await deliveries.list(organizationId, eventId)).filter(({ id }) => !before.has(id));

    await reviewService.decide(organizer, eventId, [proposalId], "accepted", "Yes");
    const first = await contentService.acceptSession(
      organizer,
      { eventId, proposalId },
      "acceptance-repeat-1",
    );
    const afterFirst = await added();

    log.reset();
    const repeat = await log.measure("repeat", () =>
      reviewService
        .decide(organizer, eventId, [proposalId], "accepted", "Yes")
        .then(() =>
          contentService.acceptSession(organizer, { eventId, proposalId }, "acceptance-repeat-2"),
        ),
    );

    // The same session, not a second one.
    expect(repeat.result).toBe(first);
    // One invitation, two task notices, one decision notice — no more and no fewer.
    const triggers = (queued: readonly { triggerType: string }[]) =>
      queued.map(({ triggerType }) => triggerType).sort();
    expect(triggers(afterFirst)).toEqual([
      "decision.recorded",
      "speaker.invited",
      "speaker.task_assigned",
      "speaker.task_assigned",
    ]);
    // And the repeat queues nothing at all: each key converged on the delivery already there.
    expect((await added()).map(({ id }) => id).sort()).toEqual(
      afterFirst.map(({ id }) => id).sort(),
    );

    report(`repeat: ${criticalPath(repeat.trips)} sequential waits`);
    expect(criticalPath(repeat.trips)).toBeLessThanOrEqual(REPEAT_SEQUENTIAL_BUDGET);
  });
});

/*
 * What one acceptance may cost, in sequential waits on D1.
 *
 * Measured on the seeded fixture with the same harness, before and after issue #207:
 *
 * | phase                          | before | after |
 * |--------------------------------|--------|-------|
 * | decide                         |     13 |    12 |
 * | accept (what the route calls)  |     52 |    18 |
 * | **the acceptance request**     | **65** |**30** |
 * | the console's reload afterwards|      2 |     2 |
 * | a repeated acceptance          |      — |    14 |
 *
 * The budgets sit one or two above each measurement, so ordinary drift is visible without the
 * suite failing on a statement legitimately added. What they exist to catch is the class of
 * change this issue found: a serialized read added to the busiest write in the product.
 *
 * **Three costs were measured and deliberately not taken**, so a later reader does not re-derive
 * them from the numbers:
 *
 * - `decide` reads the event's status set twice and the proposals twice, because
 *   `transitionAtomically` re-validates both for the callers that reach it directly. Removing
 *   the duplication means giving `SubmittedProposalInterface` a typed not-found and a way to
 *   accept an already-read status set — a change to CFP's port from inside a review lane, which
 *   is exactly the shape "fix, don't file" tells this lane not to make. Two round trips.
 * - `CommunicationsService.enqueue` inserts a delivery and then reads it back, four times per
 *   acceptance. `RETURNING` would collapse each pair, and the file is communications'.
 * - The speaker conversion is twelve sequential round trips and stays that way. Every
 *   insert-then-read pair in it is a claim followed by "who actually won", which is the whole
 *   mechanism that makes two concurrent conversions land on one speaker; an `INSERT OR IGNORE`
 *   that was ignored returns nothing, so the read-back cannot be folded into it. It is also the
 *   **cold** path only — a repeat acceptance short-circuits on the first read, which is what the
 *   repeat measurement above shows. This is the part of the cost that is inherent, and #207 asks
 *   for that to be said with the measurement rather than optimized away.
 */
const DECIDE_SEQUENTIAL_BUDGET = 13;
const ACCEPT_SEQUENTIAL_BUDGET = 20;
const RELOAD_SEQUENTIAL_BUDGET = 3;
const REPEAT_SEQUENTIAL_BUDGET = 16;
