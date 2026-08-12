import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function defineContentSchema(references: {
  eventsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
  const contentSessions = sqliteTable(
    "content_sessions",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      proposalId: text("proposal_id").notNull(),
      title: text("title").notNull(),
      abstract: text("abstract").notNull(),
      format: text("format").notNull(),
      speakerProfileIds: text("speaker_profile_ids").notNull(),
      tags: text("tags").notNull(),
      tracks: text("tracks").notNull(),
      // No schedule columns: a session's time is its agenda placement, resolved through the
      // agenda's public application interface on every read (migration 0022).
      publicationState: text("publication_state").notNull(),
    },
    (table) => [
      // Idempotency guard for ContentService.accept under concurrency.
      unique("content_sessions_event_id_proposal_id_unique").on(table.eventId, table.proposalId),
      check(
        "content_sessions_publication_state",
        sql`${table.publicationState} IN ('draft','ready','published')`,
      ),
      index("content_sessions_event_id_idx").on(table.eventId),
    ],
  );
  const speakerProfiles = sqliteTable(
    "speaker_profiles",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      userId: text("user_id")
        .notNull()
        .references(() => references.usersId),
      sourcePersonId: text("source_person_id").notNull(),
      name: text("name").notNull(),
      email: text("email").notNull(),
      bio: text("bio").notNull(),
      pronouns: text("pronouns").notNull(),
      organization: text("organization").notNull(),
      photoAssetId: text("photo_asset_id"),
      workflowStatus: text("workflow_status").notNull().default("onboarding"),
      logisticsJson: text("logistics_json").notNull().default("{}"),
      customFieldsJson: text("custom_fields_json").notNull().default("{}"),
    },
    (table) => [
      unique("speaker_profiles_event_id_source_person_id_unique").on(
        table.eventId,
        table.sourcePersonId,
      ),
      index("speaker_profiles_event_user_idx").on(table.eventId, table.userId),
      check(
        "speaker_profiles_workflow_status",
        sql`${table.workflowStatus} IN ('invited','onboarding','ready','blocked')`,
      ),
    ],
  );
  const speakerTasks = sqliteTable(
    "speaker_tasks",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      speakerProfileId: text("speaker_profile_id")
        .notNull()
        .references(() => speakerProfiles.id),
      title: text("title").notNull(),
      dueAt: text("due_at").notNull(),
      status: text("status").notNull(),
      completedAt: text("completed_at"),
      taskType: text("task_type").notNull().default("general"),
      instructions: text("instructions").notNull().default(""),
      sessionId: text("session_id"),
    },
    (table) => [
      check("speaker_tasks_status", sql`${table.status} IN ('open','complete')`),
      check("speaker_tasks_task_type", sql`${table.taskType} IN ('general','file-request')`),
      index("speaker_tasks_profile_idx").on(table.speakerProfileId),
    ],
  );
  const speakerAssets = sqliteTable(
    "speaker_assets",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      speakerProfileId: text("speaker_profile_id")
        .notNull()
        .references(() => speakerProfiles.id),
      name: text("name").notNull(),
      contentType: text("content_type").notNull(),
      storageKey: text("storage_key").notNull().unique(),
      visibility: text("visibility").notNull(),
      uploadedAt: text("uploaded_at").notNull(),
    },
    (table) => [
      check("speaker_assets_visibility", sql`${table.visibility} IN ('private','publishable')`),
      index("speaker_assets_profile_idx").on(table.speakerProfileId),
    ],
  );
  const speakerMessages = sqliteTable(
    "speaker_messages",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      speakerProfileId: text("speaker_profile_id")
        .notNull()
        .references(() => speakerProfiles.id),
      subject: text("subject").notNull(),
      sentAt: text("sent_at").notNull(),
    },
    (table) => [index("speaker_messages_profile_idx").on(table.speakerProfileId)],
  );
  const speakerResources = sqliteTable(
    "speaker_resources",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      title: text("title").notNull(),
      slug: text("slug").notNull(),
      bodyHtml: text("body_html").notNull(),
      embedHtml: text("embed_html").notNull(),
      visibility: text("visibility").notNull(),
      sortOrder: integer("sort_order").notNull(),
    },
    (table) => [
      unique("speaker_resources_event_slug_unique").on(table.eventId, table.slug),
      check("speaker_resources_visibility", sql`${table.visibility} IN ('hidden','visible')`),
      index("speaker_resources_event_order_idx").on(table.eventId, table.sortOrder),
    ],
  );
  const speakerConversionSources = sqliteTable(
    "speaker_conversion_sources",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sourceKind: text("source_kind").notNull(),
      sourceId: text("source_id").notNull(),
      speakerId: text("speaker_id")
        .notNull()
        .references(() => speakerProfiles.id),
    },
    (table) => [primaryKey({ columns: [table.eventId, table.sourceKind, table.sourceId] })],
  );
  const speakerConversionClaims = sqliteTable(
    "speaker_conversion_claims",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sourceKind: text("source_kind").notNull(),
      sourceId: text("source_id").notNull(),
      normalizedEmail: text("normalized_email").notNull(),
      speakerId: text("speaker_id").notNull(),
      userId: text("user_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.eventId, table.sourceKind, table.sourceId] })],
  );
  const speakerEmailClaims = sqliteTable(
    "speaker_email_claims",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      normalizedEmail: text("normalized_email").notNull(),
      speakerId: text("speaker_id").notNull(),
      userId: text("user_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.eventId, table.normalizedEmail] })],
  );

  return {
    contentSessions,
    speakerProfiles,
    speakerTasks,
    speakerAssets,
    speakerMessages,
    speakerResources,
    speakerConversionSources,
    speakerConversionClaims,
    speakerEmailClaims,
  };
}
