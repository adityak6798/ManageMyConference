import type {
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerMessage,
  SpeakerProfile,
  SpeakerTask,
  SpeakerResource,
  ContentComment,
  ContentRevision,
} from "../../domain/content/content";

export interface AcceptedContent {
  session: ContentSession;
  speakers: readonly SpeakerProfile[];
  tasks: readonly SpeakerTask[];
  messages: readonly SpeakerMessage[];
}

export interface ContentRepository {
  findSessionByProposal(eventId: string, proposalId: string): Promise<ContentSession | null>;
  accept(content: AcceptedContent): Promise<void>;
  workspace(eventId: string, userId?: string): Promise<ContentWorkspace>;
  updateProfile(profile: SpeakerProfile): Promise<void>;
  updateTask(task: SpeakerTask): Promise<void>;
  updateSession(session: ContentSession): Promise<void>;
  /** Remove a withdrawn session. Its speaker, their tasks, and their uploads are untouched. */
  deleteSession(sessionId: string): Promise<void>;
  updateAsset(asset: SpeakerAsset): Promise<void>;
  addAsset(asset: SpeakerAsset): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  addTask(task: SpeakerTask): Promise<void>;
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
  addRevision(revision: ContentRevision): Promise<void>;
  findRevision(revisionId: string): Promise<ContentRevision | null>;
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
