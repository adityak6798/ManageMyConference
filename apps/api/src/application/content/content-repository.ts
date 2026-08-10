import type {
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerMessage,
  SpeakerProfile,
  SpeakerTask,
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
  addAsset(asset: SpeakerAsset): Promise<void>;
  addTask(task: SpeakerTask): Promise<void>;
  addMessage(message: SpeakerMessage): Promise<void>;
  findProfile(profileId: string): Promise<SpeakerProfile | null>;
  findProfileBySource(eventId: string, sourcePersonId: string): Promise<SpeakerProfile | null>;
}

export class ContentConflictError extends Error {}

export interface AssetStoragePort {
  put(input: { key: string; contentType: string; bytes: Uint8Array }): Promise<{ key: string }>;
  delete(key: string): Promise<void>;
}
