import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export function definePublishingSchema(references: {
  eventsId: AnySQLiteColumn;
  organizationsId: AnySQLiteColumn;
  usersId: AnySQLiteColumn;
}) {
  // @spec PRD-PUB-001
  const publicEventProjections = sqliteTable(
    "public_event_projections",
    {
      eventId: text("event_id")
        .primaryKey()
        .notNull()
        .references(() => references.eventsId),
      slug: text("slug").notNull().unique(),
      state: text("state").notNull(),
      draftJson: text("draft_json").notNull(),
      publishedJson: text("published_json"),
      publishedAt: text("published_at"),
      projectionVersion: integer("projection_version").notNull().default(0),
      agendaVersion: integer("agenda_version"),
      agendaPublishedAt: text("agenda_published_at"),
      cfpVersion: integer("cfp_version"),
      cfpPublishedAt: text("cfp_published_at"),
      contentDigest: text("content_digest"),
      activationCause: text("activation_cause"),
    },
    (table) => [
      check("public_event_projections_slug_length", sql`length(${table.slug}) BETWEEN 1 AND 120`),
      check(
        "public_event_projections_state",
        sql`${table.state} IN ('draft', 'published', 'unpublished')`,
      ),
      check("public_event_projections_draft_json", sql`json_valid(${table.draftJson})`),
      check(
        "public_event_projections_published_json",
        sql`${table.publishedJson} IS NULL OR json_valid(${table.publishedJson})`,
      ),
      check("public_event_projections_version", sql`${table.projectionVersion} >= 0`),
      check(
        "public_event_projections_activation_cause",
        sql`${table.activationCause} IS NULL OR ${table.activationCause} IN ('site-published', 'schedule-published', 'source-reconciled')`,
      ),
      index("public_event_projections_slug_state_idx").on(table.slug, table.state),
      uniqueIndex("public_event_projections_draft_slug_idx").on(
        sql`json_extract(${table.draftJson}, '$.event.slug')`,
      ),
    ],
  );

  // @spec PRD-PUB-001
  const publicEventProjectionVersions = sqliteTable(
    "public_event_projection_versions",
    {
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      version: integer("version").notNull(),
      activatedAt: text("activated_at").notNull(),
      projectionJson: text("projection_json").notNull(),
      agendaVersion: integer("agenda_version"),
      agendaPublishedAt: text("agenda_published_at"),
      cfpVersion: integer("cfp_version"),
      cfpPublishedAt: text("cfp_published_at"),
      contentDigest: text("content_digest"),
      activationCause: text("activation_cause").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.eventId, table.version] }),
      check("public_event_projection_versions_version", sql`${table.version} > 0`),
      check("public_event_projection_versions_json", sql`json_valid(${table.projectionJson})`),
      check(
        "public_event_projection_versions_activation_cause",
        sql`${table.activationCause} IN ('site-published', 'schedule-published', 'source-reconciled')`,
      ),
      index("public_event_projection_versions_activated_idx").on(table.eventId, table.activatedAt),
    ],
  );

  /*
   * An attendee's chosen sessions, addressed by a capability token rather than by a user.
   *
   * `/api/public/*` reads no session and cannot: its `Access-Control-Allow-Origin: *`
   * policy forbids credentials, which is exactly what lets a conference's own site embed
   * the schedule. The token is the identity, only its hash is stored, and the row names
   * sessions by the published projection's public slugs so nothing here can reach past
   * what the organizer published.
   */
  // @spec PRD-PUB-001
  const attendeeItineraries = sqliteTable(
    "attendee_itineraries",
    {
      tokenHash: text("token_hash").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId),
      sessionSlugs: text("session_slugs").notNull(),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      check("attendee_itineraries_token_hash", sql`length(${table.tokenHash}) = 64`),
      check("attendee_itineraries_session_slugs", sql`json_valid(${table.sessionSlugs})`),
      index("attendee_itineraries_event_id_idx").on(table.eventId),
      index("attendee_itineraries_empty_updated_at_idx")
        .on(table.updatedAt)
        .where(sql`${table.sessionSlugs} = '[]'`),
    ],
  );

  /*
   * ---- Sites and portals (issue #196) -------------------------------------
   *
   * A Site is not a second public-event projection and shares none of its machinery: it composes
   * *pointers* to programs other domains own, resolved at read time through their public
   * application interfaces. See `1804_sites.sql` for why nothing here copies another domain's
   * data, and why there is no delete.
   */
  // @spec PRD-PUB-002
  const sites = sqliteTable(
    "sites",
    {
      id: text("id").primaryKey().notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => references.organizationsId, { onDelete: "cascade" }),
      slug: text("slug").notNull().unique(),
      name: text("name").notNull(),
      tagline: text("tagline").notNull().default(""),
      landingHeading: text("landing_heading").notNull().default(""),
      landingBody: text("landing_body").notNull().default(""),
      loginHeading: text("login_heading").notNull().default(""),
      loginBody: text("login_body").notNull().default(""),
      theme: text("theme").notNull().default("light"),
      primaryColor: text("primary_color").notNull().default("#2f5d50"),
      state: text("state").notNull().default("draft"),
      publishedAt: text("published_at"),
      revision: integer("revision").notNull().default(1),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
    },
    (table) => [
      check("sites_theme", sql`${table.theme} IN ('light', 'dark', 'auto')`),
      check("sites_state", sql`${table.state} IN ('draft', 'published', 'unpublished')`),
      check("sites_slug_length", sql`length(${table.slug}) BETWEEN 1 AND 120`),
      check("sites_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      // Not six positional GLOB classes: SQLite refuses that pattern as "too complex", so the
      // obvious spelling would fail every insert rather than only the malformed ones.
      check(
        "sites_primary_color",
        sql`length(${table.primaryColor}) = 7 AND substr(${table.primaryColor}, 1, 1) = '#' AND lower(${table.primaryColor}) NOT GLOB '*[^#0-9a-f]*'`,
      ),
      check("sites_revision", sql`${table.revision} >= 1`),
      check(
        "sites_published_at",
        sql`${table.state} <> 'published' OR ${table.publishedAt} IS NOT NULL`,
      ),
      index("sites_organization_idx").on(table.organizationId, table.name),
      index("sites_state_idx").on(table.state, table.slug),
    ],
  );

  /** `program_ref` names another domain's row and carries no foreign key, deliberately. */
  const sitePrograms = sqliteTable(
    "site_programs",
    {
      siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
      programKind: text("program_kind").notNull(),
      programRef: text("program_ref").notNull(),
      label: text("label").notNull().default(""),
      position: integer("position").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.siteId, table.programKind, table.programRef] }),
      check(
        "site_programs_kind",
        sql`${table.programKind} IN ('event-cfp', 'interest-form', 'speaker-portal')`,
      ),
      check("site_programs_position", sql`${table.position} >= 0`),
      check("site_programs_label_length", sql`length(${table.label}) <= 120`),
      index("site_programs_order_idx").on(table.siteId, table.position),
    ],
  );

  const sitePages = sqliteTable(
    "site_pages",
    {
      id: text("id").primaryKey().notNull(),
      siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
      slug: text("slug").notNull(),
      title: text("title").notNull(),
      bodyHtml: text("body_html").notNull(),
      position: integer("position").notNull(),
      visibility: text("visibility").notNull().default("visible"),
    },
    (table) => [
      check("site_pages_slug_length", sql`length(${table.slug}) BETWEEN 1 AND 120`),
      check("site_pages_title_length", sql`length(${table.title}) BETWEEN 1 AND 160`),
      check("site_pages_body_length", sql`length(${table.bodyHtml}) <= 40000`),
      check("site_pages_position", sql`${table.position} >= 0`),
      check("site_pages_visibility", sql`${table.visibility} IN ('visible', 'hidden')`),
      uniqueIndex("site_pages_slug_idx").on(table.siteId, table.slug),
      index("site_pages_order_idx").on(table.siteId, table.position),
    ],
  );

  /** Append-only by version: a consent naming a version whose text can move records nothing. */
  const sitePrivacyNotices = sqliteTable(
    "site_privacy_notices",
    {
      siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
      version: integer("version").notNull(),
      bodyHtml: text("body_html").notNull(),
      effectiveAt: text("effective_at").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.siteId, table.version] }),
      check("site_privacy_notices_version", sql`${table.version} >= 1`),
      check("site_privacy_notices_body_length", sql`length(${table.bodyHtml}) BETWEEN 1 AND 40000`),
    ],
  );

  const siteRegistrationFields = sqliteTable(
    "site_registration_fields",
    {
      siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
      fieldKey: text("field_key").notNull(),
      label: text("label").notNull(),
      kind: text("kind").notNull(),
      required: integer("required").notNull().default(0),
      options: text("options").notNull().default("[]"),
      position: integer("position").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.siteId, table.fieldKey] }),
      check(
        "site_registration_fields_kind",
        sql`${table.kind} IN ('text', 'longtext', 'select', 'checkbox')`,
      ),
      check("site_registration_fields_required", sql`${table.required} IN (0, 1)`),
      check("site_registration_fields_key_length", sql`length(${table.fieldKey}) BETWEEN 1 AND 60`),
      check("site_registration_fields_label_length", sql`length(${table.label}) BETWEEN 1 AND 120`),
      check("site_registration_fields_options", sql`json_valid(${table.options})`),
      check("site_registration_fields_position", sql`${table.position} >= 0`),
      index("site_registration_fields_order_idx").on(table.siteId, table.position),
    ],
  );

  /** Exactly what somebody accepted: the version, the actor and the instant, none of them derived. */
  const siteConsents = sqliteTable(
    "site_consents",
    {
      id: text("id").primaryKey().notNull(),
      siteId: text("site_id")
        .notNull()
        .references(() => sites.id, { onDelete: "cascade" }),
      noticeVersion: integer("notice_version").notNull(),
      actorRef: text("actor_ref").notNull(),
      acceptedAt: text("accepted_at").notNull(),
      answersJson: text("answers_json").notNull().default("{}"),
    },
    (table) => [
      // Composite: a consent names one Site's notice version, and cannot name another Site's.
      foreignKey({
        columns: [table.siteId, table.noticeVersion],
        foreignColumns: [sitePrivacyNotices.siteId, sitePrivacyNotices.version],
      }),
      check("site_consents_answers_json", sql`json_valid(${table.answersJson})`),
      index("site_consents_site_idx").on(table.siteId, table.acceptedAt),
      uniqueIndex("site_consents_actor_idx").on(table.siteId, table.actorRef),
    ],
  );

  /** No foreign key: a publish record outlives what it describes, as an audit record does. */
  const sitePublications = sqliteTable(
    "site_publications",
    {
      siteId: text("site_id").notNull(),
      version: integer("version").notNull(),
      publishedAt: text("published_at").notNull(),
      snapshotJson: text("snapshot_json").notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.siteId, table.version] }),
      check("site_publications_version", sql`${table.version} >= 1`),
      check("site_publications_snapshot_json", sql`json_valid(${table.snapshotJson})`),
      index("site_publications_time_idx").on(table.siteId, table.publishedAt),
    ],
  );

  /**
   * A named, revocable embed (issue #192's residual lifecycle epic).
   *
   * Deliberately not a `capability_link`: those are one-off shares that expire and count views,
   * and an embed is a *standing* publication with neither. Sharing the table would have meant
   * giving every embed an expiry nobody wants, or every share link an immortality nobody should
   * have. `output` and `token_hash` are immutable — two triggers in `1805_publication_embeds.sql`
   * refuse to move either, because a host page parsing JSON does not survive being handed HTML.
   */
  // @spec PRD-PUB-001
  const publicationEmbeds = sqliteTable(
    "publication_embeds",
    {
      id: text("id").primaryKey().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => references.eventsId, { onDelete: "cascade" }),
      name: text("name").notNull(),
      view: text("view").notNull(),
      output: text("output").notNull(),
      accent: text("accent").notNull().default("#2f5d50"),
      theme: text("theme").notNull().default("light"),
      filtersJson: text("filters_json").notNull().default("{}"),
      fieldsJson: text("fields_json").notNull().default("[]"),
      tokenHash: text("token_hash").notNull().unique(),
      createdBy: text("created_by")
        .notNull()
        .references(() => references.usersId),
      createdAt: text("created_at").notNull(),
      updatedAt: text("updated_at").notNull(),
      revision: integer("revision").notNull().default(1),
      revokedAt: text("revoked_at"),
    },
    (table) => [
      check(
        "publication_embeds_view",
        sql`${table.view} IN ('schedule', 'speakers', 'gallery', 'itinerary')`,
      ),
      check(
        "publication_embeds_output",
        sql`${table.output} IN ('styled-html', 'basic-html', 'json', 'xml', 'ical')`,
      ),
      check("publication_embeds_theme", sql`${table.theme} IN ('light', 'dark', 'auto')`),
      check("publication_embeds_filters_json", sql`json_valid(${table.filtersJson})`),
      check("publication_embeds_fields_json", sql`json_valid(${table.fieldsJson})`),
      check("publication_embeds_token_hash", sql`length(${table.tokenHash}) = 64`),
      check("publication_embeds_revision", sql`${table.revision} >= 1`),
      check("publication_embeds_name_length", sql`length(${table.name}) BETWEEN 1 AND 120`),
      // Not six positional GLOB classes; SQLite refuses that pattern as "too complex".
      check(
        "publication_embeds_accent",
        sql`length(${table.accent}) = 7 AND substr(${table.accent}, 1, 1) = '#' AND lower(${table.accent}) NOT GLOB '*[^#0-9a-f]*'`,
      ),
      index("publication_embeds_event_idx").on(table.eventId, table.createdAt),
      index("publication_embeds_live_idx")
        .on(table.tokenHash)
        .where(sql`${table.revokedAt} IS NULL`),
    ],
  );

  return {
    publicEventProjections,
    publicEventProjectionVersions,
    attendeeItineraries,
    publicationEmbeds,
    sites,
    sitePrograms,
    sitePages,
    sitePrivacyNotices,
    siteRegistrationFields,
    siteConsents,
    sitePublications,
  };
}
