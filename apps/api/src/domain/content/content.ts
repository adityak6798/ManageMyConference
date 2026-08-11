export type PublicationState = "draft" | "ready" | "published";
export type TaskStatus = "open" | "complete";
export type AssetVisibility = "private" | "publishable";

export interface ContentSession {
  readonly id: string;
  readonly eventId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly abstract: string;
  readonly format: string;
  readonly speakerProfileIds: readonly string[];
  readonly tags: readonly string[];
  readonly tracks: readonly string[];
  readonly publicationState: PublicationState;
  readonly schedule?: { startsAt: string; endsAt: string; location: string };
}

export interface SpeakerProfile {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly sourcePersonId: string;
  readonly name: string;
  readonly email: string;
  readonly bio: string;
  readonly pronouns: string;
  readonly organization: string;
  readonly photoAssetId?: string;
}

export interface SpeakerTask {
  readonly id: string;
  readonly eventId: string;
  readonly speakerProfileId: string;
  readonly title: string;
  readonly dueAt: string;
  readonly status: TaskStatus;
  readonly completedAt?: string;
}

export interface SpeakerAsset {
  readonly id: string;
  readonly eventId: string;
  readonly speakerProfileId: string;
  readonly name: string;
  readonly contentType: string;
  readonly storageKey: string;
  readonly visibility: AssetVisibility;
  readonly uploadedAt: string;
}

/**
 * Only an image can stand in for a person.
 *
 * The upload route accepts slide decks as well as headshots, so "this file belongs to the
 * speaker" is not enough to make it a face: a PDF reached from `photoAssetId` renders as a
 * broken tile in every gallery that trusts the projection, and the projection has no way to
 * tell. The rule lives in the domain because it is a statement about what a speaker profile
 * is, not about how any particular request is shaped.
 */
export function canBeProfilePhoto(asset: Pick<SpeakerAsset, "contentType">): boolean {
  return /^image\//i.test(asset.contentType.trim());
}

export interface SpeakerMessage {
  readonly id: string;
  readonly eventId: string;
  readonly speakerProfileId: string;
  readonly subject: string;
  readonly sentAt: string;
}

export interface ContentWorkspace {
  readonly sessions: readonly ContentSession[];
  readonly speakers: readonly SpeakerProfile[];
  readonly tasks: readonly SpeakerTask[];
  readonly assets: readonly SpeakerAsset[];
  readonly messages: readonly SpeakerMessage[];
}
