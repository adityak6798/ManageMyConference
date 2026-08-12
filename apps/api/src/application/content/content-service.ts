import {
  type ContentSession,
  type ContentWorkspace,
  canBeProfilePhoto,
  type SpeakerAsset,
  type SpeakerProfile,
  type SpeakerResource,
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
import {
  type AssetStoragePort,
  ContentConflictError,
  type ContentRepository,
  type EventPublicationQuery,
  type SpeakerWorkflowFields,
} from "./content-repository";
import type { SpeakerConversionPort } from "./speaker-conversion";

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
export class ResourceEmbedDeniedError extends Error {}

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
  /** The agenda publication those session schedules came from. */
  readonly schedulePublicationVersion: number | null;
}

/**
 * How content asks for a speaker to be told something.
 *
 * Content owns this interface and holds no import of the delivering domain — the same inversion
 * `SpeakerConversionPort` and the CRM's `OutreachDispatchPort` already use, bound in the
 * composition root. Content states the lifecycle fact ("this speaker was accepted"); which
 * template renders it, which trigger it carries and how it is deduplicated are the delivering
 * domain's decisions, not content's.
 *
 * **Implementations must not throw.** Every method here is called after the change that caused
 * it is already durable. Failing the request at that point would report a failure for work that
 * succeeded, and `requestTasks` mints its task ids per call, so an organizer retrying it would
 * create a second set of tasks — the message would be sent at the cost of duplicating the thing
 * it was announcing. An implementation that cannot queue the message reports it through its own
 * telemetry instead; see the binding in `apps/api/src/index.ts`.
 *
 * @spec PRD-SPK-002 PRD-COM-001 ARC-DOM-001
 */
export interface SpeakerNotificationPort {
  /** An accepted proposal became this speaker's session. */
  speakerAccepted(fact: {
    readonly eventId: string;
    readonly profileId: string;
    readonly speakerName: string;
    readonly speakerEmail: string;
    readonly sessionTitle: string;
  }): Promise<void>;
  /** Work was assigned to this speaker. Keyed on `taskId`, which is unique per assignment. */
  taskAssigned(fact: {
    readonly eventId: string;
    readonly profileId: string;
    readonly taskId: string;
    readonly speakerName: string;
    readonly speakerEmail: string;
    readonly taskTitle: string;
    readonly dueAt: string;
  }): Promise<void>;
}

export interface ContentServiceDependencies {
  repository: ContentRepository;
  /**
   * Tells speakers about things that happened to them. Optional: a composition exercising only
   * the workspace has nobody to tell, and content works unchanged without it — the speaker
   * simply is not written to, which is what the product did before issue #66.
   */
  speakerNotifications?: SpeakerNotificationPort;
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
  /** Hosts organizers may embed into portal resources. Deployment configuration may narrow this. */
  sanitizeResourceHtml?: (input: string) => string;
  sanitizeResourceEmbed?: (input: string, allowedHosts: readonly string[]) => string;
  parseSpeakerCsv?: (csv: string) => {
    rows: {
      name: string;
      email: string;
      workflowStatus?: string | undefined;
      logistics?: string | undefined;
      customFields?: string | undefined;
    }[];
    errors: { row: number; message: string }[];
  };
  createDeliverablesZip?: (files: readonly { name: string; bytes: Uint8Array }[]) => Uint8Array;
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
export function escapeCalendarText(value: string) {
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
export function foldCalendarLine(line: string) {
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
export function utcCalendarStamp(instant: Date) {
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
export function calendarDateTime(value: string) {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : utcCalendarStamp(instant);
}

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export class ContentService {
  constructor(private readonly dependencies: ContentServiceDependencies) {}

  async importSpeakers(
    actor: Actor | null,
    input: { eventId: string; csv: string; commit: boolean },
    correlationId: string,
  ) {
    const authorized = requireEventCapability(actor, input.eventId, "content:manage");
    const parsed = this.dependencies.parseSpeakerCsv?.(input.csv) ?? {
      rows: [],
      errors: [{ row: 1, message: "CSV parser is unavailable" }],
    };
    const existing = await this.dependencies.repository.workspace(input.eventId);
    const known = new Set(existing.speakers.map(({ email }) => email.toLowerCase()));
    const parserErrors = new Map<number, string[]>();
    for (const error of parsed.errors)
      parserErrors.set(error.row, [...(parserErrors.get(error.row) ?? []), error.message]);
    const seen = new Set<string>();
    const rows = parsed.rows.map((row, index) => {
      const normalizedEmail = row.email.trim().toLowerCase();
      const rowNumber = index + 2;
      const errors = [...(parserErrors.get(rowNumber) ?? [])];
      if (!row.name) errors.push("Name is required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errors.push("Valid email is required");
      if (
        row.workflowStatus &&
        !["invited", "onboarding", "ready", "blocked"].includes(row.workflowStatus)
      )
        errors.push("Workflow status is invalid");
      for (const [label, value] of [
        ["Logistics", row.logistics],
        ["Custom fields", row.customFields],
      ] as const) {
        if (!value) continue;
        try {
          const parsedFields = JSON.parse(value);
          if (!parsedFields || Array.isArray(parsedFields) || typeof parsedFields !== "object")
            errors.push(`${label} must be a JSON object`);
          else if (Object.values(parsedFields).some((field) => typeof field !== "string"))
            errors.push(`${label} values must be strings`);
        } catch {
          // ERROR-INTENT: malformed optional JSON is a row validation disposition, not an exception that aborts preview.
          errors.push(`${label} must be valid JSON`);
        }
      }
      const duplicate = known.has(normalizedEmail) || seen.has(normalizedEmail);
      if (duplicate) errors.push("Duplicate email");
      seen.add(normalizedEmail);
      return { row: rowNumber, ...row, email: normalizedEmail, duplicate, errors };
    });
    let imported = 0;
    if (input.commit)
      for (const row of rows) {
        const importState = await this.dependencies.repository.findSpeakerImport(
          input.eventId,
          row.email,
        );
        if (importState === "pending") {
          const duplicateIndex = row.errors.indexOf("Duplicate email");
          if (duplicateIndex >= 0) row.errors.splice(duplicateIndex, 1);
          row.duplicate = false;
        }
        if (row.errors.length || importState === "complete") continue;
        try {
          await this.dependencies.repository.beginSpeakerImport(input.eventId, row.email);
          const { speakerId } = await this.dependencies.speakerConversion.createOrLink({
            eventId: input.eventId,
            source: { kind: "csv", id: row.email },
            name: row.name,
            email: row.email,
            actorId: authorized.id,
            occurredAt: this.dependencies.now().toISOString(),
            correlationId,
            idempotencyKey: `content-csv:${input.eventId}:${row.email}`,
          });
          const profile = await this.dependencies.repository.findProfile(speakerId);
          if (profile) {
            const parseFields = (value?: string) =>
              value ? (JSON.parse(value) as Record<string, string>) : {};
            // The three columns the import owns, and only those. Writing the whole row would
            // carry a name, bio and headshot from the read above, so a long import could
            // quietly revert an organizer editing the same speaker while it ran.
            await this.dependencies.repository.updateProfileWorkflow(profile.id, {
              workflowStatus: (["invited", "onboarding", "ready", "blocked"].includes(
                row.workflowStatus ?? "",
              )
                ? row.workflowStatus
                : "onboarding") as SpeakerWorkflowFields["workflowStatus"],
              logistics: parseFields(row.logistics),
              customFields: parseFields(row.customFields),
            });
          }
          await this.dependencies.repository.completeSpeakerImport(input.eventId, row.email);
          imported += 1;
        } catch {
          // ERROR-INTENT: imports are idempotent per normalized email; expose the failed row so a retry is explicit and safe.
          row.errors.push("Import failed; retry this row safely");
        }
      }
    return {
      preview: !input.commit,
      total: rows.length,
      valid: rows.filter(({ errors }) => errors.length === 0).length,
      imported,
      invalid: rows.filter(({ errors }) => errors.length > 0 && !errors.includes("Duplicate email"))
        .length,
      duplicates: rows.filter(({ duplicate }) => duplicate).length,
      rows,
    };
  }

  async updateSpeakerWorkflow(
    actor: Actor | null,
    profileId: string,
    input: Pick<SpeakerProfile, "workflowStatus" | "logistics" | "customFields">,
  ) {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError();
    const authorized = requireEventCapability(actor, profile.eventId, "content:manage");
    const updated = await this.dependencies.repository.reviseProfile(
      profile.id,
      this.draftRevision(authorized, profile.eventId),
      (current) => ({ ...current, ...input }),
    );
    if (!updated) throw new CapabilityDeniedError();
    return updated;
  }

  async requestTasks(
    actor: Actor | null,
    input: {
      profileIds: string[];
      title: string;
      dueAt: string;
      type: "general" | "file-request";
      instructions: string;
      sessionId?: string | undefined;
    },
  ) {
    const profiles = await Promise.all(
      input.profileIds.map((id) => this.dependencies.repository.findProfile(id)),
    );
    if (profiles.some((profile) => !profile)) throw new CapabilityDeniedError();
    const eventId = profiles[0]?.eventId ?? "";
    if (profiles.some((profile) => profile?.eventId !== eventId)) throw new CapabilityDeniedError();
    requireEventCapability(actor, eventId, "content:manage");
    if (input.sessionId) {
      const session = await this.dependencies.repository.findSession(input.sessionId);
      if (!session || session.eventId !== eventId) throw new CapabilityDeniedError();
    }
    const tasks: SpeakerTask[] = [];
    for (const profile of profiles) {
      if (!profile) continue;
      const task: SpeakerTask = {
        id: this.dependencies.newId(),
        eventId,
        speakerProfileId: profile.id,
        title: input.title,
        dueAt: input.dueAt,
        status: "open",
        type: input.type,
        instructions: input.instructions,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      };
      tasks.push(task);
    }
    await this.dependencies.repository.addTasks(tasks);
    // One message per task rather than one per speaker: a speaker given three deliverables has
    // three things to do by three dates, and a single "you have work" message is the kind that
    // gets read once and never acted on. `taskId` keys each one, so a repeated request that
    // somehow reuses an id converges rather than sending twice.
    for (const task of tasks) {
      const profile = profiles.find((candidate) => candidate?.id === task.speakerProfileId);
      if (!profile) continue;
      await this.dependencies.speakerNotifications?.taskAssigned({
        eventId,
        profileId: profile.id,
        taskId: task.id,
        speakerName: profile.name,
        speakerEmail: profile.email,
        taskTitle: task.title,
        dueAt: task.dueAt,
      });
    }
    return tasks;
  }

  async createResource(
    actor: Actor | null,
    input: Omit<SpeakerResource, "id" | "bodyHtml" | "embedHtml"> & {
      bodyHtml: string;
      embedHtml: string;
      embedAllowedHosts: string[];
    },
  ) {
    requireEventCapability(actor, input.eventId, "content:manage");
    const { embedAllowedHosts, ...storedInput } = input;
    if (!this.dependencies.sanitizeResourceHtml || !this.dependencies.sanitizeResourceEmbed)
      throw new Error("Resource sanitizer is unavailable");
    const resource: SpeakerResource = {
      ...storedInput,
      id: this.dependencies.newId(),
      bodyHtml: this.dependencies.sanitizeResourceHtml(input.bodyHtml),
      embedHtml: this.dependencies.sanitizeResourceEmbed(input.embedHtml, embedAllowedHosts),
    };
    await this.dependencies.repository.addResource(resource);
    return resource;
  }

  async updateResource(
    actor: Actor | null,
    resourceId: string,
    input: Omit<SpeakerResource, "id" | "eventId" | "bodyHtml" | "embedHtml"> & {
      bodyHtml: string;
      embedHtml: string;
      embedAllowedHosts: string[];
    },
  ) {
    const existing = await this.dependencies.repository.findResource(resourceId);
    if (!existing) throw new CapabilityDeniedError();
    requireEventCapability(actor, existing.eventId, "content:manage");
    if (!this.dependencies.sanitizeResourceHtml || !this.dependencies.sanitizeResourceEmbed)
      throw new Error("Resource sanitizer is unavailable");
    const { embedAllowedHosts, ...storedInput } = input;
    const resource: SpeakerResource = {
      ...existing,
      ...storedInput,
      bodyHtml: this.dependencies.sanitizeResourceHtml(input.bodyHtml),
      embedHtml:
        input.embedHtml === existing.embedHtml && embedAllowedHosts.length === 0
          ? existing.embedHtml
          : this.dependencies.sanitizeResourceEmbed(input.embedHtml, embedAllowedHosts),
    };
    await this.dependencies.repository.updateResource(resource);
    return resource;
  }

  async deleteResource(actor: Actor | null, resourceId: string) {
    const existing = await this.dependencies.repository.findResource(resourceId);
    if (!existing) throw new CapabilityDeniedError();
    requireEventCapability(actor, existing.eventId, "content:manage");
    await this.dependencies.repository.deleteResource(resourceId);
  }

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
      // Told after the session is durable, so nobody is welcomed to a session that failed to
      // commit. Inside the `!existing` branch because a re-accept of the same proposal is the
      // same acceptance — the delivering domain deduplicates too, but not announcing it twice
      // is cheaper than deduplicating it twice.
      await this.dependencies.speakerNotifications?.speakerAccepted({
        eventId: command.eventId,
        profileId: speaker.id,
        speakerName: speaker.name,
        speakerEmail: speaker.email,
        sessionTitle: session.title,
      });
      for (const task of tasks)
        await this.dependencies.speakerNotifications?.taskAssigned({
          eventId: command.eventId,
          profileId: speaker.id,
          taskId: task.id,
          speakerName: speaker.name,
          speakerEmail: speaker.email,
          taskTitle: task.title,
          dueAt: task.dueAt,
        });
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
    const [workspace, schedules, schedulePublicationVersion] = await Promise.all([
      this.dependencies.repository.workspace(eventId, userId),
      this.dependencies.agenda.publishedSessionSchedules(eventId),
      this.dependencies.agenda.publishedScheduleVersion(eventId),
    ]);
    return {
      ...workspace,
      schedulePublicationVersion,
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
    const updated = await this.dependencies.repository.reviseProfile(
      profile.id,
      this.draftRevision(authorized, profile.eventId),
      (current) => ({ ...current, ...input }),
    );
    if (!updated) throw new CapabilityDeniedError("Speaker profile access denied");
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
    await this.dependencies.repository.updateProfilePhoto(profile.id, asset.id);
    // Answered from the store rather than from the copy read a moment ago. Now that this writes
    // one column, an organizer's edit landing alongside it survives — and a response assembled
    // from the earlier read would report the bio it replaced as though it were still there.
    return (
      (await this.dependencies.repository.findProfile(profile.id)) ?? {
        ...profile,
        photoAssetId: asset.id,
      }
    );
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
    await this.dependencies.repository.updateProfilePhoto(profile.id, null);
    return (await this.dependencies.repository.findProfile(profile.id)) ?? withoutPhoto;
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
    await this.dependencies.speakerNotifications?.taskAssigned({
      eventId: profile.eventId,
      profileId: profile.id,
      taskId: task.id,
      speakerName: profile.name,
      speakerEmail: profile.email,
      taskTitle: task.title,
      dueAt: task.dueAt,
    });
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
    const updated = await this.dependencies.repository.reviseSession(
      session.id,
      this.draftRevision(authorized, session.eventId),
      (current) => ({ ...current, ...input }),
    );
    if (!updated) throw new CapabilityDeniedError("Organizer session access denied");
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
    if (profile?.photoAssetId === asset.id)
      await this.dependencies.repository.updateProfilePhoto(profile.id, null);
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
      taskId?: string | undefined;
      sessionId?: string | undefined;
      versionGroupId?: string | undefined;
    },
  ): Promise<SpeakerAsset> {
    const profile = await this.dependencies.repository.findProfile(input.profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker asset access denied");
    const authorized = requireEventCapability(actor, profile.eventId, "content:read");
    if (!hasEventRole(authorized, profile.eventId, "speaker") || profile.userId !== authorized.id)
      throw new CapabilityDeniedError("Speaker asset access denied");
    const workspace = await this.dependencies.repository.workspace(profile.eventId);
    const previous = input.versionGroupId
      ? workspace.assets
          .filter(
            (asset) =>
              asset.versionGroupId === input.versionGroupId &&
              asset.speakerProfileId === profile.id,
          )
          .toSorted((a, b) => (b.versionNumber ?? 1) - (a.versionNumber ?? 1))[0]
      : input.taskId
        ? workspace.assets.filter(
            (asset) =>
              asset.taskId === input.taskId &&
              asset.speakerProfileId === profile.id &&
              asset.isLatest !== false,
          )[0]
        : undefined;
    if (
      input.taskId &&
      !workspace.tasks.some(
        (task) => task.id === input.taskId && task.speakerProfileId === profile.id,
      )
    )
      throw new CapabilityDeniedError("Speaker asset access denied");
    if (
      input.sessionId &&
      !workspace.sessions.some(
        (session) =>
          session.id === input.sessionId && session.speakerProfileIds.includes(profile.id),
      )
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
      ...(input.taskId || previous?.taskId ? { taskId: input.taskId ?? previous?.taskId } : {}),
      ...(input.sessionId || previous?.sessionId
        ? { sessionId: input.sessionId ?? previous?.sessionId }
        : {}),
      versionGroupId: previous?.versionGroupId ?? previous?.id ?? input.versionGroupId ?? id,
      versionNumber: (previous?.versionNumber ?? 0) + 1,
      isLatest: true,
    };
    try {
      await this.dependencies.repository.replaceLatestAsset(asset, previous);
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
   * The revision half of an attributed edit: who is editing, when, and on whose behalf.
   *
   * The store fills in everything else. Numbering a revision here would mean reading the
   * highest number and adding one, which two organizers editing the same speaker do
   * identically and one of them then loses; snapshotting here would mean recording a state
   * this service read before the write rather than the state the row held when it happened.
   * Both belong to the operation that writes them (`ContentRevisionDraft`).
   */
  private draftRevision(actor: Actor, eventId: string, restoredFromRevisionId?: string) {
    return {
      id: this.dependencies.newId(),
      eventId,
      actorId: actor.id,
      createdAt: this.dependencies.now().toISOString(),
      ...(restoredFromRevisionId ? { restoredFromRevisionId } : {}),
    };
  }

  async addAssetComment(actor: Actor | null, assetId: string, body: string) {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset || !(await this.mayReadPrivately(actor, asset))) throw new CapabilityDeniedError();
    const authorized = requireEventCapability(actor, asset.eventId, "content:read");
    const comment = {
      id: this.dependencies.newId(),
      eventId: asset.eventId,
      assetId,
      authorId: authorized.id,
      authorName: authorized.name,
      body,
      createdAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.repository.addComment(comment);
    return comment;
  }

  async bulkDownload(actor: Actor | null, eventId: string, assetIds: readonly string[]) {
    requireEventCapability(actor, eventId, "content:manage");
    const workspace = await this.dependencies.repository.workspace(eventId);
    const selected = workspace.assets.filter(
      (asset) => assetIds.includes(asset.id) && asset.isLatest !== false,
    );
    if (selected.length !== new Set(assetIds).size)
      throw new CapabilityDeniedError("Deliverable selection is unavailable");
    const files: { name: string; bytes: Uint8Array }[] = [];
    const maximumArchiveBytes = 50 * 1024 * 1024;
    let totalBytes = 0;
    const used = new Set<string>();
    for (const asset of selected.toSorted((a, b) => a.id.localeCompare(b.id))) {
      const stored = await this.dependencies.assetStorage.get(asset.storageKey);
      if (!stored) throw new CapabilityDeniedError("Deliverable selection is unavailable");
      totalBytes += stored.bytes.byteLength;
      if (totalBytes > maximumArchiveBytes)
        throw new ContentConflictError("Selected deliverables exceed the 50 MB ZIP limit");
      const safe =
        asset.name.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "deliverable";
      let name = safe;
      let suffix = 1;
      while (used.has(name)) {
        const dot = safe.lastIndexOf(".");
        const stem = dot > 0 ? safe.slice(0, dot) : safe;
        const extension = dot > 0 ? safe.slice(dot) : "";
        name = `${stem}-${asset.speakerProfileId}-${suffix}${extension}`;
        suffix += 1;
      }
      used.add(name);
      files.push({ name, bytes: stored.bytes });
    }
    return this.dependencies.createDeliverablesZip?.(files) ?? new Uint8Array();
  }

  async restoreRevision(actor: Actor | null, revisionId: string) {
    const revision = await this.dependencies.repository.findRevision(revisionId);
    if (!revision) throw new CapabilityDeniedError();
    const authorized = requireEventCapability(actor, revision.eventId, "content:manage");
    // A restore is an edit like any other, and takes the same indivisible path: the state it
    // replaces is recorded by whatever writes the replacement, or neither happens.
    //
    // It restores the fields an edit can change and nothing else, named one by one rather than
    // spread from the snapshot. Identity — which event a session belongs to, which user a
    // profile is — is never restorable, so a revision cannot move an entity between events or
    // hand it to somebody else. Nor are the fields no edit writes: `email` and `sourcePersonId`
    // come from speaker conversion, and a snapshot carrying an older one must not appear to put
    // it back when no repository would have stored it.
    const draft = this.draftRevision(authorized, revision.eventId, revision.id);
    if (revision.entityType === "profile") {
      const snapshot = JSON.parse(revision.snapshotJson) as SpeakerProfile;
      const restored = await this.dependencies.repository.reviseProfile(
        revision.entityId,
        draft,
        ({ photoAssetId: _replaced, ...current }) => ({
          ...current,
          name: snapshot.name,
          bio: snapshot.bio,
          pronouns: snapshot.pronouns,
          organization: snapshot.organization,
          // Restored exactly as the snapshot held it, absence included: a revision taken before
          // the speaker chose a headshot puts the profile back to having none.
          ...(snapshot.photoAssetId ? { photoAssetId: snapshot.photoAssetId } : {}),
          workflowStatus: snapshot.workflowStatus,
          logistics: snapshot.logistics,
          customFields: snapshot.customFields,
        }),
      );
      if (!restored) throw new CapabilityDeniedError();
    } else {
      const snapshot = JSON.parse(revision.snapshotJson) as ContentSession;
      const restored = await this.dependencies.repository.reviseSession(
        revision.entityId,
        draft,
        (current) => ({
          ...current,
          title: snapshot.title,
          abstract: snapshot.abstract,
          format: snapshot.format,
          speakerProfileIds: snapshot.speakerProfileIds,
          tags: snapshot.tags,
          tracks: snapshot.tracks,
          publicationState: snapshot.publicationState,
        }),
      );
      if (!restored) throw new CapabilityDeniedError();
    }
    return this.projected(revision.eventId);
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
