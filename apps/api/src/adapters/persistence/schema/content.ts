import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
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
      /** A closed set of platform keys the application validates (`1407`). */
      socialLinksJson: text("social_links_json").notNull().default("{}"),
      /**
       * How many portal invitations an organizer has deliberately asked for (`1408`).
       *
       * The occurrence a re-invitation is keyed on, allocated inside the UPDATE that claims it
       * so two organizers pressing Invite at once take two numbers rather than one. Not written
       * by `profileWrite`, and deliberately absent from `PROFILE_WRITTEN_COLUMNS`: an invitation
       * claim changes no column an attributed edit rewrites, so it must not make that edit's
       * compare-and-swap lose.
       */
      invitationsSent: integer("invitations_sent").notNull().default(0),
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
      taskId: text("task_id"),
      sessionId: text("session_id"),
      versionGroupId: text("version_group_id"),
      versionNumber: integer("version_number").notNull().default(1),
      isLatest: integer("is_latest", { mode: "boolean" }).notNull().default(true),
      /**
       * Which logical deliverable this upload is a version of (migration `1406`).
       *
       * The group id says which chain a row is in; this says how a *new* upload finds that
       * chain when the client names no group. Storing it is what makes the lookup atomic —
       * the insert allocates both the group and the number against this key in one statement,
       * so two uploads arriving together cannot both decide they are the first.
       */
      logicalKey: text("logical_key"),
    },
    (table) => [
      check("speaker_assets_visibility", sql`${table.visibility} IN ('private','publishable')`),
      index("speaker_assets_profile_idx").on(table.speakerProfileId),
      index("speaker_assets_logical_idx").on(
        table.eventId,
        table.speakerProfileId,
        table.logicalKey,
        table.versionNumber,
      ),
      uniqueIndex("speaker_assets_version_unique")
        .on(table.versionGroupId, table.versionNumber)
        .where(sql`${table.versionGroupId} IS NOT NULL`),
      uniqueIndex("speaker_assets_latest_unique")
        .on(table.versionGroupId)
        .where(sql`${table.versionGroupId} IS NOT NULL AND ${table.isLatest}=1`),
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
  // A checklist line belongs to the event, not to a speaker: `speaker_tasks.speaker_profile_id`
  // is NOT NULL, and a template with nobody attached could not live there. Migration `1405`.
  const speakerTaskTemplates = sqliteTable(
    "speaker_task_templates",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      title: text("title").notNull(),
      description: text("description").notNull(),
      sortOrder: integer("sort_order").notNull(),
      dueOffsetDays: integer("due_offset_days").notNull(),
      createdAt: text("created_at").notNull(),
    },
    (table) => [
      // The clone key. See the migration: ids are per event, so a checklist copied into a second
      // event converges on its titles or not at all.
      unique("speaker_task_templates_event_title_unique").on(table.eventId, table.title),
      index("speaker_task_templates_event_order_idx").on(table.eventId, table.sortOrder),
    ],
  );
  const contentAssetComments = sqliteTable(
    "content_asset_comments",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      assetId: text("asset_id")
        .notNull()
        .references(() => speakerAssets.id),
      authorId: text("author_id")
        .notNull()
        .references(() => references.usersId),
      authorName: text("author_name").notNull(),
      body: text("body").notNull(),
      createdAt: text("created_at").notNull(),
    },
    (table) => [index("content_asset_comments_asset_idx").on(table.assetId, table.createdAt)],
  );
  const contentRevisions = sqliteTable(
    "content_revisions",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      entityType: text("entity_type").notNull(),
      entityId: text("entity_id").notNull(),
      revisionNumber: integer("revision_number").notNull(),
      snapshotJson: text("snapshot_json").notNull(),
      actorId: text("actor_id")
        .notNull()
        .references(() => references.usersId),
      createdAt: text("created_at").notNull(),
      restoredFromRevisionId: text("restored_from_revision_id"),
    },
    (table) => [
      check("content_revisions_entity_type", sql`${table.entityType} IN ('profile','session')`),
      unique("content_revisions_entity_revision_unique").on(
        table.entityType,
        table.entityId,
        table.revisionNumber,
      ),
      index("content_revisions_entity_idx").on(
        table.entityType,
        table.entityId,
        table.revisionNumber,
      ),
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
  const contentSpeakerImportRows = sqliteTable(
    "content_speaker_import_rows",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      normalizedEmail: text("normalized_email").notNull(),
      status: text("status").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.normalizedEmail] }),
      check("content_speaker_import_rows_status", sql`${table.status} IN ('pending','complete')`),
    ],
  );

  return {
    contentSessions,
    speakerProfiles,
    speakerTasks,
    speakerAssets,
    speakerMessages,
    speakerResources,
    speakerTaskTemplates,
    contentAssetComments,
    contentRevisions,
    speakerConversionSources,
    speakerConversionClaims,
    speakerEmailClaims,
    contentSpeakerImportRows,
  };
}
