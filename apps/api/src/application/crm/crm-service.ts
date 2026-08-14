import {
  type ContactActivity,
  type ContactAlias,
  type ContactImport,
  type ContactSegment,
  type DirectoryFilters,
  findDuplicateGroups,
  normalizeEmail,
  type OrganizationContact,
} from "../../domain/crm/contact";
import {
  MAX_IMPORT_ROWS,
  type ParsedContactRow,
  parseContactCsv,
} from "../../domain/crm/contact-import";
import {
  CONVERTED_STAGE_KEY,
  DEFAULT_PIPELINE_STAGES,
  isMovableStage,
  normalizeStageOrder,
  type PipelineStage,
  type Prospect,
  type ProspectActivity,
  type ProspectTransition,
  type StageCategory,
} from "../../domain/crm/prospect";
import type { SpeakerConversionPort } from "../content/speaker-conversion";
import {
  type Actor,
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { AssignableOwner, IdentityDirectory } from "../identity/identity-directory";
import { fieldAccessAcross, type HideableContactField, type Redacted } from "../identity/public";
import type { CrmRepository, ProspectFilters } from "./crm-repository";
import {
  ContactEmailTakenError,
  ContactImportInvalidError,
  ContactMergeInvalidError,
  ContactNotFoundError,
  EventOutsideOrganizationError,
  OutreachRecipientsEmptyError,
  PipelineStageInUseError,
  PipelineStageInvalidError,
  PipelineStageNotFoundError,
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
  ProspectOwnerNotEligibleError,
  SegmentNameTakenError,
  SegmentNotFoundError,
} from "./errors";
import type { OutreachDispatchPort } from "./outreach-dispatch";

/**
 * What an import row and the contact it updates come to, together.
 *
 * The row's own values come first: a file is authoritative about what it names, so where both
 * carry a key the file wins, and the surviving order reflects that. Shared by the preview and
 * the commit because the two describing different unions is the defect this whole path keeps
 * being repaired for.
 */
function union(
  row: ParsedContactRow,
  existing: OrganizationContact,
): Pick<OrganizationContact, "tags" | "fields"> {
  return {
    tags: [...new Set([...row.tags, ...existing.tags])],
    fields: [
      ...row.fields,
      ...existing.fields.filter(({ key }) => !row.fields.some((field) => field.key === key)),
    ],
  };
}

/**
 * Why this row cannot be applied to this contact — empty when it can.
 *
 * The test is whether the row *increases* the count past the limit, not whether the result
 * exceeds it. A merge unions tags with no cap, so a contact legitimately sitting above the
 * limit exists; measuring the result alone refused every later row against that address,
 * including rows carrying no tags at all, whose write would have been identical to what was
 * already stored. Both limits are reported when both are broken, because fixing the one the
 * message named and earning a second refusal for the one it did not is a poor way to learn.
 */
function capacityErrors(row: ParsedContactRow, existing: OrganizationContact): string[] {
  const { tags, fields } = union(row, existing);
  const errors: string[] = [];
  if (tags.length > 20 && tags.length > existing.tags.length)
    errors.push(
      `This row would take ${row.email} to ${tags.length} tags, and a contact may carry 20.`,
    );
  if (fields.length > 30 && fields.length > existing.fields.length)
    errors.push(
      `This row would take ${row.email} to ${fields.length} custom fields, and a contact may carry 30.`,
    );
  return errors;
}

/**
 * Custom fields with one entry per key, the last occurrence winning.
 *
 * `crm_contact_fields` is keyed on `(contact_id, field_key)` and the write upserts, so storage
 * collapses repeats whatever the caller sent. Collapsing here too keeps the response describing
 * what was stored, and keeps a count against the thirty-field limit from including entries that
 * would have merged into one — the same correction the CSV parser carries, on the JSON path.
 */
function distinctFields(
  fields: readonly { key: string; value: string }[] | undefined,
): { key: string; value: string }[] {
  return [...new Map((fields ?? []).map((field) => [field.key, field] as const)).values()];
}

export interface CreateProspectCommand {
  eventId: string;
  name: string;
  ownerId: string;
  nextAction?: string | undefined;
  nextActionAt?: string | undefined;
  contact: { name: string; email: string };
}
/**
 * The activity kinds a caller may record. `stage-change` and `conversion` are narrated by
 * this service as it applies the transition they describe, so accepting one here would let
 * a caller write a transition into the timeline that the prospect never made.
 */
export type RecordableActivityKind = Exclude<
  ProspectActivity["kind"],
  "stage-change" | "conversion"
>;
export interface UpdateProspectCommand {
  stage?: string | undefined;
  /** What moved it. A drag on the board and an edit in the panel are different acts. */
  source?: "board" | "detail" | undefined;
  ownerId?: string | undefined;
  nextAction?: string | null | undefined;
  nextActionAt?: string | null | undefined;
  activity?: { kind: RecordableActivityKind; summary: string; private: boolean } | undefined;
  contact?: { name: string; email: string; isPrimary: boolean } | undefined;
}

export interface CreateContactCommand {
  name: string;
  email: string;
  company?: string | undefined;
  title?: string | undefined;
  notes?: string | undefined;
  tags?: readonly string[] | undefined;
  fields?: readonly { key: string; value: string }[] | undefined;
}
export interface UpdateContactCommand {
  name?: string | undefined;
  company?: string | null | undefined;
  title?: string | null | undefined;
  notes?: string | null | undefined;
  tags?: readonly string[] | undefined;
  fields?: readonly { key: string; value: string }[] | undefined;
  activity?:
    | { kind: "note" | "email" | "call" | "meeting"; summary: string; private: boolean }
    | undefined;
}
export interface DirectoryQuery extends DirectoryFilters {
  readonly segmentId?: string | undefined;
}
export interface OutreachCommand {
  eventId: string;
  templateKey: string;
  templateVersion?: number | undefined;
  contactIds?: readonly string[] | undefined;
  segmentId?: string | undefined;
}
export interface OutreachRecipient {
  readonly contactId: string;
  readonly name: string;
  readonly email: string;
  readonly deliveryId?: string;
  /** Absent on a preview. False when this send converged on a delivery that already existed. */
  readonly created?: boolean;
}
export interface ImportPreview {
  readonly filename: string;
  readonly rows: readonly (ParsedContactRow & { action: "create" | "update" | "skip" })[];
  readonly notices: readonly string[];
  readonly summary: { create: number; update: number; skip: number };
}

/** How the CRM asks the events domain what it may not answer itself. */
export interface EventOrganizationDirectory {
  belongsToOrganization(eventId: string, organizationId: string): Promise<boolean>;
  listEventIdsInOrganization(
    organizationId: string,
    candidateEventIds: readonly string[],
  ): Promise<readonly string[]>;
}

/**
 * The one sentence this service says about Converted, wherever a caller arrives at it.
 *
 * A move into it, a stage deletion that would herd cards into it, and a creation with no other
 * column to land in are the same rule refusing three approaches, so they refuse in the same
 * words: an organizer meeting this twice should recognise the rule rather than read a second
 * explanation and wonder whether it is a different one.
 */
const CONVERTED_IS_NOT_A_DESTINATION =
  "Prospects cannot be moved into Converted: converting one is what puts it there.";

// @spec PRD-CRM-001 PRD-IAM-002 ARC-FLOW-003
export class CrmService {
  constructor(
    private readonly dependencies: {
      repository: CrmRepository;
      speakerConversion: SpeakerConversionPort;
      identities: Pick<IdentityDirectory, "listAssignableOwnersForEvent">;
      /** Events owns which organization an event belongs to; the CRM asks rather than joins. */
      events: EventOrganizationDirectory;
      outreach: OutreachDispatchPort;
      newId: () => string;
      now: () => Date;
    },
  ) {}

  private authorize(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "crm:manage");
  }

  /**
   * Who may see across an organization's events.
   *
   * Three conditions, and each rules out a different escalation:
   *
   * 1. `crm:manage` at all — a reviewer or speaker on any of the organization's events never
   *    holds it, so being staffed on an event grants no directory access.
   * 2. Membership of *this* organization — an organizer of another organization's events holds
   *    a perfectly good actor-wide `crm:manage`, and it must not reach this directory.
   * 3. That the capability was earned inside this organization. Conditions 1 and 2 can be
   *    satisfied by two different organizations at once: a user who organizes an event in A and
   *    merely belongs to B would otherwise read B's directory on the strength of a grant A gave
   *    them. This is the mixed-role escalation `#27` was opened for, and it is the reason this
   *    is not simply `requireCapability` plus a membership test.
   *
   * The effect is narrower than event access, never wider: it can only refuse someone the first
   * two conditions would have admitted.
   */
  private async requireOrganization(actor: Actor | null, organizationId: string): Promise<Actor> {
    return (await this.requireOrganizationScope(actor, organizationId)).actor;
  }

  /**
   * The same three-condition check, but keeping the events the capability was earned on.
   *
   * The directory is organization-scoped while a custom role is event-scoped, so answering "what
   * may this person see here" needs the set of qualifying events rather than only a yes
   * (`fieldAccessAcross`). Everything else about the rule is unchanged.
   */
  private async requireOrganizationScope(
    actor: Actor | null,
    organizationId: string,
  ): Promise<{ actor: Actor; eventIds: readonly string[] }> {
    const authorized = requireCapability(actor, "crm:manage");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    const candidateEventIds = authorized.eventAccess
      .filter(({ capabilities }) => capabilities.has("crm:manage"))
      .map(({ eventId }) => eventId);
    const eventIds = await this.dependencies.events.listEventIdsInOrganization(
      organizationId,
      candidateEventIds,
    );
    if (eventIds.length > 0) return { actor: authorized, eventIds };
    throw new CapabilityDeniedError("Actor lacks crm:manage inside this organization");
  }

  private async requireOrganizationEvent(organizationId: string, eventId: string): Promise<void> {
    if (!(await this.dependencies.events.belongsToOrganization(eventId, organizationId)))
      throw new EventOutsideOrganizationError("Event is not part of this organization");
  }

  /**
   * Who may own a prospect on this event. Identity-access owns the answer; the CRM never reads
   * `users` or `event_roles`, and holding this listing grants nobody CRM access.
   */
  listOwners(actor: Actor | null, eventId: string): Promise<readonly AssignableOwner[]> {
    this.authorize(actor, eventId);
    return this.dependencies.identities.listAssignableOwnersForEvent(eventId);
  }

  private async requireAssignableOwner(eventId: string, ownerId: string): Promise<void> {
    const owners = await this.dependencies.identities.listAssignableOwnersForEvent(eventId);
    if (owners.some(({ id }) => id === ownerId)) return;
    throw new ProspectOwnerNotEligibleError({
      ownerId: ["Choose an organizer or reviewer assigned to this event."],
    });
  }

  list(
    actor: Actor | null,
    eventId: string,
    filters: ProspectFilters,
  ): Promise<readonly Prospect[]> {
    this.authorize(actor, eventId);
    return this.dependencies.repository.list(eventId, filters);
  }

  async get(actor: Actor | null, eventId: string, prospectId: string): Promise<Prospect> {
    this.authorize(actor, eventId);
    const prospect = await this.dependencies.repository.findById(eventId, prospectId);
    if (!prospect) throw new ProspectNotFoundError("Prospect not found");
    return prospect;
  }

  async create(actor: Actor | null, command: CreateProspectCommand): Promise<Prospect> {
    const authorized = this.authorize(actor, command.eventId);
    await this.requireAssignableOwner(command.eventId, command.ownerId);
    const now = this.dependencies.now().toISOString();
    /*
     * Where a new prospect lands is the board's first `open` stage rather than the literal
     * `identified`. An organizer who renamed or reordered their intake column would otherwise
     * find every new card arriving in a column they had moved to the end — the board would be
     * configurable everywhere except where things enter it.
     *
     * The fallback is the first column a card may be *put* in, never simply the leftmost one.
     * A board whose stages are all `won`, `nurture` or `lost` is a board this service accepts,
     * and it can begin with Converted — so `stages[0]` created a prospect standing in Converted
     * with no `speakerId` and no `convertedAt` behind it, which is the exact state `update`
     * refuses to reach and the board refuses to accept a drop into. When Converted is the only
     * column left there is nowhere honest to land, and creating is refused in the same words.
     */
    const stages = await this.ensureStages(command.eventId);
    const entry =
      stages.find(({ category }) => category === "open") ??
      stages.find(({ key }) => isMovableStage(key));
    if (!entry) throw new PipelineStageInvalidError(CONVERTED_IS_NOT_A_DESTINATION);
    const prospect: Prospect = {
      id: this.dependencies.newId(),
      eventId: command.eventId,
      name: command.name,
      stage: entry.key,
      ownerId: command.ownerId,
      nextAction: command.nextAction ?? null,
      nextActionAt: command.nextActionAt ?? null,
      contacts: [{ id: this.dependencies.newId(), ...command.contact, isPrimary: true }],
      activities: [],
      speakerId: null,
      convertedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.dependencies.repository.create(prospect, {
      id: this.dependencies.newId(),
      eventId: command.eventId,
      prospectId: prospect.id,
      // From nowhere: this is the prospect arriving, not a move somebody made.
      fromStage: null,
      toStage: prospect.stage,
      actorId: authorized.id,
      source: "created",
      occurredAt: now,
    });
    return prospect;
  }

  async update(
    actor: Actor | null,
    eventId: string,
    prospectId: string,
    command: UpdateProspectCommand,
  ): Promise<Prospect> {
    const authorized = this.authorize(actor, eventId);
    const current = await this.get(authorized, eventId, prospectId);
    if (current.speakerId)
      throw new ProspectAlreadyConvertedError("Converted prospects are immutable");
    // Only a reassignment is checked. Re-sending the stored owner cannot introduce an
    // ineligible one, and refusing it would block every other edit on a prospect whose owner
    // has since left the event.
    if (command.ownerId !== undefined && command.ownerId !== current.ownerId)
      await this.requireAssignableOwner(eventId, command.ownerId);
    const now = this.dependencies.now().toISOString();
    const moving = command.stage !== undefined && command.stage !== current.stage;
    /*
     * A stage the board does not have is refused here rather than by a CHECK. The constraint
     * that used to do it pinned five keys and is gone (`1502`); which keys exist is data now,
     * so this is the boundary — and it has to be, because a stored key with no column would
     * render a card nowhere at all.
     */
    let stageLabels = new Map<string, string>();
    if (moving) {
      const stages = await this.ensureStages(eventId);
      stageLabels = new Map(stages.map((stage) => [stage.key, stage.label]));
      const target = stages.find(({ key }) => key === command.stage);
      if (!target) throw new PipelineStageNotFoundError("That stage is not on this board");
      if (!isMovableStage(target.key))
        throw new PipelineStageInvalidError(CONVERTED_IS_NOT_A_DESTINATION);
    }
    // One write carries every consequence of this command. The stage transition is recorded
    // here rather than by the caller — `UpdateProspectCommand` cannot express one, and the
    // HTTP schema refuses it — so the timeline cannot disagree with the stage, and it lands
    // in the same repository call as the organizer's note.
    const activities: ProspectActivity[] = [];
    if (moving)
      activities.push({
        id: this.dependencies.newId(),
        kind: "stage-change",
        // Labels rather than keys: the timeline is read by a person, and `future-fit` is not
        // what their board calls that column.
        summary: `${stageLabels.get(current.stage) ?? current.stage} → ${stageLabels.get(command.stage as string) ?? command.stage}`,
        private: false,
        occurredAt: now,
        actorId: authorized.id,
      });
    if (command.activity)
      activities.push({
        id: this.dependencies.newId(),
        ...command.activity,
        occurredAt: now,
        actorId: authorized.id,
      });
    const contact = command.contact
      ? { id: this.dependencies.newId(), ...command.contact }
      : undefined;
    const updated = {
      ...current,
      stage: command.stage ?? current.stage,
      ownerId: command.ownerId ?? current.ownerId,
      nextAction: command.nextAction === undefined ? current.nextAction : command.nextAction,
      nextActionAt:
        command.nextActionAt === undefined ? current.nextActionAt : command.nextActionAt,
      updatedAt: now,
      activities: [...current.activities, ...activities],
      contacts: contact
        ? [
            ...current.contacts.map((item) =>
              contact.isPrimary ? { ...item, isPrimary: false } : item,
            ),
            contact,
          ]
        : current.contacts,
    };
    await this.dependencies.repository.update(
      updated,
      activities,
      contact,
      moving
        ? {
            id: this.dependencies.newId(),
            eventId,
            prospectId: current.id,
            fromStage: current.stage,
            toStage: updated.stage,
            actorId: authorized.id,
            // The command carries where the move came from, so a report can tell a drag on the
            // board from an edit in the detail panel. `detail` is the conservative default.
            source: command.source ?? "detail",
            occurredAt: now,
          }
        : undefined,
    );
    return updated;
  }

  /* ------------------------------ the board itself ------------------------------ */

  /**
   * This event's stages, healing an event that has none.
   *
   * Self-healing rather than "create the stages when an event is created", for the same reason
   * review's `storedStatuses` is: an event created before `1501`, or by a path that predates
   * this feature, would otherwise open a board with no columns and every card rendering nowhere.
   * `ensureStages` writes with `INSERT OR IGNORE`, so healing can never undo a rename and two
   * organizers opening a new board at once cannot fail each other.
   */
  async pipelineStages(actor: Actor | null, eventId: string): Promise<readonly PipelineStage[]> {
    this.authorize(actor, eventId);
    return this.ensureStages(eventId);
  }

  private async ensureStages(eventId: string): Promise<readonly PipelineStage[]> {
    const existing = await this.dependencies.repository.listStages(eventId);
    if (existing.length) return existing;
    const createdAt = this.dependencies.now().toISOString();
    return this.dependencies.repository.ensureStages(
      eventId,
      DEFAULT_PIPELINE_STAGES.map((stage) => ({
        ...stage,
        id: this.dependencies.newId(),
        eventId,
        createdAt,
      })),
    );
  }

  /**
   * Add, rename and reorder in one command, because on a board they are one act.
   *
   * The whole list is sent rather than a diff: a reorder moves every column, and three narrow
   * writes would leave the order half-applied if the second failed. What this refuses is the
   * two ways a stage list stops describing a board — a key that no longer exists while prospects
   * still sit in it, and a duplicate key or label that would render two identical columns.
   */
  async savePipelineStages(
    actor: Actor | null,
    eventId: string,
    stages: readonly { key: string; label: string; category: StageCategory }[],
  ): Promise<readonly PipelineStage[]> {
    this.authorize(actor, eventId);
    const existing = await this.ensureStages(eventId);
    const keys = stages.map(({ key }) => key);
    if (new Set(keys).size !== keys.length)
      throw new PipelineStageInvalidError("Two stages cannot share a key");
    const labels = stages.map(({ label }) => label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length)
      throw new PipelineStageInvalidError("Two stages cannot share a name");
    if (!stages.length) throw new PipelineStageInvalidError("A pipeline needs at least one stage");

    /*
     * `converted` is the product's, not the organizer's. It is what `convert` writes, and
     * `crm_activities_one_conversion_idx` makes reaching it a once-ever fact — so a board
     * without that column would have converted cards rendering nowhere, and one that let it be
     * renamed to a different key would strand every card already in it.
     */
    if (!keys.includes(CONVERTED_STAGE_KEY))
      throw new PipelineStageInvalidError(
        "The Converted stage cannot be removed: it is where converting a prospect puts it.",
      );

    // A stage nobody is standing in may simply go. One that still holds cards has to be deleted
    // through `deletePipelineStage`, which asks where they should go.
    const counts = await this.dependencies.repository.countByStage(eventId);
    const dropped = existing.filter(({ key }) => !keys.includes(key));
    const occupied = dropped.filter(({ key }) => (counts.get(key) ?? 0) > 0);
    if (occupied.length)
      throw new PipelineStageInUseError(
        `${occupied.map(({ label }) => label).join(", ")} still ${occupied.length === 1 ? "holds" : "hold"} prospects. Choose where they should move first.`,
      );

    const byKey = new Map(existing.map((stage) => [stage.key, stage]));
    const createdAt = this.dependencies.now().toISOString();
    const next = normalizeStageOrder(
      stages.map((stage, index) => ({
        // A surviving stage keeps its id, so the console's list keeps its React keys across a
        // reorder and a rename reads as an edit rather than as a delete plus an insert.
        id: byKey.get(stage.key)?.id ?? this.dependencies.newId(),
        eventId,
        key: stage.key,
        label: stage.label.trim(),
        category: stage.category,
        sortOrder: index,
        createdAt: byKey.get(stage.key)?.createdAt ?? createdAt,
      })),
    );
    await this.dependencies.repository.saveStages(eventId, next);
    return next;
  }

  /**
   * Delete a stage, moving whatever is in it somewhere the organizer named.
   *
   * The migration target is required rather than defaulted. A default would silently decide
   * where somebody's shortlist went, and the whole reason this refuses a bare delete is that
   * losing track of a prospect is worse than an extra question (#197).
   */
  async deletePipelineStage(
    actor: Actor | null,
    eventId: string,
    stageKey: string,
    migrateTo: string,
  ): Promise<readonly PipelineStage[]> {
    const authorized = this.authorize(actor, eventId);
    const existing = await this.ensureStages(eventId);
    if (!existing.some(({ key }) => key === stageKey))
      throw new PipelineStageNotFoundError("That stage is not on this board");
    if (stageKey === CONVERTED_STAGE_KEY)
      throw new PipelineStageInvalidError(
        "The Converted stage cannot be removed: it is where converting a prospect puts it.",
      );
    if (!existing.some(({ key }) => key === migrateTo) || migrateTo === stageKey)
      throw new PipelineStageInvalidError("Choose another stage on this board to move them to");
    if (migrateTo === CONVERTED_STAGE_KEY)
      throw new PipelineStageInvalidError(CONVERTED_IS_NOT_A_DESTINATION);

    const remaining = normalizeStageOrder(existing.filter(({ key }) => key !== stageKey));
    await this.dependencies.repository.deleteStage(
      eventId,
      stageKey,
      migrateTo,
      // Who and when, not who moved. Every card that moves says so in the history, because
      // "where did these go" is exactly the question somebody asks after a stage disappears —
      // but *which* cards those are is decided by the write, not by a read taken just before it.
      {
        actorId: authorized.id,
        source: "detail",
        occurredAt: this.dependencies.now().toISOString(),
      },
      remaining,
    );
    return remaining;
  }

  /** Every move on this event's board, oldest first. */
  async pipelineHistory(
    actor: Actor | null,
    eventId: string,
  ): Promise<readonly ProspectTransition[]> {
    this.authorize(actor, eventId);
    return this.dependencies.repository.listTransitions(eventId);
  }

  async convert(
    actor: Actor | null,
    eventId: string,
    prospectId: string,
    correlationId: string,
  ): Promise<Prospect> {
    const authorized = this.authorize(actor, eventId);
    const current = await this.get(authorized, eventId, prospectId);
    if (current.speakerId) return current;
    const primary = current.contacts.find(({ isPrimary }) => isPrimary) ?? current.contacts[0];
    if (!primary) throw new ProspectContactRequiredError("A contact is required before conversion");
    const occurredAt = this.dependencies.now().toISOString();
    const { speakerId } = await this.dependencies.speakerConversion.createOrLink({
      eventId,
      source: { kind: "crm-prospect", id: prospectId },
      name: current.name,
      email: primary.email,
      actorId: authorized.id,
      occurredAt,
      correlationId,
      idempotencyKey: `crm-conversion:${eventId}:${prospectId}`,
    });
    return this.dependencies.repository.recordConversion(
      eventId,
      prospectId,
      speakerId,
      {
        id: this.dependencies.newId(),
        kind: "conversion",
        summary: "Converted prospect to speaker",
        private: false,
        occurredAt,
        actorId: authorized.id,
      },
      // Converting moves the card, so it belongs in the same history as every other move —
      // otherwise a board's busiest transition is the one its report cannot see.
      {
        id: this.dependencies.newId(),
        eventId,
        prospectId,
        fromStage: current.stage,
        toStage: CONVERTED_STAGE_KEY,
        actorId: authorized.id,
        source: "conversion",
        occurredAt,
      },
    );
  }

  /* ---------------------------------------------------------------------------------------
   * The organization-wide directory.
   *
   * Every method here begins with `requireOrganization`, and none of them takes an event id as
   * its scope. An event id appears only where an event is genuinely the target — sourcing a
   * contact into a pipeline, or sending outreach that communications will deliver against one —
   * and in both cases the event-scoped capability is checked *as well*, never instead.
   * ------------------------------------------------------------------------------------- */

  private async resolveFilters(
    organizationId: string,
    query: DirectoryQuery,
  ): Promise<DirectoryFilters> {
    if (!query.segmentId) {
      const { segmentId: _ignored, ...filters } = query;
      return filters;
    }
    const segment = await this.dependencies.repository.findSegment(organizationId, query.segmentId);
    if (!segment) throw new SegmentNotFoundError("Segment not found");
    return segment.filters;
  }

  async listContacts(
    actor: Actor | null,
    organizationId: string,
    query: DirectoryQuery = {},
  ): Promise<{
    contacts: readonly Redacted<OrganizationContact, HideableContactField>[];
    filters: DirectoryFilters;
  }> {
    const scope = await this.requireOrganizationScope(actor, organizationId);
    const filters = await this.resolveFilters(organizationId, query);
    const access = fieldAccessAcross(scope.actor, scope.eventIds);
    // Redacted at the projection, so the directory screen, its CSV export and any report over it
    // reach the same answer. A sponsor liaison who cannot read a contact's notes does not get
    // them here, in the download, or by asking a report for them.
    return {
      contacts: access.redactAll<OrganizationContact, HideableContactField>(
        "contact",
        await this.dependencies.repository.listContacts(organizationId, filters),
      ),
      filters,
    };
  }

  async getContact(
    actor: Actor | null,
    organizationId: string,
    contactId: string,
  ): Promise<Redacted<OrganizationContact, HideableContactField>> {
    const scope = await this.requireOrganizationScope(actor, organizationId);
    return fieldAccessAcross(scope.actor, scope.eventIds).redact<
      OrganizationContact,
      HideableContactField
    >("contact", await this.loadContact(organizationId, contactId));
  }

  /**
   * The whole contact, for a command that has to reason about it.
   *
   * Separate from `getContact` because redaction belongs at the *read boundary* and nowhere else.
   * An update composes the next record from the current one, and a merge reads both sides; hand
   * either of those a redacted copy and the write would silently erase whatever the caller's role
   * could not see — which is a data-loss bug wearing an access-control costume. What a restricted
   * caller may *change* is enforced separately, by `assertEditable` on the command's own fields.
   */
  private async loadContact(
    organizationId: string,
    contactId: string,
  ): Promise<OrganizationContact> {
    const contact = await this.dependencies.repository.findContact(organizationId, contactId);
    if (!contact) throw new ContactNotFoundError("Contact not found");
    return contact;
  }

  private async requireAddressIsFree(
    organizationId: string,
    email: string,
    allowedId?: string,
  ): Promise<void> {
    const existing = await this.dependencies.repository.findContactByEmail(organizationId, email);
    if (!existing || existing.id === allowedId) return;
    throw new ContactEmailTakenError({
      email: [`${existing.name} already holds this address. Merge the records instead.`],
    });
  }

  private newContact(
    organizationId: string,
    input: CreateContactCommand,
    source: OrganizationContact["source"],
    now: string,
  ): OrganizationContact {
    return {
      id: this.dependencies.newId(),
      organizationId,
      name: input.name,
      email: normalizeEmail(input.email),
      company: input.company ?? null,
      title: input.title ?? null,
      notes: input.notes ?? null,
      source,
      mergedIntoId: null,
      tags: [...new Set(input.tags ?? [])],
      fields: distinctFields(input.fields),
      aliases: [],
      events: [],
      activities: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async createContact(
    actor: Actor | null,
    organizationId: string,
    input: CreateContactCommand,
  ): Promise<OrganizationContact> {
    await this.requireOrganization(actor, organizationId);
    await this.requireAddressIsFree(organizationId, normalizeEmail(input.email));
    const contact = this.newContact(
      organizationId,
      input,
      "manual",
      this.dependencies.now().toISOString(),
    );
    await this.dependencies.repository.createContact(contact);
    return contact;
  }

  async updateContact(
    actor: Actor | null,
    organizationId: string,
    contactId: string,
    command: UpdateContactCommand,
  ): Promise<OrganizationContact> {
    const authorized = await this.requireOrganization(actor, organizationId);
    const current = await this.loadContact(organizationId, contactId);
    if (current.mergedIntoId)
      throw new ContactMergeInvalidError("A merged contact is read-only; edit the primary");
    const now = this.dependencies.now().toISOString();
    const activities: ContactActivity[] = command.activity
      ? [
          {
            id: this.dependencies.newId(),
            ...command.activity,
            occurredAt: now,
            actorId: authorized.id,
          },
        ]
      : [];
    // Absent leaves alone, `null` clears — the same convention the prospect update uses, so a
    // client can empty the notes without resending the tags it did not touch.
    const settled = <T>(supplied: T | null | undefined, current: T | null): T | null =>
      supplied === undefined ? current : supplied;
    const updated: OrganizationContact = {
      ...current,
      name: command.name ?? current.name,
      company: settled(command.company, current.company),
      title: settled(command.title, current.title),
      notes: settled(command.notes, current.notes),
      tags: command.tags ? [...new Set(command.tags)] : current.tags,
      fields: command.fields ? distinctFields(command.fields) : current.fields,
      activities: [...current.activities, ...activities],
      updatedAt: now,
    };
    await this.dependencies.repository.updateContact(updated, activities);
    /*
     * The stored record, not the one assembled above.
     *
     * The write is guarded on the contact still being live, and that check happens inside the
     * batch, so a merge landing between the read at the top of this method and the write leaves
     * it applying nothing. Returning the locally-built object then answered 200 with an edit
     * that does not exist. Re-reading costs one query and makes the response describe storage.
     */
    const stored = await this.dependencies.repository.findContact(organizationId, contactId);
    if (!stored || stored.mergedIntoId)
      throw new ContactMergeInvalidError(
        "This contact was merged while it was being edited; edit the primary",
      );
    return stored;
  }

  /* CSV import. */

  private async classify(
    organizationId: string,
    parsed: readonly ParsedContactRow[],
  ): Promise<ImportPreview["rows"]> {
    const seen = new Map<string, number>();
    const rows: (ParsedContactRow & { action: "create" | "update" | "skip" })[] = [];
    // One bulk resolve for the whole file rather than a query per row: a 500-row import was 500
    // serial round trips before it wrote anything.
    const existingByEmail = await this.dependencies.repository.findContactsByEmails(
      organizationId,
      [...new Set(parsed.filter((row) => row.errors.length === 0).map((row) => row.email))],
    );
    for (const row of parsed) {
      // Read before overwriting: the useful half of this message is the *earlier* row that
      // already claimed the address, and setting first made it name the offending row itself.
      // Rows the parser already rejected are left out of the map entirely — several unreadable
      // addresses all normalise to the empty string, and they would otherwise accuse each other
      // of duplicating a contact that has no address at all.
      const unusable = row.errors.length > 0;
      const claimedBy = unusable ? undefined : seen.get(row.email);
      if (!unusable) seen.set(row.email, claimedBy ?? row.line);
      const errors =
        claimedBy === undefined
          ? row.errors
          : [...row.errors, `Line ${claimedBy} already imports ${row.email}.`];
      const existing = errors.length ? null : (existingByEmail.get(row.email) ?? null);
      // Capacity is decided here, where the preview is built, and not again at commit time.
      // A check that ran only in the commit made the preview promise an update the write then
      // refused — and this is the one method whose whole purpose is that those two agree.
      const refusals = existing ? [...errors, ...capacityErrors(row, existing)] : errors;
      rows.push({
        ...row,
        errors: refusals,
        action: refusals.length ? "skip" : existing ? "update" : "create",
      });
    }
    return rows;
  }

  /**
   * What committing this file would do, resolved against the live directory by the same code
   * the commit runs — so the preview an organizer approves and the write that follows cannot
   * describe different outcomes.
   */
  async previewImport(
    actor: Actor | null,
    organizationId: string,
    input: { filename: string; csv: string },
  ): Promise<ImportPreview> {
    await this.requireOrganization(actor, organizationId);
    return this.buildPreview(organizationId, input);
  }

  /**
   * The preview itself, for a caller that has already been authorized.
   *
   * `importContacts` needs the same answer and used to get it by calling `previewImport`, which
   * re-ran the organization check — and that check costs a database round trip per event the
   * actor can reach, so the import paid the whole fan-out twice.
   */
  private async buildPreview(
    organizationId: string,
    input: { filename: string; csv: string },
  ): Promise<ImportPreview> {
    const parsed = parseContactCsv(input.csv);
    if (parsed.rows.length === 0 && parsed.errors.length > 0)
      throw new ContactImportInvalidError({ csv: [...parsed.errors] });
    /*
     * A file bigger than this is refused whole rather than started.
     *
     * Every row costs at least one read to classify and one statement to commit, so a megabyte
     * of valid rows — which the byte cap alone permits — runs out of a Worker's query budget
     * partway through, leaving a partial import nobody asked for. Refusing up front is the
     * honest failure, and it names the number so the file can be split.
     */
    if (parsed.rows.length > MAX_IMPORT_ROWS)
      throw new ContactImportInvalidError({
        csv: [
          `This file has ${parsed.rows.length} rows, and an import may carry ${MAX_IMPORT_ROWS}. Split it and import the parts.`,
        ],
      });
    const rows = await this.classify(organizationId, parsed.rows);
    return {
      filename: input.filename,
      rows,
      notices: parsed.errors,
      summary: {
        create: rows.filter(({ action }) => action === "create").length,
        update: rows.filter(({ action }) => action === "update").length,
        skip: rows.filter(({ action }) => action === "skip").length,
      },
    };
  }

  async importContacts(
    actor: Actor | null,
    organizationId: string,
    input: { filename: string; csv: string },
  ): Promise<{
    record: ContactImport;
    contacts: readonly OrganizationContact[];
    rejected: ImportPreview["rows"];
  }> {
    const authorized = await this.requireOrganization(actor, organizationId);
    const preview = await this.buildPreview(organizationId, input);
    const now = this.dependencies.now().toISOString();
    const activity = (summary: string): ContactActivity => ({
      id: this.dependencies.newId(),
      kind: "import",
      summary,
      private: false,
      occurredAt: now,
      actorId: authorized.id,
    });
    const created: OrganizationContact[] = [];
    const updated: OrganizationContact[] = [];
    for (const row of preview.rows) {
      if (row.action === "skip") continue;
      const command: CreateContactCommand = {
        name: row.name,
        email: row.email,
        ...(row.company ? { company: row.company } : {}),
        ...(row.title ? { title: row.title } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
        tags: row.tags,
        fields: row.fields,
      };
      if (row.action === "create") {
        const contact = this.newContact(organizationId, command, "import", now);
        created.push({
          ...contact,
          activities: [activity(`Imported from ${input.filename}`)],
        });
        continue;
      }
      const existing = await this.dependencies.repository.findContactByEmail(
        organizationId,
        row.email,
      );
      // Re-read rather than reused from the preview: the row is about to be written, and the
      // directory may have moved since it was classified.
      // Classified as an update a moment ago, so it exists; a concurrent merge is the only way
      // it could not, and then the row is simply not applied rather than resurrecting a record.
      if (!existing || existing.mergedIntoId) continue;
      updated.push({
        ...existing,
        name: row.name,
        company: row.company ?? existing.company,
        title: row.title ?? existing.title,
        // An import enriches; it never silently erases a note somebody typed here.
        notes: existing.notes ?? row.notes,
        // The same union the preview measured, from the same function.
        ...union(row, existing),
        activities: [...existing.activities, activity(`Updated by import ${input.filename}`)],
        updatedAt: now,
      });
    }
    const record: ContactImport = {
      id: this.dependencies.newId(),
      organizationId,
      filename: input.filename,
      rowCount: preview.rows.length,
      createdCount: created.length,
      updatedCount: updated.length,
      skippedCount: preview.rows.filter(({ action }) => action === "skip").length,
      importedAt: now,
      importedBy: authorized.id,
    };
    await this.dependencies.repository.commitImport(record, created, updated);
    return {
      record,
      contacts: [...created, ...updated],
      rejected: preview.rows.filter(({ action }) => action === "skip"),
    };
  }

  /* Deduplication. */

  async duplicates(actor: Actor | null, organizationId: string) {
    await this.requireOrganization(actor, organizationId);
    return findDuplicateGroups(await this.dependencies.repository.listContacts(organizationId, {}));
  }

  async mergeContacts(
    actor: Actor | null,
    organizationId: string,
    input: { primaryId: string; duplicateIds: readonly string[] },
  ): Promise<OrganizationContact> {
    const authorized = await this.requireOrganization(actor, organizationId);
    const duplicateIds = [...new Set(input.duplicateIds)];
    if (duplicateIds.includes(input.primaryId))
      throw new ContactMergeInvalidError("The primary contact cannot also be a duplicate");
    const primary = await this.dependencies.repository.findContact(organizationId, input.primaryId);
    if (!primary) throw new ContactNotFoundError("Contact not found");
    if (primary.mergedIntoId)
      throw new ContactMergeInvalidError("The primary contact has already been merged away");
    const now = this.dependencies.now().toISOString();
    const aliases: ContactAlias[] = [];
    for (const duplicateId of duplicateIds) {
      const duplicate = await this.dependencies.repository.findContact(organizationId, duplicateId);
      // Refused whole rather than partially applied: a merge cannot be undone, so a request
      // naming one unreachable record must not quietly fold the others away.
      if (!duplicate) throw new ContactNotFoundError("Contact not found");
      if (duplicate.mergedIntoId)
        throw new ContactMergeInvalidError(`${duplicate.name} has already been merged away`);
      aliases.push({
        id: this.dependencies.newId(),
        name: duplicate.name,
        email: duplicate.email,
        mergedFromId: duplicate.id,
        mergedAt: now,
      });
      // The address a merged record was found under stays searchable, and so does any address
      // it had itself absorbed earlier.
      for (const inherited of duplicate.aliases)
        aliases.push({ ...inherited, id: this.dependencies.newId(), mergedAt: now });
    }
    return this.dependencies.repository.mergeContacts({
      organizationId,
      primaryId: input.primaryId,
      duplicateIds,
      aliases,
      activity: {
        id: this.dependencies.newId(),
        kind: "merge",
        summary: `Merged ${aliases
          .filter(({ mergedFromId }) => duplicateIds.includes(mergedFromId))
          .map(({ email }) => email)
          .join(", ")} into this contact`,
        private: false,
        occurredAt: now,
        actorId: authorized.id,
      },
    });
  }

  /* Saved views. */

  async listSegments(actor: Actor | null, organizationId: string) {
    await this.requireOrganization(actor, organizationId);
    return this.dependencies.repository.listSegments(organizationId);
  }

  async createSegment(
    actor: Actor | null,
    organizationId: string,
    input: { name: string; filters: DirectoryFilters },
  ): Promise<ContactSegment> {
    const authorized = await this.requireOrganization(actor, organizationId);
    const existing = await this.dependencies.repository.listSegments(organizationId);
    if (existing.some(({ name }) => name.toLowerCase() === input.name.toLowerCase()))
      throw new SegmentNameTakenError({ name: ["A segment already uses this name."] });
    const segment: ContactSegment = {
      id: this.dependencies.newId(),
      organizationId,
      name: input.name,
      // The definition, never a frozen list of ids: reopening a saved view has to show who
      // matches it today, including contacts imported after it was saved.
      filters: input.filters,
      createdAt: this.dependencies.now().toISOString(),
      createdBy: authorized.id,
    };
    await this.dependencies.repository.createSegment(segment);
    return segment;
  }

  /* Bulk outreach. */

  private async recipients(
    organizationId: string,
    command: OutreachCommand,
  ): Promise<readonly OrganizationContact[]> {
    if (command.segmentId) {
      const filters = await this.resolveFilters(organizationId, { segmentId: command.segmentId });
      const matched = await this.dependencies.repository.listContacts(organizationId, filters);
      if (matched.length === 0)
        throw new OutreachRecipientsEmptyError("This segment matches no contacts");
      return matched;
    }
    const wanted = [...new Set(command.contactIds ?? [])];
    const contacts: OrganizationContact[] = [];
    for (const contactId of wanted) {
      const contact = await this.dependencies.repository.findContact(organizationId, contactId);
      // A merged-away id is not an error the sender can act on — the survivor is already in the
      // list whenever the merge is what put it there — so it is dropped rather than refused.
      if (contact && !contact.mergedIntoId) contacts.push(contact);
    }
    if (contacts.length === 0)
      throw new OutreachRecipientsEmptyError("No contact in this organization matched");
    return contacts;
  }

  /**
   * Both halves of a send, sharing one authorization path and one recipient resolution.
   *
   * `eventId` is checked twice on purpose: `requireEventCapability` because delivery is written
   * against an event and a directory-wide grant must not become a send into an event this actor
   * does not run, and `requireOrganizationEvent` because an event this actor *does* run may
   * belong to a different organization than the contacts being addressed.
   */
  private async resolveOutreach(
    actor: Actor | null,
    organizationId: string,
    command: OutreachCommand,
  ) {
    const authorized = await this.requireOrganization(actor, organizationId);
    this.authorize(authorized, command.eventId);
    await this.requireOrganizationEvent(organizationId, command.eventId);
    return { authorized, contacts: await this.recipients(organizationId, command) };
  }

  private message(organizationId: string, command: OutreachCommand, contact: OrganizationContact) {
    return {
      organizationId,
      eventId: command.eventId,
      /*
       * Deterministic, so re-sending one campaign to the same contact converges on a single
       * delivery instead of mailing them twice. The template and its version are both in the
       * key on purpose: a *different* message, or a corrected version of the same one, is a
       * send that should happen, and only a repeat of the identical one is the duplicate this
       * is guarding against.
       */
      idempotencyKey: `crm-outreach:${command.eventId}:${contact.id}:${command.templateKey}:v${
        command.templateVersion ?? "latest"
      }`,
      templateKey: command.templateKey,
      templateVersion: command.templateVersion,
      recipientRef: `crm-contact:${contact.id}`,
      // Named for what a message says rather than for what the directory stores: a template
      // greets a person by name, and the renderer refuses a placeholder nothing fills.
      payload: {
        contactId: contact.id,
        speakerName: contact.name,
        name: contact.name,
        email: contact.email,
        company: contact.company,
      },
    };
  }

  async previewOutreach(
    actor: Actor | null,
    organizationId: string,
    command: OutreachCommand,
  ): Promise<{ eventId: string; templateKey: string; recipients: readonly OutreachRecipient[] }> {
    const { contacts } = await this.resolveOutreach(actor, organizationId, command);
    const [first] = contacts;
    // Resolved by the dispatcher rather than assumed, now that communications publishes a call
    // that resolves without writing: a template key that does not exist fails here, on the
    // screen showing what will be sent, instead of after the first message is queued.
    if (first)
      await this.dependencies.outreach.prepare(this.message(organizationId, command, first));
    return {
      eventId: command.eventId,
      templateKey: command.templateKey,
      recipients: contacts.map(({ id, name, email }) => ({ contactId: id, name, email })),
    };
  }

  async sendOutreach(
    actor: Actor | null,
    organizationId: string,
    command: OutreachCommand,
  ): Promise<{ eventId: string; templateKey: string; sent: readonly OutreachRecipient[] }> {
    const { authorized, contacts } = await this.resolveOutreach(actor, organizationId, command);
    const now = this.dependencies.now().toISOString();
    const sent: OutreachRecipient[] = [];
    /*
     * Recorded per recipient, as each send returns, rather than in one write at the end.
     *
     * A campaign is a sequence of individually durable deliveries, not one transaction: batching
     * the timeline entries meant a failure on the fifth recipient left four messages queued in
     * communications with nothing in the CRM saying so, which is the opposite of what a delivery
     * log is for. Each entry lands before the next send is attempted, so whatever the loop
     * manages before it fails is recorded.
     */
    for (const contact of contacts) {
      const { deliveryId, created } = await this.dependencies.outreach.send(
        this.message(organizationId, command, contact),
      );
      sent.push({
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        deliveryId,
        created,
      });
      // Only a delivery this send actually created is news. Re-running a campaign converges on
      // the original by design, and recording that again claimed a message had been queued that
      // had not, and put a second "Sent" line on one contact's timeline for one message.
      if (!created) continue;
      await this.dependencies.repository.recordContactActivities(organizationId, [
        {
          contactId: contact.id,
          activity: {
            id: this.dependencies.newId(),
            kind: "outreach",
            summary: `Sent "${command.templateKey}" (delivery ${deliveryId})`,
            private: false,
            occurredAt: now,
            actorId: authorized.id,
          },
        },
      ]);
    }
    return { eventId: command.eventId, templateKey: command.templateKey, sent };
  }

  /* Organization-level analytics, counted over stored rows. */

  async dashboard(actor: Actor | null, organizationId: string) {
    await this.requireOrganization(actor, organizationId);
    const [contacts, segments] = await Promise.all([
      this.dependencies.repository.listContacts(organizationId, {}),
      this.dependencies.repository.listSegments(organizationId),
    ]);
    const stages = new Map<string, Set<string>>();
    const companies = new Map<string, number>();
    for (const contact of contacts) {
      for (const link of contact.events)
        stages.set(link.stage, (stages.get(link.stage) ?? new Set()).add(contact.id));
      if (contact.company)
        companies.set(contact.company, (companies.get(contact.company) ?? 0) + 1);
    }
    return {
      contacts: contacts.length,
      contactsInMultipleEvents: contacts.filter(({ events }) => events.length > 1).length,
      convertedContacts: contacts.filter(({ events }) =>
        events.some(({ speakerId }) => speakerId !== null),
      ).length,
      duplicateGroups: findDuplicateGroups(contacts).length,
      segments: segments.length,
      imported: contacts.filter(({ source }) => source === "import").length,
      byStage: [...stages]
        .map(([stage, owners]) => ({ stage, contacts: owners.size }))
        .sort((left, right) => left.stage.localeCompare(right.stage)),
      topCompanies: [...companies]
        .map(([company, count]) => ({ company, contacts: count }))
        .sort(
          (left, right) =>
            right.contacts - left.contacts || left.company.localeCompare(right.company),
        )
        .slice(0, 5),
    };
  }

  /**
   * Source a directory contact into one event, optionally taking it straight through the
   * conversion boundary.
   *
   * The contact does not become a speaker directly. It becomes this event's prospect, and that
   * prospect converts through the existing `ARC-FLOW-003` command with the existing idempotency
   * key — so a contact pushed twice yields one prospect and one speaker, the provenance
   * `#6` shipped is unchanged, and a prospect created before the directory existed converts by
   * exactly the same path it always did.
   */
  async pushContactToEvent(
    actor: Actor | null,
    organizationId: string,
    contactId: string,
    command: { eventId: string; ownerId: string; convert: boolean },
    correlationId: string,
  ): Promise<{
    contact: Redacted<OrganizationContact, HideableContactField>;
    prospect: Prospect;
  }> {
    const authorized = await this.requireOrganization(actor, organizationId);
    // The directory grant is not a licence to write into any event: this is the same
    // event-scoped check every prospect mutation makes.
    this.authorize(authorized, command.eventId);
    await this.requireOrganizationEvent(organizationId, command.eventId);
    const contact = await this.loadContact(organizationId, contactId);
    if (contact.mergedIntoId)
      throw new ContactMergeInvalidError("A merged contact cannot be sourced; use the primary");
    await this.requireAssignableOwner(command.eventId, command.ownerId);

    const existing = contact.events.find(({ eventId }) => eventId === command.eventId);
    const now = this.dependencies.now().toISOString();
    let prospectId = existing?.prospectId;
    if (!prospectId) {
      const tracked = await this.dependencies.repository.findByPrimaryEmail(
        command.eventId,
        normalizeEmail(contact.email),
      );
      if (tracked) {
        await this.dependencies.repository.linkContactToExistingProspect({
          contact,
          prospect: tracked,
          activity: {
            id: this.dependencies.newId(),
            kind: "note",
            summary: `Already tracked on event ${command.eventId}; linked existing prospect`,
            private: false,
            occurredAt: now,
            actorId: authorized.id,
          },
        });
        prospectId = tracked.id;
      }
    }
    if (!prospectId) {
      const prospect: Prospect = {
        id: this.dependencies.newId(),
        eventId: command.eventId,
        name: contact.name,
        stage: "identified",
        ownerId: command.ownerId,
        nextAction: "Confirm interest for this event",
        nextActionAt: null,
        contacts: [
          {
            id: this.dependencies.newId(),
            name: contact.name,
            email: contact.email,
            isPrimary: true,
          },
        ],
        activities: [],
        speakerId: null,
        convertedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.dependencies.repository.linkContactToEvent({
        contact,
        prospect,
        activity: {
          id: this.dependencies.newId(),
          kind: "note",
          summary: `Sourced into event ${command.eventId}`,
          private: false,
          occurredAt: now,
          actorId: authorized.id,
        },
      });
      // The write is guarded on the contact still being live, and that check happens inside the
      // batch — so a merge landing between the read above and this write refuses the whole
      // sourcing and leaves nothing behind. Saying so here is the difference between reporting
      // the race and reporting "prospect not found", which names something the caller never
      // asked about.
      if (!(await this.dependencies.repository.findById(command.eventId, prospect.id)))
        throw new ContactMergeInvalidError(
          "This contact was merged while it was being sourced; use the primary",
        );
      prospectId = prospect.id;
    }

    const prospect = command.convert
      ? await this.convert(authorized, command.eventId, prospectId, correlationId)
      : await this.get(authorized, command.eventId, prospectId);
    // The repository makes this insert-if-absent atomic, so concurrent pushes converge here as
    // well as at the speaker-conversion boundary.
    if (command.convert && prospect.speakerId)
      await this.dependencies.repository.recordContactConversion(
        organizationId,
        contact.id,
        command.eventId,
        {
          id: this.dependencies.newId(),
          private: false,
          occurredAt: this.dependencies.now().toISOString(),
          actorId: authorized.id,
        },
      );
    return {
      contact: await this.getContact(authorized, organizationId, contactId),
      prospect,
    };
  }
}
