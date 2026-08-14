import type {
  CrmRepository,
  ProspectMove,
  ProspectFilters,
  StageMigration,
} from "../../application/crm/crm-repository";
import {
  ContactAlreadySourcedError,
  ContactEmailTakenError,
  ContactNotFoundError,
  PipelineStageInUseError,
  ProspectAlreadyConvertedError,
} from "../../application/crm/errors";
import type {
  ContactActivity,
  ContactAlias,
  ContactImport,
  ContactSegment,
  DirectoryFilters,
  OrganizationContact,
} from "../../domain/crm/contact";
import type {
  PipelineStage,
  Prospect,
  ProspectActivity,
  ProspectContact,
  ProspectTransition,
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
  stage: string;
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
interface StageRow {
  id: string;
  event_id: string;
  key: string;
  label: string;
  category: string;
  sort_order: number;
  created_at: string;
}
interface TransitionRow {
  id: string;
  event_id: string;
  prospect_id: string;
  from_stage: string | null;
  to_stage: string;
  actor_id: string;
  source: string;
  occurred_at: string;
}
interface ContactEventRow extends ContactChildRow {
  event_id: string;
  prospect_id: string;
  linked_at: string;
  stage: string;
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

/**
 * D1 refuses a statement carrying more than about a hundred bound variables, so any query that
 * expands a list into placeholders has a size past which it stops working rather than slowing
 * down. Everything that hydrates a set of contacts goes through this.
 */
const BIND_CHUNK = 80;

function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += BIND_CHUNK)
    chunks.push(items.slice(index, index + BIND_CHUNK));
  return chunks;
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
          `SELECT id, prospect_id, kind, summary, is_private, occurred_at, actor_id FROM crm_activities WHERE prospect_id IN (${placeholders}) ORDER BY prospect_id, occurred_at, CASE WHEN kind='stage-change' THEN 0 ELSE 1 END, id`,
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
  async findByPrimaryEmail(eventId: string, email: string) {
    const result = await this.database
      .prepare(
        "SELECT p.id FROM crm_prospects p JOIN crm_contacts c ON c.prospect_id=p.id WHERE p.event_id=? AND c.is_primary=1 AND lower(trim(c.email))=? ORDER BY p.created_at,p.id LIMIT 1",
      )
      .bind(eventId, email.trim().toLowerCase())
      .all<{ id: string }>();
    if (!result.success)
      throw new Error(
        `D1 failed to find CRM prospect by address: ${result.error ?? "unknown error"}`,
      );
    const id = result.results?.[0]?.id;
    return id ? this.findById(eventId, id) : null;
  }
  async create(prospect: Prospect, transition?: ProspectTransition) {
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
      // The arrival is the first entry in the prospect's history, written in the same batch so
      // a board can never show a card whose history begins after it.
      ...(transition ? [this.transitionStatement(transition)] : []),
    ];
    await this.runBatch(statements, "create prospect atomically");
  }
  async update(
    prospect: Prospect,
    activities: readonly ProspectActivity[] = [],
    contact?: ProspectContact,
    move?: ProspectMove,
  ) {
    const statements: D1Statement[] = [];
    if (move) {
      /*
       * Both histories read `stage` before the UPDATE below. They therefore describe the row
       * this batch actually found, not the stale stage the service saw before a concurrent move.
       * SQL mints the ids because only SQL knows whether this predicate matched a row.
       */
      statements.push(
        this.database
          .prepare(
            `INSERT INTO crm_prospect_transitions (id,event_id,prospect_id,from_stage,to_stage,actor_id,source,occurred_at)
             SELECT ${D1CrmRepository.SQL_UUID}, event_id, id, stage, ?, ?, ?, ?
               FROM crm_prospects
              WHERE id=? AND event_id=? AND speaker_id IS NULL AND stage<>?`,
          )
          .bind(
            move.toStage,
            move.actorId,
            move.source,
            move.occurredAt,
            prospect.id,
            prospect.eventId,
            move.toStage,
          ),
        this.database
          .prepare(
            `INSERT INTO crm_activities (id,prospect_id,kind,summary,is_private,occurred_at,actor_id)
             SELECT ${D1CrmRepository.SQL_UUID}, p.id, 'stage-change',
                    COALESCE(from_stage.label, p.stage) || ' → ' || COALESCE(to_stage.label, ?),
                    0, ?, ?
               FROM crm_prospects p
               LEFT JOIN crm_pipeline_stages from_stage
                 ON from_stage.event_id=p.event_id AND from_stage.key=p.stage
               LEFT JOIN crm_pipeline_stages to_stage
                 ON to_stage.event_id=p.event_id AND to_stage.key=?
              WHERE p.id=? AND p.event_id=? AND p.speaker_id IS NULL AND p.stage<>?`,
          )
          .bind(
            move.toStage,
            move.occurredAt,
            move.actorId,
            move.toStage,
            prospect.id,
            prospect.eventId,
            move.toStage,
          ),
      );
    }
    statements.push(
      this.database
        .prepare(
          "UPDATE crm_prospects SET stage=COALESCE(?,stage),owner_id=?,next_action=?,next_action_at=?,updated_at=? WHERE id=? AND event_id=? AND speaker_id IS NULL",
        )
        .bind(
          move?.toStage ?? null,
          prospect.ownerId,
          prospect.nextAction,
          prospect.nextActionAt,
          prospect.updatedAt,
          prospect.id,
          prospect.eventId,
        ),
    );
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
    await this.runBatch(statements, "update prospect atomically");
    const current = await this.findById(prospect.eventId, prospect.id);
    if (!current) throw new Error("Prospect not found after update");
    if (current?.speakerId)
      throw new ProspectAlreadyConvertedError("Converted prospects cannot be updated");
    return current;
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
    transition?: ProspectTransition,
  ) {
    const update = this.database
      .prepare(
        "UPDATE crm_prospects SET stage='converted', speaker_id=?, converted_at=?, updated_at=? WHERE id=? AND event_id=? AND speaker_id IS NULL",
      )
      .bind(speakerId, activity.occurredAt, activity.occurredAt, prospectId, eventId);
    await this.runBatch(
      [
        /*
         * The history entry goes in *before* the row is stamped, and under the same
         * `speaker_id IS NULL` clause the stamp itself carries.
         *
         * Unguarded it recorded conversions that did not happen: two organizers pressing Convert
         * at once produced one winning UPDATE, one conversion activity — the partial index sees
         * to that — and two transition rows, so the history claimed a move the loser never made.
         *
         * The order is what makes the guard mean the right thing. Inside a batch each statement
         * sees what the ones before it left, so placed after the UPDATE this clause would read
         * the row this very batch had just converted and refuse every entry; placed before it,
         * both clauses read the same pre-batch row and therefore agree — the entry lands exactly
         * when the conversion does.
         */
        ...(transition
          ? [this.unconvertedTransitionStatement(transition, prospectId, eventId)]
          : []),
        update,
        this.activityStatement(prospectId, activity),
      ],
      "record conversion atomically",
    );
    const current = await this.findById(eventId, prospectId);
    if (!current) throw new Error("Prospect not found");
    return current;
  }

  /* ------------------------------ the board itself ------------------------------ */

  private stageRow(row: StageRow): PipelineStage {
    return {
      id: row.id,
      eventId: row.event_id,
      key: row.key,
      label: row.label,
      category: row.category as PipelineStage["category"],
      sortOrder: Number(row.sort_order),
      createdAt: row.created_at,
    };
  }

  async listStages(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, key, label, category, sort_order, created_at FROM crm_pipeline_stages WHERE event_id=? ORDER BY sort_order, key",
      )
      .bind(eventId)
      .all<StageRow>();
    if (!result.success)
      throw new Error(`D1 failed to list pipeline stages: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map((row) => this.stageRow(row));
  }

  /**
   * Write the default board for an event that has none, then answer with what it now has.
   *
   * `INSERT OR IGNORE` against `UNIQUE (event_id, key)` rather than "read, then decide": two
   * organizers opening a new event's board at the same instant both read no stages, and a
   * read-then-write would have one of them fail on the other's insert. An existing row is left
   * exactly as it is, so healing can never undo a rename.
   */
  async ensureStages(eventId: string, stages: readonly PipelineStage[]) {
    if (stages.length)
      await this.runBatch(
        stages.map((stage) =>
          this.database
            .prepare(
              "INSERT OR IGNORE INTO crm_pipeline_stages (id,event_id,key,label,category,sort_order,created_at) VALUES (?,?,?,?,?,?,?)",
            )
            .bind(
              stage.id,
              eventId,
              stage.key,
              stage.label,
              stage.category,
              stage.sortOrder,
              stage.createdAt,
            ),
        ),
        "seed the default pipeline stages",
      );
    return this.listStages(eventId);
  }

  /**
   * Replace this event's stage list wholesale.
   *
   * One batch, and a delete-then-insert rather than a diff: adding, renaming and reordering are
   * the same operation from the board's point of view, and a partial application would leave two
   * columns claiming the same position. The delete is scoped to keys *not* in the new list, so a
   * stage that survives keeps its id — history is text and does not follow the id, but a stable
   * id is what lets the console's own list keep its React keys across a reorder.
   */
  async saveStages(eventId: string, stages: readonly PipelineStage[]) {
    const keys = stages.map(({ key }) => key);
    const placeholders = keys.map(() => "?").join(",");
    const statements: D1Statement[] = [
      this.database
        .prepare(
          keys.length
            ? `DELETE FROM crm_pipeline_stages WHERE event_id=? AND key NOT IN (${placeholders})`
            : "DELETE FROM crm_pipeline_stages WHERE event_id=?",
        )
        .bind(eventId, ...keys),
      ...stages.map((stage) =>
        this.database
          .prepare(
            "INSERT INTO crm_pipeline_stages (id,event_id,key,label,category,sort_order,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id,key) DO UPDATE SET label=excluded.label, category=excluded.category, sort_order=excluded.sort_order",
          )
          .bind(
            stage.id,
            eventId,
            stage.key,
            stage.label,
            stage.category,
            stage.sortOrder,
            stage.createdAt,
          ),
      ),
    ];
    try {
      await this.runBatch(statements, "save the pipeline stages");
    } catch (error) {
      if (error instanceof Error && /pipeline stage still holds prospects/i.test(error.message))
        throw new PipelineStageInUseError(
          "A removed stage still holds prospects. Choose where they should move first.",
        );
      throw error;
    }
  }

  /**
   * A version-4 UUID built in SQL, for rows this adapter inserts from a SELECT rather than from
   * a list it was handed.
   *
   * Character for character the generator `1501_crm_pipeline_stages.sql` uses to backfill this
   * same table, so a history row's id has one shape whoever wrote it. `randomblob` is
   * re-evaluated per result row, which is what makes it usable as a primary key for a set whose
   * size is only known inside the statement.
   */
  private static readonly SQL_UUID =
    "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
    "substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || " +
    "'-' || lower(hex(randomblob(6)))";

  /**
   * Move everything out of a stage and delete it, in one batch.
   *
   * The migration and the delete cannot be two requests: between them the board would serve a
   * stage key no column exists for, and every card in it would render nowhere. The transitions
   * are written in the same batch for the same reason — a move nobody can see in the history is
   * a move that did not happen as far as a report is concerned.
   */
  async deleteStage(
    eventId: string,
    stageKey: string,
    migrateTo: string,
    move: StageMigration,
    remaining: readonly PipelineStage[],
  ) {
    /*
     * The history rows are derived from the same predicate the migration runs on.
     *
     * This used to be handed a finished list of transitions that `CrmService` built from a
     * separate `list()` round trip, so the list described the stage as it stood a few
     * milliseconds earlier and the two sets drifted apart in both directions: a card dragged out
     * of the stage in between got a transition row for a move that never happened, and a card
     * dragged *into* it was migrated with no history at all — precisely the "where did these
     * go?" the history exists to answer. The caller now passes only who and when, so the set
     * that moves and the set that gets a history entry are the same set by construction, and
     * neither an empty stage nor a busy one has a special case.
     */
    await this.runBatch(
      [
        // Before the UPDATE, for the same reason the conversion's entry goes before its stamp:
        // afterwards this SELECT would find the stage already empty.
        this.database
          .prepare(
            `INSERT INTO crm_prospect_transitions (id,event_id,prospect_id,from_stage,to_stage,actor_id,source,occurred_at)
             SELECT ${D1CrmRepository.SQL_UUID}, event_id, id, stage, ?, ?, ?, ?
               FROM crm_prospects WHERE event_id=? AND stage=?`,
          )
          .bind(migrateTo, move.actorId, move.source, move.occurredAt, eventId, stageKey),
        this.database
          .prepare("UPDATE crm_prospects SET stage=?, updated_at=? WHERE event_id=? AND stage=?")
          .bind(migrateTo, move.occurredAt, eventId, stageKey),
        this.database
          .prepare("DELETE FROM crm_pipeline_stages WHERE event_id=? AND key=?")
          .bind(eventId, stageKey),
        ...remaining.map((stage) =>
          this.database
            .prepare("UPDATE crm_pipeline_stages SET sort_order=? WHERE event_id=? AND key=?")
            .bind(stage.sortOrder, eventId, stage.key),
        ),
      ],
      "migrate and delete a pipeline stage",
    );
  }

  /**
   * A history entry that lands only while the prospect is still unconverted.
   *
   * The one shape both writes that move a card use, rather than a clause each of them repeats:
   * the unguarded copy in the conversion path is exactly how the two drifted apart, and a
   * history row is not something a caller can notice is missing. The guard belongs to whichever
   * statement in the batch decides the move, so this must be placed *before* that statement —
   * see `recordConversion`, where the conversion's own stamp would otherwise falsify it.
   */
  private unconvertedTransitionStatement(
    transition: ProspectTransition,
    prospectId: string,
    eventId: string,
  ) {
    return this.database
      .prepare(
        "INSERT INTO crm_prospect_transitions (id,event_id,prospect_id,from_stage,to_stage,actor_id,source,occurred_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM crm_prospects WHERE id=? AND event_id=? AND speaker_id IS NULL)",
      )
      .bind(
        transition.id,
        transition.eventId,
        transition.prospectId,
        transition.fromStage,
        transition.toStage,
        transition.actorId,
        transition.source,
        transition.occurredAt,
        prospectId,
        eventId,
      );
  }

  /** The arrival entry, unguarded: `create` inserts the prospect in the same batch. */
  private transitionStatement(transition: ProspectTransition) {
    return this.database
      .prepare(
        "INSERT INTO crm_prospect_transitions (id,event_id,prospect_id,from_stage,to_stage,actor_id,source,occurred_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        transition.id,
        transition.eventId,
        transition.prospectId,
        transition.fromStage,
        transition.toStage,
        transition.actorId,
        transition.source,
        transition.occurredAt,
      );
  }

  async listTransitions(eventId: string) {
    const result = await this.database
      .prepare(
        "SELECT id, event_id, prospect_id, from_stage, to_stage, actor_id, source, occurred_at FROM crm_prospect_transitions WHERE event_id=? ORDER BY occurred_at, id",
      )
      .bind(eventId)
      .all<TransitionRow>();
    if (!result.success)
      throw new Error(`D1 failed to list stage transitions: ${result.error ?? "unknown error"}`);
    return (result.results ?? []).map(
      (row): ProspectTransition => ({
        id: row.id,
        eventId: row.event_id,
        prospectId: row.prospect_id,
        fromStage: row.from_stage,
        toStage: row.to_stage,
        actorId: row.actor_id,
        source: row.source as ProspectTransition["source"],
        occurredAt: row.occurred_at,
      }),
    );
  }

  /* ---------------------------------------------------------------------------------------
   * The organization-wide directory.
   *
   * Every statement below carries `organization_id` in its WHERE clause or reaches the row
   * through a subquery that does, including the writes. A caller cannot pass an id from another
   * organization and have it match, so the boundary holds even if a service-level check is ever
   * mistakenly skipped.
   * ------------------------------------------------------------------------------------- */

  /**
   * Reads one child table for a set of contacts, in chunks small enough to bind.
   *
   * The single-statement version failed outright once an organization held more than ~100
   * contacts — and it failed for `listContacts`, which is also what the dashboard and the
   * duplicate scan call, so the directory stopped loading rather than loading slowly.
   */
  private async childRows<T extends ContactChildRow>(
    ids: readonly string[],
    sql: (placeholders: string) => string,
    what: string,
  ): Promise<T[]> {
    const results = await Promise.all(
      chunked(ids).map((chunk) =>
        this.database
          .prepare(sql(chunk.map(() => "?").join(",")))
          .bind(...chunk)
          .all<T>(),
      ),
    );
    if (results.some((result) => !result.success)) throw new Error(`D1 failed to hydrate ${what}`);
    return results.flatMap((result) => result.results ?? []);
  }

  private async hydrateContacts(
    rows: readonly OrganizationContactRow[],
  ): Promise<OrganizationContact[]> {
    if (!rows.length) return [];
    const ids = rows.map(({ id }) => id);
    const [tags, fields, aliases, events, activities] = await Promise.all([
      this.childRows<ContactTagRow>(
        ids,
        (placeholders) =>
          `SELECT contact_id, tag FROM crm_contact_tags WHERE contact_id IN (${placeholders}) ORDER BY contact_id, tag`,
        "contact tags",
      ),
      this.childRows<ContactFieldRow>(
        ids,
        (placeholders) =>
          `SELECT contact_id, field_key, field_value FROM crm_contact_fields WHERE contact_id IN (${placeholders}) ORDER BY contact_id, field_key`,
        "contact fields",
      ),
      this.childRows<ContactAliasRow>(
        ids,
        (placeholders) =>
          `SELECT id, contact_id, name, email, merged_from_id, merged_at FROM crm_contact_aliases WHERE contact_id IN (${placeholders}) ORDER BY contact_id, merged_at, id`,
        "contact aliases",
      ),
      // Stage, speaker and conversion time come from the prospect on every read rather than
      // from a copy on the link, so the directory cannot claim a conversion the pipeline
      // does not have.
      this.childRows<ContactEventRow>(
        ids,
        (placeholders) =>
          `SELECT l.contact_id, l.event_id, l.prospect_id, l.linked_at, p.stage, p.speaker_id, p.converted_at
             FROM crm_contact_events l JOIN crm_prospects p ON p.id = l.prospect_id
            WHERE l.contact_id IN (${placeholders}) ORDER BY l.contact_id, l.linked_at, l.event_id`,
        "contact event history",
      ),
      this.childRows<ContactActivityRow>(
        ids,
        (placeholders) =>
          `SELECT id, contact_id, kind, summary, is_private, occurred_at, actor_id FROM crm_contact_activities WHERE contact_id IN (${placeholders}) ORDER BY contact_id, occurred_at, id`,
        "contact timelines",
      ),
    ]);
    const by = <T extends ContactChildRow>(rows: readonly T[]) =>
      Map.groupBy(rows, ({ contact_id }) => contact_id);
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

  /**
   * Resolves an address to the live contact that owns it, following aliases.
   *
   * The alias half matters: after a merge, the loser's address survives only as an alias, so an
   * address-only lookup found nothing and the next import of the same spreadsheet row created a
   * fresh contact — recreating precisely the duplicate the merge had just resolved. Following
   * the alias means a re-import enriches the survivor, and `requireAddressIsFree` refuses a new
   * contact on an address a merge already accounted for.
   */
  async findContactByEmail(organizationId: string, email: string) {
    const result = await this.database
      .prepare(
        `SELECT c.* FROM crm_organization_contacts c
          WHERE c.organization_id = ? AND c.merged_into_id IS NULL
            AND (c.email = ? OR EXISTS (
                  SELECT 1 FROM crm_contact_aliases a
                   WHERE a.contact_id = c.id AND a.email = ?))
          ORDER BY CASE WHEN c.email = ? THEN 0 ELSE 1 END, c.id
          LIMIT 1`,
      )
      .bind(organizationId, email, email, email)
      .all<OrganizationContactRow>();
    if (!result.success)
      throw new Error(`D1 failed to resolve contact address: ${result.error ?? "unknown error"}`);
    return (await this.hydrateContacts(result.results ?? []))[0] ?? null;
  }

  async findContactsByEmails(organizationId: string, emails: readonly string[]) {
    const resolved = new Map<string, OrganizationContact>();
    if (!emails.length) return resolved;
    // Chunked for the same reason the hydration is: a 500-row import would otherwise bind 500
    // variables in one statement and fail outright.
    for (const chunk of chunked(emails)) {
      const placeholders = chunk.map(() => "?").join(",");
      const result = await this.database
        .prepare(
          `SELECT c.*, a.email AS matched_alias FROM crm_organization_contacts c
             LEFT JOIN crm_contact_aliases a ON a.contact_id = c.id AND a.email IN (${placeholders})
            WHERE c.organization_id = ? AND c.merged_into_id IS NULL
              AND (c.email IN (${placeholders}) OR a.email IS NOT NULL)`,
        )
        .bind(...chunk, organizationId, ...chunk)
        .all<OrganizationContactRow & { matched_alias: string | null }>();
      if (!result.success)
        throw new Error(`D1 failed to resolve contact addresses: ${result.error ?? "unknown"}`);
      const rows = result.results ?? [];
      const hydrated = await this.hydrateContacts(rows);
      rows.forEach((row, index) => {
        const contact = hydrated[index];
        if (!contact) return;
        // Keyed by every address that found it — its own, and any alias in this chunk — so the
        // caller can look up by exactly the address it asked about.
        if (chunk.includes(row.email)) resolved.set(row.email, contact);
        if (row.matched_alias && chunk.includes(row.matched_alias))
          resolved.set(row.matched_alias, contact);
      });
    }
    return resolved;
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
      ...contact.activities.map((activity) =>
        this.contactActivityStatement(contact.id, activity, contact.organizationId),
      ),
    ];
  }

  /**
   * The one condition every write about a contact is allowed to proceed under: this
   * organization's, and not merged away.
   *
   * A child table carries no organization of its own, so a statement keyed only on
   * `contact_id` matches a contact anywhere. That is how the tag and field writes below came to
   * delete and replace another organization's data while the contact row's own UPDATE, which
   * was scoped, quietly changed nothing.
   *
   * `merged_into_id IS NULL` is part of it rather than an extra condition some statements add,
   * because the version that left it to individual statements produced exactly the same class
   * of bug one level down: the contact row refused an update to a record merged away mid-flight
   * while its tags, fields and timeline accepted one, so a row the directory no longer lists
   * had its history rewritten. One clause, applied everywhere, is the only version of this that
   * cannot drift apart again.
   */
  private static readonly LIVE =
    "EXISTS (SELECT 1 FROM crm_organization_contacts o WHERE o.id = ? AND o.organization_id = ? AND o.merged_into_id IS NULL)";

  /** Tags and fields are replaced wholesale, so a removed one disappears rather than lingering. */
  private childStatements(contact: OrganizationContact): D1Statement[] {
    const owns = [contact.id, contact.organizationId];
    return [
      ...contact.tags.map((tag) =>
        this.database
          .prepare(
            `INSERT OR IGNORE INTO crm_contact_tags (contact_id,tag) SELECT ?,? WHERE ${D1CrmRepository.LIVE}`,
          )
          .bind(contact.id, tag, ...owns),
      ),
      ...contact.fields.map((field) =>
        this.database
          .prepare(
            `INSERT INTO crm_contact_fields (contact_id,field_key,field_value) SELECT ?,?,? WHERE ${D1CrmRepository.LIVE} ON CONFLICT(contact_id,field_key) DO UPDATE SET field_value=excluded.field_value`,
          )
          .bind(contact.id, field.key, field.value, ...owns),
      ),
    ];
  }

  /**
   * An activity insert scoped to the contact's organization.
   *
   * `organizationId` is required rather than optional on purpose: every caller has one, and an
   * optional guard is a guard somebody forgets. Within a batch the preceding statements are
   * visible, so this is satisfied by a contact the same batch has just inserted.
   */
  private contactActivityStatement(
    contactId: string,
    activity: ContactActivity,
    organizationId: string,
  ) {
    return this.database
      .prepare(
        `INSERT INTO crm_contact_activities (id,contact_id,kind,summary,is_private,occurred_at,actor_id) SELECT ?,?,?,?,?,?,? WHERE ${D1CrmRepository.LIVE}`,
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
      );
  }

  /**
   * Run a batch, and translate the uniqueness violations that are races rather than faults.
   *
   * A service-level check followed by an insert is not atomic: two organizers submitting the
   * same address, or one double-clicking "Add to event", both pass the read and the second
   * write meets the index. That is a caller-visible conflict the domain already has words for,
   * so it must not surface as the redacted 500 an unhandled adapter error becomes — the whole
   * reason `ContactEmailTakenError` exists is that this failure should name the field.
   *
   * Both failure shapes are handled because D1 uses both: `batch()` *rejects* on a statement
   * error rather than returning a non-success result, so a version of this that inspected only
   * the results array was unreachable code and every race still answered 500.
   *
   * `conflict.when` is matched against the driver's message and is deliberately specific to one
   * index. Matching "constraint failed" would also catch the CHECK and FOREIGN KEY violations
   * these batches can raise — the contact insert carries tags, fields and an activity whose
   * `actor_id` is a foreign key — and reporting one of those as "another contact already holds
   * this address" would send the organizer to fix something that is not wrong.
   */
  private batchFailure(
    what: string,
    reason: string,
    conflict?: { when: RegExp; error: () => Error },
  ): Error {
    if (conflict && /UNIQUE constraint failed/i.test(reason) && conflict.when.test(reason))
      return conflict.error();
    return new Error(`D1 failed to ${what}: ${reason}`);
  }

  private async runBatch(
    statements: D1Statement[],
    what: string,
    conflict?: { when: RegExp; error: () => Error },
  ) {
    let results: Array<{ success: boolean; error?: string }>;
    try {
      results = await this.database.batch(statements);
    } catch (error) {
      throw this.batchFailure(
        what,
        error instanceof Error ? error.message : String(error),
        conflict,
      );
    }
    const failed = results.find((result) => !result.success);
    if (failed) throw this.batchFailure(what, failed.error ?? "unknown error", conflict);
  }

  async createContact(contact: OrganizationContact) {
    await this.runBatch(this.insertContactStatements(contact), "create contact atomically", {
      when: /crm_organization_contacts/i,
      error: () =>
        new ContactEmailTakenError({
          email: ["Another contact already holds this address. Merge the records instead."],
        }),
    });
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
      // Both DELETEs are gated on the organization as well as the contact. Keyed on the contact
      // alone they matched a contact anywhere, so replacing this contact's tags wholesale
      // deleted another organization's — the destructive half of the same asymmetry the merge
      // batch had.
      this.database
        .prepare(
          `DELETE FROM crm_contact_tags WHERE contact_id=?${
            contact.tags.length ? ` AND tag NOT IN (${contact.tags.map(() => "?").join(",")})` : ""
          } AND ${D1CrmRepository.LIVE}`,
        )
        .bind(contact.id, ...contact.tags, contact.id, contact.organizationId),
      this.database
        .prepare(
          `DELETE FROM crm_contact_fields WHERE contact_id=?${
            contact.fields.length
              ? ` AND field_key NOT IN (${contact.fields.map(() => "?").join(",")})`
              : ""
          } AND ${D1CrmRepository.LIVE}`,
        )
        .bind(
          contact.id,
          ...contact.fields.map(({ key }) => key),
          contact.id,
          contact.organizationId,
        ),
      ...this.childStatements(contact),
      ...activities.map((activity) =>
        this.contactActivityStatement(contact.id, activity, contact.organizationId),
      ),
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
    /*
     * Both sides of the merge are scoped to the organization, not just the primary.
     *
     * `losers` resolves the duplicate ids *through* `crm_organization_contacts` filtered by
     * organization, so an id belonging to somebody else selects nothing and moves nothing. That
     * matters even though `CrmService.mergeContacts` already resolves every duplicate through
     * the organization-scoped `findContact`: scoping only the primary made this statement's
     * defence a claim rather than a fact, and a caller reaching the adapter directly could move
     * another organization's private history onto a contact here.
     */
    const list = duplicateIds.map(() => "?").join(",");
    const losers = `SELECT id FROM crm_organization_contacts WHERE id IN (${list}) AND organization_id = ?`;
    // `LIVE`, the same clause as everywhere else. It was a weaker, merge-local variant until the
    // activity insert started using the shared one, at which point a primary merged away
    // mid-flight let every move land while the record *of* the merge silently vanished — an
    // irreversible operation with nothing saying it happened. One clause refuses the batch whole.
    const owned = `AND ${D1CrmRepository.LIVE}`;
    await this.runBatch(
      [
        ...input.aliases.map((alias) =>
          this.database
            .prepare(
              `INSERT INTO crm_contact_aliases (id,contact_id,name,email,merged_from_id,merged_at) SELECT ?,?,?,?,?,? WHERE ${D1CrmRepository.LIVE}`,
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
            `UPDATE crm_contact_activities SET contact_id = ? WHERE contact_id IN (${losers}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, organizationId, primaryId, organizationId),
        // `OR IGNORE`: when both records were sourced into the same event, the primary already
        // holds that link and the loser's stays on the merged-away row rather than being
        // dropped. Nothing is deleted either way.
        this.database
          .prepare(
            `UPDATE OR IGNORE crm_contact_events SET contact_id = ? WHERE contact_id IN (${losers}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, organizationId, primaryId, organizationId),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO crm_contact_tags (contact_id,tag) SELECT ?, tag FROM crm_contact_tags WHERE contact_id IN (${losers}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, organizationId, primaryId, organizationId),
        this.database
          .prepare(
            `INSERT OR IGNORE INTO crm_contact_fields (contact_id,field_key,field_value) SELECT ?, field_key, field_value FROM crm_contact_fields WHERE contact_id IN (${losers}) ${owned}`,
          )
          .bind(primaryId, ...duplicateIds, organizationId, primaryId, organizationId),
        // Gated on the *primary* as well as the losers. Without it a foreign primary id retired
        // this organization's contacts — pointing them at a record nobody here can open, and
        // with no undo route — which is a worse outcome than the loser-side hole, not a lesser
        // one: the directory silently loses a live person.
        this.database
          .prepare(
            `UPDATE crm_organization_contacts SET merged_into_id = ?, updated_at = ? WHERE id IN (${list}) AND organization_id = ? AND merged_into_id IS NULL ${owned}`,
          )
          .bind(
            primaryId,
            input.activity.occurredAt,
            ...duplicateIds,
            organizationId,
            primaryId,
            organizationId,
          ),
        // Likewise: an ungated insert here wrote an activity row onto another organization's
        // contact, which is a cross-tenant write rather than a cross-tenant read. The shared
        // helper now carries that guard for every caller.
        this.contactActivityStatement(primaryId, input.activity, organizationId),
      ],
      "merge contacts atomically",
    );
    // `findContact` resolves merged-away rows on purpose, so a primary retired between the
    // service's check and this batch would otherwise be returned as a successful merge — every
    // statement a no-op, and the caller told the records were folded together.
    const merged = await this.findContact(organizationId, primaryId);
    if (!merged || merged.mergedIntoId) throw new ContactNotFoundError("Contact not found");
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
    /*
     * Records onto the survivor, following the merge pointer, rather than onto the id it was
     * given.
     *
     * This is the one write that must not simply refuse a merged-away contact. Its callers have
     * already done the thing being recorded — `sendOutreach` has a delivery id in hand by the
     * time it gets here — so dropping the entry loses the only trace of a message that was
     * genuinely sent. `COALESCE(merged_into_id, id)` lands it where the organizer will look:
     * the contact the merge kept.
     */
    await this.runBatch(
      entries.map(({ contactId, activity }) =>
        this.database
          .prepare(
            "INSERT INTO crm_contact_activities (id,contact_id,kind,summary,is_private,occurred_at,actor_id) SELECT ?,COALESCE(o.merged_into_id, o.id),?,?,?,?,? FROM crm_organization_contacts o WHERE o.id = ? AND o.organization_id = ?",
          )
          .bind(
            activity.id,
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

  async recordContactConversion(
    organizationId: string,
    contactId: string,
    eventId: string,
    activity: Omit<ContactActivity, "kind" | "summary">,
  ) {
    const summary = `Converted to a speaker on event ${eventId}`;
    const result = await this.database
      .prepare(
        `INSERT INTO crm_contact_activities (id,contact_id,kind,summary,is_private,occurred_at,actor_id)
         SELECT ?,COALESCE(o.merged_into_id,o.id),?,?,?,?,?
         FROM crm_organization_contacts o
         WHERE o.id=? AND o.organization_id=?
           AND NOT EXISTS (
             SELECT 1 FROM crm_contact_activities a
             WHERE a.contact_id=COALESCE(o.merged_into_id,o.id)
               AND a.kind='conversion' AND a.summary=?
           )`,
      )
      .bind(
        activity.id,
        "conversion",
        summary,
        activity.private ? 1 : 0,
        activity.occurredAt,
        activity.actorId,
        contactId,
        organizationId,
        summary,
      )
      .run();
    if (!result.success)
      throw new Error(`D1 failed to record contact conversion: ${result.error ?? "unknown error"}`);
  }

  async linkContactToEvent(input: {
    contact: OrganizationContact;
    prospect: Prospect;
    activity: ContactActivity;
  }) {
    const { contact, prospect } = input;
    /*
     * Every statement carries the same guard, the pipeline rows included.
     *
     * Gating only the link left the prospect behind when the guard refused: a row in the
     * event's pipeline that no directory link points at. That is reachable without a hostile
     * caller — a contact merged away between the service's read and this batch takes the same
     * path — and it produced a timeline claiming a sourcing that did not happen. Either the
     * whole sourcing lands or none of it does, which is what `LIVE` on all four gives.
     */
    const owns = [contact.id, contact.organizationId];
    await this.runBatch(
      [
        this.database
          .prepare(
            `INSERT INTO crm_prospects (id,event_id,name,stage,owner_id,next_action,next_action_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${D1CrmRepository.LIVE}`,
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
            ...owns,
          ),
        ...prospect.contacts.map((item) =>
          this.database
            .prepare(
              `INSERT INTO crm_contacts (id,prospect_id,name,email,is_primary) SELECT ?,?,?,?,? WHERE ${D1CrmRepository.LIVE}`,
            )
            .bind(item.id, prospect.id, item.name, item.email, item.isPrimary ? 1 : 0, ...owns),
        ),
        this.database
          .prepare(
            `INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) SELECT ?,?,?,? WHERE ${D1CrmRepository.LIVE}`,
          )
          .bind(contact.id, prospect.eventId, prospect.id, input.activity.occurredAt, ...owns),
        this.contactActivityStatement(contact.id, input.activity, contact.organizationId),
      ],
      "source the contact into the event atomically",
      // A double-submitted "Add to event": the second write meets `PRIMARY KEY (contact_id,
      // event_id)`, or the unique index that keeps one prospect to one contact. Reported as the
      // conflict it is rather than as a server fault.
      {
        when: /crm_contact_events/i,
        error: () =>
          new ContactAlreadySourcedError("This contact is already in that event's pipeline"),
      },
    );
  }

  async linkContactToExistingProspect(input: {
    contact: OrganizationContact;
    prospect: Prospect;
    activity: ContactActivity;
  }) {
    const { contact, prospect } = input;
    const owns = [contact.id, contact.organizationId];
    await this.runBatch(
      [
        this.database
          .prepare(
            `INSERT INTO crm_contact_events (contact_id,event_id,prospect_id,linked_at) SELECT ?,?,?,? WHERE ${D1CrmRepository.LIVE} AND EXISTS (SELECT 1 FROM crm_prospects p WHERE p.id=? AND p.event_id=?)`,
          )
          .bind(
            contact.id,
            prospect.eventId,
            prospect.id,
            input.activity.occurredAt,
            ...owns,
            prospect.id,
            prospect.eventId,
          ),
        this.contactActivityStatement(contact.id, input.activity, contact.organizationId),
      ],
      "link the contact to an existing event prospect atomically",
      {
        when: /crm_contact_events/i,
        error: () =>
          new ContactAlreadySourcedError("This contact is already in that event's pipeline"),
      },
    );
  }
}

/**
 * A stored filter definition, narrowed to the criteria this version understands.
 *
 * Every value is checked rather than asserted, because a row can predate the current shape and
 * nothing between here and the SQL re-validates it: an unreadable definition used to throw out
 * of `listSegments` as an untranslated 500, and since the workspace loads contacts, segments,
 * metrics and owners together, that took the whole directory page down over one bad row. A
 * definition that cannot be read now degrades to "no criteria" — the segment still opens, and
 * shows everybody rather than nothing, which is the safe direction for a saved view.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toFilters(definition: string): ContactSegment["filters"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    // ERROR-INTENT: an unreadable stored definition degrades to no criteria rather than failing the directory.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  /*
   * Bounds as well as types, and for the same reason the types are checked: the criteria are
   * echoed back inside `contactListResponseSchema` and `segmentListResponseSchema`, so a value
   * of the right type and the wrong size fails the client's decode exactly as an unparseable
   * row did. `contactFiltersSchema` is the authority on the numbers; the adapter layer declares
   * no contracts dependency, so they are restated rather than imported, and a mismatch would
   * show up as a decode failure in the segment tests.
   */
  const text = (key: string, max: number) => {
    const value = source[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length >= 1 && trimmed.length <= max ? trimmed : undefined;
  };
  const tags = Array.isArray(source.tags)
    ? source.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length >= 1 && tag.length <= 40)
        .slice(0, 20)
    : undefined;
  const eventId = text("eventId", 36);
  return {
    ...(text("search", 160) ? { search: text("search", 160) } : {}),
    ...(text("company", 160) ? { company: text("company", 160) } : {}),
    ...(text("title", 160) ? { title: text("title", 160) } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(text("fieldKey", 60) ? { fieldKey: text("fieldKey", 60) } : {}),
    ...(text("fieldValue", 300) ? { fieldValue: text("fieldValue", 300) } : {}),
    ...(eventId && UUID.test(eventId) ? { eventId } : {}),
  };
}

function toSegment(row: SegmentRow): ContactSegment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    filters: toFilters(row.definition_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
