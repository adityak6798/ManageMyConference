import type { Actor } from "../identity/actor";
import type { IdentityDirectory } from "../identity/identity-directory";
import {
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import type { Delivery, MessageTemplate } from "../../domain/communications/delivery";
import {
  TemplatePlaceholderError,
  TemplateValueError,
  renderTemplate,
} from "../../domain/communications/template";
import {
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
} from "./errors";
import { type CommunicationsRepository, DeliveryRecoveryConflictError } from "./ports";
import type { CommunicationsEnqueue, DeliveryRequest, EnqueuedDelivery } from "./public";

export interface CommunicationsDependencies {
  repository: CommunicationsRepository;
  eventDirectory: {
    belongsToOrganization(eventId: string, organizationId: string): Promise<boolean>;
  };
  /**
   * Who an event's speakers are, answered by identity-access through its declared interface.
   * Communications never reads `event_roles`, `users` or content's `speaker_profiles`.
   *
   * Named as a `Pick` of `IdentityDirectory` rather than restated structurally, so the contract
   * that a null email means unreachable — never a guess — is documented in one place and this
   * consumer is bound to it. CRM and review reach the same interface the same way.
   *
   * Optional because a composition that exercises only the outbox has no directory to give; a
   * broadcast attempted without one is a composition bug and says so.
   */
  speakerDirectory?: Pick<IdentityDirectory, "listSpeakersForEvent">;
  newId(): string;
  now(): Date;
}

/** One speaker a broadcast would reach, or the reason it would not. */
export interface BroadcastRecipient {
  readonly userId: string;
  readonly name: string;
  /** Null when identity holds no address for this speaker; they are counted, never guessed at. */
  readonly address: string | null;
}

export interface BroadcastResult {
  /** Deliveries this send actually created. Never counts a row an earlier send already wrote. */
  readonly enqueued: number;
  /**
   * Recipients whose delivery already existed under the same key, so nothing new was queued for
   * them. Pressing Send twice on one template version reports every speaker here and none as
   * `enqueued` — the alternative is telling an organizer that mail is on its way when no row
   * was written and none ever will be.
   */
  readonly alreadySent: number;
  /** Speakers with no address. Reported so a count of 3 out of 4 is visible, not silent. */
  readonly unreachable: readonly BroadcastRecipient[];
  readonly deliveries: readonly Delivery[];
}

/**
 * The largest audience one send will attempt.
 *
 * A Worker invocation has a bounded subrequest budget. Enqueueing is one batch now, but the
 * bound keeps a pathological event from producing a batch nothing downstream can hold, and it
 * fails *before* writing anything rather than partway through.
 */
export const MAX_BROADCAST_RECIPIENTS = 500;

export {
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
} from "./errors";

const decodeCursor = (cursor: string) => {
  const separator = cursor.lastIndexOf("~");
  if (separator < 1 || separator === cursor.length - 1)
    throw new CommunicationsInputError("History cursor is malformed");
  return { createdAt: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
};

export class CommunicationsService implements CommunicationsEnqueue {
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

  /**
   * Every version of every template in the organization, by key, newest version first.
   *
   * Versions are immutable, so "editing" a template is publishing a new version and the old one
   * stays readable — a delivery sent last week names the version it used, and this is where an
   * organizer goes to read what that version actually said.
   */
  async templates(
    actor: Actor | null,
    organizationId: string,
  ): Promise<readonly MessageTemplate[]> {
    this.organization(actor, organizationId);
    return this.dependencies.repository.listTemplates(organizationId);
  }

  /** Who a broadcast would reach, for a confirmation the organizer sees before sending. */
  async recipients(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
  ): Promise<readonly BroadcastRecipient[]> {
    const authorized = this.organization(actor, organizationId);
    await this.event(authorized, eventId, organizationId);
    const directory = this.dependencies.speakerDirectory;
    if (!directory) throw new Error("Communications speaker directory is not configured");
    return (await directory.listSpeakersForEvent(eventId)).map((speaker) => ({
      userId: speaker.id,
      name: speaker.name,
      address: speaker.email,
    }));
  }

  /**
   * Send one template to every speaker on the event.
   *
   * Deliberately not a fan-out of one delivery: each speaker gets their own row, their own
   * rendered message, their own attempt history and their own retry, because "the send failed"
   * is never true of a whole audience — it is true of one address at a time.
   *
   * The idempotency key is `broadcast:{templateKey}:v{version}:{eventId}:{userId}`, so pressing
   * Send twice, or a retried request, converges on one delivery per speaker instead of mailing
   * them twice. Sending a *new version* of the same template is a different key and does send
   * again, which is the intended way to correct a message that went out wrong.
   */
  async broadcast(
    actor: Actor | null,
    input: {
      organizationId: string;
      eventId: string;
      templateKey: string;
      templateVersion?: number | undefined;
      payload?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<BroadcastResult> {
    const authorized = this.organization(actor, input.organizationId);
    await this.event(authorized, input.eventId, input.organizationId);
    const template = await this.dependencies.repository.findTemplate(
      input.organizationId,
      input.templateKey,
      input.templateVersion,
    );
    if (!template) throw new CommunicationsNotFoundError("Template version not found");
    if (template.channel !== "email")
      throw new CommunicationsInputError("Only email templates can be sent to speakers");

    const recipients = await this.recipients(actor, input.organizationId, input.eventId);
    const reachable = recipients.filter(
      (recipient): recipient is BroadcastRecipient & { address: string } =>
        recipient.address !== null,
    );
    if (reachable.length > MAX_BROADCAST_RECIPIENTS)
      throw new CommunicationsInputError(
        `This event has ${reachable.length} reachable speakers and one send is limited to ${MAX_BROADCAST_RECIPIENTS}. Sending more than that in one request risks exhausting the worker mid-send, which would queue some speakers and report failure for all of them.`,
      );

    const prepared = await Promise.all(
      reachable.map((recipient) =>
        this.prepare(
          {
            organizationId: input.organizationId,
            eventId: input.eventId,
            idempotencyKey: `broadcast:${template.key}:v${template.version}:${input.eventId}:${recipient.userId}`,
            triggerType: "speaker.invited",
            channel: "email",
            recipientRef: recipient.address,
            payload: { ...input.payload, speakerName: recipient.name },
            templateKey: template.key,
            templateVersion: template.version,
          },
          { scopeChecked: true },
        ),
      ),
    );
    // One durable round trip for the whole audience, so a large event cannot be half-sent.
    const deliveries = await this.dependencies.repository.enqueueMany(prepared);
    // A stored row keeping the id we just minted is one this send created; a row that came back
    // with a different id was already there, and saying "queued" about it would be a lie.
    const created = deliveries.filter((delivery, index) => delivery.id === prepared[index]?.id);
    return {
      enqueued: created.length,
      alreadySent: deliveries.length - created.length,
      unreachable: recipients.filter((recipient) => recipient.address === null),
      deliveries: [...deliveries],
    };
  }

  /**
   * The organizer-initiated send. Authorizes, then takes the same path a lifecycle event does.
   */
  async trigger(actor: Actor | null, input: DeliveryRequest): Promise<Delivery> {
    const authorized = this.organization(actor, input.organizationId);
    await this.event(authorized, input.eventId, input.organizationId);
    return this.dependencies.repository.enqueue(await this.prepare(input, { scopeChecked: true }));
  }

  /**
   * Enqueue on behalf of a lifecycle event, which has no request actor. See `public.ts` for why
   * this surface takes none and what still guards it.
   */
  async enqueue(request: DeliveryRequest): Promise<EnqueuedDelivery> {
    const prepared = await this.prepare(request);
    const delivery = await this.dependencies.repository.enqueue(prepared);
    return {
      id: delivery.id,
      idempotencyKey: delivery.idempotencyKey,
      state: delivery.state,
      // The stored row keeps the id of whichever enqueue wrote it, so an id that came back
      // unchanged is one this call created.
      created: delivery.id === prepared.id,
    };
  }

  /**
   * Resolve a delivery without writing it, for a caller committing it inside its own batch.
   *
   * When this key already has a delivery, that row is returned rather than a fresh one. The
   * caller is going to hold the returned id — in its own table, in an event payload — and the
   * insert it commits will not write a second row for the same key, so minting a new id here
   * would hand back a reference to a delivery that never exists. A retried publish command must
   * end up pointing at the delivery the first attempt created.
   */
  async prepareEnqueue(request: DeliveryRequest): Promise<Delivery> {
    const existing = await this.dependencies.repository.findByIdempotencyKey(
      request.organizationId,
      request.idempotencyKey,
    );
    return existing ?? this.prepare(request);
  }

  private async prepare(
    input: DeliveryRequest,
    options: { scopeChecked?: boolean } = {},
  ): Promise<Delivery> {
    if (
      !options.scopeChecked &&
      !(await this.dependencies.eventDirectory.belongsToOrganization(
        input.eventId,
        input.organizationId,
      ))
    )
      throw new CommunicationsInputError("Event does not belong to that organization");
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
    // Render once, here, so the delivery carries the message rather than the instructions for
    // reconstructing it. A projection has no template and therefore no message.
    let rendered: { subject: string | null; body: string } | null = null;
    if (template) {
      try {
        rendered = renderTemplate(template, input.payload);
      } catch (error) {
        // ERROR-INTENT: an unfilled placeholder is a caller mistake, not a server fault; it is
        // re-thrown as the domain's own input error so the transport answers 400 with the
        // offending key rather than 500.
        if (error instanceof TemplatePlaceholderError || error instanceof TemplateValueError)
          throw new CommunicationsInputError(error.message);
        throw error;
      }
    }
    const now = this.dependencies.now().toISOString();
    return {
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
      renderedSubject: rendered?.subject ?? null,
      renderedBody: rendered?.body ?? null,
      projectionVersion: input.projectionVersion ?? null,
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: now,
      leaseToken: null,
      createdAt: now,
      updatedAt: now,
    };
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
