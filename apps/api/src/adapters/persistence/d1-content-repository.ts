import {
  type AcceptedContent,
  ContentConflictError,
  type ContentEdit,
  type ContentRepository,
  type ContentRevisionDraft,
  type SpeakerWorkflowFields,
} from "../../application/content/content-repository";
import type { AgendaContentQuery, PublishingContentQuery } from "../../application/content/public";
import type {
  ContentComment,
  ContentRevision,
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerMessage,
  SpeakerProfile,
  SpeakerResource,
  SpeakerTask,
} from "../../domain/content/content";

/**
 * How many rows a statement actually touched.
 *
 * Load-bearing rather than diagnostic: a conditional write that matched nothing is a *success*
 * in D1, so without this an `UPDATE … WHERE <no longer true>` and a real write are the same
 * answer — which is how a write that changed nothing gets reported as one that did.
 */
interface D1Meta {
  changes?: number;
}
interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: D1Meta;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T>(): Promise<D1Result<T>>;
}
export interface ContentDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1Result<T>>>;
}

/** A `WHERE` clause and the values it binds, so a guard can be shared by two statements. */
interface RowGuard {
  sql: string;
  values: unknown[];
}

/**
 * Exactly the columns `profileWrite` and `sessionWrite` rewrite.
 *
 * These lists are what a revised edit compares against to decide whether the row moved under
 * it. A column added to one of those writes and not to the list here is a column a concurrent
 * writer can change without this noticing, so the two belong next to each other.
 */
const PROFILE_WRITTEN_COLUMNS = [
  "name",
  "bio",
  "pronouns",
  "organization",
  "photo_asset_id",
  "workflow_status",
  "logistics_json",
  "custom_fields_json",
] as const;
const SESSION_WRITTEN_COLUMNS = [
  "title",
  "abstract",
  "format",
  "speaker_profile_ids",
  "tags",
  "tracks",
  "publication_state",
] as const;

type Row = Record<string, string | null>;
const parse = <T>(value: string | null | undefined) => JSON.parse(value ?? "[]") as T;

export class D1ContentRepository
  implements ContentRepository, AgendaContentQuery, PublishingContentQuery
{
  constructor(private readonly database: ContentDatabasePort) {}
  async findSpeakerImport(eventId: string, email: string) {
    const row = (
      await this.rows(
        "SELECT status FROM content_speaker_import_rows WHERE event_id=? AND normalized_email=? LIMIT 1",
        eventId,
        email,
      )
    )[0];
    return row ? (row.status as "pending" | "complete") : null;
  }
  async beginSpeakerImport(eventId: string, email: string) {
    await this.run(
      "INSERT OR IGNORE INTO content_speaker_import_rows (event_id,normalized_email,status) VALUES (?,?,'pending')",
      eventId,
      email,
    );
  }
  async completeSpeakerImport(eventId: string, email: string) {
    await this.run(
      "UPDATE content_speaker_import_rows SET status='complete' WHERE event_id=? AND normalized_email=?",
      eventId,
      email,
    );
  }
  async listSchedulableSessions(eventId: string) {
    const sessions = await this.rows(
      "SELECT id, title, speaker_profile_ids, tracks FROM content_sessions WHERE event_id = ? ORDER BY title",
      eventId,
    );
    return sessions
      .map((row) => ({
        id: row.id ?? "",
        title: row.title ?? "",
        speakerProfileIds: parse<string[]>(row.speaker_profile_ids),
        tracks: parse<string[]>(row.tracks),
      }))
      .map(({ id, title, speakerProfileIds, tracks }) => ({
        id,
        title,
        speakerProfileIds,
        tracks,
      }));
  }
  async publishedEventContent(eventId: string) {
    const workspace = await this.workspace(eventId);
    const sessions = workspace.sessions
      .filter(({ publicationState }) => publicationState === "published")
      .map(({ id, title, abstract, format, speakerProfileIds, tags, tracks }) => ({
        id,
        title,
        abstract,
        format,
        speakerProfileIds,
        tags,
        tracks,
      }));
    const speakerIds = new Set(sessions.flatMap(({ speakerProfileIds }) => speakerProfileIds));
    return {
      sessions,
      speakers: workspace.speakers
        .filter(({ id }) => speakerIds.has(id))
        .map(({ id, name, bio, pronouns, organization, photoAssetId }) => ({
          id,
          name,
          bio,
          pronouns,
          organization,
          ...(photoAssetId ? { photoAssetId } : {}),
        })),
      assets: workspace.assets
        .filter(
          ({ speakerProfileId, visibility }) =>
            speakerIds.has(speakerProfileId) && visibility === "publishable",
        )
        .map(({ id, speakerProfileId, name, contentType }) => ({
          id,
          speakerProfileId,
          name,
          contentType,
        })),
    };
  }
  private async rows(query: string, ...values: unknown[]): Promise<Row[]> {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .all<Row>();
    if (!result.success)
      throw new Error(`D1 content query failed: ${result.error ?? "unknown error"}`);
    return result.results ?? [];
  }
  private async run(query: string, ...values: unknown[]) {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .run();
    if (!result.success)
      throw new Error(`D1 content write failed: ${result.error ?? "unknown error"}`);
  }
  async findSessionByProposal(eventId: string, proposalId: string): Promise<ContentSession | null> {
    const row = (
      await this.rows(
        "SELECT * FROM content_sessions WHERE event_id = ? AND proposal_id = ? LIMIT 1",
        eventId,
        proposalId,
      )
    )[0];
    return row ? this.session(row) : null;
  }
  async accept(content: AcceptedContent): Promise<void> {
    const session = content.session;
    const statements = [
      this.database
        .prepare(
          "INSERT INTO content_sessions (id,event_id,proposal_id,title,abstract,format,speaker_profile_ids,tags,tracks,publication_state) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          session.id,
          session.eventId,
          session.proposalId,
          session.title,
          session.abstract,
          session.format,
          JSON.stringify(session.speakerProfileIds),
          JSON.stringify(session.tags),
          JSON.stringify(session.tracks),
          session.publicationState,
        ),
      ...content.speakers.map((profile) =>
        this.database
          .prepare(
            "INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id,workflow_status,logistics_json,custom_fields_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            profile.id,
            profile.eventId,
            profile.userId,
            profile.sourcePersonId,
            profile.name,
            profile.email,
            profile.bio,
            profile.pronouns,
            profile.organization,
            profile.photoAssetId ?? null,
            profile.workflowStatus ?? "onboarding",
            JSON.stringify(profile.logistics ?? {}),
            JSON.stringify(profile.customFields ?? {}),
          ),
      ),
      ...content.tasks.map((task) =>
        this.database
          .prepare(
            "INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at,task_type,instructions,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            task.id,
            task.eventId,
            task.speakerProfileId,
            task.title,
            task.dueAt,
            task.status,
            task.completedAt ?? null,
            task.type ?? "general",
            task.instructions ?? "",
            task.sessionId ?? null,
          ),
      ),
      ...content.messages.map((message) =>
        this.database
          .prepare(
            "INSERT INTO speaker_messages (id,event_id,speaker_profile_id,subject,sent_at) VALUES (?,?,?,?,?)",
          )
          .bind(
            message.id,
            message.eventId,
            message.speakerProfileId,
            message.subject,
            message.sentAt,
          ),
      ),
    ];
    try {
      const results = await this.database.batch(statements);
      const failed = results.find((result) => !result.success);
      if (failed) {
        if (failed.error?.includes("UNIQUE constraint failed"))
          throw new ContentConflictError(failed.error);
        throw new Error(`D1 content acceptance failed: ${failed.error ?? "unknown error"}`);
      }
    } catch (error) {
      if (error instanceof ContentConflictError) throw error;
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed"))
        throw new ContentConflictError(error.message);
      throw error;
    }
  }
  async workspace(eventId: string, userId?: string): Promise<ContentWorkspace> {
    const profileRows = await this.rows(
      `SELECT * FROM speaker_profiles WHERE event_id = ?${userId ? " AND user_id = ?" : ""} ORDER BY name`,
      eventId,
      ...(userId ? [userId] : []),
    );
    const speakers = profileRows.map((row) => this.profile(row));
    if (userId && speakers.length === 0)
      return {
        sessions: [],
        speakers: [],
        tasks: [],
        assets: [],
        messages: [],
        resources: [],
        comments: [],
        revisions: [],
      };
    const scoped = <T>(table: string, order: string, map: (row: Row) => T) =>
      this.rows(
        `SELECT owned.* FROM ${table} AS owned INNER JOIN speaker_profiles AS profile ON profile.id = owned.speaker_profile_id WHERE owned.event_id = ? AND profile.event_id = owned.event_id AND profile.user_id = ? ORDER BY ${order}`,
        eventId,
        userId,
      ).then((rows) => rows.map(map));
    const sessions = (
      await this.rows(
        userId
          ? "SELECT DISTINCT session.* FROM content_sessions AS session, json_each(session.speaker_profile_ids) AS speaker INNER JOIN speaker_profiles AS profile ON profile.id = speaker.value WHERE session.event_id = ? AND profile.event_id = session.event_id AND profile.user_id = ? ORDER BY session.title"
          : "SELECT * FROM content_sessions WHERE event_id = ? ORDER BY title",
        eventId,
        ...(userId ? [userId] : []),
      )
    ).map((row) => this.session(row));
    const tasks = userId
      ? await scoped("speaker_tasks", "due_at,title", (row) => this.task(row))
      : (
          await this.rows(
            "SELECT * FROM speaker_tasks WHERE event_id = ? ORDER BY due_at,title",
            eventId,
          )
        ).map((row) => this.task(row));
    const assets = userId
      ? await scoped("speaker_assets", "uploaded_at", (row) => this.asset(row))
      : (
          await this.rows(
            "SELECT * FROM speaker_assets WHERE event_id = ? ORDER BY uploaded_at",
            eventId,
          )
        ).map((row) => this.asset(row));
    const messages = userId
      ? await scoped("speaker_messages", "sent_at", (row) => this.message(row))
      : (
          await this.rows(
            "SELECT * FROM speaker_messages WHERE event_id = ? ORDER BY sent_at",
            eventId,
          )
        ).map((row) => this.message(row));
    const resources = (
      await this.rows(
        `SELECT * FROM speaker_resources WHERE event_id = ?${userId ? " AND visibility = 'visible'" : ""} ORDER BY sort_order,title`,
        eventId,
      )
    ).map((row) => this.resource(row));
    const comments = (
      await this.rows(
        userId
          ? "SELECT comment.* FROM content_asset_comments comment INNER JOIN speaker_assets asset ON asset.id=comment.asset_id INNER JOIN speaker_profiles profile ON profile.id=asset.speaker_profile_id WHERE comment.event_id=? AND profile.user_id=? ORDER BY comment.created_at"
          : "SELECT * FROM content_asset_comments WHERE event_id=? ORDER BY created_at",
        eventId,
        ...(userId ? [userId] : []),
      )
    ).map((row) => this.comment(row));
    const revisions = userId
      ? []
      : (
          await this.rows(
            // Timestamp first, then the entity's own numbering. Two revisions of one record can
            // legitimately share an instant — a retried edit is stamped no earlier than the
            // revision it follows — and SQLite's sort is not stable, so without the tiebreak the
            // console could list revision 2 above revision 1 with both numbers on screen.
            "SELECT * FROM content_revisions WHERE event_id=? ORDER BY created_at,entity_type,entity_id,revision_number",
            eventId,
          )
        ).map((row) => this.revision(row));
    return { sessions, speakers, tasks, assets, messages, resources, comments, revisions };
  }
  private profileWrite(profile: SpeakerProfile, where?: RowGuard): D1Statement {
    return this.database
      .prepare(
        `UPDATE speaker_profiles SET name=?,bio=?,pronouns=?,organization=?,photo_asset_id=?,workflow_status=?,logistics_json=?,custom_fields_json=? WHERE ${where?.sql ?? "id=?"}`,
      )
      .bind(
        profile.name,
        profile.bio,
        profile.pronouns,
        profile.organization,
        profile.photoAssetId ?? null,
        profile.workflowStatus ?? "onboarding",
        JSON.stringify(profile.logistics ?? {}),
        JSON.stringify(profile.customFields ?? {}),
        ...(where?.values ?? [profile.id]),
      );
  }
  async updateProfile(profile: SpeakerProfile) {
    const result = await this.profileWrite(profile).run();
    if (!result.success)
      throw new Error(`D1 content write failed: ${result.error ?? "unknown error"}`);
  }
  async updateProfilePhoto(profileId: string, assetId: string | null) {
    await this.run("UPDATE speaker_profiles SET photo_asset_id=? WHERE id=?", assetId, profileId);
  }
  async updateProfileWorkflow(profileId: string, fields: SpeakerWorkflowFields) {
    await this.run(
      "UPDATE speaker_profiles SET workflow_status=?,logistics_json=?,custom_fields_json=? WHERE id=?",
      fields.workflowStatus,
      JSON.stringify(fields.logistics),
      JSON.stringify(fields.customFields),
      profileId,
    );
  }
  async updateTask(task: SpeakerTask) {
    await this.run(
      "UPDATE speaker_tasks SET status=?,completed_at=? WHERE id=?",
      task.status,
      task.completedAt ?? null,
      task.id,
    );
  }
  private sessionWrite(session: ContentSession, where?: RowGuard): D1Statement {
    return this.database
      .prepare(
        `UPDATE content_sessions SET title=?,abstract=?,format=?,speaker_profile_ids=?,tags=?,tracks=?,publication_state=? WHERE ${where?.sql ?? "id=?"}`,
      )
      .bind(
        session.title,
        session.abstract,
        session.format,
        JSON.stringify(session.speakerProfileIds),
        JSON.stringify(session.tags),
        JSON.stringify(session.tracks),
        session.publicationState,
        ...(where?.values ?? [session.id]),
      );
  }
  async updateSession(session: ContentSession) {
    const result = await this.sessionWrite(session).run();
    if (!result.success)
      throw new Error(`D1 content write failed: ${result.error ?? "unknown error"}`);
  }
  async deleteSession(sessionId: string) {
    await this.run("DELETE FROM content_sessions WHERE id=?", sessionId);
  }
  async updateAsset(asset: SpeakerAsset) {
    await this.run(
      "UPDATE speaker_assets SET visibility=?,task_id=?,session_id=?,version_group_id=?,version_number=?,is_latest=? WHERE id=?",
      asset.visibility,
      asset.taskId ?? null,
      asset.sessionId ?? null,
      asset.versionGroupId ?? asset.id,
      asset.versionNumber ?? 1,
      asset.isLatest === false ? 0 : 1,
      asset.id,
    );
  }
  async addAsset(asset: SpeakerAsset) {
    await this.run(
      "INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at,task_id,session_id,version_group_id,version_number,is_latest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      asset.id,
      asset.eventId,
      asset.speakerProfileId,
      asset.name,
      asset.contentType,
      asset.storageKey,
      asset.visibility,
      asset.uploadedAt,
      asset.taskId ?? null,
      asset.sessionId ?? null,
      asset.versionGroupId ?? asset.id,
      asset.versionNumber ?? 1,
      asset.isLatest === false ? 0 : 1,
    );
  }
  async replaceLatestAsset(asset: SpeakerAsset, previous?: SpeakerAsset) {
    const statements: D1Statement[] = [];
    if (previous)
      statements.push(
        this.database.prepare("UPDATE speaker_assets SET is_latest=0 WHERE id=?").bind(previous.id),
      );
    statements.push(
      this.database
        .prepare(
          "INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at,task_id,session_id,version_group_id,version_number,is_latest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          asset.id,
          asset.eventId,
          asset.speakerProfileId,
          asset.name,
          asset.contentType,
          asset.storageKey,
          asset.visibility,
          asset.uploadedAt,
          asset.taskId ?? null,
          asset.sessionId ?? null,
          asset.versionGroupId ?? asset.id,
          asset.versionNumber ?? 1,
          1,
        ),
    );
    const results = await this.database.batch(statements);
    if (results.some((result) => !result.success))
      throw new Error("Content asset version batch failed");
  }
  async deleteAsset(assetId: string) {
    const asset = await this.findAsset(assetId);
    const statements = [
      this.database.prepare("DELETE FROM content_asset_comments WHERE asset_id=?").bind(assetId),
      this.database.prepare("DELETE FROM speaker_assets WHERE id=?").bind(assetId),
    ];
    if (asset?.isLatest !== false && asset?.versionGroupId)
      statements.push(
        this.database
          .prepare(
            "UPDATE speaker_assets SET is_latest=1 WHERE id=(SELECT id FROM speaker_assets WHERE version_group_id=? AND id<>? ORDER BY version_number DESC LIMIT 1)",
          )
          .bind(asset.versionGroupId, assetId),
      );
    const results = await this.database.batch(statements);
    if (results.some((result) => !result.success))
      throw new Error("Content asset deletion batch failed");
  }
  async addTask(task: SpeakerTask) {
    await this.run(
      "INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at,task_type,instructions,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      task.id,
      task.eventId,
      task.speakerProfileId,
      task.title,
      task.dueAt,
      task.status,
      task.completedAt ?? null,
      task.type ?? "general",
      task.instructions ?? "",
      task.sessionId ?? null,
    );
  }
  async addTasks(tasks: readonly SpeakerTask[]) {
    const results = await this.database.batch(
      tasks.map((task) =>
        this.database
          .prepare(
            "INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at,task_type,instructions,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            task.id,
            task.eventId,
            task.speakerProfileId,
            task.title,
            task.dueAt,
            task.status,
            task.completedAt ?? null,
            task.type ?? "general",
            task.instructions ?? "",
            task.sessionId ?? null,
          ),
      ),
    );
    if (results.some((result) => !result.success)) throw new Error("Content task batch failed");
  }
  async addMessage(message: SpeakerMessage) {
    await this.run(
      "INSERT INTO speaker_messages (id,event_id,speaker_profile_id,subject,sent_at) VALUES (?,?,?,?,?)",
      message.id,
      message.eventId,
      message.speakerProfileId,
      message.subject,
      message.sentAt,
    );
  }
  async findProfile(profileId: string) {
    const row = (
      await this.rows("SELECT * FROM speaker_profiles WHERE id = ? LIMIT 1", profileId)
    )[0];
    return row ? this.profile(row) : null;
  }
  async findSession(sessionId: string) {
    const row = (
      await this.rows("SELECT * FROM content_sessions WHERE id = ? LIMIT 1", sessionId)
    )[0];
    return row ? this.session(row) : null;
  }
  async findAsset(assetId: string) {
    const row = (await this.rows("SELECT * FROM speaker_assets WHERE id = ? LIMIT 1", assetId))[0];
    return row ? this.asset(row) : null;
  }
  async findProfileBySource(eventId: string, sourcePersonId: string) {
    const row = (
      await this.rows(
        "SELECT * FROM speaker_profiles WHERE event_id = ? AND source_person_id = ? LIMIT 1",
        eventId,
        sourcePersonId,
      )
    )[0];
    return row ? this.profile(row) : null;
  }
  async addResource(resource: SpeakerResource) {
    await this.run(
      "INSERT INTO speaker_resources (id,event_id,title,slug,body_html,embed_html,visibility,sort_order) VALUES (?,?,?,?,?,?,?,?)",
      resource.id,
      resource.eventId,
      resource.title,
      resource.slug,
      resource.bodyHtml,
      resource.embedHtml,
      resource.visibility,
      resource.sortOrder,
    );
  }
  async updateResource(resource: SpeakerResource) {
    await this.run(
      "UPDATE speaker_resources SET title=?,slug=?,body_html=?,embed_html=?,visibility=?,sort_order=? WHERE id=?",
      resource.title,
      resource.slug,
      resource.bodyHtml,
      resource.embedHtml,
      resource.visibility,
      resource.sortOrder,
      resource.id,
    );
  }
  async deleteResource(resourceId: string) {
    await this.run("DELETE FROM speaker_resources WHERE id=?", resourceId);
  }
  async findResource(resourceId: string) {
    const row = (
      await this.rows("SELECT * FROM speaker_resources WHERE id=? LIMIT 1", resourceId)
    )[0];
    return row ? this.resource(row) : null;
  }
  async addComment(comment: ContentComment) {
    await this.run(
      "INSERT INTO content_asset_comments (id,event_id,asset_id,author_id,author_name,body,created_at) VALUES (?,?,?,?,?,?,?)",
      comment.id,
      comment.eventId,
      comment.assetId,
      comment.authorId,
      comment.authorName,
      comment.body,
      comment.createdAt,
    );
  }
  /**
   * Run a batch as the single transaction D1 makes it, and report a failed statement rather
   * than raise it.
   *
   * A batch reports a bad statement two ways — an unsuccessful result, or a rejected promise —
   * and the caller has to distinguish "another writer took this revision number", which is
   * retried, from "the canonical write is invalid", which is not. Both arrive as a message, so
   * both leave as one.
   */
  private async batch(
    statements: D1Statement[],
  ): Promise<{ failure: string } | { changes: number[] }> {
    try {
      const results = await this.database.batch(statements);
      const failed = results.find((result) => !result.success);
      // A failure the driver did not describe is still a failure. Reading `error` alone would
      // turn `{ success: false }` into "nothing went wrong" and hand back a write that never
      // landed, which is the class of defect this whole operation exists to remove.
      if (failed) return { failure: failed.error ?? "unknown error" };
      // A driver that cannot say how many rows it touched is a failure too, and specifically not
      // a retry. Reading a missing count as zero would send a write that *did* land back around
      // the loop to be attempted a second time under the same revision id — reporting an edit
      // that succeeded as a primary-key fault. Silence about the count is not evidence of none.
      const changes = results.map((result) => result.meta?.changes);
      if (changes.some((count) => typeof count !== "number"))
        return { failure: "D1 reported no row count for a content revision batch" };
      return { changes: changes as number[] };
    } catch (error) {
      // ERROR-INTENT: returned to the caller, which decides between a retry and a throw; the
      // driver's message is carried whole into whichever it picks.
      return { failure: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * `WHERE` clause matching a row only while every column this repository rewrites still holds
   * the value the caller just read.
   *
   * Built from the raw row rather than the mapped entity on purpose: `logistics_json` is
   * compared as the bytes SQLite stores, so re-serializing a parsed object with different key
   * order cannot read as a change that did not happen. `IS` rather than `=` so a `NULL` column
   * — an absent headshot — compares equal to itself instead of to nothing.
   */
  private unchanged(columns: readonly string[], row: Row): RowGuard {
    return {
      sql: `id=?${columns.map((column) => ` AND ${column} IS ?`).join("")}`,
      values: [row.id ?? null, ...columns.map((column) => row[column] ?? null)],
    };
  }

  /**
   * Append the revision and apply the edit in one D1 batch, which is one transaction.
   *
   * Neither write can outlive the other: a canonical update a constraint rejects takes its
   * revision down with it, which is what stops history from claiming an edit that never
   * happened.
   *
   * Both statements carry the same guard — this row, still exactly as it was read — so the pair
   * is a compare-and-swap, and three different losses collapse into one answer of "nothing
   * happened, look again":
   *
   * - the row was **deleted** after the read. Without the guard the `UPDATE` would match no
   *   rows, which D1 reports as success, and the revision would survive describing an edit to
   *   something that no longer exists.
   * - the row was **changed by a writer that records no revision** — a headshot, an import.
   *   Without the guard this write would put every column back the way it read them, silently
   *   reverting that change, and the snapshot would name a state the row had already left.
   * - the row was **changed by another revised edit**, which also took the next revision number
   *   and so trips `UNIQUE(entity_type, entity_id, revision_number)` as well.
   *
   * Each is retried against a re-read row, so the losing edit lands on top of the winner rather
   * than reverting it, and both keep attributed history. A row that has genuinely gone answers
   * `null` on the next read. Only a writer that loses five times running gives up, and it says
   * so with a conflict rather than a silent no-op.
   */
  private async revise<T>(
    entityType: ContentRevision["entityType"],
    entityId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<T>,
    table: string,
    guarded: readonly string[],
    read: (row: Row) => T,
    write: (next: T, where: RowGuard) => D1Statement,
  ): Promise<T | null> {
    let lastFailure = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = (
        await this.rows(
          `SELECT owned.*, (SELECT COALESCE(MAX(revision_number),0) FROM content_revisions WHERE entity_type=? AND entity_id=owned.id) AS latest_revision, (SELECT MAX(created_at) FROM content_revisions WHERE entity_type=? AND entity_id=owned.id) AS latest_created_at FROM ${table} AS owned WHERE owned.id=? LIMIT 1`,
          entityType,
          entityType,
          entityId,
        )
      )[0];
      if (!row) return null;
      const current = read(row);
      const next = edit(current);
      const where = this.unchanged(guarded, row);
      const result = await this.batch([
        this.database
          .prepare(
            `INSERT INTO content_revisions (id,event_id,entity_type,entity_id,revision_number,snapshot_json,actor_id,created_at,restored_from_revision_id) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM ${table} WHERE ${where.sql})`,
          )
          .bind(
            draft.id,
            draft.eventId,
            entityType,
            entityId,
            Number(row.latest_revision ?? 0) + 1,
            JSON.stringify(current),
            draft.actorId,
            // Never earlier than the revision it follows. The draft is stamped when the actor
            // asked, which a retry does not change, so two editors a millisecond apart could
            // otherwise leave the history reading out of order in the console that lists it.
            row.latest_created_at && row.latest_created_at > draft.createdAt
              ? row.latest_created_at
              : draft.createdAt,
            draft.restoredFromRevisionId ?? null,
            ...where.values,
          ),
        write(next, where),
      ]);
      if ("changes" in result) {
        if (result.changes[0] === 1) return next;
        continue;
      }
      lastFailure = result.failure;
      // The composite guard names all three of its columns; the primary key names only `id`, so
      // a duplicated revision id is a fault to report rather than contention to retry.
      if (!/UNIQUE constraint failed:[^\n]*content_revisions\.revision_number/.test(lastFailure))
        throw new Error(`D1 content revision failed: ${lastFailure}`);
    }
    throw new ContentConflictError(
      "This record is being edited by someone else. Reload and try again.",
      // ERROR-INTENT: the driver's own message is kept as the cause. The message above is the
      // one a 409 shows an organizer, and it must not leak SQL; an operator still needs to see
      // which guard did the refusing.
      lastFailure ? { cause: new Error(lastFailure) } : undefined,
    );
  }

  async reviseProfile(
    profileId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<SpeakerProfile>,
  ) {
    return this.revise(
      "profile",
      profileId,
      draft,
      edit,
      "speaker_profiles",
      PROFILE_WRITTEN_COLUMNS,
      (row) => this.profile(row),
      (next, where) => this.profileWrite(next, where),
    );
  }

  async reviseSession(
    sessionId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<ContentSession>,
  ) {
    return this.revise(
      "session",
      sessionId,
      draft,
      edit,
      "content_sessions",
      SESSION_WRITTEN_COLUMNS,
      (row) => this.session(row),
      (next, where) => this.sessionWrite(next, where),
    );
  }
  async findRevision(revisionId: string) {
    const row = (
      await this.rows("SELECT * FROM content_revisions WHERE id=? LIMIT 1", revisionId)
    )[0];
    return row ? this.revision(row) : null;
  }
  private session(row: Row): ContentSession {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      proposalId: row.proposal_id ?? "",
      title: row.title ?? "",
      abstract: row.abstract ?? "",
      format: row.format ?? "",
      speakerProfileIds: parse<string[]>(row.speaker_profile_ids),
      tags: parse<string[]>(row.tags),
      tracks: parse<string[]>(row.tracks),
      publicationState: (row.publication_state ?? "draft") as ContentSession["publicationState"],
    };
  }
  private profile(row: Row): SpeakerProfile {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      userId: row.user_id ?? "",
      sourcePersonId: row.source_person_id ?? "",
      name: row.name ?? "",
      email: row.email ?? "",
      bio: row.bio ?? "",
      pronouns: row.pronouns ?? "",
      organization: row.organization ?? "",
      ...(row.photo_asset_id ? { photoAssetId: row.photo_asset_id } : {}),
      workflowStatus: (row.workflow_status ?? "onboarding") as SpeakerProfile["workflowStatus"],
      logistics: parse<Record<string, string>>(row.logistics_json ?? "{}"),
      customFields: parse<Record<string, string>>(row.custom_fields_json ?? "{}"),
    };
  }
  private task(row: Row): SpeakerTask {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      speakerProfileId: row.speaker_profile_id ?? "",
      title: row.title ?? "",
      dueAt: row.due_at ?? "",
      status: (row.status ?? "open") as SpeakerTask["status"],
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      type: (row.task_type ?? "general") as SpeakerTask["type"],
      instructions: row.instructions ?? "",
      ...(row.session_id ? { sessionId: row.session_id } : {}),
    };
  }
  private asset(row: Row): SpeakerAsset {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      speakerProfileId: row.speaker_profile_id ?? "",
      name: row.name ?? "",
      contentType: row.content_type ?? "",
      storageKey: row.storage_key ?? "",
      visibility: (row.visibility ?? "private") as SpeakerAsset["visibility"],
      uploadedAt: row.uploaded_at ?? "",
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.version_group_id ? { versionGroupId: row.version_group_id } : {}),
      versionNumber: Number(row.version_number ?? 1),
      isLatest: Number(row.is_latest ?? 1) === 1,
    };
  }
  private message(row: Row): SpeakerMessage {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      speakerProfileId: row.speaker_profile_id ?? "",
      subject: row.subject ?? "",
      sentAt: row.sent_at ?? "",
    };
  }
  private resource(row: Row): SpeakerResource {
    return {
      id: String(row.id ?? ""),
      eventId: String(row.event_id ?? ""),
      title: String(row.title ?? ""),
      slug: String(row.slug ?? ""),
      bodyHtml: String(row.body_html ?? ""),
      embedHtml: String(row.embed_html ?? ""),
      visibility: String(row.visibility ?? "hidden") as SpeakerResource["visibility"],
      sortOrder: Number(row.sort_order ?? 0),
    };
  }
  private comment(row: Row): ContentComment {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      assetId: row.asset_id ?? "",
      authorId: row.author_id ?? "",
      authorName: row.author_name ?? "",
      body: row.body ?? "",
      createdAt: row.created_at ?? "",
    };
  }
  private revision(row: Row): ContentRevision {
    return {
      id: row.id ?? "",
      eventId: row.event_id ?? "",
      entityType: (row.entity_type ?? "profile") as ContentRevision["entityType"],
      entityId: row.entity_id ?? "",
      revisionNumber: Number(row.revision_number ?? 1),
      snapshotJson: row.snapshot_json ?? "{}",
      actorId: row.actor_id ?? "",
      createdAt: row.created_at ?? "",
      ...(row.restored_from_revision_id
        ? { restoredFromRevisionId: row.restored_from_revision_id }
        : {}),
    };
  }
}
