/**
 * `CustomRoleRepository` against D1.
 *
 * The two conventions this domain's adapters share are both load-bearing here. Every state change
 * is batched with its audit row, and a conditional write's audit row carries `WHERE changes() > 0`
 * so a write that matched nothing records nothing. Every conditional write answers its affected
 * row count through `changedRows`, and a driver that cannot report one is a failure rather than a
 * silent zero.
 *
 * **A role is three tables and one revision.** Capabilities and field policies are child rows, so
 * an update is delete-then-insert against them — and the whole set has to move atomically or a
 * concurrent read sees a role that grants a capability whose field policy has not arrived yet.
 * The `UPDATE … WHERE revision = ?` goes **first** in the batch, which is what makes that safe:
 * D1 runs a batch as one sequential transaction, so a lost revision race leaves the child rows
 * untouched because the guarded statement matched nothing and every statement after it is
 * likewise guarded on `changes()`.
 *
 * @spec PRD-IAM-002 ARC-AUTH-001
 */
import type { AuditContext } from "../../application/identity/audit";
import {
  type CustomRole,
  type CustomRoleAssignment,
  CustomRoleNameTakenError,
  type CustomRoleRepository,
} from "../../application/identity/custom-roles";
import type { FieldPolicy, FieldSubject } from "../../application/identity/field-access";
import { type AuditDatabasePort, auditEventStatement } from "./d1-identity-audit";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface CustomRoleDatabasePort extends AuditDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

interface RoleRow {
  id: string;
  event_id: string;
  organization_id: string;
  name: string;
  description: string;
  template: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  revision: number;
}
interface CapabilityRow {
  role_id: string;
  capability: string;
}
interface PolicyRow {
  role_id: string;
  subject: FieldSubject;
  field: string;
  policy: FieldPolicy;
}

/**
 * The audit `detail` for a role change.
 *
 * The whole composed role, because the question an operator asks afterwards is "what could this
 * role see on the day", and a diff against a row that has since moved cannot answer it. Nothing
 * here is a credential — a role is names and policies.
 */
const roleDetail = (role: CustomRole) => ({
  roleId: role.id,
  name: role.name,
  template: role.template,
  capabilities: [...role.capabilities],
  fieldPolicies: role.fieldPolicies.map(({ subject, field, policy }) => ({
    subject,
    field,
    policy,
  })),
  revision: role.revision,
});

export class D1CustomRoleRepository implements CustomRoleRepository {
  constructor(private readonly database: CustomRoleDatabasePort) {}

  async list(eventId: string): Promise<readonly CustomRole[]> {
    const roles = await this.database
      .prepare(
        "SELECT id, event_id, organization_id, name, description, template, created_by, created_at, updated_at, revision " +
          "FROM event_custom_roles WHERE event_id = ? ORDER BY name, id",
      )
      .bind(eventId)
      .all<RoleRow>();
    if (!roles.success)
      throw new Error(`D1 failed to list custom roles: ${roles.error ?? "unknown error"}`);
    const rows = roles.results ?? [];
    if (rows.length === 0) return [];
    return this.compose(rows);
  }

  async find(eventId: string, roleId: string): Promise<CustomRole | null> {
    const roles = await this.database
      .prepare(
        "SELECT id, event_id, organization_id, name, description, template, created_by, created_at, updated_at, revision " +
          "FROM event_custom_roles WHERE event_id = ? AND id = ? LIMIT 1",
      )
      .bind(eventId, roleId)
      .all<RoleRow>();
    if (!roles.success)
      throw new Error(`D1 failed to read a custom role: ${roles.error ?? "unknown error"}`);
    const row = roles.results?.[0];
    if (!row) return null;
    return (await this.compose([row]))[0] ?? null;
  }

  /** The children for a set of roles, in two statements rather than one per role. */
  private async compose(rows: readonly RoleRow[]): Promise<CustomRole[]> {
    const ids = JSON.stringify(rows.map((row) => row.id));
    const [capabilities, policies] = await Promise.all([
      this.database
        .prepare(
          "SELECT role_id, capability FROM event_custom_role_capabilities " +
            "WHERE role_id IN (SELECT value FROM json_each(?)) ORDER BY capability",
        )
        .bind(ids)
        .all<CapabilityRow>(),
      this.database
        .prepare(
          "SELECT role_id, subject, field, policy FROM event_custom_role_field_policies " +
            "WHERE role_id IN (SELECT value FROM json_each(?)) ORDER BY subject, field",
        )
        .bind(ids)
        .all<PolicyRow>(),
    ]);
    if (!capabilities.success)
      throw new Error(
        `D1 failed to read custom role capabilities: ${capabilities.error ?? "unknown error"}`,
      );
    if (!policies.success)
      throw new Error(
        `D1 failed to read custom role field policies: ${policies.error ?? "unknown error"}`,
      );
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      organizationId: row.organization_id,
      name: row.name,
      description: row.description,
      template: row.template,
      capabilities: (capabilities.results ?? [])
        .filter((entry) => entry.role_id === row.id)
        .map(({ capability }) => capability),
      fieldPolicies: (policies.results ?? [])
        .filter((entry) => entry.role_id === row.id)
        .map(({ subject, field, policy }) => ({ subject, field, policy })),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    }));
  }

  private childStatements(role: CustomRole): D1Statement[] {
    return [
      ...role.capabilities.map((capability) =>
        this.database
          .prepare("INSERT INTO event_custom_role_capabilities (role_id, capability) VALUES (?,?)")
          .bind(role.id, capability),
      ),
      ...role.fieldPolicies.map((entry) =>
        this.database
          .prepare(
            "INSERT INTO event_custom_role_field_policies (role_id, subject, field, policy) VALUES (?,?,?,?)",
          )
          .bind(role.id, entry.subject, entry.field, entry.policy),
      ),
    ];
  }

  async create(role: CustomRole, context: AuditContext): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO event_custom_roles (id, event_id, organization_id, name, description, template, created_by, created_at, updated_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          role.id,
          role.eventId,
          role.organizationId,
          role.name,
          role.description,
          role.template,
          role.createdBy,
          role.createdAt,
          role.updatedAt,
          role.revision,
        ),
      ...this.childStatements(role),
      auditEventStatement(
        this.database,
        {
          action: "custom_role.created",
          outcome: "succeeded",
          occurredAt: role.createdAt,
          organizationId: role.organizationId,
          eventId: role.eventId,
          detail: roleDetail(role),
        },
        context,
      ),
    ]);
    // `event_custom_roles_event_name_idx` is the arbiter of a duplicate name rather than a read
    // before the write: two administrators naming a role "AV" at once would both pass a read.
    const failed = results.find((result) => !result.success);
    if (failed) {
      if (/unique/i.test(failed.error ?? "")) throw new CustomRoleNameTakenError();
      throw new Error(`D1 failed to create a custom role: ${failed.error ?? "unknown error"}`);
    }
  }

  async update(role: CustomRole, expectedRevision: number, context: AuditContext): Promise<number> {
    const results = await this.database.batch([
      // First, and guarded on the revision: every statement after it is conditional on this one
      // having matched, so a lost race leaves the child rows exactly as they were.
      this.database
        .prepare(
          "UPDATE event_custom_roles SET name = ?, description = ?, updated_at = ?, revision = ? " +
            "WHERE id = ? AND event_id = ? AND revision = ?",
        )
        .bind(
          role.name,
          role.description,
          role.updatedAt,
          role.revision,
          role.id,
          role.eventId,
          expectedRevision,
        ),
      // Every statement below tests the *stored* revision against the one the update wrote, not
      // `changes()`. `changes()` reports only the statement immediately before, so a chain of six
      // guarded statements cannot use it — the second would be testing the first delete's count
      // rather than the update's. Reading the row back is the guard that stays correct however
      // many statements the role's capability and policy sets add.
      this.database
        .prepare(
          "DELETE FROM event_custom_role_capabilities WHERE role_id = ? AND (SELECT revision FROM event_custom_roles WHERE id = ?) = ?",
        )
        .bind(role.id, role.id, role.revision),
      this.database
        .prepare(
          "DELETE FROM event_custom_role_field_policies WHERE role_id = ? AND (SELECT revision FROM event_custom_roles WHERE id = ?) = ?",
        )
        .bind(role.id, role.id, role.revision),
      ...role.capabilities.map((capability) =>
        this.database
          .prepare(
            "INSERT INTO event_custom_role_capabilities (role_id, capability) " +
              "SELECT ?, ? WHERE (SELECT revision FROM event_custom_roles WHERE id = ?) = ?",
          )
          .bind(role.id, capability, role.id, role.revision),
      ),
      ...role.fieldPolicies.map((entry) =>
        this.database
          .prepare(
            "INSERT INTO event_custom_role_field_policies (role_id, subject, field, policy) " +
              "SELECT ?, ?, ?, ? WHERE (SELECT revision FROM event_custom_roles WHERE id = ?) = ?",
          )
          .bind(role.id, entry.subject, entry.field, entry.policy, role.id, role.revision),
      ),
      auditEventStatement(
        this.database,
        {
          action: "custom_role.updated",
          outcome: "succeeded",
          occurredAt: role.updatedAt,
          organizationId: role.organizationId,
          eventId: role.eventId,
          detail: roleDetail(role),
        },
        context,
        // Safe as an unconditional `changes()` guard because `validate` requires at least one
        // capability, so there is always a guarded insert immediately before this row. A role
        // with no capabilities never reaches here.
        { onlyWhenChanged: true },
      ),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed) {
      if (/unique/i.test(failed.error ?? "")) throw new CustomRoleNameTakenError();
      throw new Error(`D1 failed to update a custom role: ${failed.error ?? "unknown error"}`);
    }
    const [updated] = results;
    if (!updated) throw new Error("D1 returned no result while updating a custom role");
    return changedRows(updated, "update a custom role");
  }

  async remove(
    eventId: string,
    roleId: string,
    expectedRevision: number,
    occurredAt: number,
    context: AuditContext,
  ): Promise<number> {
    // Read first so the audit row can say what was deleted; the delete is still guarded on the
    // revision, so a role that moved between the two is refused rather than removed.
    const existing = await this.find(eventId, roleId);
    if (!existing) return 0;
    const results = await this.database.batch<{ id: string }>([
      /*
       * The child rows and every `event_roles` grant naming this role go with it, by
       * `ON DELETE CASCADE` — nobody is left holding a role that no longer says what it permits.
       *
       * `RETURNING id` rather than the affected-row count, and the cascade is exactly why. D1
       * reports `meta.changes` for the whole statement including the rows the cascade removed, so
       * a role with two capabilities, two policies and one holder answers 6 — a number that is
       * true and is not the answer to "did this role go". The returned rows are.
       */
      this.database
        .prepare(
          "DELETE FROM event_custom_roles WHERE id = ? AND event_id = ? AND revision = ? RETURNING id",
        )
        .bind(roleId, eventId, expectedRevision),
      auditEventStatement(
        this.database,
        {
          action: "custom_role.deleted",
          outcome: "succeeded",
          occurredAt,
          organizationId: existing.organizationId,
          eventId,
          detail: roleDetail(existing),
        },
        context,
        { onlyWhenChanged: true },
      ),
    ]);
    this.assertBatch(results, "delete a custom role");
    const [deleted] = results;
    if (!deleted?.results) throw new Error("D1 returned no rows while deleting a custom role");
    return deleted.results.length;
  }

  /**
   * Grant the role, as an `event_roles` row whose `role` is `custom`.
   *
   * `INSERT … SELECT … WHERE EXISTS` rather than a plain insert: the role must still exist, and
   * naming a deleted role has to answer 0 rather than violate a foreign key with a 500. The
   * `ON CONFLICT DO UPDATE` is what makes re-granting move somebody from one custom role to
   * another — the primary key admits one `custom` row per person per event, which is the product
   * rule migration `1005` states.
   */
  async assign(
    eventId: string,
    roleId: string,
    userId: string,
    occurredAt: number,
    context: AuditContext,
  ): Promise<number> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO event_roles (event_id, user_id, role, custom_role_id) " +
            "SELECT ?, ?, 'custom', ? WHERE EXISTS (SELECT 1 FROM event_custom_roles WHERE id = ? AND event_id = ?) " +
            "ON CONFLICT (event_id, user_id, role) DO UPDATE SET custom_role_id = excluded.custom_role_id " +
            "WHERE event_roles.custom_role_id <> excluded.custom_role_id",
        )
        .bind(eventId, userId, roleId, roleId, eventId),
      auditEventStatement(
        this.database,
        {
          action: "event_role.granted",
          outcome: "succeeded",
          occurredAt,
          subjectUserId: userId,
          eventId,
          detail: { role: "custom", customRoleId: roleId },
        },
        context,
        { onlyWhenChanged: true },
      ),
    ]);
    this.assertBatch(results, "assign a custom role");
    const [assigned] = results;
    if (!assigned) throw new Error("D1 returned no result while assigning a custom role");
    return changedRows(assigned, "assign a custom role");
  }

  async unassign(
    eventId: string,
    roleId: string,
    userId: string,
    occurredAt: number,
    context: AuditContext,
  ): Promise<number> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'custom' AND custom_role_id = ?",
        )
        .bind(eventId, userId, roleId),
      auditEventStatement(
        this.database,
        {
          action: "event_role.revoked",
          outcome: "succeeded",
          occurredAt,
          subjectUserId: userId,
          eventId,
          detail: { role: "custom", customRoleId: roleId },
        },
        context,
        { onlyWhenChanged: true },
      ),
    ]);
    this.assertBatch(results, "unassign a custom role");
    const [removed] = results;
    if (!removed) throw new Error("D1 returned no result while unassigning a custom role");
    return changedRows(removed, "unassign a custom role");
  }

  async listAssignments(eventId: string): Promise<readonly CustomRoleAssignment[]> {
    const found = await this.database
      .prepare(
        "SELECT r.custom_role_id AS role_id, r.user_id, u.name FROM event_roles r " +
          "JOIN users u ON u.id = r.user_id " +
          "WHERE r.event_id = ? AND r.role = 'custom' ORDER BY u.name, r.user_id",
      )
      .bind(eventId)
      .all<{ role_id: string; user_id: string; name: string }>();
    if (!found.success)
      throw new Error(`D1 failed to list custom role holders: ${found.error ?? "unknown error"}`);
    return (found.results ?? []).map((row) => ({
      roleId: row.role_id,
      userId: row.user_id,
      userName: row.name,
    }));
  }

  async isMember(organizationId: string, userId: string): Promise<boolean> {
    const found = await this.database
      .prepare(
        "SELECT 1 AS present FROM organization_memberships WHERE organization_id = ? AND user_id = ? LIMIT 1",
      )
      .bind(organizationId, userId)
      .all<{ present: number }>();
    if (!found.success)
      throw new Error(`D1 failed to read membership: ${found.error ?? "unknown error"}`);
    return (found.results?.length ?? 0) > 0;
  }

  private assertBatch(
    results: Array<D1WriteResult & { results?: unknown[] }>,
    operation: string,
  ): void {
    const failed = results.find((result) => !result.success);
    if (failed) throw new Error(`D1 failed to ${operation}: ${failed.error ?? "unknown error"}`);
  }
}
