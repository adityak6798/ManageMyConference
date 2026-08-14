import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
  uniqueIndex,
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
        sql`${table.action} IN ('session.issued', 'session.signed_out', 'session.revoked_all', 'membership.invited', 'membership.invitation_revoked', 'membership.accepted', 'membership.removed', 'membership.role_changed', 'event_role.granted', 'event_role.revoked', 'api_client.created', 'api_client.rotated', 'api_client.revoked', 'custom_role.created', 'custom_role.updated', 'custom_role.deleted')`,
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

  /**
   * A role an organization admin composed, and the per-field access it carries (issue #196).
   *
   * Event-scoped, because that is where every other grant in this product lives: a role spanning
   * events would be a second authorization model beside `requireEventCapability`.
   */
  // @spec PRD-IAM-002
  const eventCustomRoles = sqliteTable(
    "event_custom_roles",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId, { onDelete: "cascade" }),
      name: text("name").notNull(),
      description: text("description").notNull().default(""),
      template: text("template").notNull(),
      createdBy: text("created_by")
        .notNull()
        .references(() => users.id),
      createdAt: integer("created_at").notNull(),
      updatedAt: integer("updated_at").notNull(),
      revision: integer("revision").notNull().default(1),
    },
    (table) => [
      check(
        "event_custom_roles_template",
        sql`${table.template} IN ('av', 'programme-assistant', 'sponsor-liaison')`,
      ),
      check("event_custom_roles_name_length", sql`length(${table.name}) BETWEEN 1 AND 80`),
      check("event_custom_roles_description_length", sql`length(${table.description}) <= 400`),
      check("event_custom_roles_revision", sql`${table.revision} >= 1`),
      uniqueIndex("event_custom_roles_event_name_idx").on(table.eventId, sql`lower(${table.name})`),
      index("event_custom_roles_organization_idx").on(table.organizationId, table.eventId),
    ],
  );

  /** `identity:manage` is deliberately absent — see `1005_custom_event_roles.sql`. */
  const eventCustomRoleCapabilities = sqliteTable(
    "event_custom_role_capabilities",
    {
      roleId: text("role_id")
        .notNull()
        .references(() => eventCustomRoles.id, { onDelete: "cascade" }),
      capability: text("capability").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.roleId, table.capability] }),
      check(
        "event_custom_role_capabilities_capability",
        sql`${table.capability} IN ('events:read', 'events:settings:read', 'communications:manage', 'agenda:manage', 'crm:manage', 'content:read', 'content:manage', 'review:manage', 'review:evaluate', 'reports:pii')`,
      ),
    ],
  );

  /** `field = '*'` is the subject-wide default. `GOVERNED_FIELDS` is the same allowlist. */
  const eventCustomRoleFieldPolicies = sqliteTable(
    "event_custom_role_field_policies",
    {
      roleId: text("role_id")
        .notNull()
        .references(() => eventCustomRoles.id, { onDelete: "cascade" }),
      subject: text("subject").notNull(),
      field: text("field").notNull(),
      policy: text("policy").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.roleId, table.subject, table.field] }),
      check(
        "event_custom_role_field_policies_subject",
        sql`${table.subject} IN ('session', 'speaker', 'contact')`,
      ),
      check(
        "event_custom_role_field_policies_policy",
        sql`${table.policy} IN ('view', 'lock', 'hide')`,
      ),
      check(
        "event_custom_role_field_policies_field",
        sql`(${table.subject} = 'session' AND ${table.field} IN ('*', 'title', 'abstract', 'format', 'tags', 'tracks', 'publicationState')) OR (${table.subject} = 'speaker' AND ${table.field} IN ('*', 'name', 'email', 'bio', 'pronouns', 'organization', 'photoAssetId', 'workflowStatus', 'logistics', 'customFields')) OR (${table.subject} = 'contact' AND ${table.field} IN ('*', 'name', 'email', 'company', 'title', 'notes', 'tags', 'fields', 'activities'))`,
      ),
      check(
        "event_custom_role_field_policies_required",
        sql`NOT (${table.policy} = 'hide' AND ((${table.subject} = 'session' AND ${table.field} = 'title') OR (${table.subject} = 'speaker' AND ${table.field} = 'name') OR (${table.subject} = 'contact' AND ${table.field} = 'name')))`,
      ),
    ],
  );

  /**
   * What an organizer has closed on this event's own portal (issue #196; the primitive `GAP-028`
   * needs).
   *
   * Not the custom-role policy table, and the difference is the whole point: that one answers
   * "what may this staffed role see", this one answers "what may the person whose record it is
   * change". A speaker editing their own profile holds no custom role, and freezing the biography
   * after the programme is printed is a property of the event. Same vocabulary, so
   * `fieldAccessFor` composes both without a second rule. See `1007_event_field_locks.sql`.
   */
  // @spec PRD-IAM-002
  const eventFieldLocks = sqliteTable(
    "event_field_locks",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      subject: text("subject").notNull(),
      field: text("field").notNull(),
      policy: text("policy").notNull(),
      updatedBy: text("updated_by")
        .notNull()
        .references(() => users.id),
      updatedAt: integer("updated_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.subject, table.field] }),
      check(
        "event_field_locks_subject",
        sql`${table.subject} IN ('session', 'speaker', 'contact')`,
      ),
      check("event_field_locks_policy", sql`${table.policy} IN ('view', 'lock', 'hide')`),
      check(
        "event_field_locks_field",
        sql`(${table.subject} = 'session' AND ${table.field} IN ('*', 'title', 'abstract', 'format', 'tags', 'tracks', 'publicationState')) OR (${table.subject} = 'speaker' AND ${table.field} IN ('*', 'name', 'email', 'bio', 'pronouns', 'organization', 'photoAssetId', 'workflowStatus', 'logistics', 'customFields')) OR (${table.subject} = 'contact' AND ${table.field} IN ('*', 'name', 'email', 'company', 'title', 'notes', 'tags', 'fields', 'activities'))`,
      ),
      check(
        "event_field_locks_required",
        sql`NOT (${table.policy} = 'hide' AND ((${table.subject} = 'session' AND ${table.field} = 'title') OR (${table.subject} = 'speaker' AND ${table.field} = 'name') OR (${table.subject} = 'contact' AND ${table.field} = 'name')))`,
      ),
      index("event_field_locks_event_idx").on(table.eventId, table.subject),
    ],
  );

  /**
   * The primary key states a product rule: **a person holds at most one custom role on an
   * event.** Two would make the field decision a negotiation between two policy sets, and every
   * rule for resolving that disagreement is one somebody must be told before they can predict
   * what an exported row contains.
   */
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
      customRoleId: text("custom_role_id").references(() => eventCustomRoles.id, {
        onDelete: "cascade",
      }),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.userId, table.role] }),
      check(
        "event_roles_role",
        sql`${table.role} IN ('organizer', 'reviewer', 'speaker', 'public', 'custom')`,
      ),
      check(
        "event_roles_custom_role",
        sql`(${table.role} = 'custom') = (${table.customRoleId} IS NOT NULL)`,
      ),
      index("event_roles_user_id_idx").on(table.userId),
      index("event_roles_custom_role_idx").on(table.customRoleId),
    ],
  );

  const apiClients = sqliteTable(
    "api_clients",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId, { onDelete: "cascade" }),
      name: text("name").notNull(),
      keyPrefix: text("key_prefix").notNull().unique(),
      secretHash: text("secret_hash").notNull(),
      previousSecretHash: text("previous_secret_hash"),
      previousSecretExpiresAt: integer("previous_secret_expires_at"),
      createdBy: text("created_by")
        .notNull()
        .references(() => users.id),
      createdAt: integer("created_at").notNull(),
      expiresAt: integer("expires_at"),
      revokedAt: integer("revoked_at"),
    },
    (table) => [
      check(
        "api_clients_previous_secret_pair",
        sql`(${table.previousSecretHash} IS NULL) = (${table.previousSecretExpiresAt} IS NULL)`,
      ),
      index("api_clients_key_prefix_idx").on(table.keyPrefix),
      index("api_clients_organization_idx").on(table.organizationId, table.createdAt, table.id),
    ],
  );

  const apiClientScopes = sqliteTable(
    "api_client_scopes",
    {
      clientId: text("client_id")
        .notNull()
        .references(() => apiClients.id, { onDelete: "cascade" }),
      capability: text("capability").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.clientId, table.capability] }),
      check(
        "api_client_scopes_capability",
        sql`${table.capability} IN ('events:read', 'events:create', 'events:settings:read', 'events:settings:update', 'communications:manage', 'agenda:manage', 'crm:manage', 'content:read', 'content:manage', 'review:manage', 'review:evaluate', 'identity:manage', 'reports:pii')`,
      ),
    ],
  );

  const apiClientEvents = sqliteTable(
    "api_client_events",
    {
      clientId: text("client_id")
        .notNull()
        .references(() => apiClients.id, { onDelete: "cascade" }),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
    },
    (table) => [
      primaryKey({ columns: [table.clientId, table.eventId] }),
      index("api_client_events_event_idx").on(table.eventId, table.clientId),
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
    eventCustomRoles,
    eventCustomRoleCapabilities,
    eventCustomRoleFieldPolicies,
    eventFieldLocks,
    eventRoles,
    apiClients,
    apiClientScopes,
    apiClientEvents,
  };
}
