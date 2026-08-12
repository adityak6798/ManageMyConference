import {
  canBeProfilePhoto,
  type ContentSession,
  type ContentWorkspace,
  type SpeakerAsset,
  type SpeakerProfile,
  type SpeakerTask,
} from "../../domain/content/content";
import type { ContentAgendaInterface, SessionSchedule } from "../agenda/public";
import {
  type Actor,
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { AcceptedProposalQuery } from "../review/public";
import type { SpeakerConversionPort } from "./speaker-conversion";
import {
  type AssetStoragePort,
  ContentConflictError,
  type ContentRepository,
  type EventPublicationQuery,
} from "./content-repository";

/**
 * Acceptance carries a proposal reference and nothing else.
 *
 * Everything else — title, abstract, format, and the speaker's identity — is resolved server-side
 * through the review domain's public application interface and the speaker conversion port. A
 * client that could name the title and the speaker could invent both, which is exactly how a
 * fabricated proposal id used to become a session with a ghost speaker. Organizers edit the
 * session afterwards through `PATCH /api/content-sessions/{id}`, so no override belongs here.
 */
export interface AcceptContentCommand {
  eventId: string;
  proposalId: string;
}

/** The speaker identity could not be provisioned from the accepted proposal. */
export class SpeakerIdentityUnavailableError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("Speaker identity could not be resolved for this proposal");
  }
}

/**
 * The named file cannot be this speaker's headshot, reported against the field that named it.
 *
 * A refusal the caller can act on — pick another file, or upload an image — so it is a typed
 * 400 with the offending field, never an opaque failure.
 */
export class SpeakerPhotoInvalidError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super("This file cannot be used as a profile photo");
  }
}

/**
 * A session as content projects it: the stored session plus where the agenda puts it.
 *
 * `schedule` is present only while the event's *published agenda* places this session, and it
 * is recomputed on every read. Nothing writes it, which is the whole point: there is one copy
 * of a session's time, so nothing here can go stale against the agenda that owns it.
 *
 * Which of the three clocks this is matters, and `PRD-PUB-001` keeps them apart deliberately:
 *
 * - the agenda **draft** — the organizer's board, moved by every drag. Never read here. A
 *   session dropped into a slot has no `schedule` until the agenda is published.
 * - the agenda **publication** — the numbered immutable snapshot the organizer committed to.
 *   This is what `schedule` is, read live through `ContentAgendaInterface` on every request.
 * - the **site** publication — the public projection frozen when the organizer published the
 *   event page, which is what `/api/public/events/{slug}/schedule` and the event hub serve.
 *
 * Publishing the agenda moves the second immediately and leaves the third where it was, so
 * the speaker portal and the `.ics` can be one site publication ahead of the public programme
 * until the organizer publishes the site as well. That window is the rule, not a defect: a
 * speaker is told the time their organizer committed to, and the public surface only ever
 * changes when somebody deliberately republishes it.
 */
export interface ScheduledContentSession extends ContentSession {
  readonly schedule?: SessionSchedule;
}

/** The content workspace as it leaves the application layer, with schedules resolved. */
export interface ContentWorkspaceView extends Omit<ContentWorkspace, "sessions"> {
  readonly sessions: readonly ScheduledContentSession[];
}

export interface ContentServiceDependencies {
  repository: ContentRepository;
  assetStorage: AssetStoragePort;
  /** The review domain's answer to "may this proposal become content?". */
  proposals: AcceptedProposalQuery;
  /**
   * The agenda domain's answer to "when does this session happen?", and the way a withdrawn
   * session leaves the board. Required, not optional: a session's time has exactly one source,
   * and a composition that cannot reach it would otherwise quietly invent "unscheduled".
   */
  agenda: ContentAgendaInterface;
  /** Idempotent speaker provisioning, shared with CRM conversion (`ARC-FLOW-003`). */
  speakerConversion: SpeakerConversionPort;
  /**
   * Publication state of the owning event, consulted before any asset is served publicly.
   * Omitted means "no event is published", so an unwired deployment withholds bytes rather
   * than exposing them.
   */
  eventPublication?: EventPublicationQuery;
  newId: () => string;
  now: () => Date;
}

function hasEventRole(actor: Actor, eventId: string, role: "organizer" | "speaker") {
  return actor.eventAccess.some((access) => access.eventId === eventId && access.role === role);
}

/** RFC 5545 section 3.1: a content line carries at most 75 octets before its CRLF. */
const CALENDAR_LINE_OCTETS = 75;

/**
 * RFC 5545 section 3.1 admits every character except CONTROL (%x00-08, %x0A-1F, %x7F) in a
 * TEXT value; HTAB is the one C0 character that survives. Line breaks are escaped before this
 * runs, so whatever is left is a control character no conforming parser would accept.
 */
function isCalendarTextCharacter(character: string) {
  const code = character.codePointAt(0) ?? 0;
  return character === "\t" || (code >= 0x20 && code !== 0x7f);
}

/**
 * RFC 5545 section 3.3.11 TEXT: backslash, comma, semicolon, and line breaks are escaped.
 * The backslash has to go first so the escapes introduced afterwards are not escaped again.
 */
function escapeCalendarText(value: string) {
  return [
    ...value
      .replaceAll("\\", "\\\\")
      .replaceAll(",", "\\,")
      .replaceAll(";", "\\;")
      .replaceAll(/\r\n|\r|\n/g, "\\n"),
  ]
    .filter(isCalendarTextCharacter)
    .join("");
}

/**
 * RFC 5545 section 3.1 folding: split on UTF-8 octet boundaries and continue with CRLF plus
 * one space, which the reader strips to recover the original line. The split never lands
 * inside a multi-octet character, so unfolding restores the text byte for byte.
 */
function foldCalendarLine(line: string) {
  const octets = new TextEncoder().encode(line);
  if (octets.length <= CALENDAR_LINE_OCTETS) return line;
  const decoder = new TextDecoder();
  const folded: string[] = [];
  let start = 0;
  // The first line spends all 75 octets on content; every continuation spends one on its space.
  let budget = CALENDAR_LINE_OCTETS;
  while (start < octets.length) {
    let end = Math.min(start + budget, octets.length);
    // 0b10xxxxxx marks a UTF-8 continuation octet: step back until the boundary is a character.
    while (end < octets.length && ((octets[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
    folded.push(decoder.decode(octets.subarray(start, end)));
    start = end;
    budget = CALENDAR_LINE_OCTETS - 1;
  }
  return folded.join("\r\n ");
}

/** RFC 5545 section 3.3.5 UTC DATE-TIME form: `YYYYMMDDTHHMMSSZ`, no fractional seconds. */
function utcCalendarStamp(instant: Date) {
  return instant
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Convert a stored ISO instant to the UTC DATE-TIME form, or null when it is not an instant.
 * An offset is required: `2026-09-15T17:00:00` would be read in whatever zone the worker
 * happens to run in, which would make the export non-deterministic.
 */
function calendarDateTime(value: string) {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : utcCalendarStamp(instant);
}

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export class ContentService {
  constructor(private readonly dependencies: ContentServiceDependencies) {}

  /**
   * Turn an accepted proposal into program content.
   *
   * Idempotent per `(eventId, proposalId)`: the session's unique constraint is the arbiter, and a
   * loser of that race retries and finds the winner's session. `ARC-FLOW-001`.
   */
  async accept(
    actor: Actor | null,
    command: AcceptContentCommand,
    correlationId: string,
    conflictRetries = 2,
  ): Promise<ContentWorkspaceView> {
    const authorized = requireEventCapability(actor, command.eventId, "content:manage");
    // Throws a typed 4xx for unknown, foreign, undecided, or identity-less proposals.
    const accepted = await this.dependencies.proposals.acceptedProposal(
      command.eventId,
      command.proposalId,
    );
    const existing = await this.dependencies.repository.findSessionByProposal(
      command.eventId,
      command.proposalId,
    );
    if (!existing) {
      const speaker = await this.resolveSpeaker(accepted, authorized.id, correlationId);
      // The conversion port owns the profile row, so the onboarding checklist is keyed off the
      // work already assigned to this person rather than off "did I just insert the profile".
      const before = await this.dependencies.repository.workspace(command.eventId);
      const isNew = !before.tasks.some(({ speakerProfileId }) => speakerProfileId === speaker.id);
      const session: ContentSession = {
        id: this.dependencies.newId(),
        eventId: command.eventId,
        proposalId: command.proposalId,
        title: accepted.title,
        abstract: accepted.abstract,
        format: accepted.format,
        speakerProfileIds: [speaker.id],
        tags: [],
        tracks: [],
        publicationState: "draft",
      };
      const tasks: SpeakerTask[] = isNew
        ? ["Complete your speaker profile", "Upload a headshot"].map((title) => ({
            id: this.dependencies.newId(),
            eventId: command.eventId,
            speakerProfileId: speaker.id,
            title,
            dueAt: this.dependencies.now().toISOString(),
            status: "open",
          }))
        : [];
      try {
        await this.dependencies.repository.accept({
          session,
          // The speaker profile is already durable: `SpeakerConversionPort` provisions the user
          // and the profile together, which is what keeps a client-named `userId` — and the
          // foreign-key failure it used to cause — out of this path entirely.
          speakers: [],
          tasks,
          messages: [],
        });
      } catch (error) {
        if (error instanceof ContentConflictError && conflictRetries > 0)
          return this.accept(actor, command, correlationId, conflictRetries - 1);
        throw error;
      }
    }
    return this.projected(command.eventId);
  }

  /**
   * The stored workspace with every session's time resolved from the agenda.
   *
   * One place asks, so no caller can forget to. `publishedSessionSchedules` is a single read of
   * the snapshot in force; a session it does not name has no `schedule` at all rather than an
   * empty or stale one.
   */
  private async projected(eventId: string, userId?: string): Promise<ContentWorkspaceView> {
    const [workspace, schedules] = await Promise.all([
      this.dependencies.repository.workspace(eventId, userId),
      this.dependencies.agenda.publishedSessionSchedules(eventId),
    ]);
    return {
      ...workspace,
      sessions: workspace.sessions.map((session) => {
        const schedule = schedules.get(session.id);
        return schedule ? { ...session, schedule } : session;
      }),
    };
  }

  private async resolveSpeaker(
    accepted: { eventId: string; proposalId: string; submitter: { name: string; email: string } },
    actorId: string,
    correlationId: string,
  ): Promise<SpeakerProfile> {
    let speakerId: string;
    try {
      ({ speakerId } = await this.dependencies.speakerConversion.createOrLink({
        eventId: accepted.eventId,
        source: { kind: "cfp-proposal", id: accepted.proposalId },
        name: accepted.submitter.name,
        email: accepted.submitter.email,
        actorId,
        occurredAt: this.dependencies.now().toISOString(),
        correlationId,
        idempotencyKey: `content-accept:${accepted.eventId}:${accepted.proposalId}`,
      }));
    } catch (error) {
      // A referential failure here means the submitted identity cannot be provisioned. That is
      // an input problem the organizer can act on, not the opaque 500 it used to produce.
      if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message))
        throw new SpeakerIdentityUnavailableError({
          "submitter.email": ["This submitter cannot be linked to a speaker identity."],
        });
      throw error;
    }
    const profile = await this.dependencies.repository.findProfile(speakerId);
    if (!profile || profile.eventId !== accepted.eventId)
      throw new SpeakerIdentityUnavailableError({
        "submitter.email": ["This submitter cannot be linked to a speaker identity."],
      });
    return profile;
  }

  async workspace(actor: Actor | null, eventId: string): Promise<ContentWorkspaceView> {
    const authorized = requireEventCapability(actor, eventId, "content:read");
    const isOrganizer = hasEventRole(authorized, eventId, "organizer");
    const isSpeaker = hasEventRole(authorized, eventId, "speaker");
    if (!isOrganizer && !isSpeaker)
      throw new CapabilityDeniedError("Content workspace access denied");
    return this.projected(eventId, isOrganizer ? undefined : authorized.id);
  }

  async updateMyProfile(
    actor: Actor | null,
    profileId: string,
    input: Pick<SpeakerProfile, "name" | "bio" | "pronouns" | "organization">,
  ): Promise<SpeakerProfile> {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    const authorized = requireEventCapability(actor, profile.eventId, "content:read");
    if (
      !profile ||
      !hasEventRole(authorized, profile.eventId, "speaker") ||
      profile.userId !== authorized.id
    )
      throw new CapabilityDeniedError("Speaker profile access denied");
    const updated = { ...profile, ...input };
    await this.dependencies.repository.updateProfile(updated);
    return updated;
  }

  /**
   * Point a speaker profile at one of that speaker's own uploaded images.
   *
   * This is the link that was missing. `photo_asset_id` was read by the public projection and
   * cleared when its asset was deleted, but nothing ever wrote it, so the only headshot that
   * could exist anywhere was the one the seed inserted by hand — and "upload a headshot, use
   * it as your profile photo" was a journey no speaker could complete.
   *
   * Two identities may record the choice, and only two: the speaker whose profile it is, doing
   * their own portal work, and an organizer of the event whose programme the photo appears on,
   * fixing it on their behalf. A speaker on the same event, a reviewer, and an anonymous caller
   * are all refused identically to a profile that does not exist.
   *
   * Recording the choice never publishes anything. The asset's `visibility` is untouched, so
   * marking a private upload as the headshot leaves it private: `PublicationService.preview`
   * emits a `photoUrl` only for an asset the organizer separately marked publishable, and
   * `readAsset` opens the public door only while the asset is publishable *and* its event's
   * page is live. Choosing the face and publishing it stay two decisions, held by two people.
   */
  async setProfilePhoto(
    actor: Actor | null,
    profileId: string,
    assetId: string,
  ): Promise<SpeakerProfile> {
    const profile = await this.requireProfileSteward(actor, profileId);
    const asset = await this.dependencies.repository.findAsset(assetId);
    // Whoever gets this far already lists this profile's uploads through the workspace, so
    // naming the mismatch reveals nothing new; an asset belonging to another profile and one
    // that does not exist at all still answer identically (`ARC-AUTH-001`).
    if (!asset || asset.speakerProfileId !== profile.id)
      throw new SpeakerPhotoInvalidError({
        assetId: ["Choose a file this speaker uploaded."],
      });
    if (!canBeProfilePhoto(asset))
      throw new SpeakerPhotoInvalidError({
        assetId: [`“${asset.name}” is not an image. A profile photo must be a PNG or JPEG.`],
      });
    const updated: SpeakerProfile = { ...profile, photoAssetId: asset.id };
    await this.dependencies.repository.updateProfile(updated);
    return updated;
  }

  /**
   * Take the headshot back off the profile, leaving the file itself alone.
   *
   * The same two identities as `setProfilePhoto`, because withdrawing a choice cannot need
   * more authority than making it. The upload survives — this is "not this picture", not
   * "delete my file", which is what `deleteAsset` is for.
   */
  async clearProfilePhoto(actor: Actor | null, profileId: string): Promise<SpeakerProfile> {
    const profile = await this.requireProfileSteward(actor, profileId);
    const { photoAssetId: _removed, ...withoutPhoto } = profile;
    await this.dependencies.repository.updateProfile(withoutPhoto);
    return withoutPhoto;
  }

  /** The speaker whose profile it is, or an organizer of the event that profile belongs to. */
  private async requireProfileSteward(
    actor: Actor | null,
    profileId: string,
  ): Promise<SpeakerProfile> {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    const authorized = requireEventCapability(actor, profile.eventId, "content:read");
    const isOwner = Boolean(
      profile.userId === authorized.id && hasEventRole(authorized, profile.eventId, "speaker"),
    );
    if (!isOwner && !hasEventRole(authorized, profile.eventId, "organizer"))
      throw new CapabilityDeniedError("Speaker profile access denied");
    return profile;
  }

  async completeTask(
    actor: Actor | null,
    taskId: string,
    eventId: string,
  ): Promise<ContentWorkspaceView> {
    const authorized = requireEventCapability(actor, eventId, "content:read");
    if (!hasEventRole(authorized, eventId, "speaker"))
      throw new CapabilityDeniedError("Speaker task access denied");
    const workspace = await this.dependencies.repository.workspace(eventId, authorized.id);
    const task = workspace.tasks.find(({ id }) => id === taskId);
    if (!task) throw new CapabilityDeniedError("Speaker task access denied");
    await this.dependencies.repository.updateTask({
      ...task,
      status: "complete",
      completedAt: this.dependencies.now().toISOString(),
    });
    return this.workspace(actor, eventId);
  }

  async requestTask(
    actor: Actor | null,
    input: { profileId: string; title: string; dueAt: string },
  ) {
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile) throw new CapabilityDeniedError("Organizer speaker access denied");
    requireEventCapability(actor, profile.eventId, "content:manage");
    const task: SpeakerTask = {
      id: this.dependencies.newId(),
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      title: input.title,
      dueAt: input.dueAt,
      status: "open",
    };
    await this.dependencies.repository.addTask(task);
    return task;
  }

  async recordMessage(actor: Actor | null, input: { profileId: string; subject: string }) {
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile) throw new CapabilityDeniedError("Organizer speaker access denied");
    requireEventCapability(actor, profile.eventId, "content:manage");
    const message = {
      id: this.dependencies.newId(),
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      subject: input.subject,
      sentAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.repository.addMessage(message);
    return message;
  }

  async updateSession(
    actor: Actor | null,
    sessionId: string,
    input: Pick<
      ContentSession,
      "title" | "abstract" | "format" | "speakerProfileIds" | "tags" | "tracks" | "publicationState"
    >,
  ) {
    const session = await this.dependencies.repository.findSession(sessionId);
    if (!session) throw new CapabilityDeniedError("Organizer session access denied");
    const authorized = requireEventCapability(actor, session.eventId, "content:manage");
    const profiles = await Promise.all(
      input.speakerProfileIds.map((id) => this.dependencies.repository.findProfile(id)),
    );
    if (profiles.some((profile) => !profile || profile.eventId !== session.eventId))
      throw new CapabilityDeniedError("Session speaker access denied");
    const updated = { ...session, ...input };
    await this.dependencies.repository.updateSession(updated);
    return updated;
  }

  /**
   * Take a session out of the programme entirely.
   *
   * The affordance the decline dialog names. Declining an abstract that was already accepted
   * records the reversal, but the session it created is content's own object and only content
   * can remove it — before this existed the dialog sent organizers hunting for a control the
   * product had never built.
   *
   * Organizer-only, like every other write to somebody else's session. The agenda is told
   * first, through its public application interface: a placement outliving its session is a
   * `MISSING_SESSION` conflict that blocks the next schedule publication, whereas a session
   * that outlives the attempt to unplace it is merely still on the board. Order the two writes
   * the other way and a failure in between leaves the worse of the two states.
   *
   * The speaker profile, its tasks, and its uploads all survive: the person may be speaking in
   * another session, and deleting their work because one talk was withdrawn would be a second
   * destructive surprise. Publication snapshots are immutable, so the session leaves the public
   * page at the next publish, which is what the confirmation says.
   */
  async withdrawSession(actor: Actor | null, sessionId: string): Promise<ContentWorkspaceView> {
    const session = await this.dependencies.repository.findSession(sessionId);
    if (!session) throw new CapabilityDeniedError("Organizer session access denied");
    const authorized = requireEventCapability(actor, session.eventId, "content:manage");
    await this.dependencies.agenda.unscheduleSession(authorized, session.eventId, session.id);
    await this.dependencies.repository.deleteSession(session.id);
    return this.projected(session.eventId);
  }

  /**
   * Read an uploaded asset's bytes.
   *
   * Assets were write-only, so an uploaded headshot could never be shown anywhere.
   * Access mirrors how the asset was uploaded: organizers of the owning event and
   * the speaker who owns the profile may read any of their assets; everyone else,
   * including anonymous public traffic, may read only assets an organizer has
   * explicitly marked publishable *while that event's public page is live*.
   *
   * Tying the public door to the event's publication state is deliberate. `publishAsset`
   * means "this may appear on the event's public page"; if the organizer takes the page
   * down, the bytes it exposed have to go with it, or `POST /unpublish` is not a withdrawal
   * at all. Deriving it at read time rather than rewriting every asset's visibility keeps
   * re-publishing the event lossless and leaves the organizer's own decision intact.
   *
   * `publiclyReadable` reports which door opened, because only bytes served through the
   * public one may be stored by a shared cache.
   */
  async readAsset(
    actor: Actor | null,
    assetId: string,
  ): Promise<{
    asset: SpeakerAsset;
    contentType: string;
    bytes: Uint8Array;
    publiclyReadable: boolean;
  } | null> {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset) return null;
    // Missing and inaccessible collapse to the same null so the route cannot be used to
    // discover which asset ids exist — `ARC-AUTH-001` in docs/architecture/authorization.md
    // requires that errors not reveal whether an inaccessible record exists. This route is
    // reachable anonymously, which is why it collapses rather than throwing the way the
    // organizer-only mutations below do.
    const publiclyReadable =
      asset.visibility === "publishable" &&
      (await (this.dependencies.eventPublication?.isEventPublished(asset.eventId) ??
        Promise.resolve(false)));
    if (!publiclyReadable && !(await this.mayReadPrivately(actor, asset))) return null;
    const stored = await this.dependencies.assetStorage.get(asset.storageKey);
    if (!stored) return null;
    return { asset, contentType: stored.contentType, bytes: stored.bytes, publiclyReadable };
  }

  /** The owning speaker and organizers of the event read an asset whatever its visibility. */
  private async mayReadPrivately(actor: Actor | null, asset: SpeakerAsset): Promise<boolean> {
    let authorized: Actor;
    try {
      authorized = requireCapability(actor, "content:read");
    } catch {
      // ERROR-INTENT: an unauthenticated or uncapable caller must not learn the asset exists.
      return false;
    }
    if (hasEventRole(authorized, asset.eventId, "organizer")) return true;
    const profile = await this.dependencies.repository.findProfile(asset.speakerProfileId);
    // Ownership is event-scoped: `content:read` is the union across every event the actor can
    // touch, so matching the stored user id alone would keep serving this asset after the
    // speaker's access to its event was removed.
    return profile?.userId === authorized.id && hasEventRole(authorized, asset.eventId, "speaker");
  }

  async publishAsset(actor: Actor | null, assetId: string) {
    return this.setAssetVisibility(actor, assetId, "publishable");
  }

  /**
   * Return a published asset to `private`.
   *
   * The reverse of `publishAsset` and organizer-only for the same reason: publication is the
   * organizer's decision, so retracting one is too. An unknown id and an asset belonging to
   * another organizer's event fail identically, so neither can be told apart (`ARC-AUTH-001`).
   */
  async unpublishAsset(actor: Actor | null, assetId: string) {
    return this.setAssetVisibility(actor, assetId, "private");
  }

  private async setAssetVisibility(
    actor: Actor | null,
    assetId: string,
    visibility: SpeakerAsset["visibility"],
  ) {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset) throw new CapabilityDeniedError("Organizer asset access denied");
    requireEventCapability(actor, asset.eventId, "content:manage");
    const updated: SpeakerAsset = { ...asset, visibility };
    await this.dependencies.repository.updateAsset(updated);
    return updated;
  }

  /**
   * Delete an asset: the stored object first, then the row that points at it.
   *
   * The speaker who owns the profile may withdraw their own upload, and an organizer of the
   * event may remove one they should never have received. The stored object goes first so a
   * failure part-way through leaves a row whose bytes are already gone — reads 404 either way
   * — rather than an orphaned object nobody can reach to delete. A profile photo that pointed
   * at this asset is cleared first, so no public projection is left advertising a dead URL.
   */
  async deleteAsset(actor: Actor | null, assetId: string): Promise<void> {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset) throw new CapabilityDeniedError("Speaker asset access denied");
    const authorized = requireEventCapability(actor, asset.eventId, "content:read");
    const profile = asset
      ? await this.dependencies.repository.findProfile(asset.speakerProfileId)
      : null;
    const isOwner = Boolean(
      profile &&
        profile.userId === authorized.id &&
        hasEventRole(authorized, profile.eventId, "speaker"),
    );
    if (!isOwner && !hasEventRole(authorized, asset.eventId, "organizer"))
      throw new CapabilityDeniedError("Speaker asset access denied");
    if (profile?.photoAssetId === asset.id) {
      const { photoAssetId: _removed, ...withoutPhoto } = profile;
      await this.dependencies.repository.updateProfile(withoutPhoto);
    }
    await this.dependencies.assetStorage.delete(asset.storageKey);
    await this.dependencies.repository.deleteAsset(asset.id);
  }

  async upload(
    actor: Actor | null,
    input: {
      profileId: string;
      name: string;
      contentType: string;
      bytes: Uint8Array;
    },
  ): Promise<SpeakerAsset> {
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker asset access denied");
    const authorized = requireEventCapability(actor, profile.eventId, "content:read");
    if (!hasEventRole(authorized, profile.eventId, "speaker") || profile.userId !== authorized.id)
      throw new CapabilityDeniedError("Speaker asset access denied");
    const id = this.dependencies.newId();
    const key = `${profile.eventId}/${profile.id}/${id}`;
    const stored = await this.dependencies.assetStorage.put({
      key,
      contentType: input.contentType,
      bytes: input.bytes,
    });
    const asset: SpeakerAsset = {
      id,
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      name: input.name,
      contentType: input.contentType,
      storageKey: stored.key,
      visibility: "private",
      uploadedAt: this.dependencies.now().toISOString(),
    };
    try {
      await this.dependencies.repository.addAsset(asset);
    } catch (metadataError) {
      try {
        await this.dependencies.assetStorage.delete(stored.key);
      } catch (cleanupError) {
        throw new AggregateError(
          [metadataError, cleanupError],
          "Asset metadata and R2 cleanup both failed",
        );
      }
      throw metadataError;
    }
    return asset;
  }

  /**
   * The speaker's scheduled sessions as an RFC 5545 iCalendar stream.
   *
   * "Scheduled" means placed on the event's **published agenda**, which is where every start,
   * end, and location below comes from. A session the organizer has moved on the board but not
   * yet published keeps its published time until the agenda is published again. A session with
   * no published placement produces no VEVENT at all — an absent entry is honest, an invented
   * one is not — and a speaker with no placed session gets no document, which the route answers
   * as a 404.
   *
   * This file is *not* the public programme, and the two can legitimately disagree. It tracks
   * the agenda publication live; `/api/public/events/{slug}/schedule` serves the site snapshot
   * frozen at the last site publication (see `ScheduledContentSession` above and `PRD-PUB-001`).
   * Republishing the agenda alone therefore moves a speaker's calendar entry before the public
   * page agrees, and the two reconverge when the organizer publishes the site. Nobody may write
   * code — or a comment — that assumes these two are the same bytes; the invariant that does
   * hold is that this document always equals the agenda publication in force at read time.
   *
   * VCALENDAR carries the two REQUIRED properties, PRODID (3.7.3) and VERSION (3.7.4), plus
   * CALSCALE (3.7.1) stated explicitly even though GREGORIAN is its default. METHOD (3.7.2) is
   * deliberately absent: it MUST match the `method` parameter of the Content-Type the transport
   * sends, and this document is downloaded as a plain `text/calendar` file to import, not as an
   * iTIP message. Each VEVENT carries UID and DTSTAMP, REQUIRED by 3.6.1, and DTSTART, which is
   * REQUIRED there too because the object specifies no METHOD. DTEND (3.6.1), SUMMARY (3.8.1.12),
   * and LOCATION (3.8.1.7) are OPTIONAL and emitted only when they carry a value.
   *
   * DTSTAMP comes from the injected clock, never the wall clock, so the same workspace and the
   * same clock always produce byte-identical bytes.
   *
   * Returns `null` when no session yields a VEVENT. RFC 5545 section 3.4 defines
   * `icalbody = calprops component` with `component = 1*(...)`: at least one component is
   * REQUIRED, so a calprops-only VCALENDAR is not an iCalendar object at all and Apple Calendar
   * and Google Calendar both reject the file. The route turns that `null` into a 404 rather than
   * serving a download that fails on import, and rather than inventing a placeholder VEVENT that
   * would put fiction in the speaker's calendar.
   */
  async calendar(actor: Actor | null, eventId: string): Promise<string | null> {
    const workspace = await this.workspace(actor, eventId);
    const stamp = utcCalendarStamp(this.dependencies.now());
    const events = workspace.sessions
      .filter((session) => session.schedule)
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((session) => {
        const startsAt = calendarDateTime(session.schedule?.startsAt ?? "");
        // A stored start that is not an instant cannot be expressed as a DATE-TIME. Such a
        // session is left out rather than written as a malformed VEVENT, which would cost the
        // speaker every other session in the file.
        if (!startsAt) return [];
        const endsAt = calendarDateTime(session.schedule?.endsAt ?? "");
        const summary = escapeCalendarText(session.title);
        const location = escapeCalendarText(session.schedule?.location ?? "");
        return [
          "BEGIN:VEVENT",
          // The session id is already globally unique, and it keeps this VEVENT identified as
          // the same entry across re-downloads so a calendar updates rather than duplicates it.
          `UID:${escapeCalendarText(session.id)}@greenroom`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${startsAt}`,
          // 3.6.1: DTEND MUST be later than DTSTART, so anything else is dropped and the
          // event reads as the zero-length instant DTSTART already describes.
          ...(endsAt && endsAt > startsAt ? [`DTEND:${endsAt}`] : []),
          ...(summary ? [`SUMMARY:${summary}`] : []),
          ...(location ? [`LOCATION:${location}`] : []),
          "END:VEVENT",
        ];
      });
    if (!events.length) return null;
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Project Greenroom//Speaker Portal//EN",
      "CALSCALE:GREGORIAN",
      ...events,
      "END:VCALENDAR",
      "",
    ]
      .map(foldCalendarLine)
      .join("\r\n");
  }
}
