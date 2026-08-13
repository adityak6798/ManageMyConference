/** Signed webhook administration, fan-out, egress safety, and retry processing. @spec PRD-INT-001 */
import type { Delivery } from "../../domain/communications/delivery";
import type {
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookEventType,
  WebhookPayload,
  WebhookSubscription,
} from "../../domain/communications/webhook";
import type { Actor } from "../identity/actor";
import {
  CapabilityDeniedError,
  requireCapability,
  requireEventCapability,
} from "../identity/actor";
import {
  CommunicationsConflictError,
  CommunicationsInputError,
  CommunicationsNotFoundError,
} from "./errors";
import type { DomainEventConsumer, ProviderResult } from "./ports";
import type { WebhookEgress } from "./webhook-security";

export const WEBHOOK_SECRET_OVERLAP_MS = 24 * 60 * 60_000;
export const WEBHOOK_MAX_ATTEMPTS = 3;
const webhookRetryDelayMs = (attempt: number) =>
  Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
export interface WebhookIdempotencyWrite {
  organizationId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  response: unknown;
  createdAt: string;
}
export interface WebhookCreateResult {
  subscription: WebhookSubscription;
  secret: string;
}
export interface WebhookRotateResult {
  secret: string;
  overlapExpiresAt: string;
}

export interface WebhookRepository {
  create(subscription: WebhookSubscription, idempotency: WebhookIdempotencyWrite): Promise<void>;
  list(organizationId: string): Promise<readonly WebhookSubscription[]>;
  get(subscriptionId: string): Promise<WebhookSubscription | null>;
  update(
    input: {
      organizationId: string;
      subscriptionId: string;
      expectedRevision: number;
      url?: string;
      eventId?: string | null;
      eventTypes?: readonly WebhookEventType[];
    },
    idempotency: WebhookIdempotencyWrite,
  ): Promise<number>;
  disable(
    organizationId: string,
    subscriptionId: string,
    now: string,
    reason: string,
    idempotency: WebhookIdempotencyWrite,
  ): Promise<number>;
  rotate(
    organizationId: string,
    subscriptionId: string,
    secretMaterial: string,
    overlapExpiresAt: string,
    expectedRevision: number,
    idempotency: WebhookIdempotencyWrite,
  ): Promise<number>;
  activeFor(
    eventType: WebhookEventType,
    organizationId: string,
    eventId: string,
  ): Promise<readonly WebhookSubscription[]>;
  enqueue(delivery: WebhookDelivery): Promise<WebhookDelivery>;
  getDelivery(deliveryId: string): Promise<WebhookDelivery | null>;
  historyPage(
    subscriptionId: string,
    page: { limit: number; after?: { createdAt: string; id: string } },
  ): Promise<{
    items: readonly { delivery: WebhookDelivery; attempts: readonly WebhookDeliveryAttempt[] }[];
    hasMore: boolean;
  }>;
  leaseNext(now: string, leaseToken: string): Promise<WebhookDelivery | null>;
  complete(
    leaseToken: string,
    attempt: WebhookDeliveryAttempt,
    next: Pick<WebhookDelivery, "state" | "nextAttemptAt" | "updatedAt">,
  ): Promise<void>;
  replay(
    deliveryId: string,
    organizationId: string,
    actorId: string,
    now: string,
    attemptId: string,
    idempotency: WebhookIdempotencyWrite,
  ): Promise<number>;
  idempotencyRecord(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<{ operation: string; requestHash: string; response: unknown } | null>;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export const mintWebhookSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes);
};

const isUnsafeIpv4 = (host: string): boolean => {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

export const validateWebhookUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommunicationsInputError("Webhook URL is malformed");
  }
  if (url.protocol !== "https:") throw new CommunicationsInputError("Webhook URL must use HTTPS");
  if (url.username || url.password)
    throw new CommunicationsInputError("Webhook URL must not contain credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv6 = host.includes(":");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".test") ||
    isUnsafeIpv4(host) ||
    host === "::" ||
    host === "::1" ||
    (ipv6 &&
      (host.startsWith("fc") ||
        host.startsWith("fd") ||
        /^fe[89ab]/.test(host) ||
        host.startsWith("ff"))) ||
    host.startsWith("::ffff:")
  )
    throw new CommunicationsInputError("Webhook URL resolves to a non-public host");
  url.hash = "";
  return url.toString();
};

const encodeCursor = ({ createdAt, id }: { createdAt: string; id: string }) => `${createdAt}~${id}`;
const decodeCursor = (cursor: string) => {
  const at = cursor.lastIndexOf("~");
  if (at < 1 || at === cursor.length - 1)
    throw new CommunicationsInputError("Webhook history cursor is malformed");
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
};
const mutationHash = async (operation: string, request: unknown): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ operation, request })),
      ),
    ),
  );

export class WebhookService {
  constructor(
    private readonly dependencies: {
      repository: WebhookRepository;
      eventDirectory: {
        belongsToOrganization(eventId: string, organizationId: string): Promise<boolean>;
        listEventIdsForOrganization(organizationId: string): Promise<readonly string[]>;
      };
      egress: WebhookEgress;
      newId(): string;
      now(): Date;
    },
  ) {}
  private async organization(actor: Actor | null, organizationId: string): Promise<Actor> {
    const authorized = requireCapability(actor, "communications:manage");
    if (!authorized.organizations.some(({ id }) => id === organizationId))
      throw new CapabilityDeniedError("Organization access denied");
    const organizationEvents = new Set(
      await this.dependencies.eventDirectory.listEventIdsForOrganization(organizationId),
    );
    if (
      !authorized.eventAccess.some(
        ({ eventId, capabilities }) =>
          organizationEvents.has(eventId) && capabilities.has("communications:manage"),
      )
    )
      throw new CapabilityDeniedError("Actor lacks communications:manage inside this organization");
    return authorized;
  }
  private async event(actor: Actor, organizationId: string, eventId: string | null): Promise<void> {
    if (!eventId) return;
    requireEventCapability(actor, eventId, "communications:manage");
    if (!(await this.dependencies.eventDirectory.belongsToOrganization(eventId, organizationId)))
      throw new CapabilityDeniedError("Event organization access denied");
  }
  private async idempotent<T>(
    organizationId: string,
    idempotencyKey: string,
    operation: "create" | "update" | "disable" | "rotate" | "replay",
    request: unknown,
    action: (record: (response: T) => WebhookIdempotencyWrite) => Promise<T>,
  ): Promise<T> {
    const requestHash = await mutationHash(operation, request);
    const existing = await this.dependencies.repository.idempotencyRecord(
      organizationId,
      idempotencyKey,
    );
    if (existing) {
      if (existing.operation !== operation || existing.requestHash !== requestHash)
        throw new CommunicationsConflictError(
          "Idempotency-Key was already used for a different webhook mutation",
        );
      return existing.response as T;
    }
    try {
      return await action((response) => ({
        organizationId,
        idempotencyKey,
        operation,
        requestHash,
        response,
        createdAt: this.dependencies.now().toISOString(),
      }));
    } catch (error) {
      // A competing request can commit this key after the read above but before our atomic
      // mutation. Its uniqueness failure is a successful retry only when the durable record
      // proves both operation and request bytes agree; every other storage error is rethrown.
      const raced = await this.dependencies.repository.idempotencyRecord(
        organizationId,
        idempotencyKey,
      );
      if (!raced) throw error;
      if (raced.operation !== operation || raced.requestHash !== requestHash)
        throw new CommunicationsConflictError(
          "Idempotency-Key was already used for a different webhook mutation",
        );
      return raced.response as T;
    }
  }
  async create(
    actor: Actor | null,
    input: {
      organizationId: string;
      eventId?: string | null;
      url: string;
      eventTypes: readonly WebhookEventType[];
    },
    idempotencyKey: string,
  ): Promise<WebhookCreateResult> {
    const authorized = await this.organization(actor, input.organizationId);
    await this.event(authorized, input.organizationId, input.eventId ?? null);
    const normalized = {
      eventId: input.eventId ?? null,
      url: validateWebhookUrl(input.url),
      eventTypes: [...new Set(input.eventTypes)].sort(),
    };
    return this.idempotent(
      input.organizationId,
      idempotencyKey,
      "create",
      normalized,
      async (record) => {
        await this.dependencies.egress.validate(normalized.url);
        const secret = mintWebhookSecret();
        const subscription: WebhookSubscription = {
          id: this.dependencies.newId(),
          organizationId: input.organizationId,
          eventId: normalized.eventId,
          url: normalized.url,
          secretMaterial: secret,
          previousSecretMaterial: null,
          previousSecretExpiresAt: null,
          eventTypes: normalized.eventTypes,
          state: "active",
          createdAt: this.dependencies.now().toISOString(),
          disabledAt: null,
          disabledReason: null,
          revision: 0,
        };
        const response = { subscription, secret };
        await this.dependencies.repository.create(subscription, record(response));
        return response;
      },
    );
  }
  async list(actor: Actor | null, organizationId: string) {
    await this.organization(actor, organizationId);
    return this.dependencies.repository.list(organizationId);
  }
  async update(
    actor: Actor | null,
    organizationId: string,
    subscriptionId: string,
    input: { url?: string; eventId?: string | null; eventTypes?: readonly WebhookEventType[] },
    idempotencyKey: string,
  ): Promise<WebhookSubscription> {
    const authorized = await this.organization(actor, organizationId);
    if (input.eventId !== undefined) await this.event(authorized, organizationId, input.eventId);
    const normalizedInput = {
      ...input,
      ...(input.url === undefined ? {} : { url: validateWebhookUrl(input.url) }),
      ...(input.eventTypes === undefined
        ? {}
        : { eventTypes: [...new Set(input.eventTypes)].sort() }),
    };
    return this.idempotent(
      organizationId,
      idempotencyKey,
      "update",
      { subscriptionId, input: normalizedInput },
      async (record) => {
        if (normalizedInput.url !== undefined)
          await this.dependencies.egress.validate(normalizedInput.url);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const current = await this.dependencies.repository.get(subscriptionId);
          if (!current || current.organizationId !== organizationId || current.state !== "active")
            throw new CommunicationsNotFoundError("Webhook subscription not found");
          const result: WebhookSubscription = {
            ...current,
            revision: current.revision + 1,
            ...(normalizedInput.url === undefined ? {} : { url: normalizedInput.url }),
            ...(normalizedInput.eventId === undefined ? {} : { eventId: normalizedInput.eventId }),
            ...(normalizedInput.eventTypes === undefined
              ? {}
              : { eventTypes: normalizedInput.eventTypes }),
          };
          const changed = await this.dependencies.repository.update(
            {
              organizationId,
              subscriptionId,
              expectedRevision: current.revision,
              ...normalizedInput,
            },
            record(result),
          );
          if (changed) return result;
        }
        throw new CommunicationsConflictError("Webhook subscription changed; retry the update");
      },
    );
  }
  async disable(
    actor: Actor | null,
    organizationId: string,
    subscriptionId: string,
    idempotencyKey: string,
  ): Promise<null> {
    await this.organization(actor, organizationId);
    return this.idempotent(
      organizationId,
      idempotencyKey,
      "disable",
      { subscriptionId },
      async (record) => {
        if (
          !(await this.dependencies.repository.disable(
            organizationId,
            subscriptionId,
            this.dependencies.now().toISOString(),
            "disabled_by_user",
            record(null),
          ))
        )
          throw new CommunicationsConflictError(
            "Webhook subscription is missing or already disabled",
          );
        return null;
      },
    );
  }
  async rotate(
    actor: Actor | null,
    organizationId: string,
    subscriptionId: string,
    idempotencyKey: string,
  ): Promise<WebhookRotateResult> {
    await this.organization(actor, organizationId);
    return this.idempotent(
      organizationId,
      idempotencyKey,
      "rotate",
      { subscriptionId },
      async (record) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const current = await this.dependencies.repository.get(subscriptionId);
          if (!current || current.organizationId !== organizationId || current.state !== "active")
            throw new CommunicationsNotFoundError("Active webhook subscription not found");
          const secret = mintWebhookSecret();
          const overlapExpiresAt = new Date(
            this.dependencies.now().getTime() + WEBHOOK_SECRET_OVERLAP_MS,
          ).toISOString();
          const response = { secret, overlapExpiresAt };
          if (
            await this.dependencies.repository.rotate(
              organizationId,
              subscriptionId,
              secret,
              overlapExpiresAt,
              current.revision,
              record(response),
            )
          )
            return response;
        }
        throw new CommunicationsConflictError("Webhook subscription changed; retry rotation");
      },
    );
  }
  async history(
    actor: Actor | null,
    organizationId: string,
    subscriptionId: string,
    page: { limit: number; cursor?: string },
  ) {
    await this.organization(actor, organizationId);
    const subscription = await this.dependencies.repository.get(subscriptionId);
    if (!subscription || subscription.organizationId !== organizationId)
      throw new CommunicationsNotFoundError("Webhook subscription not found");
    const found = await this.dependencies.repository.historyPage(subscriptionId, {
      limit: page.limit,
      ...(page.cursor ? { after: decodeCursor(page.cursor) } : {}),
    });
    const last = found.items.at(-1)?.delivery;
    return { history: found.items, nextCursor: found.hasMore && last ? encodeCursor(last) : null };
  }
  async replay(
    actor: Actor | null,
    organizationId: string,
    deliveryId: string,
    idempotencyKey: string,
  ): Promise<WebhookDelivery> {
    const authorized = await this.organization(actor, organizationId);
    return this.idempotent(
      organizationId,
      idempotencyKey,
      "replay",
      { deliveryId },
      async (record) => {
        const current = await this.dependencies.repository.getDelivery(deliveryId);
        if (!current || current.organizationId !== organizationId)
          throw new CommunicationsConflictError(
            "Webhook delivery is missing or cannot be replayed",
          );
        const now = this.dependencies.now().toISOString();
        const result: WebhookDelivery = {
          ...current,
          state: "queued",
          attemptCount: current.attemptCount + 1,
          nextAttemptAt: now,
          updatedAt: now,
        };
        if (
          !(await this.dependencies.repository.replay(
            deliveryId,
            organizationId,
            authorized.id,
            now,
            this.dependencies.newId(),
            record(result),
          ))
        )
          throw new CommunicationsConflictError(
            "Webhook delivery is missing or cannot be replayed",
          );
        return result;
      },
    );
  }
}

export class WebhookFanoutConsumer implements DomainEventConsumer {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly newId: () => string,
    private readonly now: () => Date,
  ) {}
  async consume(event: Delivery): Promise<ProviderResult> {
    if (event.triggerType !== "schedule.published")
      return { kind: "terminal", code: "UNSUPPORTED_WEBHOOK_EVENT" };
    const publicationVersion = event.payload.publicationVersion;
    if (
      typeof publicationVersion !== "number" ||
      !Number.isInteger(publicationVersion) ||
      publicationVersion < 1
    )
      return { kind: "terminal", code: "EVENT_PAYLOAD_INVALID" };
    const subscriptions = await this.repository.activeFor(
      "schedule.published",
      event.organizationId,
      event.eventId,
    );
    for (const subscription of subscriptions) {
      const timestamp = this.now().toISOString();
      const payload: WebhookPayload = {
        id: event.id,
        type: "schedule.published",
        version: 1,
        occurredAt: event.createdAt,
        organizationId: event.organizationId,
        eventId: event.eventId,
        data: { publicationVersion },
      };
      await this.repository.enqueue({
        id: this.newId(),
        subscriptionId: subscription.id,
        organizationId: event.organizationId,
        eventId: event.eventId,
        eventRecordId: event.id,
        eventType: "schedule.published",
        idempotencyKey: event.id,
        payload,
        state: "queued",
        attemptCount: 0,
        nextAttemptAt: timestamp,
        leaseToken: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    return { kind: "success", providerReference: `webhooks:enqueued=${subscriptions.length}` };
  }
}

const hmac = async (secret: string, input: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))),
  );
};
export async function webhookSignature(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  return hmac(secret, `${timestamp}.${body}`);
}
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  windowSeconds = 300,
): Promise<boolean> {
  const timestamp = Number(header.match(/(?:^|,)t=(\d+)/)?.[1]);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > windowSeconds)
    return false;
  const expected = await webhookSignature(secret, body, timestamp);
  const supplied = [...header.matchAll(/(?:^|,)v1=([a-f0-9]{64})/g)]
    .map((match) => match[1])
    .filter((candidate): candidate is string => candidate !== undefined);
  return supplied.some((candidate) => {
    if (candidate.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1)
      difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
    return difference === 0;
  });
}

export class WebhookWorker {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly dependencies: {
      newId(): string;
      now(): Date;
      timeoutMs?: number;
      egress: WebhookEgress;
    },
  ) {}
  async runOne(): Promise<boolean> {
    const now = this.dependencies.now();
    const lease = this.dependencies.newId();
    const delivery = await this.repository.leaseNext(now.toISOString(), lease);
    if (!delivery) return false;
    const subscription = await this.repository.get(delivery.subscriptionId);
    let result: ProviderResult;
    if (subscription?.state !== "active")
      result = { kind: "terminal", code: "SUBSCRIPTION_DISABLED" };
    else {
      try {
        validateWebhookUrl(subscription.url);
        const body = JSON.stringify(delivery.payload);
        const timestamp = Math.floor(now.getTime() / 1000);
        const signatures = [await webhookSignature(subscription.secretMaterial, body, timestamp)];
        if (
          subscription.previousSecretMaterial &&
          subscription.previousSecretExpiresAt &&
          subscription.previousSecretExpiresAt > now.toISOString()
        )
          signatures.push(
            await webhookSignature(subscription.previousSecretMaterial, body, timestamp),
          );
        const response = await this.dependencies.egress.dispatch({
          url: subscription.url,
          timeoutMs: this.dependencies.timeoutMs ?? 10_000,
          headers: {
            "content-type": "application/json",
            "Greenroom-Signature": `t=${timestamp},${signatures.map((value) => `v1=${value}`).join(",")}`,
            "Greenroom-Event-Id": delivery.eventRecordId,
            "Greenroom-Event-Type": delivery.eventType,
            "Greenroom-Delivery-Id": delivery.id,
            "x-correlation-id": delivery.eventRecordId,
          },
          body,
        });
        result =
          response.kind === "delivered"
            ? { kind: "success", providerReference: `webhook:${response.targetStatus}` }
            : { kind: response.kind, code: response.code };
      } catch (error) {
        // ERROR-INTENT: the exception becomes a normalized durable attempt below. Provider and
        // network text is deliberately discarded because it can echo credentials or content.
        result =
          error instanceof CommunicationsInputError
            ? { kind: "terminal", code: "WEBHOOK_DESTINATION_UNSAFE" }
            : {
                kind: "retryable",
                code:
                  error instanceof DOMException && error.name === "TimeoutError"
                    ? "WEBHOOK_TIMEOUT"
                    : "WEBHOOK_UNREACHABLE",
              };
      }
    }
    const sequence = delivery.attemptCount + 1;
    const exhausted = result.kind === "retryable" && sequence >= WEBHOOK_MAX_ATTEMPTS;
    const completedAt = this.dependencies.now().toISOString();
    const state =
      result.kind === "success"
        ? "succeeded"
        : result.kind === "terminal" || exhausted
          ? "terminal"
          : "retrying";
    await this.repository.complete(
      lease,
      {
        id: this.dependencies.newId(),
        deliveryId: delivery.id,
        sequence,
        startedAt: now.toISOString(),
        completedAt,
        outcome:
          result.kind === "success"
            ? "succeeded"
            : state === "terminal"
              ? "terminal_failure"
              : "retryable_failure",
        errorCode:
          result.kind === "success"
            ? null
            : exhausted
              ? `RETRY_EXHAUSTED:${result.code}`
              : result.code,
        requestedBy: null,
      },
      {
        state,
        nextAttemptAt:
          state === "retrying"
            ? new Date(
                this.dependencies.now().getTime() + webhookRetryDelayMs(sequence),
              ).toISOString()
            : completedAt,
        updatedAt: completedAt,
      },
    );
    return true;
  }
}

export class FanoutDomainEventConsumer implements DomainEventConsumer {
  constructor(private readonly consumers: readonly DomainEventConsumer[]) {}
  async consume(delivery: Delivery): Promise<ProviderResult> {
    const results: ProviderResult[] = [];
    for (const consumer of this.consumers) {
      try {
        results.push(await consumer.consume(delivery));
      } catch {
        // ERROR-INTENT: a consumer exception is represented by the composite's retryable verdict;
        // the parent outbox persists that normalized attempt and retries every idempotent half.
        results.push({ kind: "retryable", code: "DOMAIN_EVENT_CONSUMER_FAILED" });
      }
    }
    const terminal = results.find((result) => result.kind === "terminal");
    if (terminal) return terminal;
    const retryable = results.find((result) => result.kind === "retryable");
    if (retryable) return retryable;
    return {
      kind: "success",
      providerReference: results
        .map((result) => (result.kind === "success" ? result.providerReference : ""))
        .join(";"),
    };
  }
}
