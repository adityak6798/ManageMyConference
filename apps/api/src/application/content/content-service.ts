import type {
  ContentSession,
  ContentWorkspace,
  SpeakerAsset,
  SpeakerProfile,
  SpeakerTask,
} from "../../domain/content/content";
import { type Actor, CapabilityDeniedError, requireCapability } from "../identity/actor";
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

export interface ContentServiceDependencies {
  repository: ContentRepository;
  assetStorage: AssetStoragePort;
  /** The review domain's answer to "may this proposal become content?". */
  proposals: AcceptedProposalQuery;
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
  ): Promise<ContentWorkspace> {
    const authorized = requireCapability(actor, "content:manage");
    if (!hasEventRole(authorized, command.eventId, "organizer"))
      throw new CapabilityDeniedError("Organizer event access required");
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
    return this.dependencies.repository.workspace(command.eventId);
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

  async workspace(actor: Actor | null, eventId: string): Promise<ContentWorkspace> {
    const authorized = requireCapability(actor, "content:read");
    const isOrganizer = hasEventRole(authorized, eventId, "organizer");
    const isSpeaker = hasEventRole(authorized, eventId, "speaker");
    if (!isOrganizer && !isSpeaker)
      throw new CapabilityDeniedError("Content workspace access denied");
    return this.dependencies.repository.workspace(eventId, isOrganizer ? undefined : authorized.id);
  }

  async updateMyProfile(
    actor: Actor | null,
    profileId: string,
    input: Pick<SpeakerProfile, "name" | "bio" | "pronouns" | "organization">,
  ): Promise<SpeakerProfile> {
    const authorized = requireCapability(actor, "content:read");
    const profile = await this.dependencies.repository.findProfile(profileId);
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

  async completeTask(
    actor: Actor | null,
    taskId: string,
    eventId: string,
  ): Promise<ContentWorkspace> {
    const authorized = requireCapability(actor, "content:read");
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
    const authorized = requireCapability(actor, "content:manage");
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile || !hasEventRole(authorized, profile.eventId, "organizer"))
      throw new CapabilityDeniedError("Organizer speaker access denied");
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
    const authorized = requireCapability(actor, "content:manage");
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile || !hasEventRole(authorized, profile.eventId, "organizer"))
      throw new CapabilityDeniedError("Organizer speaker access denied");
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
    const authorized = requireCapability(actor, "content:manage");
    const session = await this.dependencies.repository.findSession(sessionId);
    if (!session || !hasEventRole(authorized, session.eventId, "organizer"))
      throw new CapabilityDeniedError("Organizer session access denied");
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
    const authorized = requireCapability(actor, "content:manage");
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset || !hasEventRole(authorized, asset.eventId, "organizer"))
      throw new CapabilityDeniedError("Organizer asset access denied");
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
    const authorized = requireCapability(actor, "content:read");
    const asset = await this.dependencies.repository.findAsset(assetId);
    const profile = asset
      ? await this.dependencies.repository.findProfile(asset.speakerProfileId)
      : null;
    const isOwner = Boolean(
      profile &&
        profile.userId === authorized.id &&
        hasEventRole(authorized, profile.eventId, "speaker"),
    );
    if (!asset || (!isOwner && !hasEventRole(authorized, asset.eventId, "organizer")))
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
    const authorized = requireCapability(actor, "content:read");
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (
      !profile ||
      !hasEventRole(authorized, profile.eventId, "speaker") ||
      profile.userId !== authorized.id
    )
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
