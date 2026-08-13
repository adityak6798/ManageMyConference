/**
 * `MembershipRepository` against D1.
 *
 * Same two conventions as `d1-identity-sessions.ts`, for the same reasons. Every state change is
 * batched with its audit row, and the audit row for a *conditional* write carries
 * `WHERE changes() > 0`, so a removal that matched nothing records nothing. Every conditional
 * write's answer is its affected-row count through `changedRows`, and a driver that cannot report
 * one is a failure rather than a silent zero.
 *
 * Acceptance is the interesting statement. It is two statements in one batch: a conditional
 * `UPDATE` that marks the invitation spent, and an `INSERT … SELECT` that reads the row the
 * `UPDATE` just stamped. That ordering is what makes acceptance single-use without a second round
 * trip — two callers racing the same token both run the `UPDATE`, exactly one matches
 * `accepted_at IS NULL`, and the loser's `INSERT … SELECT` selects nothing.
 *
 * @spec PRD-IAM-001 PRD-IAM-002 ARC-AUTH-001
 */
import type { AuditAction, AuditContext, AuditEntry } from "../../application/identity/audit";
import type {
  AcceptedInvitation,
  AuditEventRow,
  Invitation,
  InvitableRole,
  MembershipRepository,
  OrganizationMember,
} from "../../application/identity/membership";
import { type AuditDatabasePort, auditEventStatement } from "./d1-identity-audit";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}

export interface MembershipDatabasePort extends AuditDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
}

/** A live invitation: not accepted, not revoked, not expired. All three are in the SQL. */
const LIVE_INVITATION = "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?";

interface MemberRow {
  user_id: string;
  name: string;
  email: string | null;
}
interface RoleRow {
  user_id: string;
  event_id: string;
  role: string;
}
interface InvitationRow {
  id: string;
  organization_id: string;
  event_id: string | null;
  email: string;
  role: InvitableRole;
  invited_by_user_id: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_by_user_id: string | null;
  revoked_at: number | null;
}

export class D1MembershipRepository implements MembershipRepository {
  constructor(private readonly database: MembershipDatabasePort) {}

  /**
   * The organization's members, each with the roles they hold on *this* organization's events.
   *
   * Two reads rather than a join: the roles query is scoped by the organization's events, and
   * folding it into the member query would either lose members who hold no event role or
   * duplicate members who hold several.
   */
  async listMembers(
    organizationId: string,
    eventIds: readonly string[],
  ): Promise<readonly OrganizationMember[]> {
    const members = await this.database
      .prepare(
        "SELECT m.user_id, u.name, e.email FROM organization_memberships m " +
          "JOIN users u ON u.id = m.user_id " +
          "LEFT JOIN identity_emails e ON e.user_id = m.user_id " +
          "WHERE m.organization_id = ? ORDER BY u.name, m.user_id",
      )
      .bind(organizationId)
      .all<MemberRow>();
    if (!members.success)
      throw new Error(`D1 failed to list members: ${members.error ?? "unknown error"}`);
    // The organization's events arrive as ids from the events domain rather than being joined
    // here: `events` is that domain's table (`table-ownership.json`), and identity reads none of
    // it. `json_each` keeps this one statement whatever the number of events.
    const roles =
      eventIds.length === 0
        ? { success: true as const, results: [] as RoleRow[], error: undefined }
        : await this.database
            .prepare(
              "SELECT user_id, event_id, role FROM event_roles " +
                "WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY event_id, role",
            )
            .bind(JSON.stringify([...eventIds]))
            .all<RoleRow>();
    if (!roles.success)
      throw new Error(`D1 failed to list event roles: ${roles.error ?? "unknown error"}`);
    return (members.results ?? []).map((member) => ({
      userId: member.user_id,
      name: member.name,
      email: member.email ?? null,
      eventRoles: (roles.results ?? [])
        .filter((role) => role.user_id === member.user_id)
        .map(({ event_id, role }) => ({ eventId: event_id, role })),
    }));
  }

  async listInvitations(organizationId: string): Promise<readonly Invitation[]> {
    const found = await this.database
      .prepare(
        "SELECT id, organization_id, event_id, email, role, invited_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at " +
          "FROM identity_invitations WHERE organization_id = ? ORDER BY created_at DESC, id",
      )
      .bind(organizationId)
      .all<InvitationRow>();
    if (!found.success)
      throw new Error(`D1 failed to list invitations: ${found.error ?? "unknown error"}`);
    // `token_hash` is deliberately absent from the projection. Nothing outside acceptance ever
    // needs it, and a listing that carried it would put every outstanding invitation's proof on
    // an organizer's screen.
    return (found.results ?? []).map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      eventId: row.event_id,
      email: row.email,
      role: row.role,
      invitedByUserId: row.invited_by_user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      acceptedByUserId: row.accepted_by_user_id,
      revokedAt: row.revoked_at,
    }));
  }

  async createInvitation(
    invitation: Invitation & { tokenHash: string },
    context: AuditContext,
  ): Promise<void> {
    const results = await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO identity_invitations (id, organization_id, event_id, email, role, token_hash, invited_by_user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          invitation.id,
          invitation.organizationId,
          invitation.eventId,
          invitation.email,
          invitation.role,
          invitation.tokenHash,
          invitation.invitedByUserId,
          invitation.createdAt,
          invitation.expiresAt,
        ),
      auditEventStatement(
        this.database,
        {
          action: "membership.invited",
          outcome: "succeeded",
          occurredAt: invitation.createdAt,
          organizationId: invitation.organizationId,
          ...(invitation.eventId ? { eventId: invitation.eventId } : {}),
          // The address, because that is what the organizer chose and what an audit reader needs
          // to recognise the invitation. Never the token or its digest.
          detail: { email: invitation.email, role: invitation.role },
        },
        context,
      ),
    ]);
    this.assertBatch(results, "create an invitation");
  }

  revokeInvitation(
    organizationId: string,
    invitationId: string,
    now: number,
    context: AuditContext,
  ): Promise<number> {
    return this.write(
      this.database
        .prepare(
          `UPDATE identity_invitations SET revoked_at = ? WHERE id = ? AND organization_id = ? AND ${LIVE_INVITATION}`,
        )
        .bind(now, invitationId, organizationId, now),
      {
        action: "membership.invitation_revoked",
        occurredAt: now,
        organizationId,
        detail: { invitationId },
      },
      context,
      "revoke an invitation",
    );
  }

  /**
   * Spend an invitation and grant what it offers, as one batch.
   *
   * Four statements, and the order is the design. The `UPDATE` is the gate: it matches only a
   * live invitation and stamps `accepted_by_user_id`, so exactly one of two racing callers wins
   * it. The two grants then `SELECT` from the row *that caller* just stamped — which is why they
   * name `accepted_by_user_id = ?` rather than re-deriving anything — and each is a no-op for the
   * offer it does not apply to. The audit row is guarded the same way.
   *
   * `INSERT OR IGNORE` on the grants: accepting an invitation to something you already have is
   * not an error, and the invitation is spent either way.
   */
  async acceptInvitation(input: {
    tokenHash: string;
    userId: string;
    now: number;
    context: AuditContext;
  }): Promise<AcceptedInvitation | null> {
    const { tokenHash, userId, now, context } = input;
    const spent = await this.database
      .prepare(
        `UPDATE identity_invitations SET accepted_at = ?, accepted_by_user_id = ? WHERE token_hash = ? AND ${LIVE_INVITATION} RETURNING id, organization_id, event_id, role`,
      )
      .bind(now, userId, tokenHash, now)
      .all<{ id: string; organization_id: string; event_id: string | null; role: InvitableRole }>();
    if (!spent.success)
      throw new Error(`D1 failed to accept an invitation: ${spent.error ?? "unknown error"}`);
    const row = spent.results?.[0];
    // Unknown, expired, revoked and already-spent are one answer, deliberately.
    if (!row) return null;

    const grant = row.event_id
      ? this.database
          .prepare("INSERT OR IGNORE INTO event_roles (event_id, user_id, role) VALUES (?,?,?)")
          .bind(row.event_id, userId, row.role)
      : this.database
          .prepare(
            "INSERT OR IGNORE INTO organization_memberships (organization_id, user_id, role) VALUES (?,?,'organizer')",
          )
          .bind(row.organization_id, userId);
    const results = await this.database.batch([
      grant,
      auditEventStatement(
        this.database,
        {
          action: "membership.accepted",
          outcome: "succeeded",
          occurredAt: now,
          organizationId: row.organization_id,
          subjectUserId: userId,
          ...(row.event_id ? { eventId: row.event_id } : {}),
          detail: { invitationId: row.id, role: row.role },
        },
        context,
      ),
    ]);
    this.assertBatch(results, "grant an accepted invitation");
    return { organizationId: row.organization_id, eventId: row.event_id, role: row.role };
  }

  /**
   * Remove somebody from the organization, and from every role on its events.
   *
   * Both, because leaving the event roles behind would be the more dangerous half: membership is
   * what grants cross-event reach, and an event role is what grants the event itself. Removing
   * only the first would take away the directory and leave the workspace.
   */
  async removeMember(
    organizationId: string,
    userId: string,
    eventIds: readonly string[],
    now: number,
    context: AuditContext,
  ): Promise<number> {
    const results = await this.database.batch([
      this.database
        .prepare("DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?")
        .bind(organizationId, userId),
      this.database
        .prepare(
          "DELETE FROM event_roles WHERE user_id = ? AND event_id IN (SELECT value FROM json_each(?))",
        )
        .bind(userId, JSON.stringify([...eventIds])),
      auditEventStatement(
        this.database,
        {
          action: "membership.removed",
          outcome: "succeeded",
          occurredAt: now,
          organizationId,
          subjectUserId: userId,
        },
        context,
      ),
    ]);
    this.assertBatch(results, "remove a member");
    const [membership] = results;
    if (!membership) throw new Error("D1 returned no result while removing a member");
    return changedRows(membership, "remove a member");
  }

  setEventRole(
    eventId: string,
    userId: string,
    role: InvitableRole,
    now: number,
    context: AuditContext,
  ): Promise<number> {
    return this.write(
      // `OR IGNORE` so re-granting a role somebody already holds is idempotent rather than a
      // constraint failure. It answers 0 rows, which is the honest "nothing changed".
      this.database
        .prepare("INSERT OR IGNORE INTO event_roles (event_id, user_id, role) VALUES (?,?,?)")
        .bind(eventId, userId, role),
      {
        action: "event_role.granted",
        occurredAt: now,
        subjectUserId: userId,
        eventId,
        detail: { role },
      },
      context,
      "grant an event role",
    );
  }

  revokeEventRole(
    eventId: string,
    userId: string,
    role: InvitableRole,
    now: number,
    context: AuditContext,
  ): Promise<number> {
    return this.write(
      this.database
        .prepare("DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = ?")
        .bind(eventId, userId, role),
      {
        action: "event_role.revoked",
        occurredAt: now,
        subjectUserId: userId,
        eventId,
        detail: { role },
      },
      context,
      "revoke an event role",
    );
  }

  /**
   * The organizer-visible log, scoped to one organization.
   *
   * Scoped by `organization_id` alone: a row that names no organization is a deployment-level
   * action — a session issue, a sign-out — and belongs to an operator reading the whole table,
   * not to one organization's screen. `before` paginates backwards through time.
   */
  async listAuditEvents(
    organizationId: string,
    limit: number,
    before: number | null,
  ): Promise<readonly AuditEventRow[]> {
    const found = await this.database
      .prepare(
        "SELECT id, occurred_at, action, outcome, source, actor_user_id, subject_user_id, event_id, correlation_id, detail " +
          "FROM identity_audit_events WHERE organization_id = ? AND (? IS NULL OR occurred_at < ?) " +
          "ORDER BY occurred_at DESC, id DESC LIMIT ?",
      )
      .bind(organizationId, before, before, limit)
      .all<{
        id: string;
        occurred_at: number;
        action: string;
        outcome: string;
        source: string;
        actor_user_id: string | null;
        subject_user_id: string | null;
        event_id: string | null;
        correlation_id: string;
        detail: string | null;
      }>();
    if (!found.success)
      throw new Error(`D1 failed to read the audit log: ${found.error ?? "unknown error"}`);
    return (found.results ?? []).map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      action: row.action,
      outcome: row.outcome,
      source: row.source,
      actorUserId: row.actor_user_id,
      subjectUserId: row.subject_user_id,
      eventId: row.event_id,
      correlationId: row.correlation_id,
      detail: row.detail,
    }));
  }

  async recordRefusal(
    entry: {
      action: AuditAction;
      organizationId: string;
      subjectUserId?: string;
      eventId?: string;
      detail?: Record<string, unknown>;
    },
    context: AuditContext,
  ): Promise<void> {
    const written = await auditEventStatement(
      this.database,
      {
        action: entry.action,
        outcome: "refused",
        occurredAt: Date.now(),
        organizationId: entry.organizationId,
        ...(entry.subjectUserId ? { subjectUserId: entry.subjectUserId } : {}),
        ...(entry.eventId ? { eventId: entry.eventId } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
      },
      context,
    ).run();
    if (!written.success)
      throw new Error(`D1 failed to record a refusal: ${written.error ?? "unknown error"}`);
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

  /** One conditional write, its guarded audit row, and the affected-row count as the answer. */
  private async write(
    statement: D1Statement,
    entry: Omit<AuditEntry, "outcome">,
    context: AuditContext,
    operation: string,
  ): Promise<number> {
    const results = await this.database.batch([
      statement,
      auditEventStatement(this.database, { ...entry, outcome: "succeeded" }, context, {
        onlyWhenChanged: true,
      }),
    ]);
    this.assertBatch(results, operation);
    const [changed] = results;
    if (!changed) throw new Error(`D1 returned no result while attempting to ${operation}`);
    return changedRows(changed, operation);
  }
}
