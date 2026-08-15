import {
  type ContentSession,
  type ContentWorkspace,
  type ContentWorkflowStatus,
  canBeProfilePhoto,
  logicalAssetKey,
  type ResourceVisibility,
  type SpeakerAsset,
  type SpeakerProfile,
  type SpeakerResource,
  type SpeakerTask,
  type SpeakerTaskTemplate,
} from "../../domain/content/content";
import type { ContentAgendaInterface, SessionSchedule } from "../agenda/public";
import {
  SPEAKER_INVITE_TEMPLATE_KEY,
  SPEAKER_REMINDER_TEMPLATE_KEY,
  type SpeakerReminderDispatchPort,
  SpeakerReminderRejectedError,
  speakerInvitationKey,
  taskReminderKey,
} from "./reminder-dispatch";
import {
  type Actor,
  AuthenticationRequiredError,
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { AssignableOwner } from "../identity/identity-directory";
import {
  fieldAccessFor,
  type HideableSessionField,
  type HideableSpeakerField,
  type Redacted,
} from "../identity/public";
import type { AcceptedProposalQuery } from "../review/public";
import {
  type CapabilityLink,
  type CapabilityLinkStore,
  MAX_CAPABILITY_LINK_HOURS,
  spendCapabilityLink,
} from "../platform/public";
import {
  type AssetStoragePort,
  ContentConflictError,
  type ContentRepository,
  type EventPublicationQuery,
  type SpeakerWorkflowFields,
} from "./content-repository";
import type { SpeakerConversionPort } from "./speaker-conversion";
import type { ContentRemixPort } from "./content-remix-port";

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
 * Which of the three clocks this is matters:
 *
 * - the agenda **draft** — the organizer's board, moved by every drag. Never read here. A
 *   session dropped into a slot has no `schedule` until the agenda is published.
 * - the agenda **publication** — the numbered immutable snapshot the organizer committed to.
 *   This is what `schedule` is, read live through `ContentAgendaInterface` on every request.
 * - the **site** publication — the active versioned public projection served by
 *   `/api/public/events/{slug}/schedule` and the event hub.
 *
 * Publishing the agenda moves the second and, for an already-live site, activates the third in
 * the same D1 batch through `EVT-SCHEDULE-PUBLISHED`. A site that is not live remains private.
 */
export interface ScheduledContentSession extends ContentSession {
  readonly schedule?: SessionSchedule;
}

/**
 * The content workspace as it leaves the application layer, with schedules resolved.
 *
 * `actorDirectory` is who an audit row may name. It is resolved here rather than in the
 * repository because the names belong to identity, not to content: the console was printing the
 * stored id `seed-organizer` in Edit history because nothing in the payload could turn that id
 * into "Olivia Organizer" (#154). Absent on the speaker-scoped projection, which carries no
 * revisions to attribute.
 */
export interface ContentWorkspaceView extends Omit<ContentWorkspace, "sessions" | "speakers"> {
  readonly sessions: readonly Redacted<ScheduledContentSession, HideableSessionField>[];
  readonly speakers: readonly Redacted<SpeakerProfile, HideableSpeakerField>[];
  readonly actorDirectory?: readonly AssignableOwner[];
  readonly workflowStatuses?: readonly ContentWorkflowStatus[];
}

export interface CalendarInviteContentWorkspaceView
  extends Omit<ContentWorkspaceView, "sessions" | "speakers"> {
  readonly speakers: readonly SpeakerProfile[];
  readonly sessions: readonly (ContentSession & {
    readonly schedule?: SessionSchedule & {
      readonly revision: number;
      readonly revisedAt: string;
    };
  })[];
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

/**
 * Identity's answer to "what is this person called?", narrowed to the one method content needs.
 *
 * The whole `IdentityDirectory` is not taken: content never resolves a persona, grants a role or
 * reads an address. Optional, so a composition exercising only the workspace still constructs —
 * without it the audit surface falls back to the stored id, which is what it printed before.
 */
export interface ContentActorDirectoryPort {
  listAssignableOwnersForEvent(eventId: string): Promise<readonly AssignableOwner[]>;
}

/**
 * A resource as an import states it, with the two things an import may not choose left out.
 *
 * There is no `id`: ids belong to the destination, and a payload that could name one could
 * point an import at a row it was never shown. There is no `eventId` either — the command's
 * input carries it, and it is the event the caller was authorized against.
 */
export interface SpeakerResourceImport {
  readonly title: string;
  readonly slug: string;
  readonly bodyHtml: string;
  readonly embedHtml: string;
  readonly visibility: ResourceVisibility;
  readonly sortOrder: number;
}

/** A checklist line as an import states it. Same rule: the destination mints the id. */
export interface SpeakerTaskTemplateImport {
  readonly title: string;
  readonly description: string;
  readonly sortOrder: number;
  readonly dueOffsetDays: number;
}

/**
 * What one imported line did, or why nothing was written for it.
 *
 * `unchanged` is a first-class answer rather than a quiet "updated". An import that rewrites a
 * row it did not change still counts as an edit everywhere an edit is observed, and a caller
 * asking "would applying this write anything?" has no other way to find out.
 */
export interface ContentImportRow {
  /** The line's identity in its own namespace: a resource's slug, a checklist line's title. */
  readonly key: string;
  readonly label: string;
  readonly disposition: "created" | "updated" | "unchanged" | "refused";
  /** Present on `refused`, carrying the refusal's own words. */
  readonly reason?: string;
}

export interface ContentImportReport {
  readonly preview: boolean;
  readonly rows: readonly ContentImportRow[];
}

/** The instantiation anchor was not an instant, so no due date could be derived from it. */
export class SpeakerChecklistAnchorError extends Error {}

/**
 * Another line on this event already holds that title.
 *
 * A refusal rather than a convergence, and the distinction is the whole reason this error
 * exists. `importTaskTemplates` writes at `(event_id, title)` because a *clone* has no other
 * identity to converge on; an organizer typing a title into the console is naming a new line,
 * and quietly rewriting the one that already had that title would replace work they can still
 * see on the screen in front of them.
 */
export class SpeakerChecklistTitleTakenError extends Error {}

/** A task this event does not carry. Named rather than skipped: the caller asked for it. */
export class ContentNotFoundError extends Error {}

/**
 * Speaker mail — a reminder or a portal invitation — was asked for in a deployment that cannot
 * send it.
 *
 * A composition with no delivering domain bound, or an event with no owning organization. Both
 * are configuration rather than a bad request, and both must say so — a reminder action that
 * quietly reported "0 sent" would look exactly like a roster with nothing due, and an invite
 * action that did would look exactly like everybody already being invited.
 *
 * Shared by both commands rather than split in two: the condition, the cause and the 503 the
 * transport already maps it to are identical, and the message each throws with names which
 * action the organizer pressed.
 */
export class SpeakerRemindersUnavailableError extends Error {}
export class ContentShareUnavailableError extends Error {}

/** The platform timeline sink for successful canonical profile revisions. */
export interface ContentProfileAuditPort {
  profileUpdated(input: {
    actorId: string;
    actorName: string;
    source: "human" | "api";
    eventId: string;
    profileId: string;
    version: number;
  }): Promise<void>;
}

export interface ContentServiceDependencies {
  repository: ContentRepository;
  remix?: ContentRemixPort;
  shares?: {
    links: CapabilityLinkStore;
    organizationOf(eventId: string): Promise<string | null>;
    mintToken(): Promise<{ token: string; tokenHash: string }>;
    hash(value: string): Promise<string>;
    baseUrl: string;
  };
  /** Resolves the actor ids on revisions to the names an organizer recognises. */
  identities?: ContentActorDirectoryPort;
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
  /**
   * Queues a reminder about work a speaker owes. Optional for the same reason
   * `speakerNotifications` is: a composition exercising only the workspace has nobody to write
   * to, and the reminder action reports that it is unavailable rather than failing silently.
   */
  reminders?: SpeakerReminderDispatchPort;
  /** Which organization runs an event. Events owns the answer; content asks rather than joins. */
  organizationOf?: (eventId: string) => Promise<string | null>;
  /** Unified platform audit; the composition owns request source and correlation metadata. */
  profileAudit?: ContentProfileAuditPort;
}

/** One task a reminder was asked for, and what happened to it. */
export interface SpeakerReminderOutcome {
  readonly taskId: string;
  readonly speakerName: string;
  readonly title: string;
  readonly dueAt: string;
  /** `queued` wrote a delivery; `already-sent` converged on one this deadline already had. */
  readonly outcome: "queued" | "already-sent" | "unreachable" | "refused";
  /** Why, for the two outcomes that are not a send. Empty otherwise. */
  readonly reason: string;
}

/**
 * One speaker an invitation was asked for, and what happened to them.
 *
 * The same four outcomes `SpeakerReminderOutcome` carries, because the organizer has the same
 * four things to do next, and `occurrence` besides: it is which invitation this was for this
 * speaker, so the console can say "second invitation sent" rather than a bare "sent" that a
 * speaker chasing an organizer about a mail they never got cannot be answered with.
 */
export interface SpeakerInvitationOutcome {
  readonly profileId: string;
  readonly speakerName: string;
  readonly email: string;
  /** Which invitation this is: 1 is the first an organizer asked for. 0 when none was claimed. */
  readonly occurrence: number;
  /** `queued` wrote a delivery; `already-sent` converged on one this occurrence already had. */
  readonly outcome: "queued" | "already-sent" | "unreachable" | "refused";
  /** Why, for the two outcomes that are not a send. Empty otherwise. */
  readonly reason: string;
}

function hasEventRole(actor: Actor, eventId: string, role: "organizer" | "speaker") {
  return actor.eventAccess.some((access) => access.eventId === eventId && access.role === role);
}

/** RFC 5545 section 3.1: a content line carries at most 75 octets before its CRLF. */
const CALENDAR_LINE_OCTETS = 75;

/** Checklist offsets are whole days from an anchor instant. */
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * What a CSV import reports for a row whose speaker or ledger row was deleted while it ran.
 *
 * Distinct from the generic `Import failed; retry this row safely` on purpose: that one is any
 * thrown fault, and this one is the specific outcome `PRD-SPK-001` decides — the row matched no
 * row, so nothing was written, and the import says so instead of counting it.
 */
const VANISHED_MID_IMPORT = "Speaker record removed during import; retry this row";

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
      return {
        row: rowNumber,
        ...row,
        email: normalizedEmail,
        duplicate,
        errors,
      };
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
          const parseFields = (value?: string) =>
            value ? (JSON.parse(value) as Record<string, string>) : {};
          // The three columns the import owns, and only those. Writing the whole row would
          // carry a name, bio and headshot from the read above, so a long import could
          // quietly revert an organizer editing the same speaker while it ran.
          //
          // The decision issue #202 was waiting on, and it is stated in `PRD-SPK-001`: a row
          // whose speaker vanished between `createOrLink` and this write is **refused and
          // reported**, not skipped and not fatal to the rest of the file. Skipping is what
          // this code used to do — `if (profile)` fell through to `completeSpeakerImport` and
          // `imported += 1`, so a deleted speaker was counted as imported and the ledger
          // recorded a run that wrote nothing. Failing the whole batch would throw away every
          // row that did land for one that did not. Refusing one row loses nothing, because
          // the ledger is keyed on the normalized address: it stays `pending`, so re-running
          // the same file re-attempts exactly this row and converges.
          const written =
            profile !== null &&
            (await this.dependencies.repository.updateProfileWorkflow(profile.id, {
              workflowStatus: (["invited", "onboarding", "ready", "blocked"].includes(
                row.workflowStatus ?? "",
              )
                ? row.workflowStatus
                : "onboarding") as SpeakerWorkflowFields["workflowStatus"],
              logistics: parseFields(row.logistics),
              customFields: parseFields(row.customFields),
            }));
          // Same reading for the ledger's own row: a count of zero means the mark of completion
          // landed on nothing, so this run may not claim the import finished.
          if (
            !written ||
            !(await this.dependencies.repository.completeSpeakerImport(input.eventId, row.email))
          ) {
            row.errors.push(VANISHED_MID_IMPORT);
            continue;
          }
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
    const statuses = await this.workflowStatuses(profile.eventId);
    if (!statuses.some(({ key }) => key === input.workflowStatus))
      throw new ContentConflictError("Choose a workflow status configured for this event");
    fieldAccessFor(authorized, profile.eventId).assertEditable("speaker", Object.keys(input));
    const updated = await this.dependencies.repository.reviseProfile(
      profile.id,
      this.draftRevision(authorized, profile.eventId),
      (current) => ({ ...current, ...input }),
    );
    if (!updated) throw new CapabilityDeniedError();
    return updated;
  }

  private async workflowStatuses(eventId: string): Promise<readonly ContentWorkflowStatus[]> {
    const stored = await this.dependencies.repository.listWorkflowStatuses(eventId);
    if (stored.length) return stored;
    const createdAt = this.dependencies.now().toISOString();
    const defaults: ContentWorkflowStatus[] = [
      ["invited", "Invited", "open"],
      ["onboarding", "Onboarding", "open"],
      ["ready", "Ready", "ready"],
      ["blocked", "Blocked", "blocked"],
    ].map(([key, label, category], sortOrder) => ({
      id: this.dependencies.newId.call(globalThis.crypto),
      eventId,
      key: key as string,
      label: label as string,
      category: category as ContentWorkflowStatus["category"],
      sortOrder,
      createdAt,
    }));
    await this.dependencies.repository.saveWorkflowStatuses(eventId, defaults);
    return defaults;
  }

  async configureWorkflowStatuses(
    actor: Actor | null,
    eventId: string,
    drafts: readonly Pick<ContentWorkflowStatus, "key" | "label" | "category">[],
  ) {
    requireEventCapability(actor, eventId, "content:manage");
    const keys = new Set(drafts.map(({ key }) => key));
    if (keys.size !== drafts.length)
      throw new ContentConflictError("Workflow status keys must be unique");
    const workspace = await this.dependencies.repository.workspace(eventId);
    const inUse = new Set(workspace.speakers.map(({ workflowStatus }) => workflowStatus));
    const removed = [...inUse].filter((key) => key && !keys.has(key));
    if (removed.length)
      throw new ContentConflictError(
        `Move speakers out of these statuses first: ${removed.join(", ")}`,
      );
    const previous = new Map(
      (await this.workflowStatuses(eventId)).map((status) => [status.key, status]),
    );
    const createdAt = this.dependencies.now().toISOString();
    const statuses = drafts.map((draft, sortOrder) => ({
      ...draft,
      id: previous.get(draft.key)?.id ?? this.dependencies.newId(),
      eventId,
      sortOrder,
      createdAt: previous.get(draft.key)?.createdAt ?? createdAt,
    }));
    await this.dependencies.repository.saveWorkflowStatuses(eventId, statuses);
    return statuses;
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
    // A resource another organizer deleted between the read above and this write matches no
    // row, and is refused exactly as one that never existed rather than reported as saved.
    if (!(await this.dependencies.repository.updateResource(resource)))
      throw new CapabilityDeniedError("Speaker resource access denied");
    return resource;
  }

  async deleteResource(actor: Actor | null, resourceId: string) {
    const existing = await this.dependencies.repository.findResource(resourceId);
    if (!existing) throw new CapabilityDeniedError();
    requireEventCapability(actor, existing.eventId, "content:manage");
    await this.dependencies.repository.deleteResource(resourceId);
  }

  /**
   * Write a set of resources at their slugs, sanitizing every one of them on the way in.
   *
   * The markup is re-sanitized here rather than trusted, and that is the whole point of the
   * command existing. Its caller is not the composer: an import replays HTML that has been at
   * rest in a row an operator can write, so a sanitizer that ran only on the authoring path
   * would leave this door open behind it. Sanitizing is idempotent, so paying it a second time
   * costs one pass over a string and buys a boundary that holds however the payload arrived.
   *
   * `commit: false` computes every disposition and writes nothing, so a preview and the write
   * it predicts come from one implementation rather than two that have to be kept in step —
   * `importSpeakers` already answers that way.
   *
   * @spec PRD-CNT-001 PRD-EVT-002
   */
  async importSpeakerResources(
    actor: Actor | null,
    input: {
      eventId: string;
      resources: readonly SpeakerResourceImport[];
      /** The destination's own embed allowlist. Never the payload's — see the slice. */
      embedAllowedHosts: readonly string[];
      commit: boolean;
    },
  ): Promise<ContentImportReport> {
    requireEventCapability(actor, input.eventId, "content:manage");
    if (!this.dependencies.sanitizeResourceHtml || !this.dependencies.sanitizeResourceEmbed)
      throw new Error("Resource sanitizer is unavailable");
    const sanitizeHtml = this.dependencies.sanitizeResourceHtml;
    const sanitizeEmbed = this.dependencies.sanitizeResourceEmbed;
    const existing = (await this.dependencies.repository.workspace(input.eventId)).resources ?? [];
    const bySlug = new Map(existing.map((resource) => [resource.slug, resource]));
    const rows: ContentImportRow[] = [];
    for (const incoming of input.resources) {
      const current = bySlug.get(incoming.slug);
      let embedHtml: string;
      try {
        embedHtml = sanitizeEmbed(incoming.embedHtml, [...input.embedAllowedHosts]);
      } catch (error) {
        // ERROR-INTENT: an embed this deployment will not host is a disposition the caller
        // reports to the organizer, not a fault — the refusal's own message travels in `reason`,
        // and every other resource in the set is still written.
        if (!(error instanceof ResourceEmbedDeniedError)) throw error;
        rows.push({
          key: incoming.slug,
          label: incoming.title,
          disposition: "refused",
          reason: error.message,
        });
        continue;
      }
      const resource: SpeakerResource = {
        id: current?.id ?? this.dependencies.newId(),
        eventId: input.eventId,
        title: incoming.title,
        slug: incoming.slug,
        bodyHtml: sanitizeHtml(incoming.bodyHtml),
        embedHtml,
        visibility: incoming.visibility,
        sortOrder: incoming.sortOrder,
      };
      // Compared field by field, and after sanitizing: the only fair question is whether what
      // would be stored differs from what is stored. Comparing the payload as it arrived would
      // call every hostile body a change forever, because the stored one is the cleaned one.
      if (
        current &&
        current.title === resource.title &&
        current.bodyHtml === resource.bodyHtml &&
        current.embedHtml === resource.embedHtml &&
        current.visibility === resource.visibility &&
        current.sortOrder === resource.sortOrder
      ) {
        rows.push({
          key: incoming.slug,
          label: incoming.title,
          disposition: "unchanged",
        });
        continue;
      }
      if (input.commit) await this.dependencies.repository.upsertResourceBySlug(resource);
      rows.push({
        key: incoming.slug,
        label: incoming.title,
        disposition: current ? "updated" : "created",
      });
    }
    return { preview: !input.commit, rows };
  }

  /** The event's checklist as its organizers declared it. Not a speaker-facing read. */
  async taskTemplates(
    actor: Actor | null,
    eventId: string,
  ): Promise<readonly SpeakerTaskTemplate[]> {
    const authorized = requireEventCapability(actor, eventId, "content:read");
    if (!hasEventRole(authorized, eventId, "organizer"))
      throw new CapabilityDeniedError("Speaker checklist access denied");
    return this.dependencies.repository.listTaskTemplates(eventId);
  }

  /**
   * Author one checklist line, or edit one, from the console (issue #176).
   *
   * Addressed by **id**, not by title, which is what `importTaskTemplates` cannot offer and why
   * this is a separate command rather than a wrapper around it. An import converges on the title
   * because a clone arriving in another event has nothing else to converge on; an organizer who
   * mistyped a title needs to change it, and doing that through the import path would leave the
   * mistyped line behind as a second one that nothing could ever remove.
   *
   * @spec PRD-SPK-002 PRD-CNT-001
   */
  async createTaskTemplate(
    actor: Actor | null,
    input: SpeakerTaskTemplateImport & { eventId: string },
  ): Promise<SpeakerTaskTemplate> {
    requireEventCapability(actor, input.eventId, "content:manage");
    return this.writeTaskTemplate(
      {
        id: this.dependencies.newId(),
        eventId: input.eventId,
        title: input.title,
        description: input.description,
        sortOrder: input.sortOrder,
        dueOffsetDays: input.dueOffsetDays,
        createdAt: this.dependencies.now().toISOString(),
      },
      false,
    );
  }

  /**
   * Edit one line, including its title.
   *
   * The event comes from the stored row rather than from the caller, exactly as `updateResource`
   * takes it from the resource: a request that could name the event could name a different one
   * from the row it edits, and then the capability check and the write would be about two
   * different events.
   */
  async updateTaskTemplate(
    actor: Actor | null,
    templateId: string,
    input: SpeakerTaskTemplateImport,
  ): Promise<SpeakerTaskTemplate> {
    const existing = await this.requireTaskTemplate(actor, templateId);
    return this.writeTaskTemplate(
      {
        ...existing,
        title: input.title,
        description: input.description,
        sortOrder: input.sortOrder,
        dueOffsetDays: input.dueOffsetDays,
      },
      true,
    );
  }

  /**
   * Remove a line from the event's checklist, and answer the event it belonged to.
   *
   * Tasks already assigned from it stay where they are, and that is deliberate rather than an
   * oversight: `speaker_tasks` holds no pointer back here, so once a line has been given to
   * somebody the work is theirs. Deleting a line an organizer has stopped asking for must not
   * quietly delete the homework of everybody who was already asked.
   */
  async deleteTaskTemplate(actor: Actor | null, templateId: string): Promise<string> {
    const existing = await this.requireTaskTemplate(actor, templateId);
    await this.dependencies.repository.deleteTaskTemplate(templateId);
    return existing.eventId;
  }

  /** A line this actor may write, or the one refusal both "no such line" and "not yours" get. */
  private async requireTaskTemplate(
    actor: Actor | null,
    templateId: string,
  ): Promise<SpeakerTaskTemplate> {
    const existing = await this.dependencies.repository.findTaskTemplate(templateId);
    if (!existing) throw new CapabilityDeniedError("Speaker checklist access denied");
    requireEventCapability(actor, existing.eventId, "content:manage");
    return existing;
  }

  private async writeTaskTemplate(
    template: SpeakerTaskTemplate,
    editing: boolean,
  ): Promise<SpeakerTaskTemplate> {
    try {
      // A matched row is what makes this a save. Another organizer can delete a line between the
      // read above and this write, and reporting that as a success would announce "saved" over a
      // checklist the same response shows the line missing from.
      if (editing) {
        if (!(await this.dependencies.repository.updateTaskTemplate(template)))
          throw new CapabilityDeniedError("Speaker checklist access denied");
      } else await this.dependencies.repository.addTaskTemplate(template);
    } catch (error) {
      // ERROR-INTENT: `UNIQUE(event_id, title)` is the checklist's own rule, so a violation is
      // the organizer's answer and becomes a 409 naming the title. Every other failure keeps
      // travelling untouched.
      if (isTitleConflict(error))
        throw new SpeakerChecklistTitleTakenError(
          `Another line on this event is already called “${template.title}”`,
        );
      throw error;
    }
    return template;
  }

  /** `importSpeakerResources` for checklist lines, whose identity in an event is their title. */
  async importTaskTemplates(
    actor: Actor | null,
    input: {
      eventId: string;
      templates: readonly SpeakerTaskTemplateImport[];
      commit: boolean;
    },
  ): Promise<ContentImportReport> {
    requireEventCapability(actor, input.eventId, "content:manage");
    const existing = await this.dependencies.repository.listTaskTemplates(input.eventId);
    const byTitle = new Map(existing.map((template) => [template.title, template]));
    const rows: ContentImportRow[] = [];
    for (const incoming of input.templates) {
      const current = byTitle.get(incoming.title);
      const template: SpeakerTaskTemplate = {
        id: current?.id ?? this.dependencies.newId(),
        eventId: input.eventId,
        title: incoming.title,
        description: incoming.description,
        sortOrder: incoming.sortOrder,
        dueOffsetDays: incoming.dueOffsetDays,
        // A line was declared when it was declared. Re-applying a template re-dates nothing,
        // which is what lets the store leave `created_at` alone on conflict.
        createdAt: current?.createdAt ?? this.dependencies.now().toISOString(),
      };
      if (
        current &&
        current.description === template.description &&
        current.sortOrder === template.sortOrder &&
        current.dueOffsetDays === template.dueOffsetDays
      ) {
        rows.push({
          key: incoming.title,
          label: incoming.title,
          disposition: "unchanged",
        });
        continue;
      }
      if (input.commit) await this.dependencies.repository.upsertTaskTemplateByTitle(template);
      rows.push({
        key: incoming.title,
        label: incoming.title,
        disposition: current ? "updated" : "created",
      });
    }
    return { preview: !input.commit, rows };
  }

  /**
   * Turn the event's checklist into real work for real people.
   *
   * Idempotent per `(profile, line)`, keyed on the line's title rather than on a template
   * pointer in `speaker_tasks`. Once a task is assigned it is that speaker's, and a stored
   * pointer would make deleting a checklist line a question about somebody's homework. Running
   * this again — after a speaker joins, say — assigns only what is missing, so an organizer can
   * treat it as "bring everyone up to date" rather than as a one-shot they must not repeat.
   *
   * The due date is derived here because the offset is a distance and an event carries no date
   * range of its own: the caller names the anchor it counts from.
   *
   * @spec PRD-SPK-002 PRD-CNT-001
   */
  async assignTaskChecklist(
    actor: Actor | null,
    input: {
      eventId: string;
      profileIds: readonly string[];
      /** ISO instant the offsets count from. Defaults to now. */
      anchorAt?: string | undefined;
    },
  ): Promise<readonly SpeakerTask[]> {
    requireEventCapability(actor, input.eventId, "content:manage");
    const anchor = input.anchorAt ? new Date(input.anchorAt) : this.dependencies.now();
    if (Number.isNaN(anchor.getTime()))
      throw new SpeakerChecklistAnchorError("Checklist anchor date is not an instant");
    const profiles = await Promise.all(
      input.profileIds.map((id) => this.dependencies.repository.findProfile(id)),
    );
    // A profile from another event is refused exactly as one that does not exist: an organizer
    // of this event has no standing to assign work on somebody else's programme.
    if (profiles.some((profile) => !profile || profile.eventId !== input.eventId))
      throw new CapabilityDeniedError("Speaker profile access denied");
    const templates = await this.dependencies.repository.listTaskTemplates(input.eventId);
    if (templates.length === 0) return [];
    const workspace = await this.dependencies.repository.workspace(input.eventId);
    // Keyed as a pair rather than as a joined string: a title is organizer prose, and a
    // separator it happens to contain would make two different lines look like one.
    const assigned = new Set(
      workspace.tasks.map((task) => JSON.stringify([task.speakerProfileId, task.title])),
    );
    const tasks: SpeakerTask[] = [];
    for (const profile of profiles)
      for (const template of templates) {
        if (!profile || assigned.has(JSON.stringify([profile.id, template.title]))) continue;
        tasks.push({
          id: this.dependencies.newId(),
          eventId: input.eventId,
          speakerProfileId: profile.id,
          title: template.title,
          dueAt: new Date(
            anchor.getTime() + template.dueOffsetDays * DAY_MILLISECONDS,
          ).toISOString(),
          status: "open",
          type: "general",
          instructions: template.description,
        });
      }
    if (tasks.length === 0) return [];
    await this.dependencies.repository.addTasks(tasks);
    // Told after the work is durable, and once per task, for the reason `requestTasks` gives:
    // three deliverables are three things to do by three dates.
    for (const task of tasks) {
      const profile = profiles.find((candidate) => candidate?.id === task.speakerProfileId);
      if (!profile) continue;
      await this.dependencies.speakerNotifications?.taskAssigned({
        eventId: input.eventId,
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

  /**
   * Turn an accepted proposal into program content, and answer with the workspace it belongs to.
   *
   * Idempotent per `(eventId, proposalId)`: the session's unique constraint is the arbiter, and a
   * loser of that race retries and finds the winner's session. `ARC-FLOW-001`.
   *
   * This is the content workspace's own command — its route answers with the workspace, so the
   * projection is the response. The composed acceptance route calls `acceptSession` instead,
   * which does the same work and skips a projection that route discards; see there for why.
   */
  async accept(
    actor: Actor | null,
    command: AcceptContentCommand,
    correlationId: string,
  ): Promise<ContentWorkspaceView> {
    await this.acceptSession(actor, command, correlationId);
    return this.projected(command.eventId);
  }

  /**
   * `accept`, answering with the session's id instead of the whole event's workspace.
   *
   * Split out for issue #207. The composed decision route creates the session and then reads one
   * field off the result — `workspace.sessions.find(…)?.id` — and threw the rest away. Producing
   * that "rest" is nine table reads plus the agenda's published schedule and the identity
   * directory's names, on the busiest write in the product, for a value nobody looked at.
   *
   * Nothing else changes: the same authorization, the same acceptance, the same batch, the same
   * notifications in the same order. The decision and the session it creates are still written
   * by one composed request whose failure between them leaves a repairable `decision_only` row
   * — the atomicity issue #207 forbids weakening is a property of that composition, not of what
   * this method returns.
   */
  async acceptSession(
    actor: Actor | null,
    command: AcceptContentCommand,
    correlationId: string,
    conflictRetries = 2,
  ): Promise<string> {
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
    if (existing) return existing.id;
    const speaker = await this.resolveSpeaker(accepted, authorized.id, correlationId);
    // The conversion port owns the profile row, so the onboarding checklist is keyed off the
    // work already assigned to this person rather than off "did I just insert the profile".
    const isNew = !(await this.dependencies.repository.hasSpeakerWork(command.eventId, speaker.id));
    const session: ContentSession = {
      id: this.dependencies.newId(),
      eventId: command.eventId,
      proposalId: command.proposalId,
      title: accepted.title,
      abstract: accepted.abstract,
      format: accepted.format,
      speakerProfileIds: [speaker.id],
      tags: [],
      tracks: accepted.track ? [accepted.track] : [],
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
        return this.acceptSession(actor, command, correlationId, conflictRetries - 1);
      throw error;
    }
    /*
     * Told after the session is durable, so nobody is welcomed to a session that failed to
     * commit. Inside the `!existing` branch because a re-accept of the same proposal is the same
     * acceptance — the delivering domain deduplicates too, but not announcing it twice is
     * cheaper than deduplicating it twice.
     *
     * **The invitation goes first, and the task notices go together after it** (issue #207).
     *
     * Every announcement resolves the owning organization, writes an audit record, reads a
     * template, inserts a delivery and writes a second audit record, and three of those chains
     * end to end was 21 of the acceptance path's 65 sequential round trips — so the obvious move
     * was to issue all three at once. Review found what that costs, and it is not nothing. A
     * delivery's `created_at` and `next_attempt_at` are stamped inside the enqueue, *after* its
     * own reads, and the sender claims one delivery at a time ordered on exactly those two
     * columns. Three chains in flight together are stamped in completion order rather than in
     * acceptance order. Ties are worse rather than better: the sender's `ORDER BY` names only
     * those two columns, so a tie has no order the schema specifies at all. A
     * speaker could receive "Upload a headshot" before the invitation that explains what the
     * tasks are for.
     *
     * Two waves rather than three keeps the ordering that carries meaning and most of the saving:
     * nothing orders the two task notices against *each other* — they are two deliverables with
     * their own dates — while the invitation genuinely precedes both.
     *
     * `Promise.all` rather than `allSettled` for the second wave: the port documents that an
     * implementation must not throw, and the composition root's does not. Worth being exact about
     * what that changes, because a chain of `await`s and a `Promise.all` are not the same on a
     * rejection — sequential awaits meant the second task notice was never *invoked* if the first
     * threw, where this invokes both and surfaces the first rejection. Unreachable through the
     * bound port, and it is the port's contract rather than this line that makes it so.
     */
    await this.dependencies.speakerNotifications?.speakerAccepted({
      eventId: command.eventId,
      profileId: speaker.id,
      speakerName: speaker.name,
      speakerEmail: speaker.email,
      sessionTitle: session.title,
    });
    await Promise.all(
      tasks.map((task) =>
        this.dependencies.speakerNotifications?.taskAssigned({
          eventId: command.eventId,
          profileId: speaker.id,
          taskId: task.id,
          speakerName: speaker.name,
          speakerEmail: speaker.email,
          taskTitle: task.title,
          dueAt: task.dueAt,
        }),
      ),
    );
    return session.id;
  }

  /**
   * The stored workspace with every session's time resolved from the agenda.
   *
   * One place asks, so no caller can forget to. `publishedSessionSchedules` is a single read of
   * the snapshot in force; a session it does not name has no `schedule` at all rather than an
   * empty or stale one.
   */
  private async projectedForCalendarInvites(
    eventId: string,
    userId?: string,
  ): Promise<CalendarInviteContentWorkspaceView> {
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

  private async projected(
    eventId: string,
    userId?: string,
    access = fieldAccessFor(null, eventId),
  ): Promise<ContentWorkspaceView> {
    const workspace = await this.projectedForCalendarInvites(eventId, userId);
    const workflowStatuses = await this.workflowStatuses(eventId);
    // Only the organizer projection carries revisions, so only it needs the names to attribute
    // them to. Asking on the speaker's read would spend a query on a directory nothing renders.
    const actorDirectory =
      userId || !this.dependencies.identities
        ? undefined
        : await this.dependencies.identities.listAssignableOwnersForEvent(eventId);
    return {
      ...workspace,
      workflowStatuses,
      speakers: access.redactAll<SpeakerProfile, HideableSpeakerField>(
        "speaker",
        workspace.speakers,
      ),
      ...(actorDirectory ? { actorDirectory } : {}),
      sessions: access.redactAll<ScheduledContentSession, HideableSessionField>(
        "session",
        workspace.sessions.map(({ schedule, ...session }) =>
          schedule
            ? {
                ...session,
                schedule: {
                  startsAt: schedule.startsAt,
                  endsAt: schedule.endsAt,
                  location: schedule.location,
                },
              }
            : session,
        ),
      ),
    };
  }

  private async resolveSpeaker(
    accepted: {
      eventId: string;
      proposalId: string;
      submitter: { name: string; email: string };
    },
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
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    const authorized = actor;
    const isOrganizer = hasEventRole(authorized, eventId, "organizer");
    const isSpeaker = hasEventRole(authorized, eventId, "speaker");
    const hasContentGrant = authorized.eventAccess.some(
      (access) => access.eventId === eventId && access.capabilities.has("content:read"),
    );
    if (!hasContentGrant || (!isOrganizer && !isSpeaker)) {
      // A profile collaboration is deliberately narrower than an event role. Ask the repository
      // for this identity's already-filtered projection, then refuse an empty result so merely
      // knowing an event id grants no access.
      const collaboration = await this.projected(eventId, authorized.id);
      if (collaboration.speakers.length === 0)
        throw new CapabilityDeniedError("Content workspace access denied");
      return collaboration;
    }
    return this.projected(
      eventId,
      isOrganizer ? undefined : authorized.id,
      fieldAccessFor(authorized, eventId),
    );
  }

  async calendarInviteWorkspace(
    actor: Actor | null,
    eventId: string,
  ): Promise<CalendarInviteContentWorkspaceView> {
    const authorized = requireEventCapability(actor, eventId, "content:read");
    if (!hasEventRole(authorized, eventId, "organizer"))
      throw new CapabilityDeniedError("Calendar invitation access denied");
    return this.projectedForCalendarInvites(eventId);
  }

  async updateProfile(
    actor: Actor | null,
    profileId: string,
    /*
     * `socialLinks` is optional and replaces the whole set when present. An older client that
     * sends only the text fields edits only the text, rather than silently clearing every link
     * the speaker had entered.
     */
    input: Pick<SpeakerProfile, "name" | "bio" | "pronouns" | "organization"> &
      Partial<Pick<SpeakerProfile, "jobTitle" | "socialLinks">> & {
        expectedVersion?: number;
      },
  ): Promise<SpeakerProfile> {
    const { profile, authorized } = await this.requireProfileSteward(actor, profileId);
    const { expectedVersion: suppliedVersion, ...changes } = input;
    fieldAccessFor(authorized, profile.eventId).assertEditable("speaker", Object.keys(changes));
    const expectedVersion = suppliedVersion ?? profile.version ?? 0;
    const updated = await this.dependencies.repository.reviseProfile(
      profile.id,
      this.draftRevision(authorized, profile.eventId),
      (current) => ({ ...current, ...changes }),
      expectedVersion,
    );
    if (!updated) throw new CapabilityDeniedError("Speaker profile access denied");
    await this.recordProfileUpdate(authorized, updated);
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
    expectedVersion?: number,
  ): Promise<SpeakerProfile> {
    const { profile, authorized } = await this.requireProfileSteward(actor, profileId);
    fieldAccessFor(authorized, profile.eventId).assertEditable("speaker", ["photoAssetId"]);
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
    // No row matched: the profile went between `requireProfileSteward` reading it and this
    // write, so the choice was recorded on nothing. Answered exactly as a profile that never
    // existed is, because that is what it now is (`ARC-AUTH-001`) — and specifically not with
    // the object this method could construct, which is how a 200 came to report a headshot on
    // a deleted speaker (issue #202).
    const updated = await this.dependencies.repository.reviseProfilePhoto(
      profile.id,
      this.draftRevision(authorized, profile.eventId),
      expectedVersion ?? profile.version ?? 0,
      asset.id,
    );
    if (!updated) throw new CapabilityDeniedError("Speaker profile access denied");
    await this.recordProfileUpdate(authorized, updated);
    return updated;
  }

  /**
   * Take the headshot back off the profile, leaving the file itself alone.
   *
   * The same two identities as `setProfilePhoto`, because withdrawing a choice cannot need
   * more authority than making it. The upload survives — this is "not this picture", not
   * "delete my file", which is what `deleteAsset` is for.
   */
  async clearProfilePhoto(
    actor: Actor | null,
    profileId: string,
    expectedVersion?: number,
  ): Promise<SpeakerProfile> {
    const { profile, authorized } = await this.requireProfileSteward(actor, profileId);
    fieldAccessFor(authorized, profile.eventId).assertEditable("speaker", ["photoAssetId"]);
    // As in `setProfilePhoto`: withdrawing a choice from a profile that has gone is refused
    // rather than reported as done.
    const updated = await this.dependencies.repository.reviseProfilePhoto(
      profile.id,
      this.draftRevision(authorized, profile.eventId),
      expectedVersion ?? profile.version ?? 0,
      null,
    );
    if (!updated) throw new CapabilityDeniedError("Speaker profile access denied");
    await this.recordProfileUpdate(authorized, updated);
    return updated;
  }

  /** The speaker whose profile it is, or an organizer of the event that profile belongs to. */
  private async requireProfileSteward(
    actor: Actor | null,
    profileId: string,
  ): Promise<{ profile: SpeakerProfile; authorized: Actor }> {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    if (!actor) throw new AuthenticationRequiredError("Authentication is required");
    if (await this.dependencies.repository.isProfileCollaborator(profile.id, actor.id, true))
      return { profile, authorized: actor };
    const authorized = requireEventCapability(actor, profile.eventId, "content:read");
    const isOwner = await this.mayStewardProfile(authorized, profile, true);
    if (!isOwner && !hasEventRole(authorized, profile.eventId, "organizer"))
      throw new CapabilityDeniedError("Speaker profile access denied");
    return { profile, authorized };
  }

  private async mayStewardProfile(actor: Actor, profile: SpeakerProfile, edit = false) {
    if (profile.userId === actor.id && hasEventRole(actor, profile.eventId, "speaker")) return true;
    return this.dependencies.repository.isProfileCollaborator(profile.id, actor.id, edit);
  }

  async setProfileCollaborators(
    actor: Actor | null,
    profileId: string,
    collaborators: readonly { userId: string; access: "view" | "edit" }[],
  ) {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    const authorized = requireEventCapability(actor, profile.eventId, "content:manage");
    await this.dependencies.repository.replaceProfileCollaborators(
      profileId,
      [...new Map(collaborators.map((item) => [item.userId, item])).values()],
      authorized.id,
      this.dependencies.now().toISOString(),
    );
    return this.dependencies.repository.listProfileCollaborators(profileId);
  }

  private async createShare(
    actor: Actor | null,
    kind: "speaker-profile" | "speaker-asset",
    resourceRef: string,
    eventId: string,
    input: {
      lifetimeHours: number;
      viewLimit?: number | undefined;
      password?: string | undefined;
    },
  ) {
    const authorized = requireEventCapability(actor, eventId, "content:manage");
    const shares = this.dependencies.shares;
    if (!shares) throw new ContentShareUnavailableError("Content sharing is unavailable");
    const organizationId = await shares.organizationOf(eventId);
    if (!organizationId) throw new ContentShareUnavailableError("Content sharing is unavailable");
    const now = this.dependencies.now();
    const { token, tokenHash } = await shares.mintToken();
    const link: CapabilityLink = {
      id: this.dependencies.newId(),
      kind,
      resourceRef,
      organizationId,
      eventId,
      createdBy: authorized.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() +
          Math.min(MAX_CAPABILITY_LINK_HOURS, Math.max(1, input.lifetimeHours)) * 3_600_000,
      ).toISOString(),
      viewLimit: input.viewLimit ?? null,
      views: 0,
      revokedAt: null,
      hasPassword: Boolean(input.password),
      scope: { privateSet: true },
    };
    await shares.links.create({
      ...link,
      tokenHash,
      passwordHash: input.password ? await shares.hash(input.password) : null,
    });
    return {
      link,
      token,
      url: `${shares.baseUrl}/${kind === "speaker-profile" ? "profiles" : "assets"}/${token}`,
    };
  }

  async createProfileShare(
    actor: Actor | null,
    profileId: string,
    input: {
      lifetimeHours: number;
      viewLimit?: number | undefined;
      password?: string | undefined;
    },
  ) {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    return this.createShare(actor, "speaker-profile", profileId, profile.eventId, input);
  }

  async createAssetShare(
    actor: Actor | null,
    assetId: string,
    input: {
      lifetimeHours: number;
      viewLimit?: number | undefined;
      password?: string | undefined;
    },
  ) {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset) throw new CapabilityDeniedError("Speaker asset access denied");
    return this.createShare(actor, "speaker-asset", assetId, asset.eventId, input);
  }

  async listProfileShares(actor: Actor | null, profileId: string) {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    requireEventCapability(actor, profile.eventId, "content:manage");
    if (!this.dependencies.shares) throw new ContentShareUnavailableError();
    return this.dependencies.shares.links.list("speaker-profile", profileId);
  }

  async listAssetShares(actor: Actor | null, assetId: string) {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset) throw new CapabilityDeniedError("Speaker asset access denied");
    requireEventCapability(actor, asset.eventId, "content:manage");
    if (!this.dependencies.shares) throw new ContentShareUnavailableError();
    return this.dependencies.shares.links.list("speaker-asset", assetId);
  }

  async revokeProfileShare(actor: Actor | null, profileId: string, shareId: string) {
    const profile = await this.dependencies.repository.findProfile(profileId);
    if (!profile) throw new CapabilityDeniedError("Speaker profile access denied");
    requireEventCapability(actor, profile.eventId, "content:manage");
    if (!this.dependencies.shares) throw new ContentShareUnavailableError();
    return (
      (await this.dependencies.shares.links.revoke(
        "speaker-profile",
        profileId,
        shareId,
        this.dependencies.now().toISOString(),
      )) > 0
    );
  }

  async revokeAssetShare(actor: Actor | null, assetId: string, shareId: string) {
    const asset = await this.dependencies.repository.findAsset(assetId);
    if (!asset) throw new CapabilityDeniedError("Speaker asset access denied");
    requireEventCapability(actor, asset.eventId, "content:manage");
    if (!this.dependencies.shares) throw new ContentShareUnavailableError();
    return (
      (await this.dependencies.shares.links.revoke(
        "speaker-asset",
        assetId,
        shareId,
        this.dependencies.now().toISOString(),
      )) > 0
    );
  }

  async draftProfileRemix(actor: Actor | null, profileId: string, instruction: string) {
    const { profile } = await this.requireProfileSteward(actor, profileId);
    if (!this.dependencies.remix)
      throw new ContentShareUnavailableError("Content remix is unavailable");
    const draft = await this.dependencies.remix.remix({
      kind: "speaker-bio",
      source: profile.bio,
      instruction,
    });
    return { state: "draft" as const, field: "bio" as const, ...draft };
  }

  async draftSessionRemix(actor: Actor | null, sessionId: string, instruction: string) {
    const session = await this.dependencies.repository.findSession(sessionId);
    if (!session) throw new CapabilityDeniedError("Session access denied");
    requireEventCapability(actor, session.eventId, "content:manage");
    if (!this.dependencies.remix)
      throw new ContentShareUnavailableError("Content remix is unavailable");
    const draft = await this.dependencies.remix.remix({
      kind: "session-abstract",
      source: session.abstract,
      instruction,
    });
    return { state: "draft" as const, field: "abstract" as const, ...draft };
  }

  private async spendShare(token: string, password?: string) {
    const shares = this.dependencies.shares;
    if (!shares) throw new ContentShareUnavailableError();
    try {
      return await spendCapabilityLink(shares.links, shares.hash, {
        token,
        password,
        now: this.dependencies.now().toISOString(),
      });
    } catch {
      // ERROR-INTENT: unknown, expired, revoked, spent and wrong-password links are deliberately
      // indistinguishable so a guessed token cannot be confirmed.
      throw new ContentShareUnavailableError();
    }
  }

  async resolveProfileShare(token: string, password?: string) {
    const link = await this.spendShare(token, password);
    if (link.kind !== "speaker-profile") throw new ContentShareUnavailableError();
    const profile = await this.dependencies.repository.findProfile(link.resourceRef);
    if (!profile || profile.eventId !== link.eventId) throw new ContentShareUnavailableError();
    return {
      id: profile.id,
      eventId: profile.eventId,
      name: profile.name,
      bio: profile.bio,
      pronouns: profile.pronouns,
      jobTitle: profile.jobTitle ?? "",
      organization: profile.organization,
      photoAssetId: profile.photoAssetId,
      socialLinks: profile.socialLinks,
    };
  }

  async resolveAssetShare(token: string, password?: string) {
    const link = await this.spendShare(token, password);
    if (link.kind !== "speaker-asset") throw new ContentShareUnavailableError();
    const asset = await this.dependencies.repository.findAsset(link.resourceRef);
    if (!asset || asset.eventId !== link.eventId) throw new ContentShareUnavailableError();
    const stored = await this.dependencies.assetStorage.get(asset.storageKey);
    if (!stored) throw new ContentShareUnavailableError();
    return { asset, contentType: stored.contentType, bytes: stored.bytes };
  }

  private async recordProfileUpdate(actor: Actor, profile: SpeakerProfile) {
    await this.dependencies.profileAudit?.profileUpdated({
      actorId: actor.id,
      actorName: actor.name,
      source: actor.requestSource ?? "human",
      eventId: profile.eventId,
      profileId: profile.id,
      version: profile.version ?? 0,
    });
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
    // Same rule: a task withdrawn while the speaker had the portal open matches nothing, and
    // answering "completed" over work that is gone is the report this count exists to prevent.
    if (
      !(await this.dependencies.repository.updateTask({
        ...task,
        status: "complete",
        completedAt: this.dependencies.now().toISOString(),
      }))
    )
      throw new CapabilityDeniedError("Speaker task access denied");
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
    fieldAccessFor(authorized, session.eventId).assertEditable("session", Object.keys(input));
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
   * destructive surprise. A live public projection drops the session on its next reconciled read,
   * which is what the confirmation says.
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
    return {
      asset,
      contentType: stored.contentType,
      bytes: stored.bytes,
      publiclyReadable,
    };
  }

  /** The owning speaker and organizers of the event read an asset whatever its visibility. */
  private async mayReadPrivately(actor: Actor | null, asset: SpeakerAsset): Promise<boolean> {
    if (!actor) return false;
    const profile = await this.dependencies.repository.findProfile(asset.speakerProfileId);
    if (profile && (await this.dependencies.repository.isProfileCollaborator(profile.id, actor.id)))
      return true;
    let authorized: Actor;
    try {
      authorized = requireCapability(actor, "content:read");
    } catch {
      // ERROR-INTENT: an unauthenticated or uncapable caller must not learn the asset exists.
      return false;
    }
    if (hasEventRole(authorized, asset.eventId, "organizer")) return true;
    const profileWithEventGrant = profile;
    // Ownership is event-scoped: `content:read` is the union across every event the actor can
    // touch, so matching the stored user id alone would keep serving this asset after the
    // speaker's access to its event was removed.
    return profileWithEventGrant
      ? this.mayStewardProfile(authorized, profileWithEventGrant)
      : false;
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
    // The whole reason this method reads a count. It answers with the object it just built, so
    // a write that matched nothing used to report an asset another organizer had already
    // deleted as private — a 200 describing a row that is not there (issue #202). An asset that
    // has gone answers identically to one that never existed, which is what `deleteAsset` and
    // the read above already do.
    if (!(await this.dependencies.repository.updateAsset(updated)))
      throw new CapabilityDeniedError("Organizer asset access denied");
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
    const profile = asset
      ? await this.dependencies.repository.findProfile(asset.speakerProfileId)
      : null;
    if (!profile) throw new CapabilityDeniedError("Speaker asset access denied");
    const { authorized } = await this.requireProfileSteward(actor, profile.id);
    const isOwner = await this.mayStewardProfile(authorized, profile, true);
    if (!isOwner && !hasEventRole(authorized, asset.eventId, "organizer"))
      throw new CapabilityDeniedError("Speaker asset access denied");
    // The one caller that reads no count and should not: if the profile went between the read
    // above and this write, the pointer at this asset went with it, which is the outcome this
    // line exists to reach. Nothing is reported to the caller from it either way.
    if (profile?.photoAssetId === asset.id) {
      const updated = await this.dependencies.repository.reviseProfilePhoto(
        profile.id,
        this.draftRevision(authorized, profile.eventId),
        profile.version ?? 0,
        null,
      );
      if (!updated) throw new CapabilityDeniedError("Speaker asset access denied");
      await this.recordProfileUpdate(authorized, updated);
    }
    await this.dependencies.assetStorage.delete(asset.storageKey);
    const concurrentClear = await this.dependencies.repository.deleteAssetAfterStorage(
      asset.id,
      asset.speakerProfileId,
      this.draftRevision(authorized, asset.eventId),
    );
    if (concurrentClear) await this.recordProfileUpdate(authorized, concurrentClear);
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
    await this.requireProfileSteward(actor, profile.id);
    const workspace = await this.dependencies.repository.workspace(profile.eventId);
    /*
     * A named group is an explicit statement about identity and is the only path that lets a
     * *renamed* file join an existing chain, so it is still resolved here — from the caller's
     * own claim rather than from an inference. Everything else is resolved by the store against
     * the stored logical key, because inferring the chain from a read is what let two uploads of
     * `slides.pdf` each decide they were the first (`1406`).
     */
    const named = input.versionGroupId
      ? workspace.assets
          .filter(
            (asset) =>
              asset.versionGroupId === input.versionGroupId &&
              asset.speakerProfileId === profile.id,
          )
          .toSorted((a, b) => (b.versionNumber ?? 1) - (a.versionNumber ?? 1))[0]
      : undefined;
    if (input.versionGroupId && !named)
      throw new CapabilityDeniedError("Speaker asset access denied");
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
    // A continuation inherits the chain's task and session, so a later version does not silently
    // detach the deliverable from the work that requested it.
    const taskId = input.taskId ?? named?.taskId;
    /*
     * A file request bound to a session hands the upload that session, and the *server* reads it
     * off the task rather than trusting the portal to send it.
     *
     * The client could send it, and then could not: the check above admits a session only when
     * this speaker is one of its speakers, which a file request about somebody else's session
     * legitimately is not — an organizer may ask a workshop's co-presenter for the room's
     * handout. Refusing that upload, or widening the check so any named session is accepted,
     * are both worse than reading the association from a task this speaker already owns and the
     * request already proved is theirs. An explicit `sessionId` still wins, because a speaker
     * filing a general upload against one of their own sessions is saying something the task
     * cannot say for them.
     */
    const requested = taskId ? workspace.tasks.find((task) => task.id === taskId) : undefined;
    const sessionId = input.sessionId ?? requested?.sessionId ?? named?.sessionId;
    const asset: SpeakerAsset = {
      id,
      eventId: profile.eventId,
      speakerProfileId: profile.id,
      name: input.name,
      contentType: input.contentType,
      storageKey: stored.key,
      visibility: "private",
      uploadedAt: this.dependencies.now().toISOString(),
      ...(taskId ? { taskId } : {}),
      ...(sessionId ? { sessionId } : {}),
      // A named continuation keeps the chain's own key so its members stay one deliverable even
      // when the file was renamed; otherwise the key is derived from what this upload is.
      logicalKey:
        named?.logicalKey ??
        (named ? logicalAssetKey(named) : logicalAssetKey({ name: input.name, taskId, sessionId })),
      isLatest: true,
    };
    let allocated: { versionGroupId: string; versionNumber: number };
    try {
      allocated = await this.dependencies.repository.replaceLatestAsset(
        asset,
        named?.versionGroupId ?? input.versionGroupId,
      );
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
    // The store allocated both, so the answer describes the row that committed rather than the
    // one this method proposed.
    return { ...asset, ...allocated };
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

  /**
   * Remind the speakers behind a chosen set of open tasks.
   *
   * The organizer's counterpart to the cron sweep, and deliberately the same delivery key: both
   * are "this task, at this deadline", so pressing Remind on something the sweep already covered
   * converges on that delivery and says so rather than writing to the speaker twice
   * (`taskReminderKey`). Extending a deadline moves the key, which is how a chase after an
   * extension is a new reminder rather than a suppressed duplicate.
   *
   * Every task is reported, including the ones nothing was sent for — a speaker with no address
   * is a real state the roster carries, and an organizer who is not told will keep waiting for a
   * reply to a message that never left. A single refusal does not take the others down with it,
   * for the same reason the sweep's does not.
   */
  async remindTasks(
    actor: Actor | null,
    eventId: string,
    taskIds: readonly string[],
  ): Promise<readonly SpeakerReminderOutcome[]> {
    requireEventCapability(actor, eventId, "content:manage");
    const dispatch = this.dependencies.reminders;
    if (!dispatch) throw new SpeakerRemindersUnavailableError("Speaker reminders are not enabled");
    const organizationId = await this.dependencies.organizationOf?.(eventId);
    if (!organizationId)
      throw new SpeakerRemindersUnavailableError("This event has no owning organization");
    const workspace = await this.dependencies.repository.workspace(eventId);
    const profiles = new Map(workspace.speakers.map((profile) => [profile.id, profile]));
    const unique = [...new Set(taskIds)];
    const chosen = unique.map((taskId) => workspace.tasks.find((task) => task.id === taskId));
    // A task id this event does not carry is refused before anything is sent, rather than
    // skipped — the caller named something that does not exist and should hear so.
    if (chosen.some((task) => !task)) throw new ContentNotFoundError("Speaker task not found");

    const outcomes: SpeakerReminderOutcome[] = [];
    for (const task of chosen) {
      if (!task) continue;
      const profile = profiles.get(task.speakerProfileId);
      const describe = {
        taskId: task.id,
        speakerName: profile?.name ?? "Unknown speaker",
        title: task.title,
        dueAt: task.dueAt,
      };
      if (task.status === "complete") {
        outcomes.push({
          ...describe,
          outcome: "refused",
          reason: "already complete",
        });
        continue;
      }
      if (!profile?.email) {
        outcomes.push({
          ...describe,
          outcome: "unreachable",
          reason: "no email address",
        });
        continue;
      }
      try {
        const delivery = await dispatch.send({
          organizationId,
          eventId,
          idempotencyKey: taskReminderKey(task.id, task.dueAt),
          recipientRef: profile.email,
          templateKey: SPEAKER_REMINDER_TEMPLATE_KEY,
          payload: {
            speakerName: profile.name,
            taskTitle: task.title,
            dueAt: task.dueAt,
          },
        });
        outcomes.push({
          ...describe,
          outcome: delivery.created ? "queued" : "already-sent",
          reason: "",
        });
      } catch (error) {
        // ERROR-INTENT: one speaker's reminder failing — an unknown template, a payload the
        // template cannot fill — must not stop the rest of the selection. It is reported in this
        // task's own row, which is where the organizer can act on it, rather than discarded or
        // turned into a failure for the whole request.
        outcomes.push({
          ...describe,
          outcome: "refused",
          reason:
            error instanceof SpeakerReminderRejectedError ? error.message : "could not be queued",
        });
      }
    }
    return outcomes;
  }

  /**
   * Invite a chosen set of speakers into the portal, deliberately and again if need be.
   *
   * The counterpart to acceptance's automatic welcome, and deliberately *not* the same delivery
   * key. Acceptance sends `speaker-invite:{eventId}:{profileId}` once, which is right for the
   * fact it announces and is why nobody could ever be invited a second time: the key names the
   * person, so every later invitation to them deduplicated into a message sent months ago
   * (#189). This claims an occurrence per invitation (`claimInvitationOccurrence`) and keys the
   * delivery on it (`speakerInvitationKey`), so a re-invitation is a second delivery an organizer
   * can see rather than a suppressed duplicate — while a retried enqueue at the same occurrence
   * still converges on one message and says so.
   *
   * Every speaker is reported, including the ones nothing was sent for, for exactly the reason
   * `remindTasks` reports every task: a speaker with no address is a real state the roster
   * carries, and an organizer who is not told keeps waiting for somebody to sign in who was never
   * written to. A single refusal does not take the others down with it.
   *
   * The occurrence is claimed only for a speaker who is actually going to be written to, so a
   * roster half of which has no address does not burn half the numbering on people nobody mailed.
   *
   * @spec PRD-SPK-002 PRD-COM-001
   */
  async inviteSpeakers(
    actor: Actor | null,
    eventId: string,
    profileIds: readonly string[],
  ): Promise<readonly SpeakerInvitationOutcome[]> {
    requireEventCapability(actor, eventId, "content:manage");
    const dispatch = this.dependencies.reminders;
    if (!dispatch)
      throw new SpeakerRemindersUnavailableError("Speaker invitations are not enabled");
    const organizationId = await this.dependencies.organizationOf?.(eventId);
    if (!organizationId)
      throw new SpeakerRemindersUnavailableError("This event has no owning organization");
    const workspace = await this.dependencies.repository.workspace(eventId);
    // Deduplicated before anything is claimed: a request naming one speaker twice is one
    // invitation, not two occurrences and two messages to the same person.
    const unique = [...new Set(profileIds)];
    const chosen = unique.map((profileId) =>
      workspace.speakers.find((profile) => profile.id === profileId),
    );
    // A profile this event does not carry is refused before anything is sent, rather than
    // skipped — the caller named somebody who is not on this roster and should hear so.
    if (chosen.some((profile) => !profile))
      throw new ContentNotFoundError("Speaker profile not found");

    const outcomes: SpeakerInvitationOutcome[] = [];
    for (const profile of chosen) {
      if (!profile) continue;
      const describe = {
        profileId: profile.id,
        speakerName: profile.name,
        email: profile.email,
      };
      if (!profile.email) {
        outcomes.push({
          ...describe,
          occurrence: 0,
          outcome: "unreachable",
          reason: "no email address",
        });
        continue;
      }
      const occurrence = await this.dependencies.repository.claimInvitationOccurrence(profile.id);
      // The profile was withdrawn between the roster read above and this claim. Reported against
      // this speaker rather than raised, so the rest of the selection is still invited.
      if (occurrence === null) {
        outcomes.push({
          ...describe,
          occurrence: 0,
          outcome: "refused",
          reason: "this speaker is no longer on the event",
        });
        continue;
      }
      try {
        const delivery = await dispatch.invite({
          organizationId,
          eventId,
          idempotencyKey: speakerInvitationKey(eventId, profile.id, occurrence),
          recipientRef: profile.email,
          templateKey: SPEAKER_INVITE_TEMPLATE_KEY,
          /*
           * What an invitation is about, and deliberately no session.
           *
           * Acceptance's welcome carries a `sessionTitle` because it announces one talk; this
           * announces the portal, and a speaker with three sessions has no single one to name.
           * `invitationNumber` rides along so the retained payload says which invitation the
           * delivery was — the delivering domain keeps the snapshot as sent, so that is where
           * the history is readable months later.
           *
           * A template that grows a placeholder content does not supply is refused by name, and
           * that refusal lands in this speaker's own row rather than being swallowed.
           */
          payload: { speakerName: profile.name, invitationNumber: occurrence },
        });
        outcomes.push({
          ...describe,
          occurrence,
          outcome: delivery.created ? "queued" : "already-sent",
          reason: "",
        });
      } catch (error) {
        // ERROR-INTENT: one speaker's invitation failing — an unknown template, a payload the
        // template cannot fill — must not stop the rest of the selection. It is reported in this
        // speaker's own row, which is where the organizer can act on it, rather than discarded or
        // turned into a failure for the whole request. The occurrence stays spent: the next
        // attempt is a genuinely new invitation, which is what a refusal should produce.
        outcomes.push({
          ...describe,
          occurrence,
          outcome: "refused",
          reason:
            error instanceof SpeakerReminderRejectedError ? error.message : "could not be queued",
        });
      }
    }
    return outcomes;
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
      const snapshotPhoto = snapshot.photoAssetId
        ? await this.dependencies.repository.findAsset(snapshot.photoAssetId)
        : null;
      const restored = await this.dependencies.repository.reviseProfile(
        revision.entityId,
        draft,
        ({ photoAssetId: _replaced, ...current }) => ({
          ...current,
          name: snapshot.name,
          bio: snapshot.bio,
          pronouns: snapshot.pronouns,
          jobTitle: snapshot.jobTitle ?? "",
          organization: snapshot.organization,
          // Restore the snapshot's choice only while that owned asset still exists. An absent or
          // since-deleted headshot restores as none, so history cannot recreate a dangling link.
          ...(snapshotPhoto?.speakerProfileId === revision.entityId
            ? { photoAssetId: snapshotPhoto.id }
            : {}),
          workflowStatus: snapshot.workflowStatus,
          logistics: snapshot.logistics,
          customFields: snapshot.customFields,
          // A revision taken before `1407` carries no links, which restores as "none recorded" —
          // the same reading the migration's default gives every profile that predates it.
          socialLinks: snapshot.socialLinks ?? {},
        }),
      );
      if (!restored) throw new CapabilityDeniedError();
      await this.recordProfileUpdate(authorized, restored);
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
   * This file is not the public programme: it follows the agenda publication and includes only
   * the speaker's sessions, while publishing owns public content allowlisting. For a live site the
   * two activate together, but callers still use the owning interface for the representation they
   * need. This document always equals the agenda publication in force at read time.
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

/**
 * Whether a driver error is the checklist's own uniqueness rule rather than anything else.
 *
 * `1405` declares the uniqueness as a table constraint, so SQLite names the columns:
 * `UNIQUE constraint failed: speaker_task_templates.event_id, speaker_task_templates.title`.
 * The table and one of its two columns are both required, because the generic phrase alone is
 * not enough — a violation on `speaker_tasks`, or on this table's primary key, must not be
 * reported to an organizer as a duplicate checklist title.
 */
function isTitleConflict(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return (
    /UNIQUE constraint failed/i.test(text) && /speaker_task_templates\.(event_id|title)/i.test(text)
  );
}
