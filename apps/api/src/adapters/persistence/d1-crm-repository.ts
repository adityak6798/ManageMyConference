import type { CrmRepository, ProspectFilters } from "../../application/crm/crm-repository";
import { ProspectAlreadyConvertedError } from "../../application/crm/errors";
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
}
