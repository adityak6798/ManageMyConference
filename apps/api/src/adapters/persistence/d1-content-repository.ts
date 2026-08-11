import {
  type AcceptedContent,
  ContentConflictError,
  type ContentRepository,
} from "../../application/content/content-repository";
import type {
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerMessage,
  SpeakerProfile,
  SpeakerTask,
} from "../../domain/content/content";
import type { AgendaContentQuery, PublishingContentQuery } from "../../application/content/public";
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run<T = unknown>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
  all<T>(): Promise<{ results?: T[]; success: boolean; error?: string }>;
}
export interface ContentDatabasePort {
  prepare(query: string): D1Statement;
  batch<T = unknown>(
    statements: D1Statement[],
  ): Promise<Array<{ results?: T[]; success: boolean; error?: string }>>;
}

type Row = Record<string, string | null>;
const parse = <T>(value: string | null | undefined) => JSON.parse(value ?? "[]") as T;

export class D1ContentRepository
  implements ContentRepository, AgendaContentQuery, PublishingContentQuery
{
  constructor(private readonly database: ContentDatabasePort) {}
  async listSchedulableSessions(eventId: string) {
    const workspace = await this.workspace(eventId);
    return workspace.sessions.map(({ id, title, speakerProfileIds, tracks }) => ({
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
          "INSERT INTO content_sessions (id,event_id,proposal_id,title,abstract,format,speaker_profile_ids,tags,tracks,publication_state,schedule_starts_at,schedule_ends_at,schedule_location) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
          session.schedule?.startsAt ?? null,
          session.schedule?.endsAt ?? null,
          session.schedule?.location ?? null,
        ),
      ...content.speakers.map((profile) =>
        this.database
          .prepare(
            "INSERT INTO speaker_profiles (id,event_id,user_id,source_person_id,name,email,bio,pronouns,organization,photo_asset_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
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
          ),
      ),
      ...content.tasks.map((task) =>
        this.database
          .prepare(
            "INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at) VALUES (?,?,?,?,?,?,?)",
          )
          .bind(
            task.id,
            task.eventId,
            task.speakerProfileId,
            task.title,
            task.dueAt,
            task.status,
            task.completedAt ?? null,
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
    const ids = new Set(speakers.map(({ id }) => id));
    const sessions = (
      await this.rows("SELECT * FROM content_sessions WHERE event_id = ? ORDER BY title", eventId)
    )
      .map((row) => this.session(row))
      .filter((session) => !userId || session.speakerProfileIds.some((id) => ids.has(id)));
    const tasks = (
      await this.rows(
        "SELECT * FROM speaker_tasks WHERE event_id = ? ORDER BY due_at,title",
        eventId,
      )
    )
      .map((row) => this.task(row))
      .filter((item) => ids.has(item.speakerProfileId));
    const assets = (
      await this.rows(
        "SELECT * FROM speaker_assets WHERE event_id = ? ORDER BY uploaded_at",
        eventId,
      )
    )
      .map((row) => this.asset(row))
      .filter((item) => ids.has(item.speakerProfileId));
    const messages = (
      await this.rows("SELECT * FROM speaker_messages WHERE event_id = ? ORDER BY sent_at", eventId)
    )
      .map((row) => this.message(row))
      .filter((item) => ids.has(item.speakerProfileId));
    return { sessions, speakers, tasks, assets, messages };
  }
  async updateProfile(profile: SpeakerProfile) {
    await this.run(
      "UPDATE speaker_profiles SET name=?,bio=?,pronouns=?,organization=?,photo_asset_id=? WHERE id=?",
      profile.name,
      profile.bio,
      profile.pronouns,
      profile.organization,
      profile.photoAssetId ?? null,
      profile.id,
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
  async updateSession(session: ContentSession) {
    await this.run(
      "UPDATE content_sessions SET title=?,abstract=?,format=?,speaker_profile_ids=?,tags=?,tracks=?,publication_state=? WHERE id=?",
      session.title,
      session.abstract,
      session.format,
      JSON.stringify(session.speakerProfileIds),
      JSON.stringify(session.tags),
      JSON.stringify(session.tracks),
      session.publicationState,
      session.id,
    );
  }
  async updateAsset(asset: SpeakerAsset) {
    await this.run("UPDATE speaker_assets SET visibility=? WHERE id=?", asset.visibility, asset.id);
  }
  async addAsset(asset: SpeakerAsset) {
    await this.run(
      "INSERT INTO speaker_assets (id,event_id,speaker_profile_id,name,content_type,storage_key,visibility,uploaded_at) VALUES (?,?,?,?,?,?,?,?)",
      asset.id,
      asset.eventId,
      asset.speakerProfileId,
      asset.name,
      asset.contentType,
      asset.storageKey,
      asset.visibility,
      asset.uploadedAt,
    );
  }
  async deleteAsset(assetId: string) {
    await this.run("DELETE FROM speaker_assets WHERE id=?", assetId);
  }
  async addTask(task: SpeakerTask) {
    await this.run(
      "INSERT INTO speaker_tasks (id,event_id,speaker_profile_id,title,due_at,status,completed_at) VALUES (?,?,?,?,?,?,?)",
      task.id,
      task.eventId,
      task.speakerProfileId,
      task.title,
      task.dueAt,
      task.status,
      task.completedAt ?? null,
    );
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
      ...(row.schedule_starts_at
        ? {
            schedule: {
              startsAt: row.schedule_starts_at,
              endsAt: row.schedule_ends_at ?? "",
              location: row.schedule_location ?? "",
            },
          }
        : {}),
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
}
