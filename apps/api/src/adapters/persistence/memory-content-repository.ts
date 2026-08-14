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
import {
  type ContentComment,
  type ContentRevision,
  type ContentSession,
  type ContentWorkspace,
  logicalAssetKey,
  type SpeakerAsset,
  type SpeakerProfile,
  type SpeakerResource,
  type SpeakerTask,
  type SpeakerTaskTemplate,
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
  // Not part of `ContentWorkspace`: a checklist line is event configuration, not somebody's
  // work, so it is read by `listTaskTemplates` and never lands in a speaker's projection.
  private taskTemplates: readonly SpeakerTaskTemplate[] = [];

  private profileVersion(profile: SpeakerProfile): SpeakerProfile {
    const version = Math.max(
      0,
      ...this.revisions
        .filter(({ entityType, entityId }) => entityType === "profile" && entityId === profile.id)
        .map(({ revisionNumber }) => revisionNumber),
    );
    return { ...profile, jobTitle: profile.jobTitle ?? "", version };
  }
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
    // The row count the D1 adapter reads, expressed as the presence of the key. Mirrored here so
    // a service test can drive the vanished-row branch without a database.
    if (!this.imports.has(`${eventId}:${email}`)) return false;
    this.imports.set(`${eventId}:${email}`, "complete");
    return true;
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
  /**
   * Mirrors the D1 allocation, including *which* rows it addresses.
   *
   * The group and the number are decided here rather than taken from the caller, because that
   * is the property the D1 statement exists to hold and a fixture that let the caller pick
   * would pass while the real adapter's version of the same test failed.
   *
   * `D1ContentRepository` is the reference for chain membership, and this follows it even where
   * following it is the *weaker* behaviour. There the chain is `logical_key=?` against the
   * **stored** column (`1406`), so a row holding no key — a raw seed insert, the twin
   * `slides.pdf` rows this mechanism exists because of — matches nothing, because SQL `NULL`
   * equals nothing. Computing a key here for such a row would quietly fold it back into the
   * chain, and a fake more capable than the adapter it doubles is worse than a strict one: the
   * service suite runs against this class, so that leniency would hide the defect the seed
   * shipped rather than fail on it. Hence the stored key is read, never derived, and an
   * incoming asset with none falls back to its own id exactly as D1 does — it starts its own
   * chain in both stores. Deriving from the file's name is a *write-time* rule, and it lives
   * where D1 puts it, in `addAsset`.
   */
  async replaceLatestAsset(asset: SpeakerAsset, versionGroupId?: string) {
    const logicalKey = asset.logicalKey ?? asset.id;
    const inChain = (item: SpeakerAsset) =>
      item.eventId === asset.eventId &&
      item.speakerProfileId === asset.speakerProfileId &&
      (versionGroupId ? item.versionGroupId === versionGroupId : item.logicalKey === logicalKey);
    const chain = this.assets.filter(inChain);
    const allocated = {
      versionGroupId:
        chain.toSorted((a, b) => (b.versionNumber ?? 1) - (a.versionNumber ?? 1))[0]
          ?.versionGroupId ?? asset.id,
      versionNumber: Math.max(0, ...chain.map(({ versionNumber }) => versionNumber ?? 1)) + 1,
    };
    this.assets = [
      ...this.assets.map((item) => (inChain(item) ? { ...item, isLatest: false } : item)),
      { ...asset, ...allocated, logicalKey, isLatest: true },
    ];
    return allocated;
  }
  /** Out-of-band profile creation, the way `SpeakerConversionPort` writes one in D1. */
  async addProfile(profile: SpeakerProfile) {
    this.speakers = [...this.speakers, profile];
  }
  /**
   * Fixture affordances, not port methods: nothing in the product deletes a speaker or an import
   * ledger row. They exist so a test can put a writer in the gap between a caller's read and its
   * write, which is the only place the affected-row count is observable (issue #202).
   */
  async deleteProfile(profileId: string) {
    this.speakers = this.speakers.filter(({ id }) => id !== profileId);
  }
  async deleteSpeakerImport(eventId: string, email: string) {
    this.imports.delete(`${eventId}:${email}`);
  }
  async workspace(eventId: string, userId?: string): Promise<ContentWorkspace> {
    const speakers = this.speakers
      .filter((item) => item.eventId === eventId && (!userId || item.userId === userId))
      .map((profile) => this.profileVersion(profile));
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
        .map(({ id, name, bio, pronouns, jobTitle, organization, photoAssetId, socialLinks }) => ({
          id,
          name,
          bio,
          pronouns,
          ...(jobTitle ? { jobTitle } : {}),
          organization,
          ...(photoAssetId ? { photoAssetId } : {}),
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
  async updateProfile(profile: SpeakerProfile) {
    this.speakers = this.speakers.map((item) => (item.id === profile.id ? profile : item));
  }
  async updateProfileWorkflow(profileId: string, fields: SpeakerWorkflowFields) {
    if (!this.speakers.some(({ id }) => id === profileId)) return false;
    this.speakers = this.speakers.map((item) =>
      item.id === profileId ? { ...item, ...fields } : item,
    );
    return true;
  }
  /**
   * The same allocation D1 performs, and the same answer for a profile that is not there.
   *
   * Decided here rather than by the caller for the reason `replaceLatestAsset` is: the property
   * the D1 statement exists to hold is that the number comes from the row, and a double that let
   * a caller pass one would pass a test the real adapter's version of fails.
   */
  async claimInvitationOccurrence(profileId: string) {
    const profile = this.speakers.find(({ id }) => id === profileId);
    if (!profile) return null;
    const invitationsSent = (profile.invitationsSent ?? 0) + 1;
    this.speakers = this.speakers.map((item) =>
      item.id === profileId ? { ...item, invitationsSent } : item,
    );
    return invitationsSent;
  }
  async updateProfilePhoto(profileId: string, assetId: string | null) {
    if (!this.speakers.some(({ id }) => id === profileId)) return false;
    this.speakers = this.speakers.map((item) => {
      if (item.id !== profileId) return item;
      const { photoAssetId: _replaced, ...withoutPhoto } = item;
      return assetId ? { ...withoutPhoto, photoAssetId: assetId } : withoutPhoto;
    });
    return true;
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
      (profile) => {
        const { photoAssetId: _removed, ...withoutPhoto } = profile;
        return { ...withoutPhoto, ...(assetId ? { photoAssetId: assetId } : {}) };
      },
      expectedVersion,
    );
  }
  async updateTask(task: SpeakerTask) {
    if (!this.tasks.some(({ id }) => id === task.id)) return false;
    this.tasks = this.tasks.map((item) => (item.id === task.id ? task : item));
    return true;
  }
  async updateSession(session: ContentWorkspace["sessions"][number]) {
    this.sessions = this.sessions.map((item) => (item.id === session.id ? session : item));
  }
  async deleteSession(sessionId: string) {
    this.sessions = this.sessions.filter(({ id }) => id !== sessionId);
  }
  async updateAsset(asset: SpeakerAsset) {
    if (!this.assets.some(({ id }) => id === asset.id)) return false;
    this.assets = this.assets.map((item) => (item.id === asset.id ? asset : item));
    return true;
  }
  /**
   * The other half of following D1 on chain identity: its insert stores the two columns a later
   * upload reads a chain by, defaulted the same way — `logicalKey ?? logicalAssetKey(asset)` and
   * `versionGroupId ?? id`. Deriving the key only at read time was the divergence; deriving it
   * nowhere would be the mirror image of it, leaving this store *stricter* than the real one, so
   * a fixture that adds an asset here and one that inserts it there must agree on what is
   * stored. The group travels with the key because `replaceLatestAsset` answers with the group
   * it found on the chain: a keyed row with no group of its own would be found and then reported
   * under the *new* asset's id, which is a group D1 would never answer.
   *
   * `versionNumber` and `isLatest` are deliberately left as they came. Every read of them in
   * this file already applies D1's own defaults (`?? 1`, `!== false`), so writing them here
   * would change nothing but the bytes a fixture's `toEqual` compares against.
   *
   * Rows handed to the constructor are the deliberate exception, and they stay keyless: that is
   * the raw `INSERT` a seed file writes, and a store that cannot hold a keyless row cannot be
   * used to test what becomes of one.
   */
  async addAsset(asset: SpeakerAsset) {
    this.assets = [
      ...this.assets,
      {
        ...asset,
        logicalKey: asset.logicalKey ?? logicalAssetKey(asset),
        versionGroupId: asset.versionGroupId ?? asset.id,
      },
    ];
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
  async deleteAssetAfterStorage(assetId: string, profileId: string, draft: ContentRevisionDraft) {
    const current = await this.findProfile(profileId);
    const revised =
      current?.photoAssetId === assetId
        ? await this.reviseProfilePhoto(profileId, draft, current.version ?? 0, null)
        : null;
    await this.deleteAsset(assetId);
    return revised;
  }
  async hasSpeakerWork(eventId: string, profileId: string) {
    return this.tasks.some(
      (task) => task.eventId === eventId && task.speakerProfileId === profileId,
    );
  }
  async addTask(task: SpeakerTask) {
    this.tasks = [...this.tasks, task];
  }
  async addMessage(message: ContentWorkspace["messages"][number]) {
    this.messages = [...this.messages, message];
  }
  async findProfile(profileId: string) {
    const profile = this.speakers.find(({ id }) => id === profileId);
    return profile ? this.profileVersion(profile) : null;
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
  /** The affected-row count D1 reports, stated the way this store can state it. */
  async updateResource(resource: SpeakerResource) {
    if (!this.resources.some(({ id }) => id === resource.id)) return false;
    this.resources = this.resources.map((item) => (item.id === resource.id ? resource : item));
    return true;
  }
  async deleteResource(resourceId: string) {
    this.resources = this.resources.filter(({ id }) => id !== resourceId);
  }
  async findResource(resourceId: string) {
    return this.resources.find(({ id }) => id === resourceId) ?? null;
  }
  /** Mirrors `ON CONFLICT(event_id,slug) DO UPDATE` in D1, id of the existing row included. */
  async upsertResourceBySlug(resource: SpeakerResource) {
    const existing = this.resources.find(
      (item) => item.eventId === resource.eventId && item.slug === resource.slug,
    );
    this.resources = existing
      ? this.resources.map((item) =>
          item.id === existing.id ? { ...resource, id: existing.id } : item,
        )
      : [...this.resources, resource];
  }
  async listTaskTemplates(eventId: string) {
    return this.taskTemplates
      .filter((item) => item.eventId === eventId)
      .toSorted(
        (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
      );
  }
  /** The `(event_id, title)` counterpart of `upsertResourceBySlug`, with the same id rule. */
  async upsertTaskTemplateByTitle(template: SpeakerTaskTemplate) {
    const existing = this.taskTemplates.find(
      (item) => item.eventId === template.eventId && item.title === template.title,
    );
    this.taskTemplates = existing
      ? this.taskTemplates.map((item) =>
          item.id === existing.id
            ? { ...template, id: existing.id, createdAt: existing.createdAt }
            : item,
        )
      : [...this.taskTemplates, template];
  }
  async findTaskTemplate(templateId: string) {
    return this.taskTemplates.find((item) => item.id === templateId) ?? null;
  }
  /**
   * The database's `UNIQUE(event_id, title)` is enforced here too.
   *
   * A double that accepts a duplicate title would let the console's own "that title is taken"
   * path go untested while the real store raises a constraint the service has to translate.
   */
  async addTaskTemplate(template: SpeakerTaskTemplate) {
    this.assertTitleFree(template);
    this.taskTemplates = [...this.taskTemplates, template];
  }
  async updateTaskTemplate(template: SpeakerTaskTemplate) {
    /*
     * Existence first, then the title rule — the order D1 resolves them in.
     *
     * A `WHERE id = ?` that matches nothing never reaches the unique index, so a store that
     * checked the title first would answer 409 where D1 answers "no such row". That is the
     * difference between a double that lets a service test pass through the wrong path and one
     * that cannot.
     */
    if (!this.taskTemplates.some((item) => item.id === template.id)) return false;
    this.assertTitleFree(template);
    this.taskTemplates = this.taskTemplates.map((item) =>
      item.id === template.id ? { ...template, createdAt: item.createdAt } : item,
    );
    return true;
  }
  async deleteTaskTemplate(templateId: string) {
    this.taskTemplates = this.taskTemplates.filter((item) => item.id !== templateId);
  }
  private assertTitleFree(template: SpeakerTaskTemplate) {
    if (
      this.taskTemplates.some(
        (item) =>
          item.id !== template.id &&
          item.eventId === template.eventId &&
          item.title === template.title,
      )
    )
      throw new Error(
        `UNIQUE constraint failed: speaker_task_templates.event_id, speaker_task_templates.title`,
      );
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
    expectedVersion?: number,
  ): T | null {
    if (!current) return null;
    const existing = this.revisions.filter(
      (revision) => revision.entityType === entityType && revision.entityId === current.id,
    );
    const version = Math.max(0, ...existing.map(({ revisionNumber }) => revisionNumber));
    if (expectedVersion !== undefined && expectedVersion !== version)
      throw new ContentConflictError(
        "This profile changed after you opened it. Reload and try again.",
      );
    const next = edit(current);
    this.revisions = [
      ...this.revisions,
      {
        id: draft.id,
        eventId: draft.eventId,
        entityType,
        entityId: current.id,
        revisionNumber: version + 1,
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
    expectedVersion?: number,
  ) {
    const stored = this.speakers.find(({ id }) => id === profileId);
    const next = this.revise(
      "profile",
      stored ? this.profileVersion(stored) : undefined,
      draft,
      (current) => {
        const edited = edit(current);
        if (
          edited.photoAssetId &&
          !this.assets.some(
            (asset) => asset.id === edited.photoAssetId && asset.speakerProfileId === profileId,
          )
        )
          throw new ContentConflictError(
            "This profile's saved headshot is no longer available. Reload and try again.",
          );
        return { ...edited, version: (current.version ?? 0) + 1 };
      },
      expectedVersion,
    );
    if (next) {
      this.speakers = this.speakers.map((item) => (item.id === next.id ? next : item));
      if (stored?.photoAssetId && stored.photoAssetId !== next.photoAssetId)
        this.assets = this.assets.map((asset) =>
          asset.id === stored.photoAssetId ? { ...asset, visibility: "private" } : asset,
        );
    }
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
