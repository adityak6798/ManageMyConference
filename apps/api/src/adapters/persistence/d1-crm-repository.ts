import type { CrmRepository, ProspectFilters } from "../../application/crm/crm-repository";
import { ContactNotFoundError, ProspectAlreadyConvertedError } from "../../application/crm/errors";
import type {
  ContactActivity,
  ContactAlias,
  ContactImport,
  ContactSegment,
  DirectoryFilters,
  OrganizationContact,
} from "../../domain/crm/contact";
import type {
  Prospect,
  ProspectActivity,
  ProspectContact,
  ProspectStage,
} from "../../domain/crm/prospect";
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<{ success: boolean; error?: string }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
interface D1DatabasePort {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<Array<{ success: boolean; error?: string }>>;
}

interface ProspectRow {
  id: string;
  event_id: string;
  name: string;
  stage: ProspectStage;
  owner_id: string;
  next_action: string | null;
  next_action_at: string | null;
  speaker_id: string | null;
  converted_at: string | null;
  created_at: string;
  updated_at: string;
}
interface ContactRow {
  id: string;
  prospect_id: string;
  name: string;
  email: string;
  is_primary: number;
}
interface ActivityRow {
  id: string;
  prospect_id: string;
  kind: ProspectActivity["kind"];
  summary: string;
  is_private: number;
  occurred_at: string;
  actor_id: string;
}
interface OrganizationContactRow {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  company: string | null;
  title: string | null;
  notes: string | null;
  source: OrganizationContact["source"];
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
}
interface ContactChildRow {
  contact_id: string;
}
interface ContactTagRow extends ContactChildRow {
  tag: string;
}
interface ContactFieldRow extends ContactChildRow {
  field_key: string;
  field_value: string;
}
interface ContactAliasRow extends ContactChildRow {
  id: string;
  name: string;
  email: string;
  merged_from_id: string;
  merged_at: string;
}
interface ContactEventRow extends ContactChildRow {
  event_id: string;
  prospect_id: string;
  linked_at: string;
  stage: ProspectStage;
  speaker_id: string | null;
  converted_at: string | null;
}
interface ContactActivityRow extends ContactChildRow {
  id: string;
  kind: ContactActivity["kind"];
  summary: string;
  is_private: number;
  occurred_at: string;
  actor_id: string;
}
interface SegmentRow {
  id: string;
  organization_id: string;
  name: string;
  definition_json: string;
  created_at: string;
  created_by: string;
}
interface ImportRow {
  id: string;
  organization_id: string;
  filename: string;
  row_count: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  imported_at: string;
  imported_by: string;
}

// @spec PRD-CRM-001
export class D1CrmRepository implements CrmRepository {
  constructor(private readonly database: D1DatabasePort) {}
  private async hydrate(rows: readonly ProspectRow[]): Promise<Prospect[]> {
    if (!rows.length) return [];
    const placeholders = rows.map(() => "?").join(",");
    const ids = rows.map(({ id }) => id);
    const [contacts, activities] = await Promise.all([
      this.database
        .prepare(
          `SELECT id, prospect_id, name, email, is_primary FROM crm_contacts WHERE prospect_id IN (${placeholders}) ORDER BY prospect_id, is_primary DESC, id`,
        )
        .bind(...ids)
        .all<ContactRow>(),
      this.database
        .prepare(
          `SELECT id, prospect_id, kind, summary, is_private, occurred_at, actor_id FROM crm_activities WHERE prospect_id IN (${placeholders}) ORDER BY prospect_id, occurred_at, id`,
        )
        .bind(...ids)
        .all<ActivityRow>(),
    ]);
    if (!contacts.success || !activities.success)
      throw new Error("D1 failed to hydrate CRM history");
    const contactRows = Map.groupBy(contacts.results ?? [], ({ prospect_id }) => prospect_id);
    const activityRows = Map.groupBy(activities.results ?? [], ({ prospect_id }) => prospect_id);
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      name: row.name,
      stage: row.stage,
      ownerId: row.owner_id,
      nextAction: row.next_action,
      nextActionAt: row.next_action_at,
      contacts: (contactRows.get(row.id) ?? []).map(
        (item): ProspectContact => ({
          id: item.id,
          name: item.name,
          email: item.email,
          isPrimary: !!item.is_primary,
        }),
      ),
      activities: (activityRows.get(row.id) ?? []).map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        private: !!item.is_private,
        occurredAt: item.occurred_at,
        actorId: item.actor_id,
      })),
      speakerId: row.speaker_id,
      convertedAt: row.converted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  async list(eventId: string, filters: ProspectFilters) {
    const clauses = ["event_id = ?"],
      values: unknown[] = [eventId];
    if (filters.stage) {
      clauses.push("stage = ?");
      values.push(filters.stage);
    }
    if (filters.ownerId) {
      clauses.push("owner_id = ?");
      values.push(filters.ownerId);
    }
    if (filters.overdueBefore) {
      clauses.push("next_action_at IS NOT NULL AND next_action_at < ? AND speaker_id IS NULL");
      values.push(filters.overdueBefore);
    }
    const result = await this.database
      .prepare(
        `SELECT * FROM crm_prospects WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(next_action_at, '9999'), created_at`,
      )
      .bind(...values)
      .all<ProspectRow>();
    if (!result.success)
      throw new Error(`D1 failed to list prospects: ${result.error ?? "unknown error"}`);
    return this.hydrate(result.results ?? []);
  }
  async findById(eventId: string, prospectId: string) {
    const result = await this.database
      .prepare("SELECT * FROM crm_prospects WHERE event_id = ? AND id = ? LIMIT 1")
      .bind(eventId, prospectId)
      .all<ProspectRow>();
    if (!result.success)
      throw new Error(`D1 failed to find prospect: ${result.error ?? "unknown error"}`);
    return (await this.hydrate(result.results ?? []))[0] ?? null;
  }
  async create(prospect: Prospect) {
    const statements = [
      this.database
        .prepare(
          "INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          prospect.id,
          prospect.eventId,
          prospect.name,
          prospect.stage,
          prospect.ownerId,
          prospect.nextAction,
          prospect.nextActionAt,
          prospect.createdAt,
          prospect.updatedAt,
        ),
      ...prospect.contacts.map((contact) =>
        this.database
          .prepare(
            "INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) VALUES (?,?,?,?,?)",
          )
          .bind(contact.id, prospect.id, contact.name, contact.email, contact.isPrimary ? 1 : 0),
      ),
    ];
    const results = await this.database.batch(statements);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(
        `D1 failed to create prospect atomically: ${failed.error ?? "unknown error"}`,
      );
  }
  async update(
    prospect: Prospect,
    activities: readonly ProspectActivity[] = [],
    contact?: ProspectContact,
  ) {
    const statements: D1Statement[] = [
      this.database
        .prepare(
          "UPDATE crm_prospects SET stage=?,owner_id=?,next_action=?,next_action_at=?,updated_at=? WHERE id=? AND event_id=? AND speaker_id IS NULL",
        )
        .bind(
          prospect.stage,
          prospect.ownerId,
          prospect.nextAction,
          prospect.nextActionAt,
          prospect.updatedAt,
          prospect.id,
          prospect.eventId,
        ),
    ];
    // Every activity this command produced rides the same batch as the row update, so a
    // stage-change entry can never survive a failed transition or be lost after a saved one.
    for (const activity of activities) {
      statements.push(
        this.database
          .prepare(
            "INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM crm_prospects WHERE id=? AND event_id=? AND speaker_id IS NULL)",
          )
          .bind(
            activity.id,
            prospect.id,
            activity.kind,
            activity.summary,
            activity.private ? 1 : 0,
            activity.occurredAt,
            activity.actorId,
            prospect.id,
            prospect.eventId,
          ),
      );
    }
    if (contact) {
      if (contact.isPrimary) {
        statements.push(
          this.database
            .prepare(
              "UPDATE crm_contacts SET is_primary=0 WHERE prospect_id=? AND EXISTS (SELECT 1 FROM crm_prospects WHERE id=? AND event_id=? AND speaker_id IS NULL)",
            )
            .bind(prospect.id, prospect.id, prospect.eventId),
        );
      }
      statements.push(
        this.database
          .prepare(
            "INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM crm_prospects WHERE id=? AND event_id=? AND speaker_id IS NULL)",
          )
          .bind(
            contact.id,
            prospect.id,
            contact.name,
            contact.email,
            contact.isPrimary ? 1 : 0,
            prospect.id,
            prospect.eventId,
          ),
      );
    }
    const results = await this.database.batch(statements);
    const failed = results.find((item) => !item.success);
    if (failed)
      throw new Error(
        `D1 failed to update prospect atomically: ${failed.error ?? "unknown error"}`,
      );
    const current = await this.findById(prospect.eventId, prospect.id);
    if (current?.speakerId)
      throw new ProspectAlreadyConvertedError("Converted prospects cannot be updated");
  }
  private activityStatement(prospectId: string, activity: ProspectActivity) {
    if (activity.kind === "conversion") {
      // ERROR-INTENT: concurrent conversion retries intentionally suppress only the partial unique-index conflict for this prospect.
      return this.database
        .prepare(
          "INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(prospect_id) WHERE kind='conversion' DO NOTHING",
        )
        .bind(
          activity.id,
          prospectId,
          activity.kind,
          activity.summary,
          activity.private ? 1 : 0,
          activity.occurredAt,
          activity.actorId,
        );
    }
    return this.database
      .prepare(
        "INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        activity.id,
        prospectId,
        activity.kind,
        activity.summary,
        activity.private ? 1 : 0,
        activity.occurredAt,
        activity.actorId,
      );
  }
  async recordConversion(
    eventId: string,
    prospectId: string,
    speakerId: string,
    activity: ProspectActivity,
  ) {
    const update = this.database
      .prepare(
        "UPDATE crm_prospects SET stage='converted', speaker_id=?, converted_at=?, updated_at=? WHERE id=? AND event_id=? AND speaker_id IS NULL",
      )
      .bind(speakerId, activity.occurredAt, activity.occurredAt, prospectId, eventId);
    const results = await this.database.batch([
      update,
      this.activityStatement(prospectId, activity),
    ]);
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(
        `D1 failed to record conversion atomically: ${failed.error ?? "unknown error"}`,
      );
    const current = await this.findById(eventId, prospectId);
    if (!current) throw new Error("Prospect not found");
    return current;
  }

  /* ---------------------------------------------------------------------------------------
   * The organization-wide directory.
   *
   * Every statement below carries `organization_id` in its WHERE clause or reaches the row
   * through a subquery that does, including the writes. A caller cannot pass an id from another
   * organization and have it match, so the boundary holds even if a service-level check is ever
   * mistakenly skipped.
   * ------------------------------------------------------------------------------------- */

  private async hydrateContacts(
    rows: readonly OrganizationContactRow[],
  ): Promise<OrganizationContact[]> {
    if (!rows.length) return [];
    const ids = rows.map(({ id }) => id);
    const placeholders = ids.map(() => "?").join(",");
    const [tags, fields, aliases, events, activities] = await Promise.all([
      this.database
        .prepare(
          `SELECT contact_id, tag FROM crm_contact_tags WHERE contact_id IN (${placeholders}) ORDER BY contact_id, tag`,
        )
        .bind(...ids)
        .all<ContactTagRow>(),
      this.database
        .prepare(
          `SELECT contact_id, field_key, field_value FROM crm_contact_fields WHERE contact_id IN (${placeholders}) ORDER BY contact_id, field_key`,
        )
        .bind(...ids)
        .all<ContactFieldRow>(),
      this.database
        .prepare(
          `SELECT id, contact_id, name, email, merged_from_id, merged_at FROM crm_contact_aliases WHERE contact_id IN (${placeholders}) ORDER BY contact_id, merged_at, id`,
        )
        .bind(...ids)
        .all<ContactAliasRow>(),
      // Stage, speaker and conversion time come from the prospect on every read rather than
      // from a copy on the link, so the directory cannot claim a conversion the pipeline
      // does not have.
      this.database
        .prepare(
          `SELECT l.contact_id, l.event_id, l.prospect_id, l.linked_at, p.stage, p.speaker_id, p.converted_at
             FROM crm_contact_events l JOIN crm_prospects p ON p.id = l.prospect_id
            WHERE l.contact_id IN (${placeholders}) ORDER BY l.contact_id, l.linked_at, l.event_id`,
        )
        .bind(...ids)
        .all<ContactEventRow>(),
      this.database
        .prepare(
          `SELECT id, contact_id, kind, summary, is_private, occurred_at, actor_id FROM crm_contact_activities WHERE contact_id IN (${placeholders}) ORDER BY contact_id, occurred_at, id`,
        )
        .bind(...ids)
        .all<ContactActivityRow>(),
    ]);
    if (
      !tags.success ||
      !fields.success ||
      !aliases.success ||
      !events.success ||
      !activities.success
    )
      throw new Error("D1 failed to hydrate the contact directory");
    const by = <T extends ContactChildRow>(result: { results?: T[] }) =>
      Map.groupBy(result.results ?? [], ({ contact_id }) => contact_id);
    const tagRows = by(tags);
    const fieldRows = by(fields);
    const aliasRows = by(aliases);
    const eventRows = by(events);
    const activityRows = by(activities);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      email: row.email,
      company: row.company,
      title: row.title,
      notes: row.notes,
      source: row.source,
      mergedIntoId: row.merged_into_id,
      tags: (tagRows.get(row.id) ?? []).map(({ tag }) => tag),
      fields: (fieldRows.get(row.id) ?? []).map((item) => ({
        key: item.field_key,
        value: item.field_value,
      })),
      aliases: (aliasRows.get(row.id) ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        email: item.email,
        mergedFromId: item.merged_from_id,
        mergedAt: item.merged_at,
      })),
      events: (eventRows.get(row.id) ?? []).map((item) => ({
        eventId: item.event_id,
        prospectId: item.prospect_id,
        stage: item.stage,
        speakerId: item.speaker_id,
        convertedAt: item.converted_at,
        linkedAt: item.linked_at,
      })),
      activities: (activityRows.get(row.id) ?? []).map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        private: !!item.is_private,
        occurredAt: item.occurred_at,
        actorId: item.actor_id,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listContacts(organizationId: string, filters: DirectoryFilters) {
    const clauses = ["c.organization_id = ?", "c.merged_into_id IS NULL"];
    const values: unknown[] = [organizationId];
    if (filters.search) {
      const pattern = `%${filters.search.trim().toLowerCase()}%`;
      clauses.push(
        `(lower(c.name) LIKE ? OR lower(c.email) LIKE ? OR lower(COALESCE(c.company,'')) LIKE ?
          OR EXISTS (SELECT 1 FROM crm_contact_aliases a WHERE a.contact_id = c.id AND lower(a.email) LIKE ?))`,
      );
      values.push(pattern, pattern, pattern, pattern);
    }
    if (filters.company) {
      clauses.push("lower(trim(COALESCE(c.company,''))) = ?");
      values.push(filters.company.trim().toLowerCase());
    }
    if (filters.title) {
      clauses.push("lower(trim(COALESCE(c.title,''))) = ?");
      values.push(filters.title.trim().toLowerCase());
    }
    if (filters.tags?.length) {
      // Every named tag, not any of them: narrowing a view by adding a tag has to narrow it.
      const tags = [...new Set(filters.tags)];
      clauses.push(
        `(SELECT COUNT(*) FROM crm_contact_tags t WHERE t.contact_id = c.id AND t.tag IN (${tags
          .map(() => "?")
          .join(",")})) = ?`,
      );
      values.push(...tags, tags.length);
    }
    if (filters.fieldKey) {
      clauses.push(
        `EXISTS (SELECT 1 FROM crm_contact_fields f WHERE f.contact_id = c.id AND f.field_key = ?${
          filters.fieldValue === undefined ? "" : " AND f.field_value = ?"
        })`,
      );
      values.push(filters.fieldKey);
      if (filters.fieldValue !== undefined) values.push(filters.fieldValue);
    }
    if (filters.eventId) {
      clauses.push(
        "EXISTS (SELECT 1 FROM crm_contact_events e WHERE e.contact_id = c.id AND e.event_id = ?)",
      );
      values.push(filters.eventId);
    }
    const result = await this.database
      .prepare(
        `SELECT c.* FROM crm_organization_contacts c WHERE ${clauses.join(" AND ")} ORDER BY c.name, c.id`,
      )
      .bind(...values)
      .all<OrganizationContactRow>();
    if (!result.success)
      throw new Error(`D1 failed to list contacts: ${result.error ?? "unknown error"}`);
    return this.hydrateContacts(result.results ?? []);
  }

  /** Merged-away records stay resolvable by id, so an id already handed out never 404s. */
  async findContact(organizationId: string, contactId: string) {
    const result = await this.database
      .prepare(
        "SELECT * FROM crm_organization_contacts WHERE organization_id = ? AND id = ? LIMIT 1",
      )
      .bind(organizationId, contactId)
      .all<OrganizationContactRow>();
    if (!result.success)
      throw new Error(`D1 failed to find contact: ${result.error ?? "unknown error"}`);
    return (await this.hydrateContacts(result.results ?? []))[0] ?? null;
  }

  async findContactByEmail(organizationId: string, email: string) {
    const result = await this.database
      .prepare(
        "SELECT * FROM crm_organization_contacts WHERE organization_id = ? AND email = ? AND merged_into_id IS NULL LIMIT 1",
      )
      .bind(organizationId, email)
      .all<OrganizationContactRow>();
    if (!result.success)
      throw new Error(`D1 failed to resolve contact address: ${result.error ?? "unknown error"}`);
    return (await this.hydrateContacts(result.results ?? []))[0] ?? null;
  }

  private insertContactStatements(contact: OrganizationContact): D1Statement[] {
    return [
      this.database
        .prepare(
          "INSERT INTO crm_organization_contacts (id,organization_id,name,email,company,title,notes,source,merged_into_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)",
        )
        .bind(
          contact.id,
          contact.organizationId,
          contact.name,
          contact.email,
          contact.company,
          contact.title,
          contact.notes,
          contact.source,
          contact.createdAt,
          contact.updatedAt,
        ),
      ...this.childStatements(contact),
      ...contact.activities.map((activity) => this.contactActivityStatement(contact.id, activity)),
    ];
  }

  /** Tags and fields are replaced wholesale, so a removed one disappears rather than lingering. */
  private childStatements(contact: OrganizationContact): D1Statement[] {
    return [
      ...contact.tags.map((tag) =>
        this.database
          .prepare("INSERT OR IGNORE INTO crm_contact_tags (contact_id,tag) VALUES (?,?)")
          .bind(contact.id, tag),
      ),
      ...contact.fields.map((field) =>
        this.database
          .prepare(
            "INSERT INTO crm_contact_fields (contact_id,field_key,field_value) VALUES (?,?,?) ON CONFLICT(contact_id,field_key) DO UPDATE SET field_value=excluded.field_value",
          )
          .bind(contact.id, field.key, field.value),
      ),
    ];
  }

  private contactActivityStatement(contactId: string, activity: ContactActivity) {
    return this.database
      .prepare(
        "INSERT INTO crm_contact_activities (id,contact_id,kind,summary,is_private,occurred_at,actor_id) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        activity.id,
        contactId,
        activity.kind,
        activity.summary,
        activity.private ? 1 : 0,
        activity.occurredAt,
        activity.actorId,
      );
  }

  private async runBatch(statements: D1Statement[], what: string) {
    const results = await this.database.batch(statements);
    const failed = results.find((result) => !result.success);
    if (failed) throw new Error(`D1 failed to ${what}: ${failed.error ?? "unknown error"}`);
  }

  async createContact(contact: OrganizationContact) {
    await this.runBatch(this.insertContactStatements(contact), "create contact atomically");
  }

  private updateContactStatements(
    contact: OrganizationContact,
    activities: readonly ContactActivity[],
  ): D1Statement[] {
    return [
      this.database
        .prepare(
          "UPDATE crm_organization_contacts SET name=?,company=?,title=?,notes=?,updated_at=? WHERE id=? AND organization_id=? AND merged_into_id IS NULL",
        )
        .bind(
          contact.name,
          contact.company,
          contact.title,
          contact.notes,
          contact.updatedAt,
          contact.id,
          contact.organizationId,
        ),
      this.database
        .prepare(
          `DELETE FROM crm_contact_tags WHERE contact_id=?${
            contact.tags.length ? ` AND tag NOT IN (${contact.tags.map(() => "?").join(",")})` : ""
          }`,
        )
        .bind(contact.id, ...contact.tags),
      this.database
        .prepare(
          `DELETE FROM crm_contact_fields WHERE contact_id=?${
            contact.fields.length
              ? ` AND field_key NOT IN (${contact.fields.map(() => "?").join(",")})`
              : ""
          }`,
        )
        .bind(contact.id, ...contact.fields.map(({ key }) => key)),
      ...this.childStatements(contact),
      ...activities.map((activity) => this.contactActivityStatement(contact.id, activity)),
    ];
  }

  async updateContact(contact: OrganizationContact, activities: readonly ContactActivity[] = []) {
    await this.runBatch(
      this.updateContactStatements(contact, activities),
      "update contact atomically",
    );
  }

  async commitImport(
    record: ContactImport,
    created: readonly OrganizationContact[],
    updated: readonly OrganizationContact[],
  ) {
    await this.runBatch(
      [
        this.database
          .prepare(
            "INSERT INTO crm_contact_imports (id,organization_id,filename,row_count,created_count,updated_count,skipped_count,imported_at,imported_by) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            record.id,
            record.organizationId,
            record.filename,
            record.rowCount,
            record.createdCount,
            record.updatedCount,
            record.skippedCount,
            record.importedAt,
            record.importedBy,
          ),
        ...created.flatMap((contact) => this.insertContactStatements(contact)),
        // The activities the import appended are already on the record it hands over, so only
        // the newest entry is written again here rather than the whole timeline.
        ...updated.flatMap((contact) =>
          this.updateContactStatements(contact, contact.activities.slice(-1)),
        ),
      ],
      "commit the contact import atomically",
    );
  }

  async mergeContacts(input: {
    organizationId: string;
    primaryId: string;
    duplicateIds: readonly string[];
    aliases: readonly ContactAlias[];
    activity: ContactActivity;
  }) {
    const { organizationId, primaryId, duplicateIds } = input;
    const list = duplicateIds.map(() => "?").join(",");
    // Every statement is additionally scoped to the organization through a subquery, so an id
    // from elsewhere folds nothing away even if it reached this far.
    const owned = `AND EXISTS (SELECT 1 FROM crm_organization_contacts o WHERE o.id = ? AND o.organization_id = ?)`;
    await this.runBatch(
      [
        ...input.aliases.map((alias) =>
          this.database
            .prepare(
              `INSERT INTO crm_contact_aliases (id,contact_id,name,email,merged_from_id,merged_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM crm_organization_contacts o WHERE o.id = ? AND o.organization_id = ?)`,
            )
            .bind(
              alias.id,
              primaryId,
              alias.name,
              alias.email,
              alias.mergedFromId,
              alias.mergedAt,
              primaryId,
              organizationId,
            ),
        ),
        this.database
          .prepare(
            `UPDATE crm_contact_activities SET contact_id = ? WHERE contact_id IN (${list}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, primaryId, organizationId),
        // `OR IGNORE`: when both records were sourced into the same event, the primary already
        // holds that link and the loser's stays on the merged-away row rather than being
        // dropped. Nothing is deleted either way.
        this.database
          .prepare(
            `UPDATE OR IGNORE crm_contact_events SET contact_id = ? WHERE contact_id IN (${list}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, primaryId, organizationId),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO crm_contact_tags (contact_id,tag) SELECT ?, tag FROM crm_contact_tags WHERE contact_id IN (${list}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, primaryId, organizationId),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO crm_contact_fields (contact_id,field_key,field_value) SELECT ?, field_key, field_value FROM crm_contact_fields WHERE contact_id IN (${list}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, primaryId, organizationId),
        this.database
          .prepare(
            `UPDATE crm_organization_contacts SET merged_into_id = ?, updated_at = ? WHERE id IN (${list}) AND organization_id = ? AND merged_into_id IS NULL`,
          )
          .bind(primaryId, input.activity.occurredAt, ...duplicateIds, organizationId),
        this.contactActivityStatement(primaryId, input.activity),
      ],
      "merge contacts atomically",
    );
    const merged = await this.findContact(organizationId, primaryId);
    if (!merged) throw new ContactNotFoundError("Contact not found");
    return merged;
  }

  async listSegments(organizationId: string) {
    const result = await this.database
      .prepare("SELECT * FROM crm_contact_segments WHERE organization_id = ? ORDER BY name, id")
      .bind(organizationId)
      .all<SegmentRow>();
    if (!result.success)
      throw new Error(`D1 failed to list segments: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(toSegment);
  }

  async findSegment(organizationId: string, segmentId: string) {
    const result = await this.database
      .prepare("SELECT * FROM crm_contact_segments WHERE organization_id = ? AND id = ? LIMIT 1")
      .bind(organizationId, segmentId)
      .all<SegmentRow>();
    if (!result.success)
      throw new Error(`D1 failed to find segment: ${result.error ?? "unknown error"}`);
    const row = result.results?.[0];
    return row ? toSegment(row) : null;
  }

  async createSegment(segment: ContactSegment) {
    const result = await this.database
      .prepare(
        "INSERT INTO crm_contact_segments (id,organization_id,name,definition_json,created_at,created_by) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        segment.id,
        segment.organizationId,
        segment.name,
        JSON.stringify(segment.filters),
        segment.createdAt,
        segment.createdBy,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to save segment: ${result.error ?? "unknown error"}`);
  }

  async listImports(organizationId: string) {
    const result = await this.database
      .prepare(
        "SELECT * FROM crm_contact_imports WHERE organization_id = ? ORDER BY imported_at DESC, id",
      )
      .bind(organizationId)
      .all<ImportRow>();
    if (!result.success)
      throw new Error(`D1 failed to list contact imports: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(
      (row): ContactImport => ({
        id: row.id,
        organizationId: row.organization_id,
        filename: row.filename,
        rowCount: row.row_count,
        createdCount: row.created_count,
        updatedCount: row.updated_count,
        skippedCount: row.skipped_count,
        importedAt: row.imported_at,
        importedBy: row.imported_by,
      }),
    );
  }

  async recordContactActivities(
    organizationId: string,
    entries: readonly { contactId: string; activity: ContactActivity }[],
  ) {
    if (!entries.length) return;
    await this.runBatch(
      entries.map(({ contactId, activity }) =>
        this.database
          .prepare(
            "INSERT INTO crm_contact_activities (id,contact_id,kind,summary,is_private,occurred_at,actor_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM crm_organization_contacts WHERE id=? AND organization_id=?)",
          )
          .bind(
            activity.id,
            contactId,
            activity.kind,
            activity.summary,
            activity.private ? 1 : 0,
            activity.occurredAt,
            activity.actorId,
            contactId,
            organizationId,
          ),
      ),
      "record contact activity",
    );
  }

  async linkContactToEvent(input: {
    contact: OrganizationContact;
    prospect: Prospect;
    activity: ContactActivity;
  }) {
    const { contact, prospect } = input;
    await this.runBatch(
      [
        this.database
          .prepare(
            "INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            prospect.id,
            prospect.eventId,
            prospect.name,
            prospect.stage,
            prospect.ownerId,
            prospect.nextAction,
            prospect.nextActionAt,
            prospect.createdAt,
            prospect.updatedAt,
          ),
        ...prospect.contacts.map((item) =>
          this.database
            .prepare(
              "INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) VALUES (?,?,?,?,?)",
            )
            .bind(item.id, prospect.id, item.name, item.email, item.isPrimary ? 1 : 0),
        ),
        // Scoped through the contact's organization, so a link cannot be written between an
        // event and a contact that belongs somewhere else.
        this.database
          .prepare(
            "INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM crm_organization_contacts WHERE id=? AND organization_id=? AND merged_into_id IS NULL)",
          )
          .bind(
            contact.id,
            prospect.eventId,
            prospect.id,
            input.activity.occurredAt,
            contact.id,
            contact.organizationId,
          ),
        this.contactActivityStatement(contact.id, input.activity),
      ],
      "source the contact into the event atomically",
    );
  }
}

function toSegment(row: SegmentRow): ContactSegment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    // Stored as the definition the organizer saved. Parsed rather than trusted as a shape:
    // the transport re-validates it against `contactFiltersSchema` before it reaches a query.
    filters: JSON.parse(row.definition_json) as ContactSegment["filters"],
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
