export type PublicationState = "draft" | "ready" | "published";
export type TaskStatus = "open" | "complete";
export type AssetVisibility = "private" | "publishable";
export type ResourceVisibility = "hidden" | "visible";
export type SpeakerWorkflowStatus = "invited" | "onboarding" | "ready" | "blocked";
export type SpeakerTaskType = "general" | "file-request";

/**
 * A session content owns.
 *
 * There is deliberately no time on it. When and where a session happens is its placement on the
 * agenda, resolved through the agenda's public application interface every time a session is
 * projected (`PRD-CNT-001`). The three `schedule_*` columns this used to carry were written by
 * nothing but the seed, so the speaker portal and the `.ics` export answered a question the
 * agenda board had already answered differently; migration `0022` drops them.
 */
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
}

/**
 * The platforms a speaker profile can carry a link for.
 *
 * Closed, and closed on purpose. An open map would let the portal store `{"myspace": "..."}` and
 * leave the public programme deciding at render time what that is and how to label it; a closed
 * set means every surface can name the platform, pick its icon, and write an accessible link
 * text without guessing. `website` is the escape hatch for everything not listed.
 */
export const SPEAKER_SOCIAL_PLATFORMS = [
  "website",
  "mastodon",
  "bluesky",
  "linkedin",
  "github",
  "x",
  "youtube",
] as const;
export type SpeakerSocialPlatform = (typeof SPEAKER_SOCIAL_PLATFORMS)[number];
/** Absent and empty mean the same thing — no link — so a blank value is dropped on write. */
export type SpeakerSocialLinks = Partial<Readonly<Record<SpeakerSocialPlatform, string>>>;

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
  readonly workflowStatus?: SpeakerWorkflowStatus | undefined;
  readonly logistics?: Readonly<Record<string, string>> | undefined;
  readonly customFields?: Readonly<Record<string, string>> | undefined;
  readonly socialLinks?: SpeakerSocialLinks | undefined;
}

export interface SpeakerTask {
  readonly id: string;
  readonly eventId: string;
  readonly speakerProfileId: string;
  readonly title: string;
  readonly dueAt: string;
  readonly status: TaskStatus;
  readonly completedAt?: string;
  readonly type?: SpeakerTaskType | undefined;
  readonly instructions?: string | undefined;
  readonly sessionId?: string | undefined;
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
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly versionGroupId?: string | undefined;
  readonly versionNumber?: number | undefined;
  readonly isLatest?: boolean | undefined;
  /** Which logical deliverable this is a version of. See `logicalAssetKey`. */
  readonly logicalKey?: string | undefined;
}

/**
 * What "the same deliverable, uploaded again" means.
 *
 * A file-request task is the strongest statement available: the task *is* one requested
 * deliverable, so replacing `deck.pdf` with `deck-final.pdf` against it is a new version of the
 * same thing rather than a second thing. With no task, the name is what a person means by "the
 * same file", scoped to a session when the upload names one.
 *
 * A client that names a `versionGroupId` overrides all of this — that is an explicit statement
 * about identity, and it is the one path that lets a rename join an existing chain.
 */
export function logicalAssetKey(input: {
  readonly name: string;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
}): string {
  if (input.taskId) return `task:${input.taskId}`;
  const name = `name:${input.name.trim().toLowerCase()}`;
  return input.sessionId ? `session:${input.sessionId}|${name}` : name;
}

export interface ContentComment {
  readonly id: string;
  readonly eventId: string;
  readonly assetId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: string;
}
export interface ContentRevision {
  readonly id: string;
  readonly eventId: string;
  readonly entityType: "profile" | "session";
  readonly entityId: string;
  readonly revisionNumber: number;
  readonly snapshotJson: string;
  readonly actorId: string;
  readonly createdAt: string;
  readonly restoredFromRevisionId?: string | undefined;
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

export interface SpeakerResource {
  readonly id: string;
  readonly eventId: string;
  readonly title: string;
  readonly slug: string;
  readonly bodyHtml: string;
  readonly embedHtml: string;
  readonly visibility: ResourceVisibility;
  readonly sortOrder: number;
}

/**
 * One line of a reusable speaker checklist: what is being asked for, and when it comes due.
 *
 * Deliberately not a `SpeakerTask` with nobody attached. `speaker_tasks.speaker_profile_id` is
 * `NOT NULL` because a task is a named person's work — the reminder cron, the portal and every
 * completion badge read it that way — while a checklist line is the event's, and stays the
 * event's until an organizer instantiates it against real speakers. Sharing one table would
 * make "whose work is this?" a question answered by a nullable column.
 *
 * `dueOffsetDays` is a distance, not a date, because an event carries no date range of its own
 * (`PRD-EVT-001`): the caller instantiating the checklist names the anchor it counts from, and
 * the same checklist therefore lands correctly on next year's conference.
 */
export interface SpeakerTaskTemplate {
  readonly id: string;
  readonly eventId: string;
  readonly title: string;
  readonly description: string;
  readonly sortOrder: number;
  /** Days after the anchor the instantiated task falls due. Negative counts backwards from it. */
  readonly dueOffsetDays: number;
  readonly createdAt: string;
}

export interface ContentWorkspace {
  readonly sessions: readonly ContentSession[];
  readonly speakers: readonly SpeakerProfile[];
  readonly tasks: readonly SpeakerTask[];
  readonly assets: readonly SpeakerAsset[];
  readonly messages: readonly SpeakerMessage[];
  readonly resources?: readonly SpeakerResource[];
  readonly comments?: readonly ContentComment[];
  readonly revisions?: readonly ContentRevision[];
}
