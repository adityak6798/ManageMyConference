import type { Actor } from "../identity/actor";
import {
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type {
  Delivery,
  DeliveryChannel,
  MessageTemplate,
  TriggerType,
} from "../../domain/communications/delivery";
import { type CommunicationsRepository, DeliveryRecoveryConflictError } from "./ports";

export interface CommunicationsDependencies {
  repository: CommunicationsRepository;
  eventDirectory: {
    belongsToOrganization(eventId: string, organizationId: string): Promise<boolean>;
  };
  newId(): string;
  now(): Date;
}

export class CommunicationsInputError extends Error {}
export class CommunicationsNotFoundError extends Error {}
export class CommunicationsConflictError extends Error {}

const decodeCursor = (cursor: string) => {
  const separator = cursor.lastIndexOf("~");
  if (separator < 1 || separator === cursor.length - 1)
    throw new CommunicationsInputError("History cursor is malformed");
  return { createdAt: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
};

export class CommunicationsService {
  constructor(private readonly dependencies: CommunicationsDependencies) {}

  private organization(actor: Actor | null, organizationId: string): Actor {
    const authorized = requireCapability(actor, "communications:manage");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    return authorized;
  }

  private async event(actor: Actor, eventId: string, organizationId: string): Promise<void> {
    requireEventCapability(actor, eventId, "communications:manage");
    if (!(await this.dependencies.eventDirectory.belongsToOrganization(eventId, organizationId)))
      throw new CapabilityDeniedError("Event organization access denied");
  }

  // @spec PRD-COM-001
  async createTemplate(
    actor: Actor | null,
    input: Omit<MessageTemplate, "id" | "createdAt">,
  ): Promise<MessageTemplate> {
    this.organization(actor, input.organizationId);
    const template = {
      ...input,
      id: this.dependencies.newId(),
      createdAt: this.dependencies.now().toISOString(),
    };
    await this.dependencies.repository.createTemplate(template);
    return template;
  }

  async trigger(
    actor: Actor | null,
    input: {
      organizationId: string;
      eventId: string;
      idempotencyKey: string;
      triggerType: TriggerType;
      channel: DeliveryChannel;
      recipientRef: string;
      payload: Readonly<Record<string, unknown>>;
      templateKey?: string | undefined;
      templateVersion?: number | undefined;
      projectionVersion?: number | undefined;
    },
  ): Promise<Delivery> {
    const authorized = this.organization(actor, input.organizationId);
    await this.event(authorized, input.eventId, input.organizationId);
    const template = input.templateKey
      ? await this.dependencies.repository.findTemplate(
          input.organizationId,
          input.templateKey,
          input.templateVersion,
        )
      : null;
    if (input.templateKey && !template)
      throw new CommunicationsNotFoundError("Template version not found");
    if (input.channel === "email" && !template)
      throw new CommunicationsInputError("Email delivery requires a template");
    if (template && template.channel !== input.channel)
      throw new CommunicationsInputError("Template channel does not match delivery channel");
    if (input.channel === "email" && input.triggerType === "projection.requested")
      throw new CommunicationsInputError("Projection triggers require a projection provider");
    if (input.channel !== "email" && input.triggerType !== "projection.requested")
      throw new CommunicationsInputError("Projection providers require a projection trigger");
    if (input.channel !== "email" && input.projectionVersion === undefined)
      throw new CommunicationsInputError("Projection delivery requires a version");
    const now = this.dependencies.now().toISOString();
    return this.dependencies.repository.enqueue({
      id: this.dependencies.newId(),
      organizationId: input.organizationId,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      triggerType: input.triggerType,
      channel: input.channel,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? null,
      recipientRef: input.recipientRef,
      payload: input.payload,
      projectionVersion: input.projectionVersion ?? null,
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: now,
      leaseToken: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async history(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
    page: { limit: number; cursor?: string | undefined },
  ) {
    const authorized = this.organization(actor, organizationId);
    await this.event(authorized, eventId, organizationId);
    const result = await this.dependencies.repository.historyPage(organizationId, eventId, {
      limit: page.limit,
      ...(page.cursor ? { after: decodeCursor(page.cursor) } : {}),
    });
    const last = result.items.at(-1)?.delivery;
    return {
      history: result.items,
      nextCursor: result.hasMore && last ? `${last.createdAt}~${last.id}` : null,
    };
  }

  async retry(actor: Actor | null, organizationId: string, deliveryId: string) {
    const authorized = this.organization(actor, organizationId);
    const delivery = await this.dependencies.repository.get(deliveryId);
    if (!delivery || delivery.organizationId !== organizationId)
      throw new CommunicationsNotFoundError("Delivery not found");
    await this.event(authorized, delivery.eventId, organizationId);
    if (delivery.leaseToken)
      throw new CommunicationsConflictError("Delivery is currently being processed");
    if (delivery.state !== "retrying" && delivery.state !== "terminal")
      throw new CommunicationsConflictError("Delivery is not recoverable");
    try {
      return await this.dependencies.repository.retry(
        deliveryId,
        organizationId,
        this.dependencies.now().toISOString(),
      );
    } catch (error) {
      if (error instanceof DeliveryRecoveryConflictError)
        throw new CommunicationsConflictError(
          "Delivery recovery conflicted with worker processing",
        );
      throw error;
    }
  }
}
