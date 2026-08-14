import type { CrmRepository, ProspectFilters } from "../../application/crm/crm-repository";
import { ContactAlreadySourcedError, ContactNotFoundError } from "../../application/crm/errors";
import {
  type ContactActivity,
  type ContactAlias,
  type ContactImport,
  type ContactSegment,
  type DirectoryFilters,
  matchesFilters,
  type OrganizationContact,
} from "../../domain/crm/contact";
import type {
  PipelineStage,
  Prospect,
  ProspectActivity,
  ProspectContact,
  ProspectTransition,
} from "../../domain/crm/prospect";

export class MemoryCrmRepository implements CrmRepository {
  private readonly prospects = new Map<string, Prospect>();
  private readonly contacts = new Map<string, OrganizationContact>();
  private readonly segments = new Map<string, ContactSegment>();
  private readonly imports: ContactImport[] = [];
  async list(eventId: string, filters: ProspectFilters): Promise<readonly Prospect[]> {
    return [...this.prospects.values()].filter(
      (item) =>
        item.eventId === eventId &&
        (!filters.stage || item.stage === filters.stage) &&
        (!filters.ownerId || item.ownerId === filters.ownerId) &&
        (!filters.overdueBefore ||
          (!!item.nextActionAt && item.nextActionAt < filters.overdueBefore && !item.speakerId)),
    );
  }
  async findById(eventId: string, prospectId: string) {
    const item = this.prospects.get(prospectId);
    return item?.eventId === eventId ? item : null;
  }
  async findByPrimaryEmail(eventId: string, email: string) {
    const normalized = email.trim().toLowerCase();
    return (
      [...this.prospects.values()]
        .filter((prospect) => prospect.eventId === eventId)
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
        )
        .find((prospect) => {
          const primary =
            prospect.contacts.find(({ isPrimary }) => isPrimary) ?? prospect.contacts[0];
          return primary?.email.trim().toLowerCase() === normalized;
        }) ?? null
    );
  }
  async create(prospect: Prospect, transition?: ProspectTransition) {
    this.prospects.set(prospect.id, prospect);
    if (transition) this.transitions.push(transition);
  }
  /**
   * The caller hands over an already-merged prospect, so the new activities and contact are
   * carried inside it. They stay in the signature because storing the row and appending its
   * history is one write for the D1 adapter, and tests assert on what a single call received.
   */
  async update(
    prospect: Prospect,
    _activities: readonly ProspectActivity[] = [],
    _contact?: ProspectContact,
    transition?: ProspectTransition,
  ) {
    this.prospects.set(prospect.id, prospect);
    if (transition) this.transitions.push(transition);
  }
  async recordConversion(
    eventId: string,
    prospectId: string,
    speakerId: string,
    activity: ProspectActivity,
    transition?: ProspectTransition,
  ) {
    const prospect = await this.findById(eventId, prospectId);
    if (!prospect) throw new Error("Prospect not found");
    if (prospect.speakerId) return prospect;
    const converted = {
      ...prospect,
      stage: "converted" as const,
      speakerId,
      convertedAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
      activities: [...prospect.activities, activity],
    };
    this.prospects.set(prospectId, converted);
    if (transition) this.transitions.push(transition);
    return converted;
  }

  /* ------------------------------ the board itself ------------------------------ */

  private readonly stages = new Map<string, PipelineStage[]>();
  private readonly transitions: ProspectTransition[] = [];

  async listStages(eventId: string): Promise<readonly PipelineStage[]> {
    return (this.stages.get(eventId) ?? []).toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
    );
  }

  /** Mirrors D1's `INSERT OR IGNORE`: an existing key is left exactly as it is. */
  async ensureStages(eventId: string, stages: readonly PipelineStage[]) {
    const existing = this.stages.get(eventId) ?? [];
    const keys = new Set(existing.map(({ key }) => key));
    this.stages.set(eventId, [...existing, ...stages.filter(({ key }) => !keys.has(key))]);
    return this.listStages(eventId);
  }

  async saveStages(eventId: string, stages: readonly PipelineStage[]) {
    this.stages.set(eventId, [...stages]);
  }

  async countByStage(eventId: string) {
    const counts = new Map<string, number>();
    for (const prospect of this.prospects.values())
      if (prospect.eventId === eventId)
        counts.set(prospect.stage, (counts.get(prospect.stage) ?? 0) + 1);
    return counts;
  }

  async deleteStage(
    eventId: string,
    stageKey: string,
    migrateTo: string,
    transitions: readonly ProspectTransition[],
    remaining: readonly PipelineStage[],
  ) {
    const movedAt = transitions[0]?.occurredAt;
    for (const [id, prospect] of this.prospects)
      if (prospect.eventId === eventId && prospect.stage === stageKey)
        this.prospects.set(id, {
          ...prospect,
          stage: migrateTo,
          ...(movedAt ? { updatedAt: movedAt } : {}),
        });
    this.transitions.push(...transitions);
    this.stages.set(eventId, [...remaining]);
  }

  async recordTransition(transition: ProspectTransition) {
    this.transitions.push(transition);
  }

  async listTransitions(eventId: string): Promise<readonly ProspectTransition[]> {
    return this.transitions
      .filter((transition) => transition.eventId === eventId)
      .toSorted(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
      );
  }

  /* The organization-wide directory. */

  /** Event links project the prospect's live stage, exactly as the D1 adapter's join does. */
  private project(contact: OrganizationContact): OrganizationContact {
    return {
      ...contact,
      events: contact.events.map((link) => {
        const prospect = this.prospects.get(link.prospectId);
        return prospect
          ? {
              ...link,
              stage: prospect.stage,
              speakerId: prospect.speakerId,
              convertedAt: prospect.convertedAt,
            }
          : link;
      }),
    };
  }

  private ofOrganization(organizationId: string): OrganizationContact[] {
    return [...this.contacts.values()]
      .filter((contact) => contact.organizationId === organizationId)
      .map((contact) => this.project(contact))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
  }

  async listContacts(organizationId: string, filters: DirectoryFilters) {
    return this.ofOrganization(organizationId).filter((contact) =>
      matchesFilters(contact, filters),
    );
  }
  async findContact(organizationId: string, contactId: string) {
    const contact = this.contacts.get(contactId);
    return contact?.organizationId === organizationId ? this.project(contact) : null;
  }
  /** Resolves through aliases, as the D1 adapter's LEFT JOIN does. */
  async findContactByEmail(organizationId: string, email: string) {
    const live = this.ofOrganization(organizationId).filter(({ mergedIntoId }) => !mergedIntoId);
    return (
      live.find((contact) => contact.email === email) ??
      live.find((contact) => contact.aliases.some((alias) => alias.email === email)) ??
      null
    );
  }
  async findContactsByEmails(organizationId: string, emails: readonly string[]) {
    const resolved = new Map<string, OrganizationContact>();
    for (const email of emails) {
      const contact = await this.findContactByEmail(organizationId, email);
      if (contact) resolved.set(email, contact);
    }
    return resolved;
  }
  async createContact(contact: OrganizationContact) {
    this.contacts.set(contact.id, contact);
  }
  /**
   * Refuses the same writes the D1 adapter refuses.
   *
   * The guard the deployed adapter applies — this organization's, and not merged away — has to
   * exist here too, or every service-level test describes writes that production would decline
   * and only the integration suite can catch a regression in it.
   */
  async updateContact(contact: OrganizationContact, _activities: readonly ContactActivity[] = []) {
    const stored = this.contacts.get(contact.id);
    if (!stored || stored.organizationId !== contact.organizationId || stored.mergedIntoId) return;
    this.contacts.set(contact.id, contact);
  }
  async commitImport(
    record: ContactImport,
    created: readonly OrganizationContact[],
    updated: readonly OrganizationContact[],
  ) {
    this.imports.push(record);
    for (const contact of created) this.contacts.set(contact.id, contact);
    // Updated rows go through the same guard the D1 adapter applies to them, because they go
    // through the same statements there.
    for (const contact of updated) await this.updateContact(contact);
  }
  async mergeContacts(input: {
    organizationId: string;
    primaryId: string;
    duplicateIds: readonly string[];
    aliases: readonly ContactAlias[];
    activity: ContactActivity;
  }) {
    const primary = this.contacts.get(input.primaryId);
    // Liveness as well as ownership, the same predicate the D1 batch's seven statements share:
    // a merge into a primary that has itself been merged away applies nothing there.
    if (!primary || primary.organizationId !== input.organizationId || primary.mergedIntoId)
      throw new ContactNotFoundError("Contact not found");
    const moved: OrganizationContact["events"][number][] = [];
    const activities: ContactActivity[] = [];
    const tags = new Set(primary.tags);
    const fields = new Map(primary.fields.map(({ key, value }) => [key, value]));
    for (const duplicateId of input.duplicateIds) {
      const duplicate = this.contacts.get(duplicateId);
      if (!duplicate || duplicate.organizationId !== input.organizationId) continue;
      // The same-event collision the D1 adapter's `UPDATE OR IGNORE` leaves behind: the primary
      // already holds that event, so the loser's link stays on the merged-away record.
      for (const link of duplicate.events)
        if (!primary.events.some(({ eventId }) => eventId === link.eventId)) moved.push(link);
      activities.push(...duplicate.activities);
      for (const tag of duplicate.tags) tags.add(tag);
      for (const field of duplicate.fields)
        if (!fields.has(field.key)) fields.set(field.key, field.value);
      this.contacts.set(duplicateId, {
        ...duplicate,
        mergedIntoId: input.primaryId,
        events: duplicate.events.filter((link) => !moved.includes(link)),
        activities: [],
        updatedAt: input.activity.occurredAt,
      });
    }
    const merged: OrganizationContact = {
      ...primary,
      tags: [...tags],
      fields: [...fields].map(([key, value]) => ({ key, value })),
      aliases: [...primary.aliases, ...input.aliases],
      events: [...primary.events, ...moved],
      activities: [...primary.activities, ...activities, input.activity].sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      ),
      updatedAt: input.activity.occurredAt,
    };
    this.contacts.set(merged.id, merged);
    return this.project(merged);
  }
  async listSegments(organizationId: string) {
    return [...this.segments.values()]
      .filter((segment) => segment.organizationId === organizationId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  async findSegment(organizationId: string, segmentId: string) {
    const segment = this.segments.get(segmentId);
    return segment?.organizationId === organizationId ? segment : null;
  }
  async createSegment(segment: ContactSegment) {
    this.segments.set(segment.id, segment);
  }
  async listImports(organizationId: string) {
    return this.imports.filter((record) => record.organizationId === organizationId);
  }
  async recordContactActivities(
    organizationId: string,
    entries: readonly { contactId: string; activity: ContactActivity }[],
  ) {
    for (const { contactId, activity } of entries) {
      const contact = this.contacts.get(contactId);
      if (!contact || contact.organizationId !== organizationId) continue;
      // Follows the merge pointer, as the D1 adapter's `COALESCE(merged_into_id, id)` does: the
      // act being recorded already happened, so the entry lands on the survivor.
      const target = contact.mergedIntoId
        ? (this.contacts.get(contact.mergedIntoId) ?? contact)
        : contact;
      this.contacts.set(target.id, {
        ...target,
        activities: [...target.activities, activity],
      });
    }
  }
  async recordContactConversion(
    organizationId: string,
    contactId: string,
    eventId: string,
    activity: Omit<ContactActivity, "kind" | "summary">,
  ) {
    const contact = this.contacts.get(contactId);
    if (!contact || contact.organizationId !== organizationId) return;
    const target = contact.mergedIntoId
      ? (this.contacts.get(contact.mergedIntoId) ?? contact)
      : contact;
    const summary = `Converted to a speaker on event ${eventId}`;
    if (target.activities.some((entry) => entry.kind === "conversion" && entry.summary === summary))
      return;
    this.contacts.set(target.id, {
      ...target,
      activities: [...target.activities, { ...activity, kind: "conversion", summary }],
    });
  }
  async linkContactToEvent(input: {
    contact: OrganizationContact;
    prospect: Prospect;
    activity: ContactActivity;
  }) {
    const contact = this.contacts.get(input.contact.id);
    if (!contact) throw new ContactNotFoundError("Contact not found");
    this.prospects.set(input.prospect.id, input.prospect);
    this.contacts.set(contact.id, {
      ...contact,
      events: [
        ...contact.events,
        {
          eventId: input.prospect.eventId,
          prospectId: input.prospect.id,
          stage: input.prospect.stage,
          speakerId: null,
          convertedAt: null,
          linkedAt: input.activity.occurredAt,
        },
      ],
      activities: [...contact.activities, input.activity],
    });
  }
  async linkContactToExistingProspect(input: {
    contact: OrganizationContact;
    prospect: Prospect;
    activity: ContactActivity;
  }) {
    const contact = this.contacts.get(input.contact.id);
    if (!contact || contact.mergedIntoId) throw new ContactNotFoundError("Contact not found");
    if (!(await this.findById(input.prospect.eventId, input.prospect.id)))
      throw new Error("Prospect not found");
    if (
      contact.events.some(({ eventId }) => eventId === input.prospect.eventId) ||
      [...this.contacts.values()].some((stored) =>
        stored.events.some(({ prospectId }) => prospectId === input.prospect.id),
      )
    )
      throw new ContactAlreadySourcedError("This contact is already in that event's pipeline");
    this.contacts.set(contact.id, {
      ...contact,
      events: [
        ...contact.events,
        {
          eventId: input.prospect.eventId,
          prospectId: input.prospect.id,
          stage: input.prospect.stage,
          speakerId: input.prospect.speakerId,
          convertedAt: input.prospect.convertedAt,
          linkedAt: input.activity.occurredAt,
        },
      ],
      activities: [...contact.activities, input.activity],
    });
  }
}
