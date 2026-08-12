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
import { parseContactCsv, type ParsedContactRow } from "../../domain/crm/contact-import";
import type { Prospect, ProspectActivity, ProspectStage } from "../../domain/crm/prospect";
import {
  type Actor,
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { AssignableOwner, IdentityDirectory } from "../identity/identity-directory";
import type { SpeakerConversionPort } from "../content/speaker-conversion";
import type { CrmRepository, ProspectFilters } from "./crm-repository";
import type { OutreachDispatchPort } from "./outreach-dispatch";
import {
  ContactEmailTakenError,
  ContactImportInvalidError,
  ContactMergeInvalidError,
  ContactNotFoundError,
  EventOutsideOrganizationError,
  OutreachRecipientsEmptyError,
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
  ProspectOwnerNotEligibleError,
  SegmentNameTakenError,
  SegmentNotFoundError,
} from "./errors";

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
  stage?: ProspectStage | undefined;
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
}

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
    const authorized = requireCapability(actor, "crm:manage");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    for (const access of authorized.eventAccess)
      if (
        access.capabilities.has("crm:manage") &&
        (await this.dependencies.events.belongsToOrganization(access.eventId, organizationId))
      )
        return authorized;
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
    this.authorize(actor, command.eventId);
    await this.requireAssignableOwner(command.eventId, command.ownerId);
    const now = this.dependencies.now().toISOString();
    const prospect: Prospect = {
      id: this.dependencies.newId(),
      eventId: command.eventId,
      name: command.name,
      stage: "identified",
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
    await this.dependencies.repository.create(prospect);
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
    // One write carries every consequence of this command. The stage transition is recorded
    // here rather than by the caller — `UpdateProspectCommand` cannot express one, and the
    // HTTP schema refuses it — so the timeline cannot disagree with the stage, and it lands
    // in the same repository call as the organizer's note.
    const activities: ProspectActivity[] = [];
    if (command.stage !== undefined && command.stage !== current.stage)
      activities.push({
        id: this.dependencies.newId(),
        kind: "stage-change",
        summary: `${current.stage} → ${command.stage}`,
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
    await this.dependencies.repository.update(updated, activities, contact);
    return updated;
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
    return this.dependencies.repository.recordConversion(eventId, prospectId, speakerId, {
      id: this.dependencies.newId(),
      kind: "conversion",
      summary: "Converted prospect to speaker",
      private: false,
      occurredAt,
      actorId: authorized.id,
    });
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
  ): Promise<{ contacts: readonly OrganizationContact[]; filters: DirectoryFilters }> {
    await this.requireOrganization(actor, organizationId);
    const filters = await this.resolveFilters(organizationId, query);
    return {
      contacts: await this.dependencies.repository.listContacts(organizationId, filters),
      filters,
    };
  }

  async getContact(
    actor: Actor | null,
    organizationId: string,
    contactId: string,
  ): Promise<OrganizationContact> {
    await this.requireOrganization(actor, organizationId);
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
      fields: input.fields ?? [],
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
    const current = await this.getContact(authorized, organizationId, contactId);
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
      fields: command.fields ?? current.fields,
      activities: [...current.activities, ...activities],
      updatedAt: now,
    };
    await this.dependencies.repository.updateContact(updated, activities);
    return updated;
  }

  /* CSV import. */

  private async classify(
    organizationId: string,
    parsed: readonly ParsedContactRow[],
  ): Promise<ImportPreview["rows"]> {
    const seen = new Map<string, number>();
    const rows: (ParsedContactRow & { action: "create" | "update" | "skip" })[] = [];
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
      const existing = errors.length
        ? null
        : await this.dependencies.repository.findContactByEmail(organizationId, row.email);
      rows.push({
        ...row,
        errors,
        action: errors.length ? "skip" : existing ? "update" : "create",
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
    /** Rows the file itself was fine with, but that this directory cannot accept as they are. */
    const refused: (ParsedContactRow & { action: "create" | "update" | "skip" })[] = [];
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
      // Classified as an update a moment ago, so it exists; a concurrent merge is the only way
      // it could not, and then the row is simply not applied rather than resurrecting a record.
      if (!existing || existing.mergedIntoId) continue;
      // The row's own values first, because a file is authoritative about what it names.
      const tags = [...new Set([...row.tags, ...existing.tags])];
      const fields = [
        ...row.fields,
        ...existing.fields.filter(({ key }) => !row.fields.some((field) => field.key === key)),
      ];
      /*
       * A union that would exceed what one contact may carry refuses the row; it does not
       * truncate it.
       *
       * Truncating looked like a cap and behaved like a delete: the sliced list is what the
       * repository writes, and the write removes every tag and field not in it, so an import
       * that merely enriched a contact silently destroyed values it never mentioned — and,
       * because the union put the stored values first, discarded the organizer's new ones
       * instead. Refusing keeps both, and says which row could not be applied.
       */
      if (tags.length > 20 || fields.length > 30) {
        refused.push({
          ...row,
          action: "skip",
          errors: [
            ...row.errors,
            tags.length > 20
              ? `Applying this row would give ${row.email} ${tags.length} tags, and a contact may carry 20.`
              : `Applying this row would give ${row.email} ${fields.length} custom fields, and a contact may carry 30.`,
          ],
        });
        continue;
      }
      updated.push({
        ...existing,
        name: row.name,
        company: row.company ?? existing.company,
        title: row.title ?? existing.title,
        // An import enriches; it never silently erases a note somebody typed here.
        notes: existing.notes ?? row.notes,
        tags,
        fields,
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
      // Rows the parser refused, plus the ones only the live directory could refuse.
      skippedCount: preview.rows.filter(({ action }) => action === "skip").length + refused.length,
      importedAt: now,
      importedBy: authorized.id,
    };
    await this.dependencies.repository.commitImport(record, created, updated);
    return {
      record,
      contacts: [...created, ...updated],
      rejected: [...preview.rows.filter(({ action }) => action === "skip"), ...refused],
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
    // Recipients and authorization only. Confirming the template would mean asking the
    // dispatcher, whose only entry point writes — see `OutreachDispatchPort`.
    const { contacts } = await this.resolveOutreach(actor, organizationId, command);
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
    const entries: { contactId: string; activity: ContactActivity }[] = [];
    for (const contact of contacts) {
      const { deliveryId } = await this.dependencies.outreach.send(
        authorized,
        this.message(organizationId, command, contact),
      );
      sent.push({ contactId: contact.id, name: contact.name, email: contact.email, deliveryId });
      entries.push({
        contactId: contact.id,
        activity: {
          id: this.dependencies.newId(),
          kind: "outreach",
          summary: `Sent "${command.templateKey}" (delivery ${deliveryId})`,
          private: false,
          occurredAt: now,
          actorId: authorized.id,
        },
      });
    }
    await this.dependencies.repository.recordContactActivities(organizationId, entries);
    return { eventId: command.eventId, templateKey: command.templateKey, sent };
  }

  /* Organization-level analytics, counted over stored rows. */

  async dashboard(actor: Actor | null, organizationId: string) {
    await this.requireOrganization(actor, organizationId);
    const [contacts, segments] = await Promise.all([
      this.dependencies.repository.listContacts(organizationId, {}),
      this.dependencies.repository.listSegments(organizationId),
    ]);
    const stages = new Map<ProspectStage, Set<string>>();
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
  ): Promise<{ contact: OrganizationContact; prospect: Prospect }> {
    const authorized = await this.requireOrganization(actor, organizationId);
    // The directory grant is not a licence to write into any event: this is the same
    // event-scoped check every prospect mutation makes.
    this.authorize(authorized, command.eventId);
    await this.requireOrganizationEvent(organizationId, command.eventId);
    const contact = await this.getContact(authorized, organizationId, contactId);
    if (contact.mergedIntoId)
      throw new ContactMergeInvalidError("A merged contact cannot be sourced; use the primary");
    await this.requireAssignableOwner(command.eventId, command.ownerId);

    const existing = contact.events.find(({ eventId }) => eventId === command.eventId);
    const now = this.dependencies.now().toISOString();
    let prospectId = existing?.prospectId;
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
    if (command.convert && prospect.speakerId && !existing?.speakerId)
      await this.dependencies.repository.recordContactActivities(organizationId, [
        {
          contactId: contact.id,
          activity: {
            id: this.dependencies.newId(),
            kind: "conversion",
            summary: `Converted to a speaker on event ${command.eventId}`,
            private: false,
            occurredAt: this.dependencies.now().toISOString(),
            actorId: authorized.id,
          },
        },
      ]);
    return {
      contact: await this.getContact(authorized, organizationId, contactId),
      prospect,
    };
  }
}
