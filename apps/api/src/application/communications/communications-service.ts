import type { Actor } from "../identity/actor";
import type { IdentityDirectory } from "../identity/identity-directory";
import {
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import { audienceVersion } from "../../domain/communications/audience";
import {
  type Delivery,
  type MessageTemplate,
  isProjectionChannel,
  triggerAllowsChannel,
} from "../../domain/communications/delivery";
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
import {
  type CommunicationsRepository,
  DeliveryRecoveryConflictError,
  TemplateVersionTakenError,
} from "./ports";
import type {
  CalendarInviteEnqueueRequest,
  CalendarInviteEnqueueResult,
  CommunicationsEnqueue,
  DeliveryRequest,
  EnqueuedDelivery,
} from "./public";

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

/**
 * How many times an allocation will read-and-try before reporting contention.
 *
 * Five is enough to absorb a handful of organizers publishing at the same instant and few enough
 * that sustained contention surfaces as a conflict rather than a request that never returns.
 */
export const TEMPLATE_ALLOCATION_ATTEMPTS = 5;

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

  /**
   * Publish a template version.
   *
   * `version` is optional, and omitting it is the right way to use this. The console used to
   * compute the next number from the template list it last read and send it — so two organizers
   * publishing the same key at once proposed the same number, the loser's insert failed the
   * unique constraint, and the transport answered `500`. Allocation belongs on the server, next
   * to the constraint that arbitrates it.
   *
   * Allocated by attempt rather than reserved, the same shape agenda publication uses: read the
   * version in force, try to claim the next, and on losing the race read again and try the one
   * after. A read cannot reserve — two callers can read the same number — so the unique index is
   * the arbiter and the retry is the allocation loop. Exhausting the attempts is reported as a
   * conflict rather than looping, because sustained contention is something an organizer should
   * see rather than wait on.
   *
   * Naming a `version` explicitly still works and now fails honestly: a taken one is a typed
   * conflict the transport answers `409`, not a `500`.
   *
   * @spec PRD-COM-001
   */
  async createTemplate(
    actor: Actor | null,
    input: Omit<MessageTemplate, "id" | "createdAt" | "version"> & {
      version?: number | undefined;
    },
  ): Promise<MessageTemplate> {
    this.organization(actor, input.organizationId);
    const write = async (version: number) => {
      const template = {
        ...input,
        version,
        id: this.dependencies.newId(),
        createdAt: this.dependencies.now().toISOString(),
      };
      await this.dependencies.repository.createTemplate(template);
      return template;
    };
    if (input.version !== undefined) {
      try {
        return await write(input.version);
      } catch (error) {
        if (error instanceof TemplateVersionTakenError)
          throw new CommunicationsConflictError(
            `Version ${input.version} of "${input.key}" already exists. Publishing a correction means publishing the next version, because a version somebody may already have been sent cannot change.`,
          );
        throw error;
      }
    }
    for (let attempt = 0; attempt < TEMPLATE_ALLOCATION_ATTEMPTS; attempt += 1) {
      const latest = await this.dependencies.repository.latestTemplateVersion(
        input.organizationId,
        input.key,
      );
      try {
        return await write(latest + 1);
      } catch (error) {
        // ERROR-INTENT: a taken version is the ordinary outcome of two organizers publishing at
        // once, not a fault. It is absorbed here and the next number is tried; every other
        // failure propagates.
        if (!(error instanceof TemplateVersionTakenError)) throw error;
      }
    }
    throw new CommunicationsConflictError(
      "Another organizer is publishing versions of this template right now. Nothing was saved; try again in a moment.",
    );
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

  /**
   * Who a broadcast would reach, for a confirmation the organizer sees before sending.
   *
   * Issued with a version naming this exact audience. A send may carry it back, and one whose
   * audience has since changed is refused rather than reaching a different set of people than
   * the count on screen described. See `audienceVersion`.
   */
  async recipients(
    actor: Actor | null,
    organizationId: string,
    eventId: string,
  ): Promise<{ recipients: readonly BroadcastRecipient[]; audienceVersion: string }> {
    const recipients = await this.resolveRecipients(actor, organizationId, eventId);
    return { recipients, audienceVersion: audienceVersion(recipients) };
  }

  private async resolveRecipients(
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
      /**
       * The version of the audience the organizer confirmed against. Optional so an API caller
       * that never saw a count is not forced to invent one, but the console always sends it.
       */
      audienceVersion?: string | undefined;
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

    const recipients = await this.resolveRecipients(actor, input.organizationId, input.eventId);
    // Refused *before* anything is written, so a stale confirmation costs nothing and the
    // organizer re-confirms against a count that is true rather than un-sending a message.
    const current = audienceVersion(recipients);
    if (input.audienceVersion !== undefined && input.audienceVersion !== current)
      throw new CommunicationsConflictError(
        `This event's speakers changed since you confirmed: it now has ${recipients.length} ${recipients.length === 1 ? "speaker" : "speakers"}. Nothing was sent. Check the list and confirm again.`,
      );
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
          { scopeChecked: true, template },
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

  async enqueueCalendarInvite(
    request: CalendarInviteEnqueueRequest,
  ): Promise<CalendarInviteEnqueueResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.dependencies.repository.calendarInviteState(
        request.organizationId,
        request.eventId,
        request.sessionId,
        request.speakerProfileId,
      );
      if (
        current &&
        (current.scheduleRef === request.scheduleRef ||
          (!/^\d+\|/.test(current.scheduleRef) &&
            current.scheduleRef ===
              request.scheduleRef.slice(request.scheduleRef.indexOf("|") + 1))) &&
        current.recipientRef === request.recipientRef
      ) {
        const delivery = await this.dependencies.repository.get(current.deliveryId);
        if (!delivery) throw new Error("Calendar invitation state refers to no delivery");
        return {
          id: delivery.id,
          idempotencyKey: delivery.idempotencyKey,
          state: delivery.state,
          created: false,
          sequence: current.sequence,
        };
      }

      const sequence = (current?.sequence ?? -1) + 1;
      const deliveryRequest = request.deliveryFor(sequence);
      if (
        deliveryRequest.organizationId !== request.organizationId ||
        deliveryRequest.eventId !== request.eventId ||
        deliveryRequest.recipientRef !== request.recipientRef
      )
        throw new CommunicationsInputError(
          "Calendar invitation delivery does not match its durable state",
        );
      const prepared = await this.prepare(deliveryRequest);
      const stored = await this.dependencies.repository.enqueueCalendarInvite(
        prepared,
        {
          organizationId: request.organizationId,
          eventId: request.eventId,
          sessionId: request.sessionId,
          speakerProfileId: request.speakerProfileId,
          scheduleRef: request.scheduleRef,
          recipientRef: request.recipientRef,
          sequence,
          deliveryId: prepared.id,
        },
        current?.sequence ?? null,
      );
      if (stored)
        return {
          id: stored.id,
          idempotencyKey: stored.idempotencyKey,
          state: stored.state,
          created: stored.id === prepared.id,
          sequence,
        };
    }
    throw new Error("Calendar invitation state changed too often to enqueue");
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
    options: { scopeChecked?: boolean; template?: MessageTemplate } = {},
  ): Promise<Delivery> {
    if (
      !options.scopeChecked &&
      !(await this.dependencies.eventDirectory.belongsToOrganization(
        input.eventId,
        input.organizationId,
      ))
    )
      throw new CommunicationsInputError("Event does not belong to that organization");
    // A fan-out resolves its template once and passes it in: reading the same row per recipient
    // would put an avoidable query per speaker between the organizer and their send, and at a
    // large event that is what exhausts the invocation.
    const template =
      options.template ??
      (input.templateKey
        ? await this.dependencies.repository.findTemplate(
            input.organizationId,
            input.templateKey,
            input.templateVersion,
          )
        : null);
    if (input.templateKey && !template)
      throw new CommunicationsNotFoundError("Template version not found");
    // One rule, read off the trigger/channel table, replacing four conditionals that between
    // them encoded the same mapping and could not express a channel that is neither email nor a
    // projection.
    if (!triggerAllowsChannel(input.triggerType, input.channel))
      throw new CommunicationsInputError(
        `A ${input.triggerType} delivery cannot be sent over the ${input.channel} channel`,
      );
    if (input.channel === "email" && !template)
      throw new CommunicationsInputError("Email delivery requires a template");
    if (template && template.channel !== input.channel)
      throw new CommunicationsInputError("Template channel does not match delivery channel");
    if (isProjectionChannel(input.channel) && input.projectionVersion === undefined)
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
