import {
  type AcceptedContent,
  ContentConflictError,
  type ContentEdit,
  type ContentRepository,
  type ContentRevisionDraft,
  type SpeakerWorkflowFields,
} from "../../application/content/content-repository";
import type {
  AgendaContentQuery,
  CommunicationsContentQuery,
  PublishingContentQuery,
} from "../../application/content/public";
import {
  type ContentComment,
  type ContentRevision,
  type ContentSession,
  type ContentWorkspace,
  logicalAssetKey,
  type SpeakerAsset,
  type SpeakerSocialLinks,
  type SpeakerMessage,
  type SpeakerProfile,
  type SpeakerResource,
  type SpeakerTask,
  type SpeakerTaskTemplate,
} from "../../domain/content/content";
import { changedRows, type D1WriteResult } from "./d1-write-result";

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  error?: string;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<D1WriteResult & { results?: T[] }>;
  all<T>(): Promise<D1Result<T>>;
}
export interface ContentDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<Array<D1WriteResult & { results?: T[] }>>;
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
  "job_title",
  "organization",
  "photo_asset_id",
  "workflow_status",
  "logistics_json",
  "custom_fields_json",
  "social_links_json",
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
  implements
    ContentRepository,
    AgendaContentQuery,
    PublishingContentQuery,
    CommunicationsContentQuery
{
  constructor(private readonly database: ContentDatabasePort) {}
  /**
   * Open speaker tasks falling due at or before `dueBefore`, across every event.
   *
   * `CommunicationsContentQuery`; the reminder rules in issue #52 are the only caller, and they
   * run from a cron tick with no event in hand. Ordered by `due_at` so that a `limit` short of
   * the whole backlog reminds about the most overdue work first rather than an arbitrary slice,
   * and bounded because a cron invocation has a finite subrequest budget.
   *
   * The join drops a task whose profile carries no address: there is nobody to remind.
   */
  async listOpenSpeakerWork(dueBefore: string, limit: number) {
    return (
      await this.rows(
        `SELECT t.id AS task_id, t.event_id, t.speaker_profile_id, t.title, t.due_at,
                p.user_id, p.name, p.email
           FROM speaker_tasks t
           JOIN speaker_profiles p ON p.id = t.speaker_profile_id
          WHERE t.status = 'open' AND t.due_at <= ? AND p.email <> ''
          ORDER BY t.due_at, t.id
          LIMIT ?`,
        dueBefore,
        limit,
      )
    ).map((row) => ({
      eventId: String(row.event_id),
      profileId: String(row.speaker_profile_id),
      userId: String(row.user_id),
      speakerName: String(row.name),
      email: String(row.email),
      taskId: String(row.task_id),
      title: String(row.title),
      dueAt: String(row.due_at),
    }));
  }
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
    const result = await this.write(
      "UPDATE content_speaker_import_rows SET status='complete' WHERE event_id=? AND normalized_email=?",
      eventId,
      email,
    );
    return changedRows(result, "complete a speaker import row") > 0;
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
        .map(({ id, name, bio, pronouns, jobTitle, organization, photoAssetId, socialLinks }) => ({
          id,
          name,
          bio,
          pronouns,
          ...(jobTitle ? { jobTitle } : {}),
          organization,
          ...(photoAssetId ? { photoAssetId } : {}),
          // Omitted rather than sent empty, so a speaker with no links adds no key to the
          // published snapshot and two publishes of the same programme stay identical bytes.
          ...(socialLinks && Object.keys(socialLinks).length > 0 ? { socialLinks } : {}),
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
    await this.write(query, ...values);
  }
  /**
   * `run`, for the writers whose correctness depends on how many rows they touched.
   *
   * A conditional write matching no row and a write that landed are both `success: true`; only
   * `meta.changes` separates them, and a driver that omits the count is refused rather than read
   * as either (`d1-write-result.ts`). The gap between a caller's read and its write is where
   * another organizer's delete lands, and without the count, editing something that has gone
   * answers 200 and announces "saved" over a projection that does not contain it.
   *
   * SQLite counts a row it rewrote to the same values as changed, so this distinguishes "no such
   * row" from "no visible difference" rather than refusing an edit that changed nothing.
   *
   * **There is no one-line rule for which writers come through here, and three attempts at
   * writing one were each wrong** (issue #202, the second filing of the same divergence).
   * "Every conditional writer", "every writer that addresses one row by id" and "every writer
   * whose caller reports success to a person" were all published in this comment and all refuted
   * by review — the last two by the very list below them. So what follows is the file, by
   * category, with the reason each is where it is. It is meant to be checked, not summarised.
   *
   * - **Reads the count and answers with it**: `updateProfilePhoto`, `updateProfileWorkflow`,
   *   `updateTask`, `updateAsset`, `updateResource`, `updateTaskTemplate`, `completeSpeakerImport`.
   *   Each is a single guarded `UPDATE` whose callers read the row first and then tell somebody
   *   it saved. That combination is what the count is for. (`updateProfilePhoto` has one further
   *   call site, inside asset deletion, that deliberately discards the answer and says so at that
   *   line — the method still reads and returns it.)
   * - **Reads the count and deliberately discards it**: `deleteSession`, `deleteResource`,
   *   `deleteTaskTemplate`. A row already gone is the outcome the caller asked for, so zero is
   *   not a failure — but a driver that cannot report a count still is, which is the half worth
   *   keeping.
   * - **Plain inserts**, whose failure mode is a raised constraint rather than a quiet zero, and
   *   the two `ON CONFLICT DO UPDATE` upserts, which converge by design. `beginSpeakerImport` is
   *   an `INSERT OR IGNORE` and so *does* converge on a quiet zero — deliberately: it claims the
   *   ledger row, and a row another attempt already claimed is the same outcome. Its caller reads
   *   the state back through `findSpeakerImport` rather than inferring it from a count.
   * - **The batch paths, which read only `success`**: `accept` and `addTasks` are inserts.
   *   `deleteAsset` carries a conditional promotion whose `WHERE id=(SELECT … LIMIT 1)` matches
   *   nothing when there is no earlier version to promote, which is an ordinary state.
   *   `replaceLatestAsset` is the interesting one: its demotion is `WHERE id=?` against the
   *   version it means to replace, and a zero there would be a lost write. It is left without a
   *   count because **storage refuses the batch instead** — `speaker_assets_latest_unique`
   *   (migration `1403`) is a partial unique index on `version_group_id`
   *   `WHERE version_group_id IS NOT NULL AND is_latest=1`, and the group is never null here
   *   because the insert binds `versionGroupId ?? id` — so an insert that lands beside a row the
   *   demotion failed to clear violates it and D1 **rejects the whole batch**, which was proven
   *   against a real database rather than argued from the schema. A constraint that makes the
   *   loss loud is a stronger guard than a count this method would have to interpret: it also
   *   catches the case a count would miss, where the demotion matched its row but a competitor
   *   had already inserted its own latest. This is a deliberate exception rather than an
   *   oversight, and loosening that index would mean revisiting this line.
   *   (The private `batch()` used by `revise` is separate: it reports each statement's count.)
   * - **On a bare `.run()`**: `updateProfile` and `updateSession` alone, both fixture-only with
   *   no production caller to mislead — stated here and in `content-repository.ts`.
   */
  private async write<T = unknown>(query: string, ...values: unknown[]) {
    const result = await this.database
      .prepare(query)
      .bind(...values)
      .run<T>();
    if (!result.success)
      throw new Error(`D1 content write failed: ${result.error ?? "unknown error"}`);
    return result;
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
            "INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id,workflow_status,logistics_json,custom_fields_json,social_links_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
            JSON.stringify(profile.socialLinks ?? {}),
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
      `SELECT profile.*, (SELECT COALESCE(MAX(revision_number),0) FROM content_revisions WHERE entity_type='profile' AND entity_id=profile.id) AS profile_version FROM speaker_profiles AS profile WHERE event_id = ?${userId ? " AND user_id = ?" : ""} ORDER BY name`,
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
    const scoped = (table: string, order: string) =>
      this.rows(
        `SELECT owned.* FROM ${table} AS owned INNER JOIN speaker_profiles AS profile ON profile.id = owned.speaker_profile_id WHERE owned.event_id = ? AND profile.event_id = owned.event_id AND profile.user_id = ? ORDER BY ${order}`,
        eventId,
        userId,
      );
    /*
     * The remaining seven reads are issued together rather than one after another (issue #207).
     *
     * Each is an independent `SELECT` over a different table; none reads a row another one
     * writes, and nothing here writes at all. Awaited in sequence they cost seven round trips to
     * D1 in a row, which locally is nothing and in the Worker is seven latencies — and this
     * method runs **twice** on the acceptance path, which measured 65 sequential round trips
     * before this change. Issued together they cost one wait.
     *
     * The profile read above stays first, and deliberately: the speaker projection returns early
     * when a portal caller owns no profile on this event, and the six scoped queries below are
     * meaningless before that is known.
     *
     * This buys no *less* consistency than before, and it is worth stating that way rather than
     * claiming a snapshot: D1 gives no cross-statement isolation, so seven `prepare().all()`
     * calls are seven independent reads whether they are issued serially or together — only
     * `batch()` is one transaction. Ordering them against each other therefore never meant
     * anything, because a concurrent writer could land between any two of them in the old
     * arrangement just as easily.
     */
    const [sessionRows, taskRows, assetRows, messageRows, resourceRows, commentRows, revisionRows] =
      await Promise.all([
        this.rows(
          userId
            ? "SELECT DISTINCT session.* FROM content_sessions AS session, json_each(session.speaker_profile_ids) AS speaker INNER JOIN speaker_profiles AS profile ON profile.id = speaker.value WHERE session.event_id = ? AND profile.event_id = session.event_id AND profile.user_id = ? ORDER BY session.title"
            : "SELECT * FROM content_sessions WHERE event_id = ? ORDER BY title",
          eventId,
          ...(userId ? [userId] : []),
        ),
        userId
          ? scoped("speaker_tasks", "due_at,title")
          : this.rows(
              "SELECT * FROM speaker_tasks WHERE event_id = ? ORDER BY due_at,title",
              eventId,
            ),
        userId
          ? scoped("speaker_assets", "uploaded_at")
          : this.rows(
              "SELECT * FROM speaker_assets WHERE event_id = ? ORDER BY uploaded_at",
              eventId,
            ),
        userId
          ? scoped("speaker_messages", "sent_at")
          : this.rows(
              "SELECT * FROM speaker_messages WHERE event_id = ? ORDER BY sent_at",
              eventId,
            ),
        this.rows(
          `SELECT * FROM speaker_resources WHERE event_id = ?${userId ? " AND visibility = 'visible'" : ""} ORDER BY sort_order,title`,
          eventId,
        ),
        this.rows(
          userId
            ? "SELECT comment.* FROM content_asset_comments comment INNER JOIN speaker_assets asset ON asset.id=comment.asset_id INNER JOIN speaker_profiles profile ON profile.id=asset.speaker_profile_id WHERE comment.event_id=? AND profile.user_id=? ORDER BY comment.created_at"
            : "SELECT * FROM content_asset_comments WHERE event_id=? ORDER BY created_at",
          eventId,
          ...(userId ? [userId] : []),
        ),
        userId
          ? Promise.resolve([] as Row[])
          : this.rows(
              // Timestamp first, then the entity's own numbering. Two revisions of one record can
              // legitimately share an instant — a retried edit is stamped no earlier than the
              // revision it follows — and SQLite's sort is not stable, so without the tiebreak the
              // console could list revision 2 above revision 1 with both numbers on screen.
              "SELECT * FROM content_revisions WHERE event_id=? ORDER BY created_at,entity_type,entity_id,revision_number",
              eventId,
            ),
      ]);
    return {
      sessions: sessionRows.map((row) => this.session(row)),
      speakers,
      tasks: taskRows.map((row) => this.task(row)),
      assets: assetRows.map((row) => this.asset(row)),
      messages: messageRows.map((row) => this.message(row)),
      resources: resourceRows.map((row) => this.resource(row)),
      comments: commentRows.map((row) => this.comment(row)),
      revisions: revisionRows.map((row) => this.revision(row)),
    };
  }
  private profileWrite(profile: SpeakerProfile, where?: RowGuard): D1Statement {
    return this.database
      .prepare(
        `UPDATE speaker_profiles SET name=?,bio=?,pronouns=?,job_title=?,organization=?,photo_asset_id=?,workflow_status=?,logistics_json=?,custom_fields_json=?,social_links_json=? WHERE ${where?.sql ?? "id=?"}`,
      )
      .bind(
        profile.name,
        profile.bio,
        profile.pronouns,
        profile.jobTitle ?? "",
        profile.organization,
        profile.photoAssetId ?? null,
        profile.workflowStatus ?? "onboarding",
        JSON.stringify(profile.logistics ?? {}),
        JSON.stringify(profile.customFields ?? {}),
        JSON.stringify(profile.socialLinks ?? {}),
        ...(where?.values ?? [profile.id]),
      );
  }
  /**
   * No count, because there is no caller to mislead: `ContentRepository` documents this as
   * fixture-only, and a fixture asserting its own setup landed is the test's job rather than
   * this adapter's. A production caller appearing here is a caller that has bypassed attributed
   * history, and it should be given `reviseProfile` rather than a row count.
   */
  async updateProfile(profile: SpeakerProfile) {
    const result = await this.profileWrite(profile).run();
    if (!result.success)
      throw new Error(`D1 content write failed: ${result.error ?? "unknown error"}`);
  }
  async updateProfilePhoto(profileId: string, assetId: string | null) {
    const result = await this.write(
      "UPDATE speaker_profiles SET photo_asset_id=? WHERE id=?",
      assetId,
      profileId,
    );
    return changedRows(result, "record a speaker headshot") > 0;
  }
  /**
   * Allocate the occurrence inside the statement that spends it.
   *
   * `invitations_sent + 1 ... RETURNING` rather than a `SELECT` followed by an `UPDATE`: the
   * read-then-write version is one two organizers pressing Invite together resolve identically,
   * and the loser's invitation then converges into the winner's delivery and reports "already
   * invited" for a message that organizer never sent. This is the shape `saveDecision` uses for a
   * decision's revision and `replaceLatestAsset` uses for a version number.
   *
   * Not in `PROFILE_WRITTEN_COLUMNS`, deliberately: this column is not one `profileWrite`
   * rewrites, so a claim landing between an attributed edit's read and its write must not make
   * that edit's compare-and-swap lose a race it did not have.
   */
  async claimInvitationOccurrence(profileId: string) {
    const result = await this.write<{ invitationsSent: number }>(
      "UPDATE speaker_profiles SET invitations_sent = invitations_sent + 1 WHERE id=? RETURNING invitations_sent AS invitationsSent",
      profileId,
    );
    // Zero rows is the profile having gone since the caller read it, which the caller reports as
    // a refusal for that speaker. The count is still read through the shared contract, so a
    // driver that cannot report one is a failure here rather than read as "no such profile".
    if (changedRows(result, "claim a speaker invitation occurrence") === 0) return null;
    const claimed = result.results?.[0]?.invitationsSent;
    // A driver that reports the write but not the number it allocated must not be read as 1:
    // that is the one value that would collide with a real first invitation, so two organizers
    // would key their invitations identically and one of them would silently send nothing.
    if (typeof claimed !== "number")
      throw new Error("D1 reported no occurrence while claiming a speaker invitation");
    return Number(claimed);
  }
  async updateProfileWorkflow(profileId: string, fields: SpeakerWorkflowFields) {
    const result = await this.write(
      "UPDATE speaker_profiles SET workflow_status=?,logistics_json=?,custom_fields_json=? WHERE id=?",
      fields.workflowStatus,
      JSON.stringify(fields.logistics),
      JSON.stringify(fields.customFields),
      profileId,
    );
    return changedRows(result, "write imported speaker workflow fields") > 0;
  }
  async updateTask(task: SpeakerTask) {
    const result = await this.write(
      "UPDATE speaker_tasks SET status=?,completed_at=? WHERE id=?",
      task.status,
      task.completedAt ?? null,
      task.id,
    );
    return changedRows(result, "update a speaker task") > 0;
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
  /** Fixture-only, for the same reason as `updateProfile`; `reviseSession` is the real writer. */
  async updateSession(session: ContentSession) {
    const result = await this.sessionWrite(session).run();
    if (!result.success)
      throw new Error(`D1 content write failed: ${result.error ?? "unknown error"}`);
  }
  async deleteSession(sessionId: string) {
    // The count is read but not returned: a session already gone is the outcome the caller
    // asked for. A driver that cannot report one is still a failure rather than a silent
    // success, which is the half of the rule that matters here.
    changedRows(
      await this.write("DELETE FROM content_sessions WHERE id=?", sessionId),
      "delete a content session",
    );
  }
  async updateAsset(asset: SpeakerAsset) {
    const result = await this.write(
      "UPDATE speaker_assets SET visibility=?,task_id=?,session_id=?,version_group_id=?,version_number=?,is_latest=? WHERE id=?",
      asset.visibility,
      asset.taskId ?? null,
      asset.sessionId ?? null,
      asset.versionGroupId ?? asset.id,
      asset.versionNumber ?? 1,
      asset.isLatest === false ? 0 : 1,
      asset.id,
    );
    return changedRows(result, "update a speaker asset") > 0;
  }
  async addAsset(asset: SpeakerAsset) {
    await this.run(
      "INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at,task_id,session_id,logical_key,version_group_id,version_number,is_latest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
      // A direct add is a fixture path rather than an upload, but it still has to leave a key
      // behind: a row with none is a row the next upload cannot find, which is how the twin
      // `slides.pdf` rows appeared in the first place.
      asset.logicalKey ?? logicalAssetKey(asset),
      asset.versionGroupId ?? asset.id,
      asset.versionNumber ?? 1,
      asset.isLatest === false ? 0 : 1,
    );
  }
  /**
   * Allocate the group and the version number inside the write.
   *
   * Both used to be decided by the service from a workspace read, which is a read-then-write two
   * concurrent uploads resolve identically: they picked the same number and the loser tripped
   * `speaker_assets_version_unique`. Worse, an upload naming no group at all read "no previous
   * version" and minted its own, so `slides.pdf` uploaded twice stored as two v1 assets rather
   * than as v1 and v2 — the evaluator's CNT-04 failure.
   *
   * The two subqueries below decide both against the *stored* `logical_key` (`1406`), so a second
   * upload either sees the first's row or does not commit. The `UPDATE` demotes the chain by that
   * same key rather than by a row id the caller read earlier, which is what makes a lost race
   * leave exactly one latest instead of none.
   */
  async replaceLatestAsset(asset: SpeakerAsset, versionGroupId?: string) {
    const logicalKey = asset.logicalKey ?? asset.id;
    // An explicit continuation addresses its chain by group; everything else by logical key.
    const scope = versionGroupId
      ? { column: "version_group_id", value: versionGroupId }
      : { column: "logical_key", value: logicalKey };
    const where = `event_id=? AND speaker_profile_id=? AND ${scope.column}=?`;
    const scopeBindings = [asset.eventId, asset.speakerProfileId, scope.value] as const;
    const statements: D1Statement[] = [
      this.database
        .prepare(`UPDATE speaker_assets SET is_latest=0 WHERE ${where} AND is_latest=1`)
        .bind(...scopeBindings),
      this.database
        .prepare(
          "INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at,task_id,session_id,logical_key,version_group_id,version_number,is_latest) " +
            `SELECT ?,?,?,?,?,?,?,?,?,?,?,` +
            // The chain's existing group, or this row's own id when it is the first version.
            `COALESCE((SELECT version_group_id FROM speaker_assets WHERE ${where} ORDER BY version_number DESC LIMIT 1), ?),` +
            `COALESCE((SELECT MAX(version_number) FROM speaker_assets WHERE ${where}), 0)+1,1 ` +
            "RETURNING version_group_id AS versionGroupId, version_number AS versionNumber",
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
          logicalKey,
          ...scopeBindings,
          asset.id,
          ...scopeBindings,
        ),
    ];
    const [demoted, inserted] = await this.database.batch<{
      versionGroupId: string;
      versionNumber: number;
    }>(statements);
    if (!demoted?.success || !inserted?.success)
      throw new Error(
        `D1 content asset version batch failed: ${inserted?.error ?? demoted?.error}`,
      );
    // Not a conditional write — the demotion may legitimately match nothing on a first upload —
    // but the count is still read through the shared contract so a driver that omits it is
    // refused here rather than believed (`d1-write-result.ts`).
    changedRows(demoted as D1WriteResult, "demote the previous latest asset version");
    const allocated = inserted.results?.[0];
    if (!allocated) throw new Error("D1 returned no allocated version for a stored speaker asset");
    return {
      versionGroupId: allocated.versionGroupId,
      versionNumber: Number(allocated.versionNumber),
    };
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
    const failed = results.find((result) => !result.success);
    if (failed)
      throw new Error(`Content asset deletion batch failed: ${failed.error ?? "unknown error"}`);
  }
  async deleteAssetAfterStorage(assetId: string, profileId: string, draft: ContentRevisionDraft) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const profile = await this.findProfile(profileId);
      if (!profile || profile.photoAssetId !== assetId) {
        try {
          await this.deleteAsset(assetId);
          return null;
        } catch (error) {
          if (error instanceof Error && error.message.includes("profile still references asset"))
            continue;
          throw error;
        }
      }
      const asset = await this.findAsset(assetId);
      try {
        return await this.revise<SpeakerProfile>(
          "profile",
          profileId,
          draft,
          (current) => {
            const { photoAssetId: _removed, ...withoutPhoto } = current;
            return { ...withoutPhoto, version: (current.version ?? 0) + 1 };
          },
          "speaker_profiles",
          PROFILE_WRITTEN_COLUMNS,
          (row) => this.profile(row),
          (next, where) => this.profileWrite(next, where),
          profile.version ?? 0,
          () => [
            this.database
              .prepare("DELETE FROM content_asset_comments WHERE asset_id=?")
              .bind(assetId),
            this.database.prepare("DELETE FROM speaker_assets WHERE id=?").bind(assetId),
            ...(asset?.isLatest !== false && asset?.versionGroupId
              ? [
                  this.database
                    .prepare(
                      "UPDATE speaker_assets SET is_latest=1 WHERE id=(SELECT id FROM speaker_assets WHERE version_group_id=? AND id<>? ORDER BY version_number DESC LIMIT 1)",
                    )
                    .bind(asset.versionGroupId, assetId),
                ]
              : []),
          ],
        );
      } catch (error) {
        if (error instanceof ContentConflictError) continue;
        throw error;
      }
    }
    throw new ContentConflictError(
      "This profile changed while its asset was being deleted. Reload and try again.",
    );
  }
  async hasSpeakerWork(eventId: string, profileId: string) {
    // `LIMIT 1` and no columns beyond the constant: the caller wants existence, and the index on
    // `speaker_profile_id` answers it without reading a row's payload.
    //
    // The event predicate is redundant *today* — a `speaker_profiles` row belongs to exactly one
    // event, so every task on a profile is on that profile's event — and it is here because
    // `speaker_tasks.event_id` is an independent foreign key with nothing constraining it to the
    // profile's own event. Without it the port's promise ("on this event") would be true by an
    // invariant no column enforces, and the caller already holds the id.
    return (
      (
        await this.rows(
          "SELECT 1 FROM speaker_tasks WHERE event_id = ? AND speaker_profile_id = ? LIMIT 1",
          eventId,
          profileId,
        )
      ).length > 0
    );
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
      await this.rows(
        "SELECT profile.*, (SELECT COALESCE(MAX(revision_number),0) FROM content_revisions WHERE entity_type='profile' AND entity_id=profile.id) AS profile_version FROM speaker_profiles AS profile WHERE id = ? LIMIT 1",
        profileId,
      )
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
        "SELECT profile.*, (SELECT COALESCE(MAX(revision_number),0) FROM content_revisions WHERE entity_type='profile' AND entity_id=profile.id) AS profile_version FROM speaker_profiles AS profile WHERE event_id = ? AND source_person_id = ? LIMIT 1",
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
    const result = await this.write(
      "UPDATE speaker_resources SET title=?,slug=?,body_html=?,embed_html=?,visibility=?,sort_order=? WHERE id=?",
      resource.title,
      resource.slug,
      resource.bodyHtml,
      resource.embedHtml,
      resource.visibility,
      resource.sortOrder,
      resource.id,
    );
    return changedRows(result, "update a speaker resource") > 0;
  }
  async deleteResource(resourceId: string) {
    // The same reading as `deleteSession` and `deleteTaskTemplate`: a resource already gone is
    // the outcome the caller asked for, so the count is read and discarded rather than returned.
    // What that keeps is the other half — a driver that cannot report one is a failure here
    // rather than a silent success. This was the one conditional delete #202 left out.
    changedRows(
      await this.write("DELETE FROM speaker_resources WHERE id=?", resourceId),
      "delete a speaker resource",
    );
  }
  async findResource(resourceId: string) {
    const row = (
      await this.rows("SELECT * FROM speaker_resources WHERE id=? LIMIT 1", resourceId)
    )[0];
    return row ? this.resource(row) : null;
  }
  /**
   * One statement, so the unique constraint resolves the collision instead of raising it.
   *
   * `id` is absent from the `DO UPDATE` list on purpose: the slug is the identity here, and a
   * row that already carries it keeps the id everything else already refers to.
   */
  async upsertResourceBySlug(resource: SpeakerResource) {
    await this.run(
      "INSERT INTO speaker_resources (id,event_id,title,slug,body_html,embed_html,visibility,sort_order) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(event_id,slug) DO UPDATE SET title=excluded.title,body_html=excluded.body_html,embed_html=excluded.embed_html,visibility=excluded.visibility,sort_order=excluded.sort_order",
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
  async listTaskTemplates(eventId: string) {
    return (
      await this.rows(
        "SELECT * FROM speaker_task_templates WHERE event_id = ? ORDER BY sort_order,title",
        eventId,
      )
    ).map((row) => this.taskTemplate(row));
  }
  /** `upsertResourceBySlug` for a checklist line. `created_at` survives an update: the line was
   * declared when it was declared, and re-applying a template does not re-date it. */
  async upsertTaskTemplateByTitle(template: SpeakerTaskTemplate) {
    await this.run(
      "INSERT INTO speaker_task_templates (id,event_id,title,description,sort_order,due_offset_days,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id,title) DO UPDATE SET description=excluded.description,sort_order=excluded.sort_order,due_offset_days=excluded.due_offset_days",
      template.id,
      template.eventId,
      template.title,
      template.description,
      template.sortOrder,
      template.dueOffsetDays,
      template.createdAt,
    );
  }
  async findTaskTemplate(templateId: string) {
    const row = (
      await this.rows("SELECT * FROM speaker_task_templates WHERE id = ? LIMIT 1", templateId)
    )[0];
    return row ? this.taskTemplate(row) : null;
  }
  async addTaskTemplate(template: SpeakerTaskTemplate) {
    // No `ON CONFLICT`: a title this event already uses is the organizer's answer, and the
    // service turns the constraint into one. Converging here would silently overwrite the line
    // they meant to add beside the existing one.
    await this.run(
      "INSERT INTO speaker_task_templates (id,event_id,title,description,sort_order,due_offset_days,created_at) VALUES (?,?,?,?,?,?,?)",
      template.id,
      template.eventId,
      template.title,
      template.description,
      template.sortOrder,
      template.dueOffsetDays,
      template.createdAt,
    );
  }
  async updateTaskTemplate(template: SpeakerTaskTemplate) {
    // `created_at` is not in the SET list: a line was declared when it was declared, and editing
    // its wording is not a new declaration.
    const result = await this.write(
      "UPDATE speaker_task_templates SET title=?,description=?,sort_order=?,due_offset_days=? WHERE id=?",
      template.title,
      template.description,
      template.sortOrder,
      template.dueOffsetDays,
      template.id,
    );
    return changedRows(result, "update a speaker checklist line") > 0;
  }
  async deleteTaskTemplate(templateId: string) {
    const result = await this.write("DELETE FROM speaker_task_templates WHERE id = ?", templateId);
    // Zero is the row having gone between the caller's read and this statement, which is the
    // outcome the caller asked for. The count is still *read*, so a driver that cannot report
    // one is a failure here rather than a silent success.
    changedRows(result, "delete a speaker checklist line");
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
      return {
        changes: results.map((result) => changedRows(result, "write content revision batch")),
      };
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
    expectedVersion?: number,
    sideEffects?: (current: T, next: T) => readonly D1Statement[],
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
      const revisionNumber = Number(row.latest_revision ?? 0);
      if (expectedVersion !== undefined && revisionNumber !== expectedVersion)
        throw new ContentConflictError(
          "This profile changed after you opened it. Reload and try again.",
        );
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
            revisionNumber + 1,
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
        ...(sideEffects?.(current, next) ?? []),
      ]);
      if ("changes" in result) {
        if (result.changes[0] === 1) return next;
        if (expectedVersion !== undefined) {
          const stillExists = (
            await this.rows(`SELECT id FROM ${table} WHERE id=? LIMIT 1`, entityId)
          )[0];
          // A concurrent deletion is still indistinguishable from a row that was never there
          // to the service's authorization boundary. A surviving row lost the version race.
          if (!stillExists) return null;
          throw new ContentConflictError(
            "This profile changed while you were saving. Reload and try again.",
          );
        }
        continue;
      }
      lastFailure = result.failure;
      if (lastFailure.includes("profile photo asset does not exist"))
        throw new ContentConflictError(
          "This profile's saved headshot is no longer available. Reload and try again.",
        );
      // The composite guard names all three of its columns; the primary key names only `id`, so
      // a duplicated revision id is a fault to report rather than contention to retry.
      if (!/UNIQUE constraint failed:[^\n]*content_revisions\.revision_number/.test(lastFailure))
        throw new Error(`D1 content revision failed: ${lastFailure}`);
      if (expectedVersion !== undefined)
        throw new ContentConflictError(
          "This profile changed while you were saving. Reload and try again.",
          { cause: new Error(lastFailure) },
        );
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
    expectedVersion?: number,
  ) {
    return this.revise<SpeakerProfile>(
      "profile",
      profileId,
      draft,
      (current) => ({ ...edit(current), version: (current.version ?? 0) + 1 }),
      "speaker_profiles",
      PROFILE_WRITTEN_COLUMNS,
      (row) => this.profile(row),
      (next, where) => this.profileWrite(next, where),
      expectedVersion,
      (current, next) =>
        current.photoAssetId && current.photoAssetId !== next.photoAssetId
          ? [
              this.database
                .prepare(
                  "UPDATE speaker_assets SET visibility='private' WHERE id=? AND speaker_profile_id=? AND EXISTS (SELECT 1 FROM content_revisions WHERE id=?)",
                )
                // Any profile revision can replace a photo (notably restore). Binding the
                // privacy side effect to the winning revision keeps a losing CAS from hiding
                // the winner's current photo.
                .bind(current.photoAssetId, profileId, draft.id),
            ]
          : [],
    );
  }

  async reviseProfilePhoto(
    profileId: string,
    draft: ContentRevisionDraft,
    expectedVersion: number,
    assetId: string | null,
  ) {
    return this.reviseProfile(
      profileId,
      draft,
      (current) => {
        const { photoAssetId: _previous, ...withoutPhoto } = current;
        return {
          ...withoutPhoto,
          ...(assetId ? { photoAssetId: assetId } : {}),
        };
      },
      expectedVersion,
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
      jobTitle: row.job_title ?? "",
      organization: row.organization ?? "",
      version: Number(row.profile_version ?? row.latest_revision ?? 0),
      ...(row.photo_asset_id ? { photoAssetId: row.photo_asset_id } : {}),
      workflowStatus: (row.workflow_status ?? "onboarding") as SpeakerProfile["workflowStatus"],
      logistics: parse<Record<string, string>>(row.logistics_json ?? "{}"),
      customFields: parse<Record<string, string>>(row.custom_fields_json ?? "{}"),
      socialLinks: parse<SpeakerSocialLinks>(row.social_links_json ?? "{}"),
      // A row written before `1408` reads 0 through the column default, which is what it is:
      // nobody has explicitly invited this speaker yet.
      invitationsSent: Number(row.invitations_sent ?? 0),
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
      ...(row.logical_key ? { logicalKey: row.logical_key } : {}),
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
  private taskTemplate(row: Row): SpeakerTaskTemplate {
    return {
      id: String(row.id ?? ""),
      eventId: String(row.event_id ?? ""),
      title: String(row.title ?? ""),
      description: String(row.description ?? ""),
      sortOrder: Number(row.sort_order ?? 0),
      dueOffsetDays: Number(row.due_offset_days ?? 0),
      createdAt: String(row.created_at ?? ""),
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
