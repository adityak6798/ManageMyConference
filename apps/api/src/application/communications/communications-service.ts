import type { Actor } from "../identity/actor";
import { CapabilityDeniedError, requireCapability } from "../identity/actor";
import type {
  Delivery,
  DeliveryChannel,
  MessageTemplate,
  TriggerType,
} from "../../domain/communications/delivery";
import type { CommunicationsRepository } from "./ports";

export interface CommunicationsDependencies {
  repository: CommunicationsRepository;
  newId(): string;
  now(): Date;
}

export class CommunicationsService {
  constructor(private readonly dependencies: CommunicationsDependencies) {}

  private organization(actor: Actor | null, organizationId: string): Actor {
    const authorized = requireCapability(actor, "communications:manage");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    return authorized;
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
    this.organization(actor, input.organizationId);
    const template = input.templateKey
      ? await this.dependencies.repository.findTemplate(
          input.organizationId,
          input.templateKey,
          input.templateVersion,
        )
      : null;
    if (input.templateKey && !template) throw new Error("Template version not found");
    if (input.channel === "email" && !template)
      throw new Error("Email delivery requires a template");
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

  async history(actor: Actor | null, organizationId: string, eventId: string) {
    this.organization(actor, organizationId);
    const deliveries = await this.dependencies.repository.list(organizationId, eventId);
    return Promise.all(
      deliveries.map(async (delivery) => ({
        delivery,
        attempts: await this.dependencies.repository.attempts(delivery.id),
      })),
    );
  }

  async retry(actor: Actor | null, organizationId: string, deliveryId: string) {
    this.organization(actor, organizationId);
    return this.dependencies.repository.retry(
      deliveryId,
      organizationId,
      this.dependencies.now().toISOString(),
    );
  }
}
