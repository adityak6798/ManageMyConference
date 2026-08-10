import type { Prospect, ProspectActivity, ProspectStage } from "../../domain/crm/prospect";
import { type Actor, CapabilityDeniedError, requireCapability } from "../identity/actor";
import type { SpeakerConversionPort } from "../content/speaker-conversion";
import type { CrmRepository, ProspectFilters } from "./crm-repository";
import {
  ProspectAlreadyConvertedError,
  ProspectContactRequiredError,
  ProspectNotFoundError,
} from "./errors";

export interface CreateProspectCommand {
  eventId: string;
  name: string;
  ownerId: string;
  nextAction?: string | undefined;
  nextActionAt?: string | undefined;
  contact: { name: string; email: string };
}
export interface UpdateProspectCommand {
  stage?: ProspectStage | undefined;
  ownerId?: string | undefined;
  nextAction?: string | null | undefined;
  nextActionAt?: string | null | undefined;
  activity?: { kind: ProspectActivity["kind"]; summary: string; private: boolean } | undefined;
  contact?: { name: string; email: string; isPrimary: boolean } | undefined;
}

// @spec PRD-CRM-001 ARC-FLOW-003
export class CrmService {
  constructor(
    private readonly dependencies: {
      repository: CrmRepository;
      speakerConversion: SpeakerConversionPort;
      newId: () => string;
      now: () => Date;
    },
  ) {}

  private authorize(actor: Actor | null, eventId: string): Actor {
    const authorized = requireCapability(actor, "crm:manage");
    const event = authorized.eventAccess.find(({ eventId: assigned }) => assigned === eventId);
    if (!event?.capabilities.has("crm:manage"))
      throw new CapabilityDeniedError("Event CRM access denied");
    return authorized;
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
    const now = this.dependencies.now().toISOString();
    const activity = command.activity
      ? {
          id: this.dependencies.newId(),
          ...command.activity,
          occurredAt: now,
          actorId: authorized.id,
        }
      : undefined;
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
      activities: activity ? [...current.activities, activity] : current.activities,
      contacts: contact
        ? [
            ...current.contacts.map((item) =>
              contact.isPrimary ? { ...item, isPrimary: false } : item,
            ),
            contact,
          ]
        : current.contacts,
    };
    await this.dependencies.repository.update(updated, activity, contact);
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
