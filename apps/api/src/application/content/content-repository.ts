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

export interface AcceptedContent {
  session: ContentSession;
  speakers: readonly SpeakerProfile[];
  tasks: readonly SpeakerTask[];
  messages: readonly SpeakerMessage[];
}

/**
 * A revision the caller wants recorded, minus the two things only the store may decide.
 *
 * `revisionNumber` is absent because an application that reads the highest number and adds one
 * has already lost the race: two organizers editing the same speaker both compute the same
 * number, and `UNIQUE(entity_type, entity_id, revision_number)` refuses the second edit that
 * was otherwise perfectly valid. `snapshotJson` is absent because the state a revision claims
 * to preserve must be the state the row actually held immediately before the write — read by
 * the store, in the same operation, not by a caller that read it moments earlier.
 */
export interface ContentRevisionDraft {
  readonly id: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly restoredFromRevisionId?: string | undefined;
}

/**
 * The edit itself, applied to whatever the store finds when it takes the row.
 *
 * A function rather than a finished entity, because the store may have to re-read: an edit that
 * lost the race for a revision number is retried against the row as it is *now*, so the losing
 * organizer's change lands on top of the winner's instead of overwriting it from a stale copy.
 */
export type ContentEdit<T> = (current: T) => T;

export interface ContentRepository {
  findSessionByProposal(eventId: string, proposalId: string): Promise<ContentSession | null>;
  accept(content: AcceptedContent): Promise<void>;
  workspace(eventId: string, userId?: string): Promise<ContentWorkspace>;
  updateProfile(profile: SpeakerProfile): Promise<void>;
  /**
   * Point a profile at one of its uploads, or at none — and touch nothing else.
   *
   * Narrow on purpose. `updateProfile` rewrites every mutable column from whatever the caller
   * last read, so choosing a headshot through it would put a bio, a workflow status and a
   * logistics field back the way they were at that read, silently undoing an organizer's edit
   * that landed in between. A speaker choosing a picture should write the picture.
   */
  updateProfilePhoto(profileId: string, assetId: string | null): Promise<void>;
  updateTask(task: SpeakerTask): Promise<void>;
  /**
   * Write a session with no revision and no guard.
   *
   * No production path calls this, and none should: an organizer's session edit goes through
   * `reviseSession`, which records who changed what and refuses to write from a copy the row
   * has moved past. It survives because fixtures in other domains' suites build session state
   * with it. A new caller here is a caller that has bypassed attributed history.
   */
  updateSession(session: ContentSession): Promise<void>;
  /** Remove a withdrawn session. Its speaker, their tasks, and their uploads are untouched. */
  deleteSession(sessionId: string): Promise<void>;
  updateAsset(asset: SpeakerAsset): Promise<void>;
  addAsset(asset: SpeakerAsset): Promise<void>;
  replaceLatestAsset(asset: SpeakerAsset, previous?: SpeakerAsset): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  addTask(task: SpeakerTask): Promise<void>;
  addTasks(tasks: readonly SpeakerTask[]): Promise<void>;
  addMessage(message: SpeakerMessage): Promise<void>;
  findProfile(profileId: string): Promise<SpeakerProfile | null>;
  findSession(sessionId: string): Promise<ContentSession | null>;
  findAsset(assetId: string): Promise<SpeakerAsset | null>;
  findProfileBySource(eventId: string, sourcePersonId: string): Promise<SpeakerProfile | null>;
  addResource(resource: SpeakerResource): Promise<void>;
  updateResource(resource: SpeakerResource): Promise<void>;
  deleteResource(resourceId: string): Promise<void>;
  findResource(resourceId: string): Promise<SpeakerResource | null>;
  addComment(comment: ContentComment): Promise<void>;
  /**
   * Record what the profile was and write what it becomes, as one indivisible operation.
   *
   * There is deliberately no way to append a revision on its own. The two writes used to be
   * separate calls, so a failure on the second left a revision describing an edit that never
   * happened — history that reads as authoritative and is not. Returns the stored profile, or
   * `null` when the profile no longer exists.
   */
  reviseProfile(
    profileId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<SpeakerProfile>,
  ): Promise<SpeakerProfile | null>;
  /** `reviseProfile` for a session: the same single-operation guarantee. */
  reviseSession(
    sessionId: string,
    draft: ContentRevisionDraft,
    edit: ContentEdit<ContentSession>,
  ): Promise<ContentSession | null>;
  findRevision(revisionId: string): Promise<ContentRevision | null>;
  findSpeakerImport(eventId: string, email: string): Promise<"pending" | "complete" | null>;
  beginSpeakerImport(eventId: string, email: string): Promise<void>;
  completeSpeakerImport(eventId: string, email: string): Promise<void>;
}

export class ContentConflictError extends Error {}

/**
 * "Is this event's public page live?", answered by whoever owns publication state.
 *
 * Content asks because an asset an organizer marked publishable is reachable *through* that
 * page: taking the page down has to take its bytes down with it. The port is declared here so
 * the content domain never imports the publishing domain; the composition root supplies it.
 * An implementation is optional, and its absence means "nothing is published" — a missing
 * wiring loses public asset reads rather than silently serving withdrawn bytes.
 */
export interface EventPublicationQuery {
  isEventPublished(eventId: string): Promise<boolean>;
}

export interface AssetStoragePort {
  put(input: { key: string; contentType: string; bytes: Uint8Array }): Promise<{ key: string }>;
  get(key: string): Promise<{ contentType: string; bytes: Uint8Array } | null>;
  delete(key: string): Promise<void>;
}
