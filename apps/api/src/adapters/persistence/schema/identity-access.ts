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

  return { users, identityEmails, identityLoginChallenges, organizationMemberships, eventRoles };
}
