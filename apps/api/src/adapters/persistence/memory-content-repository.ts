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
  SpeakerConversionCommand,
  SpeakerConversionPort,
} from "../../application/content/speaker-conversion";
import type {
  ContentComment,
  ContentRevision,
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerProfile,
  SpeakerResource,
  SpeakerTask,
} from "../../domain/content/content";

const by =
  <T>(key: (item: T) => string) =>
  (left: T, right: T) =>
    key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;

export class MemoryContentRepository
  implements ContentRepository, AgendaContentQuery, PublishingContentQuery
{
  private sessions: ContentWorkspace["sessions"] = [];
  private speakers: ContentWorkspace["speakers"] = [];
  private tasks: ContentWorkspace["tasks"] = [];
  private assets: ContentWorkspace["assets"] = [];
  private messages: ContentWorkspace["messages"] = [];
  private resources: NonNullable<ContentWorkspace["resources"]> = [];
  private comments: NonNullable<ContentWorkspace["comments"]> = [];
  private revisions: NonNullable<ContentWorkspace["revisions"]> = [];
  private imports = new Map<string, "pending" | "complete">();

  constructor(seed?: ContentWorkspace) {
    if (seed)
      ({
        sessions: this.sessions,
        speakers: this.speakers,
        tasks: this.tasks,
        assets: this.assets,
        messages: this.messages,
      } = seed);
    if (seed) this.resources = seed.resources ?? [];
    if (seed) this.comments = seed.comments ?? [];
    if (seed) this.revisions = seed.revisions ?? [];
  }
  async findSessionByProposal(eventId: string, proposalId: string) {
    return (
      this.sessions.find((item) => item.eventId === eventId && item.proposalId === proposalId) ??
      null
    );
  }
  async findSpeakerImport(eventId: string, email: string) {
    return this.imports.get(`${eventId}:${email}`) ?? null;
  }
  async beginSpeakerImport(eventId: string, email: string) {
    if (!this.imports.has(`${eventId}:${email}`))
      this.imports.set(`${eventId}:${email}`, "pending");
  }
  async completeSpeakerImport(eventId: string, email: string) {
    this.imports.set(`${eventId}:${email}`, "complete");
  }
  async accept(content: AcceptedContent) {
    // Mirrors `UNIQUE(event_id, proposal_id)` in D1 so acceptance idempotency is exercised here
    // and not only against a real database.
    if (await this.findSessionByProposal(content.session.eventId, content.session.proposalId))
      throw new ContentConflictError("UNIQUE constraint failed: content_sessions.proposal_id");
    this.sessions = [...this.sessions, content.session];
    this.speakers = [...this.speakers, ...content.speakers];
    this.tasks = [...this.tasks, ...content.tasks];
    this.messages = [...this.messages, ...content.messages];
  }
  async addTasks(tasks: readonly SpeakerTask[]) {
    this.tasks = [...this.tasks, ...tasks];
  }
  async replaceLatestAsset(asset: SpeakerAsset, previous?: SpeakerAsset) {
    if (previous)
      this.assets = this.assets.map((item) =>
        item.id === previous.id ? { ...item, isLatest: false } : item,
      );
    this.assets = [...this.assets, asset];
  }
  /** Out-of-band profile creation, the way `SpeakerConversionPort` writes one in D1. */
  async addProfile(profile: SpeakerProfile) {
    this.speakers = [...this.speakers, profile];
  }
  async workspace(eventId: string, userId?: string): Promise<ContentWorkspace> {
    const speakers = this.speakers.filter(
      (item) => item.eventId === eventId && (!userId || item.userId === userId),
    );
    const profileIds = new Set(speakers.map(({ id }) => id));
    const sessions = this.sessions.filter(
      (item) =>
        item.eventId === eventId &&
        (!userId || item.speakerProfileIds.some((id) => profileIds.has(id))),
    );
    // Same ordering the D1 repository's `ORDER BY` clauses produce, so a projection
    // composed against this repository has the same shape as one composed in production.
    return {
      sessions: sessions.toSorted(by((item) => item.title)),
      speakers: speakers.toSorted(by((item) => item.name)),
      tasks: this.tasks
        .filter((item) => profileIds.has(item.speakerProfileId))
        .toSorted(by((item) => `${item.dueAt}\u0000${item.title}`)),
      assets: this.assets
        .filter((item) => profileIds.has(item.speakerProfileId))
        .toSorted(by((item) => item.uploadedAt)),
      messages: this.messages
        .filter((item) => profileIds.has(item.speakerProfileId))
        .toSorted(by((item) => item.sentAt)),
      resources: this.resources
        .filter((item) => item.eventId === eventId && (!userId || item.visibility === "visible"))
        .toSorted(
          (left, right) =>
            left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
        ),
      comments: this.comments
        .filter(
          (item) =>
            item.eventId === eventId &&
            (!userId ||
              this.assets.some(
                (asset) => asset.id === item.assetId && profileIds.has(asset.speakerProfileId),
              )),
        )
        // `ORDER BY created_at`, exactly as D1 clauses it — the one collection whose
        // ordering this repository claimed to mirror and did not.
        .toSorted(by((item) => item.createdAt)),
      revisions: userId
        ? []
        : this.revisions
            .filter((item) => item.eventId === eventId)
            // The same total order D1 applies, tiebreak included. See `D1ContentRepository`.
            .toSorted(
              by(
                (item) =>
                  `${item.createdAt}\u0000${item.entityType}\u0000${item.entityId}\u0000${String(item.revisionNumber).padStart(12, "0")}`,
              ),
            ),
    };
  }

  /**
   * The agenda and publishing domains read content through these two public application
   * interfaces, never through `workspace`. They mirror `D1ContentRepository` exactly —
   * including the filters that keep draft sessions and private assets out of anything
   * publishable — so a test that composes against this repository exercises the real join.
   */
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
  async updateProfile(profile: SpeakerProfile) {
    this.speakers = this.speakers.map((item) => (item.id === profile.id ? profile : item));
  }
  async updateProfileWorkflow(profileId: string, fields: SpeakerWorkflowFields) {
    this.speakers = this.speakers.map((item) =>
      item.id === profileId ? { ...item, ...fields } : item,
    );
  }
  async updateProfilePhoto(profileId: string, assetId: string | null) {
    this.speakers = this.speakers.map((item) => {
      if (item.id !== profileId) return item;
      const { photoAssetId: _replaced, ...withoutPhoto } = item;
      return assetId ? { ...withoutPhoto, photoAssetId: assetId } : withoutPhoto;
    });
  }
  async updateTask(task: SpeakerTask) {
    this.tasks = this.tasks.map((item) => (item.id === task.id ? task : item));
  }
  async updateSession(session: ContentWorkspace["sessions"][number]) {
    this.sessions = this.sessions.map((item) => (item.id === session.id ? session : item));
  }
  async deleteSession(sessionId: string) {
    this.sessions = this.sessions.filter(({ id }) => id !== sessionId);
  }
  async updateAsset(asset: SpeakerAsset) {
    this.assets = this.assets.map((item) => (item.id === asset.id ? asset : item));
  }
  async addAsset(asset: SpeakerAsset) {
    this.assets = [...this.assets, asset];
  }
  async deleteAsset(assetId: string) {
    const deleted = this.assets.find(({ id }) => id === assetId);
    this.assets = this.assets.filter(({ id }) => id !== assetId);
    if (deleted && deleted.isLatest !== false && deleted.versionGroupId) {
      const previous = this.assets
        .filter(({ versionGroupId }) => versionGroupId === deleted.versionGroupId)
        .toSorted((left, right) => (right.versionNumber ?? 1) - (left.versionNumber ?? 1))[0];
      if (previous)
        this.assets = this.assets.map((asset) =>
          asset.id === previous.id ? { ...asset, isLatest: true } : asset,
        );
    }
    this.comments = this.comments.filter(({ assetId: candidate }) => candidate !== assetId);
  }
  async addTask(task: SpeakerTask) {
    this.tasks = [...this.tasks, task];
  }
  async addMessage(message: ContentWorkspace["messages"][number]) {
    this.messages = [...this.messages, message];
  }
  async findProfile(profileId: string) {
    return this.speakers.find(({ id }) => id === profileId) ?? null;
  }
  async findSession(sessionId: string) {
    return this.sessions.find(({ id }) => id === sessionId) ?? null;
  }
  async findAsset(assetId: string) {
    return this.assets.find(({ id }) => id === assetId) ?? null;
  }
  async findProfileBySource(eventId: string, sourcePersonId: string) {
    return (
      this.speakers.find(
        (profile) => profile.eventId === eventId && profile.sourcePersonId === sourcePersonId,
      ) ?? null
    );
  }
  async addResource(resource: SpeakerResource) {
    this.resources = [...this.resources, resource];
  }
  async updateResource(resource: SpeakerResource) {
    this.resources = this.resources.map((item) => (item.id === resource.id ? resource : item));
  }
  async deleteResource(resourceId: string) {
    this.resources = this.resources.filter(({ id }) => id !== resourceId);
  }
  async findResource(resourceId: string) {
    return this.resources.find(({ id }) => id === resourceId) ?? null;
  }
  async addComment(comment: ContentComment) {
    this.comments = [...this.comments, comment];
  }
  /**
   * The same indivisible pair D1 gets, which here costs nothing: the read, the append and the
   * write happen with no `await` between them, so nothing can interleave.
   */
  private revise<T extends { id: string }>(
    entityType: ContentRevision["entityType"],
    current: T | undefined,
    draft: ContentRevisionDraft,
    edit: ContentEdit<T>,
  ): T | null {
    if (!current) return null;
    const next = edit(current);
    const existing = this.revisions.filter(
      (revision) => revision.entityType === entityType && revision.entityId === current.id,
    );
    this.revisions = [
      ...this.revisions,
      {
        id: draft.id,
        eventId: draft.eventId,
        entityType,
        entityId: current.id,
        revisionNumber: Math.max(0, ...existing.map(({ revisionNumber }) => revisionNumber)) + 1,
        snapshotJson: JSON.stringify(current),
        actorId: draft.actorId,
        // Never earlier than the revision it follows, matching D1. See `D1ContentRepository`.
        createdAt: existing.reduce(
          (latest, { createdAt }) => (createdAt > latest ? createdAt : latest),
          draft.createdAt,
        ),
        ...(draft.restoredFromRevisionId
          ? { restoredFromRevisionId: draft.restoredFromRevisionId }
          : {}),
      },
    ];
    return next;
  }
  async reviseProfile(
    profileId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<SpeakerProfile>,
  ) {
    const next = this.revise(
      "profile",
      this.speakers.find(({ id }) => id === profileId),
      draft,
      edit,
    );
    if (next) this.speakers = this.speakers.map((item) => (item.id === next.id ? next : item));
    return next;
  }
  async reviseSession(
    sessionId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<ContentSession>,
  ) {
    const next = this.revise(
      "session",
      this.sessions.find(({ id }) => id === sessionId),
      draft,
      edit,
    );
    if (next) this.sessions = this.sessions.map((item) => (item.id === next.id ? next : item));
    return next;
  }
  async findRevision(revisionId: string) {
    return this.revisions.find(({ id }) => id === revisionId) ?? null;
  }
}

/**
 * In-memory `SpeakerConversionPort` with the same contract as `D1SpeakerConversion`: one profile
 * per event per email address, whichever door — CRM conversion or CFP acceptance — arrives first.
 */
export class MemorySpeakerConversion implements SpeakerConversionPort {
  constructor(
    private readonly repository: MemoryContentRepository,
    private readonly newId: () => string,
  ) {}
  async createOrLink(command: SpeakerConversionCommand) {
    const normalizedEmail = command.email.trim().toLowerCase();
    const workspace = await this.repository.workspace(command.eventId);
    const existing = workspace.speakers.find(
      (profile) => profile.email.toLowerCase() === normalizedEmail,
    );
    if (existing) return { speakerId: existing.id };
    const speakerId = this.newId();
    await this.repository.addProfile({
      id: speakerId,
      eventId: command.eventId,
      userId: this.newId(),
      sourcePersonId: `crm-email:${normalizedEmail}`,
      name: command.name,
      email: normalizedEmail,
      bio: "",
      pronouns: "",
      organization: "",
    });
    return { speakerId };
  }
}
