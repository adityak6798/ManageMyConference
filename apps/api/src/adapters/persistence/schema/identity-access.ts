import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineIdentityAccessSchema(references: {
  eventsId: AnySQLiteColumn;
  organizationsId: AnySQLiteColumn;
}) {
  // @spec PRD-IAM-001
  const users = sqliteTable(
    "users",
    {
      id: text("id").primaryKey().notNull(),
      name: text("name").notNull(),
      persona: text("persona").notNull(),
    },
    (table) => [
      check(
        "users_persona",
        sql`${table.persona} IN ('organizer', 'reviewer', 'speaker', 'public')`,
      ),
    ],
  );

  const organizationMemberships = sqliteTable(
    "organization_memberships",
    {
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId),
      userId: text("user_id")
        .notNull()
        .references(() => users.id),
      role: text("role").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.organizationId, table.userId] }),
      check("organization_memberships_role", sql`${table.role} = 'organizer'`),
    ],
  );

  const identityEmails = sqliteTable(
    "identity_emails",
    {
      userId: text("user_id")
        .primaryKey()
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      email: text("email").notNull().unique(),
    },
    (table) => [check("identity_emails_lowercase", sql`${table.email} = lower(${table.email})`)],
  );
  const identityLoginChallenges = sqliteTable(
    "identity_login_challenges",
    {
      id: text("id").primaryKey().notNull(),
      email: text("email").notNull(),
      codeProof: text("code_proof").notNull(),
      expiresAt: integer("expires_at").notNull(),
      attempts: integer("attempts").notNull().default(0),
      consumedAt: integer("consumed_at"),
    },
    (table) => [
      check("identity_login_challenges_attempts", sql`${table.attempts} BETWEEN 0 AND 5`),
      index("identity_login_challenges_expiry_idx").on(table.expiresAt),
    ],
  );

  /**
   * One in-flight authorization-code attempt: its CSRF `state` proof, its PKCE verifier and its
   * nonce. Deleted on the callback, so a row's existence is the attempt's remaining single use.
   */
  const identityOauthAttempts = sqliteTable(
    "identity_oauth_attempts",
    {
      id: text("id").primaryKey().notNull(),
      stateProof: text("state_proof").notNull(),
      codeVerifier: text("code_verifier").notNull(),
      nonce: text("nonce").notNull(),
      expiresAt: integer("expires_at").notNull(),
    },
    (table) => [index("identity_oauth_attempts_expiry_idx").on(table.expiresAt)],
  );

  /**
   * The link between an external provider identity and a Greenroom user. Keyed on the provider's
   * stable subject rather than on an address, because an address can change and a workspace
   * must not.
   */
  const identityProviderAccounts = sqliteTable(
    "identity_provider_accounts",
    {
      provider: text("provider").notNull(),
      subject: text("subject").notNull(),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      linkedAt: integer("linked_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.provider, table.subject] }),
      check("identity_provider_accounts_provider", sql`${table.provider} = 'google'`),
      index("identity_provider_accounts_user_idx").on(table.userId),
    ],
  );

  /**
   * One issued session. The row is what makes sign-out revocation rather than cookie clearing:
   * the cookie carries this row's id, and a missing, revoked or expired row refuses it.
   *
   * `userId` scopes revocation and nothing else. It is never a second way to resolve an actor —
   * see `docs/architecture/authorization.md`.
   */
  const identitySessions = sqliteTable(
    "identity_sessions",
    {
      id: text("id").primaryKey().notNull(),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      issuedAt: integer("issued_at").notNull(),
      expiresAt: integer("expires_at").notNull(),
      revokedAt: integer("revoked_at"),
    },
    (table) => [
      index("identity_sessions_user_idx").on(table.userId),
      index("identity_sessions_expiry_idx").on(table.expiresAt),
    ],
  );

  /**
   * The append-only identity audit spine. No foreign keys, deliberately: a row has to outlive
   * the user it describes, which a cascade would delete and a plain reference would refuse.
   */
  const identityAuditEvents = sqliteTable(
    "identity_audit_events",
    {
      id: text("id").primaryKey().notNull(),
      occurredAt: integer("occurred_at").notNull(),
      action: text("action").notNull(),
      outcome: text("outcome").notNull(),
      source: text("source").notNull(),
      actorUserId: text("actor_user_id"),
      subjectUserId: text("subject_user_id"),
      organizationId: text("organization_id"),
      eventId: text("event_id"),
      correlationId: text("correlation_id").notNull(),
      detail: text("detail"),
    },
    (table) => [
      check(
        "identity_audit_events_action",
        sql`${table.action} IN ('session.issued', 'session.signed_out', 'session.revoked_all', 'membership.invited', 'membership.invitation_revoked', 'membership.accepted', 'membership.removed', 'membership.role_changed', 'event_role.granted', 'event_role.revoked')`,
      ),
      check("identity_audit_events_outcome", sql`${table.outcome} IN ('succeeded', 'refused')`),
      check("identity_audit_events_source", sql`${table.source} IN ('human', 'api', 'system')`),
      index("identity_audit_events_org_idx").on(table.organizationId, table.occurredAt),
      index("identity_audit_events_actor_idx").on(table.actorUserId, table.occurredAt),
    ],
  );

  /**
   * One outstanding invitation. Accepted by the accepting session's own identity — `email`
   * addresses the invitation and authorizes nothing. See `1003_identity_invitations.sql`.
   */
  const identityInvitations = sqliteTable(
    "identity_invitations",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId, { onDelete: "cascade" }),
      eventId: text("event_id").references(() => references.eventsId, { onDelete: "cascade" }),
      email: text("email").notNull(),
      role: text("role").notNull(),
      tokenHash: text("token_hash").notNull().unique(),
      invitedByUserId: text("invited_by_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      createdAt: integer("created_at").notNull(),
      expiresAt: integer("expires_at").notNull(),
      acceptedAt: integer("accepted_at"),
      acceptedByUserId: text("accepted_by_user_id").references(() => users.id, {
        onDelete: "set null",
      }),
      revokedAt: integer("revoked_at"),
    },
    (table) => [
      check(
        "identity_invitations_role",
        sql`${table.role} IN ('organizer', 'reviewer', 'speaker')`,
      ),
      check(
        "identity_invitations_scope",
        sql`${table.eventId} IS NOT NULL OR ${table.role} = 'organizer'`,
      ),
      index("identity_invitations_org_idx").on(table.organizationId, table.createdAt),
      index("identity_invitations_email_idx").on(table.email),
    ],
  );

  const eventRoles = sqliteTable(
    "event_roles",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      userId: text("user_id")
        .notNull()
        .references(() => users.id),
      role: text("role").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.userId, table.role] }),
      check(
        "event_roles_role",
        sql`${table.role} IN ('organizer', 'reviewer', 'speaker', 'public')`,
      ),
      index("event_roles_user_id_idx").on(table.userId),
    ],
  );

  return {
    users,
    identityEmails,
    identityLoginChallenges,
    identityOauthAttempts,
    identityProviderAccounts,
    identitySessions,
    identityAuditEvents,
    identityInvitations,
    organizationMemberships,
    eventRoles,
  };
}
