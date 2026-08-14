// @acceptance ACC-IDENTITY-EVENTS
/**
 * Custom roles against a real, migrated, seeded D1 database.
 *
 * Five things are only true here, and each one is a claim the unit tests cannot make.
 *
 * **The table refuses what the service refuses.** `identity:manage` is absent from
 * `event_custom_role_capabilities`' CHECK and a policy may only name a governed field, so a
 * writer that went round the service still cannot compose a role that widens itself. A guard
 * that lives only in a service is a guard one adapter can forget.
 *
 * **A role edit is atomic across three tables.** Capabilities and field policies are child rows,
 * so an update is delete-then-insert against them, and every statement after the guarded
 * `UPDATE` re-tests the stored revision. Whether a lost race really leaves the children untouched
 * is a property of SQLite running a batch as one sequential transaction.
 *
 * **A role change takes effect on the next read with no session recreation.** The directory
 * re-derives the actor from D1 every request, so the capabilities and field policies it returns
 * follow the role rather than the session that resolved before it moved.
 *
 * **Deleting a role takes its grants with it.** `event_roles.custom_role_id` cascades, so nobody
 * is left holding a role that no longer says what it permits — which is a foreign-key behaviour
 * and not something a fake repository can demonstrate.
 *
 * **The last-administrator guard counts what would be left.** Revoking one organizer role from
 * somebody who organizes a second event in the same organization removes no administrator, and
 * the SQL has to say so.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CustomRoleDatabasePort,
  D1CustomRoleRepository,
} from "../src/adapters/persistence/d1-custom-roles";
import {
  type D1DatabasePort,
  D1EventRepository,
} from "../src/adapters/persistence/d1-event-repository";
import {
  D1IdentityDirectory,
  type IdentityDatabasePort,
  preparedOrganizerGrant,
} from "../src/adapters/persistence/d1-identity-directory";
import {
  D1MembershipRepository,
  type MembershipDatabasePort,
} from "../src/adapters/persistence/d1-identity-membership";
import { EventService } from "../src/application/events/event-service";
import type { Capability } from "../src/application/identity/actor";
import type { AuditContext } from "../src/application/identity/audit";
import type { CustomRole } from "../src/application/identity/custom-roles";
import { fieldAccessFor } from "../src/application/identity/field-access";
import { createMigratedDatabase } from "./support/seeded-d1";

const DEMO_ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const ROLE = "44444444-4444-4444-8444-444444444444";
const HOLDER = "22222222-2222-4222-8222-222222222222";
const NOW = 1_760_000_000_000;

const context: AuditContext = {
  correlationId: "correlation-under-test",
  actorUserId: "seed-organizer",
  source: "human",
};

const roleOf = (over: Partial<CustomRole> = {}): CustomRole => ({
  id: ROLE,
  eventId: DEMO_EVENT,
  organizationId: DEMO_ORGANIZATION,
  name: "AV coordinator",
  description: "Runs the room",
  template: "av",
  capabilities: ["content:read", "events:read"],
  fieldPolicies: [
    { subject: "speaker", field: "*", policy: "hide" },
    { subject: "session", field: "abstract", policy: "lock" },
  ],
  createdBy: "seed-organizer",
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
  ...over,
});

describe("custom roles against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "custom-roles" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as CustomRoleDatabasePort;
    const repository = new D1CustomRoleRepository(database);
    const directory = new D1IdentityDirectory(database as unknown as IdentityDatabasePort);
    // A real person, a member of the demo organization, holding no event grant yet.
    await database
      .prepare("INSERT INTO users (id, name, persona) VALUES (?, 'Hank Holder', 'organizer')")
      .bind(HOLDER)
      .run();
    await database
      .prepare(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (?,?, 'organizer')",
      )
      .bind(DEMO_ORGANIZATION, HOLDER)
      .run();
    return { database, repository, directory };
  }

  it("stores a role, its capabilities and its policies, with one audit row", async () => {
    const { database, repository } = await stack();
    await repository.create(roleOf(), context);
    const stored = await repository.find(DEMO_EVENT, ROLE);
    expect(stored?.capabilities).toEqual(["content:read", "events:read"]);
    expect(stored?.fieldPolicies).toEqual([
      { subject: "session", field: "abstract", policy: "lock" },
      { subject: "speaker", field: "*", policy: "hide" },
    ]);
    const audit = await database
      .prepare(
        "SELECT action, outcome, detail FROM identity_audit_events WHERE action LIKE 'custom_role%'",
      )
      .all<{ action: string; outcome: string; detail: string }>();
    expect(audit.results?.map(({ action }) => action)).toEqual(["custom_role.created"]);
    // The whole composed role, because the question asked afterwards is what it could see.
    expect(JSON.parse(audit.results?.[0]?.detail ?? "{}").capabilities).toEqual([
      "content:read",
      "events:read",
    ]);
  });

  it("refuses a capability and a field the application does not govern, at the table", async () => {
    const { database, repository } = await stack();
    await repository.create(roleOf(), context);
    // Straight past the service, exactly as a future adapter or a hand-run statement would.
    const write = (query: string, ...values: unknown[]) =>
      database
        .prepare(query)
        .bind(...values)
        .run();
    await expect(
      write(
        "INSERT INTO event_custom_role_capabilities (role_id, capability) VALUES (?,?)",
        ROLE,
        "identity:manage",
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
    await expect(
      write(
        "INSERT INTO event_custom_role_field_policies (role_id, subject, field, policy) VALUES (?,?,?,?)",
        ROLE,
        "speaker",
        "salary",
        "hide",
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
    // And an identifier cannot be hidden even by a caller who knows the field name.
    await expect(
      write(
        "INSERT INTO event_custom_role_field_policies (role_id, subject, field, policy) VALUES (?,?,?,?)",
        ROLE,
        "contact",
        "name",
        "hide",
      ),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it("leaves the child rows untouched when an edit loses the revision race", async () => {
    const { repository } = await stack();
    await repository.create(roleOf(), context);
    const stale = await repository.update(
      roleOf({ revision: 2, capabilities: ["crm:manage"], fieldPolicies: [] }),
      // The stored revision is 1; this edit believes it is 7.
      7,
      context,
    );
    expect(stale).toBe(0);
    const unchanged = await repository.find(DEMO_EVENT, ROLE);
    expect(unchanged?.revision).toBe(1);
    expect(unchanged?.capabilities).toEqual(["content:read", "events:read"]);
    expect(unchanged?.fieldPolicies).toHaveLength(2);

    const applied = await repository.update(
      roleOf({ revision: 2, capabilities: ["crm:manage"], fieldPolicies: [] }),
      1,
      context,
    );
    expect(applied).toBe(1);
    const moved = await repository.find(DEMO_EVENT, ROLE);
    expect(moved?.revision).toBe(2);
    expect(moved?.capabilities).toEqual(["crm:manage"]);
    expect(moved?.fieldPolicies).toEqual([]);
  });

  it("resolves a holder's capabilities and field policies on the very next read", async () => {
    const { repository, directory } = await stack();
    await repository.create(roleOf(), context);
    expect(await repository.assign(DEMO_EVENT, ROLE, HOLDER, NOW, context)).toBe(1);

    const granted = await directory.findByUserId(HOLDER);
    const grant = granted?.eventAccess.find(({ eventId }) => eventId === DEMO_EVENT);
    expect(grant?.role).toBe("custom");
    expect(grant?.customRole).toEqual({ id: ROLE, name: "AV coordinator" });
    expect([...(grant?.capabilities ?? [])].sort()).toEqual(["content:read", "events:read"]);
    const access = fieldAccessFor(granted, DEMO_EVENT);
    expect(access.canView("speaker", "bio")).toBe(false);
    expect(access.canEdit("session", "abstract")).toBe(false);

    // No session is touched and none exists; the actor is re-derived from D1, so widening the
    // role is visible immediately.
    await repository.update(
      roleOf({ revision: 2, capabilities: ["content:read"], fieldPolicies: [] }),
      1,
      context,
    );
    const rewidened = await directory.findByUserId(HOLDER);
    expect(fieldAccessFor(rewidened, DEMO_EVENT).canView("speaker", "bio")).toBe(true);
  });

  it("takes every grant with the role when the role is deleted", async () => {
    const { database, repository } = await stack();
    await repository.create(roleOf(), context);
    await repository.assign(DEMO_EVENT, ROLE, HOLDER, NOW, context);
    expect(await repository.remove(DEMO_EVENT, ROLE, 1, NOW, context)).toBe(1);
    const remaining = await database
      .prepare("SELECT role FROM event_roles WHERE user_id = ? AND event_id = ?")
      .bind(HOLDER, DEMO_EVENT)
      .all<{ role: string }>();
    expect(remaining.results ?? []).toEqual([]);
    const children = await database
      .prepare("SELECT COUNT(*) AS total FROM event_custom_role_field_policies WHERE role_id = ?")
      .bind(ROLE)
      .all<{ total: number }>();
    expect(children.results?.[0]?.total).toBe(0);
  });

  it("regranting the same role is idempotent and writes no second audit row", async () => {
    const { database, repository } = await stack();
    await repository.create(roleOf(), context);
    await repository.assign(DEMO_EVENT, ROLE, HOLDER, NOW, context);
    expect(await repository.assign(DEMO_EVENT, ROLE, HOLDER, NOW, context)).toBe(0);
    const audit = await database
      .prepare(
        "SELECT COUNT(*) AS total FROM identity_audit_events WHERE action = 'event_role.granted' AND subject_user_id = ?",
      )
      .bind(HOLDER)
      .all<{ total: number }>();
    expect(audit.results?.[0]?.total).toBe(1);
  });

  it("counts the administrators a removal would leave, not the ones it excludes", async () => {
    const { database } = await stack();
    const membership = new D1MembershipRepository(database as unknown as MembershipDatabasePort);
    /*
     * The second event is created through the events domain's own service rather than by
     * inserting into `events` here. `events` is that domain's table (`table-ownership.json`) and
     * identity-access reads none of it — a rule `npm run context -- check` enforces by text,
     * including in tests, and the reason two integration tests were rewritten during the
     * sign-in-before-Google lane. The organizer grant travels inside the event's own batch, so
     * this also gives the second administrator role without a second raw write.
     */
    const events = new EventService({
      repository: new D1EventRepository(
        database as unknown as D1DatabasePort,
        preparedOrganizerGrant,
      ),
      newId: () => "00000000-0000-4000-8000-0000000000ff",
      now: () => new Date(NOW),
    });
    const creator = {
      id: "seed-organizer",
      name: "Olivia Organizer",
      persona: "organizer" as const,
      organizations: [{ id: DEMO_ORGANIZATION }],
      eventAccess: [],
      capabilities: new Set<Capability>(["events:create"]),
    };
    const second = await events.create(creator, {
      organizationId: DEMO_ORGANIZATION,
      name: "Second event",
      timezone: "Europe/London",
    });
    const eventIds = [DEMO_EVENT, second.id];

    // Taking one of the two roles away leaves the same person administering the organization.
    expect(
      await membership.countAdministratorsAfter(DEMO_ORGANIZATION, eventIds, {
        userId: "seed-organizer",
        eventId: second.id,
      }),
    ).toBe(1);
    // Removing them from the organization entirely leaves nobody.
    expect(
      await membership.countAdministratorsAfter(DEMO_ORGANIZATION, eventIds, {
        userId: "seed-organizer",
        eventId: null,
      }),
    ).toBe(0);
  });
});
