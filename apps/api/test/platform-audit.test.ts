// @acceptance ACC-OPS
/*
 * The recorder's own rules, none of which the storage can enforce and none of which a route test
 * would show: what a record says about who did it, that recording never fails the change it
 * describes, and that the timeline is gated, bounded and ordered.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditRecordStore } from "../src/adapters/persistence/d1-audit-repository";
import {
  type Actor,
  AuthenticationRequiredError,
  type Capability,
  CapabilityDeniedError,
} from "../src/application/identity/actor";
import {
  AUDIT_PAGE_LIMIT_MAX,
  AuditRecorder,
  createRequestIdentity,
  lifecycleAuditKey,
} from "../src/application/platform/public";

const EVENT = "00000000-0000-4000-8000-000000000001";
const OTHER_EVENT = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION = "00000000-0000-4000-8000-000000000010";

const actorOf = (
  id: string,
  name: string,
  eventId: string,
  capabilities: readonly Capability[],
  /** The grant's role. Separate from the capability, because the gate tests both. */
  /** `custom` is excluded: it is a grant kind, never a `users.persona`. */
  role: Exclude<Actor["eventAccess"][number]["role"], "custom"> = "organizer",
): Actor => ({
  id,
  name,
  persona: role,
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [{ eventId, role, capabilities: new Set(capabilities) }],
  capabilities: new Set(capabilities),
});

const organizer = actorOf("seed-organizer", "Olivia Organizer", EVENT, [
  "events:read",
  "events:settings:read",
]);

/** The same person, on the organization's other event. */
const otherOrganizer = actorOf("seed-organizer", "Olivia Organizer", OTHER_EVENT, [
  "events:read",
  "events:settings:read",
]);

function recorder(now = "2026-08-12T12:00:00.000Z") {
  const store = new MemoryAuditRecordStore();
  const report = vi.fn();
  const identity = createRequestIdentity({ report });
  let issued = 0;
  return {
    store,
    identity,
    report,
    audit: new AuditRecorder({
      store,
      identity,
      newId: () => {
        issued += 1;
        return `record-${issued}`;
      },
      now: () => new Date(now),
      report,
    }),
  };
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORGANIZATION,
  eventId: EVENT,
  action: "review.reviewer_assigned",
  targetType: "review-round",
  targetId: "seed-reviewer:r1",
  idempotencyKey: "audit:review.reviewer_assigned:seed-reviewer:r1",
  ...overrides,
});

describe("the audit recorder", () => {
  it("attributes a record to the request's actor and carries its correlation id", async () => {
    const { audit, identity } = recorder();
    identity.begin({ actor: organizer, correlationId: "corr-1" });

    await audit.record(entry());

    const page = await audit.timeline(organizer, EVENT, { limit: 10 });
    expect(page.records).toEqual([
      expect.objectContaining({
        actorId: "seed-organizer",
        actorName: "Olivia Organizer",
        source: "human",
        correlationId: "corr-1",
        action: "review.reviewer_assigned",
        targetType: "review-round",
        targetId: "seed-reviewer:r1",
      }),
    ]);
  });

  it("distinguishes a delegated API client from the human who created it", async () => {
    const { audit, identity } = recorder();
    identity.begin({
      actor: { ...organizer, id: "api-client-1", name: "Programme sync", requestSource: "api" },
      correlationId: "corr-api",
    });

    await audit.record(entry({ idempotencyKey: "api-profile-edit" }));

    const [record] = (await audit.timeline(organizer, EVENT, { limit: 10 })).records;
    expect(record).toMatchObject({
      actorId: "api-client-1",
      actorName: "Programme sync",
      source: "api",
      correlationId: "corr-api",
    });
  });

  it("records a consequence with no request behind it as system, with no invented identity", async () => {
    const { audit } = recorder();

    // Nothing set the identity: this is the one-minute tick, or a lifecycle consequence outside
    // any request. Naming somebody here would put a person on the timeline who did nothing.
    await audit.record(entry());

    const [record] = (await audit.timeline(organizer, EVENT, { limit: 10 })).records;
    expect(record).toMatchObject({ actorId: null, actorName: "System", source: "system" });
  });

  it("writes one record for a replayed command", async () => {
    const { audit } = recorder();

    await audit.record(entry());
    await audit.record(entry());

    expect((await audit.timeline(organizer, EVENT, { limit: 10 })).records).toHaveLength(1);
  });

  it("never fails the change it describes, and reports the record it lost", async () => {
    const { audit, report, store } = recorder();
    const failure = new Error("the audit table is unreachable");
    vi.spyOn(store, "append").mockRejectedValue(failure);

    // The acceptance rule: the acceptance, the assignment, the publication has already committed.
    // Throwing here would report a failure for work that succeeded and undo nothing.
    await expect(audit.record(entry())).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(
      failure,
      // Everything needed to write the record by hand, including the key that makes doing so safe.
      expect.objectContaining({
        eventId: EVENT,
        action: "review.reviewer_assigned",
        idempotencyKey: "audit:review.reviewer_assigned:seed-reviewer:r1",
      }),
    );
  });

  it("prepares a record without writing one", async () => {
    const { audit, store } = recorder();
    const append = vi.spyOn(store, "append");

    const prepared = audit.prepare(entry());

    expect(prepared).toMatchObject({ action: "review.reviewer_assigned", source: "system" });
    expect(append).not.toHaveBeenCalled();
    expect((await audit.timeline(organizer, EVENT, { limit: 10 })).records).toEqual([]);
  });

  it("orders newest first and pages deterministically through same-millisecond records", async () => {
    const { audit } = recorder();
    for (const index of [1, 2, 3, 4])
      await audit.record(
        entry({ action: `action-${index}`, idempotencyKey: `key-${index}`, targetId: `t${index}` }),
      );

    const first = await audit.timeline(organizer, EVENT, { limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await audit.timeline(organizer, EVENT, {
      limit: 2,
      cursor: first.nextCursor ?? "",
    });

    // All four written at the same instant: the cursor carries the id as well, so the second page
    // continues rather than repeating or skipping.
    const ids = [...first.records, ...second.records].map(({ id }) => id);
    expect(new Set(ids).size).toBe(4);
    expect(second.nextCursor).toBeNull();
  });

  it("shows only this event's records", async () => {
    const { audit } = recorder();
    await audit.record(entry());
    await audit.record(entry({ eventId: OTHER_EVENT, idempotencyKey: "other" }));

    const page = await audit.timeline(organizer, EVENT, { limit: 10 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.idempotencyKey).toBe("audit:review.reviewer_assigned:seed-reviewer:r1");
  });

  it("caps the page at the contract's maximum however much is asked for", async () => {
    const { audit, store } = recorder();
    const page = vi.spyOn(store, "page");

    await audit.timeline(organizer, EVENT, { limit: 5_000 });

    expect(page).toHaveBeenCalledWith(EVENT, { limit: AUDIT_PAGE_LIMIT_MAX });
  });

  it("refuses a reader without events:settings:read on this event", async () => {
    const { audit } = recorder();
    await expect(audit.timeline(null, EVENT, { limit: 10 })).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    const speaker = actorOf("seed-speaker", "Sam Speaker", EVENT, ["events:read", "content:read"]);
    await expect(audit.timeline(speaker, EVENT, { limit: 10 })).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    const elsewhere = actorOf("stranger", "Stranger", OTHER_EVENT, ["events:settings:read"]);
    await expect(audit.timeline(elsewhere, EVENT, { limit: 10 })).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it("refuses the capability held through a role other than organizer", async () => {
    const { audit } = recorder();
    // No role but organizer is granted `events:settings:read` today, so this case is not
    // reachable through the seeded directory — which is exactly why it needs a test. The gate
    // exists for the day one is, and without this the guard could be deleted with every other
    // assertion still green. `ARC-AUTH-001` is why the role is part of the predicate at all.
    const reviewer = actorOf(
      "seed-reviewer",
      "Ravi Reviewer",
      EVENT,
      ["events:read", "events:settings:read"],
      "reviewer",
    );

    await expect(audit.timeline(reviewer, EVENT, { limit: 10 })).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });

  it("starts from the top when handed a cursor it did not produce", async () => {
    const { audit } = recorder();
    await audit.record(entry());

    // A malformed cursor is a caller mistake with an obvious safe answer; refusing would turn a
    // stale bookmark into an error page.
    const page = await audit.timeline(organizer, EVENT, { limit: 10, cursor: "nonsense" });
    expect(page.records).toHaveLength(1);
  });
});

describe("the lifecycle idempotency key", () => {
  it("separates the same target on two events in one organization", () => {
    /*
     * The constraint behind the key is `(organization_id, idempotency_key)`, and two of the facts
     * the composition root reports carry a target that is only unique within an event — a
     * reviewer's round number, a proposal id. An event-less key made the second event's record
     * collide with the first's and vanish through `ON CONFLICT DO NOTHING`, with no log line,
     * because a converged replay and a lost record are indistinguishable to that clause.
     */
    const first = lifecycleAuditKey({
      action: "review.reviewer_assigned",
      eventId: EVENT,
      targetId: "seed-reviewer:r1",
    });
    const second = lifecycleAuditKey({
      action: "review.reviewer_assigned",
      eventId: OTHER_EVENT,
      targetId: "seed-reviewer:r1",
    });

    expect(first).not.toEqual(second);
  });

  it("converges a replay of the same fact", () => {
    const entry = { action: "content.task_assigned", eventId: EVENT, targetId: "task-1" };

    expect(lifecycleAuditKey(entry)).toEqual(lifecycleAuditKey({ ...entry }));
  });

  it("separates a fact that genuinely happened again to the same target", () => {
    // Accept, decline, accept again is three decisions. The outcome is in the action, so it
    // separates the first two; only the occurrence separates the third from the first.
    const accepted = (occurrence: string) =>
      lifecycleAuditKey({
        action: "review.decision_accepted",
        eventId: EVENT,
        targetId: "proposal-1",
        occurrence,
      });

    expect(accepted("2026-08-12T09:00:00.000Z")).not.toEqual(accepted("2026-08-12T11:00:00.000Z"));
  });

  it("stores both records when the keys differ, and one when they do not", async () => {
    const { audit } = recorder();
    const shared = { action: "review.reviewer_assigned", targetType: "review-round" } as const;

    for (const eventId of [EVENT, OTHER_EVENT])
      await audit.record({
        organizationId: ORGANIZATION,
        eventId,
        ...shared,
        targetId: "seed-reviewer:r1",
        idempotencyKey: lifecycleAuditKey({ ...shared, eventId, targetId: "seed-reviewer:r1" }),
      });

    // One organization, two events, the same reviewer and round: both timelines show it.
    expect((await audit.timeline(organizer, EVENT, { limit: 10 })).records).toHaveLength(1);
    expect((await audit.timeline(otherOrganizer, OTHER_EVENT, { limit: 10 })).records).toHaveLength(
      1,
    );
  });
});
