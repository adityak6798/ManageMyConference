import type { Prospect, ProspectActivity, ProspectStage } from "../../domain/crm/prospect";
import { type Actor, requireEventCapability } from "../identity/actor";
import type { AssignableOwner, IdentityDirectory } from "../identity/identity-directory";
import type { SpeakerConversionPort } from "../content/speaker-conversion";
import type { CrmRepository, ProspectFilters } from "./crm-repository";
import {
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
  ProspectOwnerNotEligibleError,
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

// @spec PRD-CRM-001 PRD-IAM-002 ARC-FLOW-003
export class CrmService {
  constructor(
    private readonly dependencies: {
      repository: CrmRepository;
      speakerConversion: SpeakerConversionPort;
      identities: Pick<IdentityDirectory, "listAssignableOwnersForEvent">;
      newId: () => string;
      now: () => Date;
    },
  ) {}

  private authorize(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "crm:manage");
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
}
