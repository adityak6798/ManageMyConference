// @acceptance ACC-INTEGRATION
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1AgendaRepository } from "../src/adapters/persistence/d1-agenda-repository";
import { D1WebhookRepository } from "../src/adapters/persistence/d1-webhooks";
import { AgendaService } from "../src/application/agenda/agenda-service";
import {
  WebhookFanoutConsumer,
  WebhookService,
  WebhookWorker,
  verifyWebhookSignature,
} from "../src/application/communications/webhooks";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import type { Actor } from "../src/application/identity/actor";
import { EventService } from "../src/application/events/event-service";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { createHttpAppFrom } from "../src/transport/http/app";
import { memorySessionStore } from "./support/memory-session-store";
import { createUserSession } from "../src/application/identity/real-auth";
import type { Delivery } from "../src/domain/communications/delivery";
import type { SchedulePublishedEvent } from "../src/domain/agenda/agenda";
import { createMigratedDatabase } from "./support/seeded-d1";
import type {
  WebhookEgress,
  WebhookEgressRequest,
  WebhookEgressResult,
} from "../src/application/communications/webhook-security";
import { AesGcmWebhookSecretProtector } from "../src/adapters/persistence/webhook-secret-protector";
import { drainOutbox, type Environment } from "../src/index";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const actor: Actor = {
  id: "seed-organizer",
  name: "Olivia Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  capabilities: new Set(["communications:manage", "agenda:manage"]),
  eventAccess: [
    {
      eventId,
      role: "organizer",
      capabilities: new Set(["communications:manage", "agenda:manage"]),
    },
  ],
};
const apiClientActor: Actor = {
  ...actor,
  id: "api-client-webhook-fixture",
  name: "Webhook API client",
};
const wrappingKeyring = JSON.stringify({
  "test-v1": btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
});
const wrappingKeys = async () =>
  AesGcmWebhookSecretProtector.fromConfiguration({
    currentVersion: "test-v1",
    keyringJson: wrappingKeyring,
  });
class FixtureEgress implements WebhookEgress {
  readonly validations: string[] = [];
  readonly requests: WebhookEgressRequest[] = [];
  next: WebhookEgressResult = { kind: "delivered", targetStatus: 204 };
  async validate(url: string) {
    this.validations.push(url);
  }
  async dispatch(request: WebhookEgressRequest) {
    this.requests.push(request);
    return this.next;
  }
}

describe("signed webhook D1 lifecycle", () => {
  let runtime: Miniflare | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    const current = runtime;
    runtime = undefined;
    await current?.dispose();
  });

  it("subscribes, fans out idempotently, retries a signed request, rejects replay/tampering, and audits manual replay", async () => {
    const migrated = await createMigratedDatabase({ label: "webhooks", seed: true });
    runtime = migrated.runtime;
    const repository = new D1WebhookRepository(migrated.database, await wrappingKeys());
    const egress = new FixtureEgress();
    let id = 0;
    let clock = new Date("2026-08-13T12:00:00.000Z");
    const service = new WebhookService({
      repository,
      eventDirectory: {
        belongsToOrganization: async (candidate, organization) =>
          candidate === eventId && organization === organizationId,
        listEventIdsForOrganization: async () => [eventId],
      },
      egress,
      newId: () => `webhook-${++id}`,
      now: () => clock,
    });
    const created = await service.create(
      actor,
      {
        organizationId,
        eventId,
        url: "https://receiver.example.com/hooks/greenroom",
        eventTypes: ["schedule.published"],
      },
      "create-key",
    );
    const storedSecrets = await migrated.database
      .prepare(
        "SELECT secret_envelope, previous_secret_envelope FROM webhook_subscriptions WHERE id = ?",
      )
      .bind(created.subscription.id)
      .all<{ secret_envelope: string; previous_secret_envelope: string | null }>();
    expect(storedSecrets.results?.[0]?.secret_envelope).not.toContain(created.secret);
    expect(storedSecrets.results?.[0]?.previous_secret_envelope).toBeNull();
    const storedIdempotency = await migrated.database
      .prepare(
        "SELECT response_envelope FROM webhook_idempotency_records WHERE organization_id = ? AND idempotency_key = ?",
      )
      .bind(organizationId, "create-key")
      .all<{ response_envelope: string }>();
    expect(storedIdempotency.results?.[0]?.response_envelope).not.toContain(created.secret);
    await expect(
      service.create(
        actor,
        {
          organizationId,
          eventId,
          url: "https://receiver.example.com/hooks/greenroom",
          eventTypes: ["schedule.published"],
        },
        "create-key",
      ),
    ).resolves.toEqual(created);
    await expect(
      service.create(
        actor,
        {
          organizationId,
          eventId,
          url: "https://receiver.example.com/hooks/greenroom",
          eventTypes: ["schedule.published", "schedule.published"],
        },
        "create-key",
      ),
    ).resolves.toEqual(created);
    await expect(
      service.create(
        actor,
        {
          organizationId,
          eventId,
          url: "https://different.example.com/hook",
          eventTypes: ["schedule.published"],
        },
        "create-key",
      ),
    ).rejects.toThrow("different webhook mutation");
    const updated = await service.update(
      actor,
      organizationId,
      created.subscription.id,
      { url: "https://receiver.example.com/hooks/updated" },
      "update-key",
    );
    await expect(
      service.update(
        actor,
        organizationId,
        created.subscription.id,
        { url: "https://receiver.example.com/hooks/updated#ignored-on-retry" },
        "update-key",
      ),
    ).resolves.toEqual(updated);
    await expect(
      service.update(
        actor,
        organizationId,
        created.subscription.id,
        { url: "https://receiver.example.com/hooks/different" },
        "update-key",
      ),
    ).rejects.toThrow("different webhook mutation");
    const disabled = await service.create(
      actor,
      {
        organizationId,
        url: "https://disabled.example.com/hook",
        eventTypes: ["schedule.published"],
      },
      "disabled-create-key",
    );
    await service.disable(actor, organizationId, disabled.subscription.id, "disable-key");
    await expect(
      service.disable(actor, organizationId, disabled.subscription.id, "disable-key"),
    ).resolves.toBeNull();
    expect(created.secret).toHaveLength(64);
    expect(await service.list(actor, organizationId)).toHaveLength(2);

    const app = createHttpAppFrom({
      events: new EventService({
        repository: new MemoryEventRepository(),
        newId: () => "event-unused",
        now: () => clock,
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      auth: {
        demoMode: false,
        sessionSecret: "webhook-http-secret",
        now: () => clock.getTime(),
        sessions: memorySessionStore(),
        resolveActor: async () => actor,
        resolveEmail: async () => null,
        sendLoginCode: async () => undefined,
        saveLoginChallenge: async () => undefined,
        consumeLoginChallenge: async () => null,
        resolveApiClient: async () => apiClientActor,
      },
      webhooks: service,
    });
    const apiHeaders = { authorization: "Bearer grn_fixture.secret" };
    const listResponse = await app.request(`/api/organizations/${organizationId}/webhooks`, {
      headers: apiHeaders,
    });
    expect(listResponse.status).toBe(200);
    expect(JSON.stringify(await listResponse.json())).not.toContain(created.secret);
    const missingKey = await app.request(`/api/organizations/${organizationId}/webhooks`, {
      method: "POST",
      headers: apiHeaders,
      body: "{",
    });
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", message: expect.stringContaining("Idempotency-Key") },
    });
    const duplicateCreateTypes = await app.request(
      `/api/organizations/${organizationId}/webhooks`,
      {
        method: "POST",
        headers: { ...apiHeaders, "idempotency-key": "duplicate-create-types" },
        body: JSON.stringify({
          url: "https://receiver.example.com/hook",
          eventTypes: ["schedule.published", "schedule.published"],
        }),
      },
    );
    expect(duplicateCreateTypes.status).toBe(400);
    const duplicateUpdateTypes = await app.request(
      `/api/organizations/${organizationId}/webhooks/${created.subscription.id}`,
      {
        method: "PATCH",
        headers: { ...apiHeaders, "idempotency-key": "duplicate-update-types" },
        body: JSON.stringify({ eventTypes: ["schedule.published", "schedule.published"] }),
      },
    );
    expect(duplicateUpdateTypes.status).toBe(400);
    const denied = await app.request(
      "/api/organizations/00000000-0000-4000-8000-000000000099/webhooks",
      { method: "POST", headers: apiHeaders, body: "{" },
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });

    let publishedEvent: SchedulePublishedEvent | undefined;
    const agenda = new AgendaService(
      new D1AgendaRepository(
        migrated.database,
        () => clock,
        (_database, event) => {
          publishedEvent = event;
          return [];
        },
      ),
      () => clock,
      new FixtureSchedulableContentQuery(
        new Map([
          [
            eventId,
            [
              {
                id: "20000000-0000-4000-8000-000000000001",
                title: "Designing the calm conference",
                speakerIds: ["10000000-0000-4000-8000-000000000001"],
              },
              {
                id: "20000000-0000-4000-8000-000000000002",
                title: "Accessible by default",
                speakerIds: ["10000000-0000-4000-8000-000000000002"],
              },
            ],
          ],
        ]),
      ),
    );
    const publication = await agenda.publish(actor, eventId, "publish-webhook-flow");
    expect(publication.version).toBe(2);
    if (!publishedEvent) throw new Error("schedule publication emitted no event");
    const event: Delivery = {
      id: publishedEvent.id,
      organizationId,
      eventId,
      idempotencyKey: publishedEvent.id,
      triggerType: "schedule.published",
      channel: "event",
      templateId: null,
      templateVersion: null,
      recipientRef: eventId,
      recipientTrust: "account" as const,
      payload: { ...publishedEvent },
      renderedSubject: null,
      renderedBody: null,
      projectionVersion: null,
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: clock.toISOString(),
      leaseToken: null,
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    };
    const fanout = new WebhookFanoutConsumer(
      repository,
      () => `delivery-${++id}`,
      () => clock,
    );
    await expect(fanout.consume(event)).resolves.toMatchObject({ kind: "success" });
    await fanout.consume(event);

    const requests: Request[] = [];
    let response = 503;
    egress.next = { kind: "retryable", code: "TARGET_503", targetStatus: 503 };
    const receiver = async (request: WebhookEgressRequest) => {
      egress.requests.push(request);
      const requestCopy = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
      requests.push(requestCopy.clone());
      const body = await requestCopy.text();
      expect(
        await verifyWebhookSignature(
          created.secret,
          body,
          requestCopy.headers.get("Greenroom-Signature") ?? "",
          Math.floor(clock.getTime() / 1000),
        ),
      ).toBe(true);
      return response >= 500
        ? ({ kind: "retryable", code: `TARGET_${response}`, targetStatus: response } as const)
        : ({ kind: "delivered", targetStatus: response } as const);
    };
    const worker = new WebhookWorker(repository, {
      egress: { validate: (url) => egress.validate(url), dispatch: receiver },
      newId: () => `attempt-${++id}`,
      now: () => clock,
    });
    expect(await worker.runOne()).toBe(true);
    clock = new Date(clock.getTime() + 5 * 60_000);
    response = 204;
    expect(await worker.runOne()).toBe(true);
    expect(requests).toHaveLength(2);
    const signed = requests[1];
    if (!signed) throw new Error("receiver got no retry");
    const rawBody = await signed.text();
    const signature = signed.headers.get("Greenroom-Signature") ?? "";
    expect(
      await verifyWebhookSignature(
        created.secret,
        rawBody,
        signature,
        Math.floor(clock.getTime() / 1000) + 301,
      ),
    ).toBe(false);
    expect(
      await verifyWebhookSignature(
        created.secret,
        `${rawBody} `,
        signature,
        Math.floor(clock.getTime() / 1000),
      ),
    ).toBe(false);

    const history = await service.history(actor, organizationId, created.subscription.id, {
      limit: 25,
    });
    expect(history.history).toHaveLength(1);
    expect(history.history[0]?.attempts).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain("receiver detail");
    const deliveryId = history.history[0]?.delivery.id;
    if (!deliveryId) throw new Error("delivery was not persisted");
    await service.replay(apiClientActor, organizationId, deliveryId, "replay-key");
    await service.replay(apiClientActor, organizationId, deliveryId, "replay-key");
    expect(await worker.runOne()).toBe(true);
    const replayed = await service.history(actor, organizationId, created.subscription.id, {
      limit: 25,
    });
    expect(replayed.history[0]?.attempts).toHaveLength(4);
    expect(replayed.history[0]?.attempts[2]).toMatchObject({
      errorCode: "MANUAL_REPLAY_REQUESTED",
      requestedBy: apiClientActor.id,
    });

    const [rotated, racedRotation] = await Promise.all([
      service.rotate(actor, organizationId, created.subscription.id, "rotate-key"),
      service.rotate(actor, organizationId, created.subscription.id, "rotate-key"),
    ]);
    expect(racedRotation).toEqual(rotated);
    await expect(
      service.rotate(actor, organizationId, created.subscription.id, "rotate-key"),
    ).resolves.toEqual(rotated);
    expect(rotated.secret).not.toBe(created.secret);
    const rotatedStorage = await migrated.database
      .prepare(
        "SELECT secret_envelope, previous_secret_envelope FROM webhook_subscriptions WHERE id = ?",
      )
      .bind(created.subscription.id)
      .all<{ secret_envelope: string; previous_secret_envelope: string }>();
    expect(JSON.stringify(rotatedStorage.results?.[0])).not.toContain(created.secret);
    expect(JSON.stringify(rotatedStorage.results?.[0])).not.toContain(rotated.secret);
    const secondEvent = {
      ...event,
      id: "event-delivery-2",
      idempotencyKey: "schedule:event:v8",
      payload: { publicationVersion: 8 },
      createdAt: clock.toISOString(),
    };
    await fanout.consume(secondEvent);
    expect(await worker.runOne()).toBe(true);
    const rotationRequest = requests.at(-1);
    if (!rotationRequest) throw new Error("receiver got no rotated delivery");
    const rotationHeader = rotationRequest.headers.get("Greenroom-Signature") ?? "";
    const rotationBody = await rotationRequest.text();
    expect(rotationHeader.match(/v1=/g)).toHaveLength(2);
    expect(
      await verifyWebhookSignature(
        created.secret,
        rotationBody,
        rotationHeader,
        Math.floor(clock.getTime() / 1000),
      ),
    ).toBe(true);
    expect(
      await verifyWebhookSignature(
        rotated.secret,
        rotationBody,
        rotationHeader,
        Math.floor(clock.getTime() / 1000),
      ),
    ).toBe(true);
  });

  it("gives webhook delivery its own bounded progress behind a full communications budget", async () => {
    const migrated = await createMigratedDatabase({ label: "webhook-drain-fairness", seed: true });
    runtime = migrated.runtime;
    const repository = new D1WebhookRepository(migrated.database, await wrappingKeys());
    const service = new WebhookService({
      repository,
      eventDirectory: {
        belongsToOrganization: async (candidate, organization) =>
          candidate === eventId && organization === organizationId,
        listEventIdsForOrganization: async () => [eventId],
      },
      egress: new FixtureEgress(),
      newId: () => "webhook-fairness-subscription",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
    const created = await service.create(
      actor,
      {
        organizationId,
        eventId,
        url: "https://receiver.example.com/hooks/fairness",
        eventTypes: ["schedule.published"],
      },
      "fairness-create",
    );
    await repository.enqueue({
      id: "webhook-fairness-delivery",
      subscriptionId: created.subscription.id,
      organizationId,
      eventId,
      eventRecordId: "event-record-fairness",
      eventType: "schedule.published",
      idempotencyKey: "event-record-fairness",
      payload: {
        id: "event-record-fairness",
        type: "schedule.published",
        version: 1,
        occurredAt: "2026-08-13T12:00:00.000Z",
        organizationId,
        eventId,
        data: { publicationVersion: 1 },
      },
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: "2026-08-13T12:00:00.000Z",
      leaseToken: null,
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    });
    const ordinaryDue = await migrated.database
      .prepare(
        "SELECT count(*) AS count FROM communication_deliveries WHERE state IN ('queued','retrying') AND next_attempt_at <= ?",
      )
      .bind(new Date().toISOString())
      .first<{ count: number }>();
    expect(ordinaryDue?.count).toBeGreaterThanOrEqual(1);
    let releaseOrdinary!: () => void;
    const ordinaryReleased = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let markOrdinaryStarted!: () => void;
    const ordinaryStarted = new Promise<void>((resolve) => {
      markOrdinaryStarted = resolve;
    });
    let markWebhookDispatched!: () => void;
    const webhookDispatched = new Promise<void>((resolve) => {
      markWebhookDispatched = resolve;
    });
    const egress = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://mail.example.net/send") {
        markOrdinaryStarted();
        await ordinaryReleased;
        return Response.json({ id: "mail-fairness" });
      }
      expect(String(input)).toBe("https://egress.example.net/v1/webhooks");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operation: "dispatch",
        url: "https://receiver.example.com/hooks/fairness",
      });
      markWebhookDispatched();
      return Response.json({ result: "delivered", targetStatus: 204 });
    });
    vi.stubGlobal("fetch", egress);

    const draining = drainOutbox(
      {
        DB: migrated.database,
        COMMUNICATIONS_PROVIDERS: "live",
        EMAIL_API_ENDPOINT: "https://mail.example.net/send",
        EMAIL_API_TOKEN: "mail-token",
        EMAIL_SENDER: "greenroom@example.test",
        AIRTABLE_BASE_ID: "airtable-base",
        AIRTABLE_TABLE_ID: "airtable-table",
        AIRTABLE_TOKEN: "airtable-token",
        ACCELEVENTS_API_ENDPOINT: "https://accelevents.example.net/project",
        ACCELEVENTS_TOKEN: "accelevents-token",
        WEBHOOK_EGRESS_ENDPOINT: "https://egress.example.net/v1/webhooks",
        WEBHOOK_EGRESS_TOKEN: "egress-token",
        WEBHOOK_WRAPPING_KEY_VERSION: "test-v1",
        WEBHOOK_WRAPPING_KEYS: wrappingKeyring,
      } as Environment,
      1,
    );
    await ordinaryStarted;
    await webhookDispatched;

    await vi.waitFor(
      async () => {
        await expect(repository.getDelivery("webhook-fairness-delivery")).resolves.toMatchObject({
          state: "succeeded",
          attemptCount: 1,
        });
      },
      { timeout: 3_000 },
    );
    releaseOrdinary();
    await expect(draining).resolves.toBe(2);
    expect(egress).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe destinations and records terminal redirects without following them", async () => {
    const migrated = await createMigratedDatabase({ label: "webhook-safety", seed: true });
    runtime = migrated.runtime;
    const repository = new D1WebhookRepository(migrated.database, await wrappingKeys());
    const egress = new FixtureEgress();
    let id = 0;
    const now = new Date("2026-08-13T12:00:00.000Z");
    const service = new WebhookService({
      repository,
      eventDirectory: {
        belongsToOrganization: async () => true,
        listEventIdsForOrganization: async () => [eventId],
      },
      egress,
      newId: () => `safe-${++id}`,
      now: () => now,
    });
    await expect(
      service.create(
        actor,
        {
          organizationId,
          url: "http://receiver.test",
          eventTypes: ["schedule.published"],
        },
        "unsafe-http",
      ),
    ).rejects.toThrow("HTTPS");
    await expect(
      service.create(
        actor,
        {
          organizationId,
          url: "https://127.0.0.1/hook",
          eventTypes: ["schedule.published"],
        },
        "unsafe-v4",
      ),
    ).rejects.toThrow("non-public");
    await expect(
      service.create(
        actor,
        {
          organizationId,
          url: "https://[::1]/hook",
          eventTypes: ["schedule.published"],
        },
        "unsafe-v6",
      ),
    ).rejects.toThrow("non-public");
    await expect(
      service.create(
        actor,
        {
          organizationId,
          url: "https://[ff02::1]/hook",
          eventTypes: ["schedule.published"],
        },
        "unsafe-v6-multicast",
      ),
    ).rejects.toThrow("non-public");
    await expect(
      service.create(
        actor,
        {
          organizationId,
          url: "https://metadata.google.internal/hook",
          eventTypes: ["schedule.published"],
        },
        "unsafe-host",
      ),
    ).rejects.toThrow("non-public");

    const redirected = await service.create(
      actor,
      {
        organizationId,
        url: "https://redirect.example.com/hook",
        eventTypes: ["schedule.published"],
      },
      "redirect-create",
    );
    const fanout = new WebhookFanoutConsumer(
      repository,
      () => `safety-delivery-${++id}`,
      () => now,
    );
    const event = {
      id: "safety-event-1",
      organizationId,
      eventId,
      idempotencyKey: "safety-event-1",
      triggerType: "schedule.published",
      channel: "event",
      templateId: null,
      templateVersion: null,
      recipientRef: eventId,
      recipientTrust: "account" as const,
      payload: { publicationVersion: 2 },
      renderedSubject: null,
      renderedBody: null,
      projectionVersion: null,
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: now.toISOString(),
      leaseToken: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    } satisfies Delivery;
    await fanout.consume(event);
    const receiver = vi.fn(async (_request: WebhookEgressRequest) => ({
      kind: "terminal" as const,
      code: "WEBHOOK_REDIRECT_REFUSED",
      targetStatus: 302,
    }));
    const worker = new WebhookWorker(repository, {
      egress: { validate: (url) => egress.validate(url), dispatch: receiver },
      newId: () => `safety-attempt-${++id}`,
      now: () => now,
    });
    expect(await worker.runOne()).toBe(true);
    expect(receiver).toHaveBeenCalledTimes(1);
    const redirectHistory = await service.history(
      actor,
      organizationId,
      redirected.subscription.id,
      {
        limit: 25,
      },
    );
    expect(redirectHistory.history[0]?.attempts[0]).toMatchObject({
      outcome: "terminal_failure",
      errorCode: "WEBHOOK_REDIRECT_REFUSED",
    });
    expect(JSON.stringify(redirectHistory)).not.toContain("private receiver detail");
    await service.disable(actor, organizationId, redirected.subscription.id, "redirect-disable");

    const changedAfterSubscription = await service.create(
      actor,
      {
        organizationId,
        url: "https://public.example.com/hook",
        eventTypes: ["schedule.published"],
      },
      "send-check-create",
    );
    await migrated.database
      .prepare("UPDATE webhook_subscriptions SET url = ? WHERE id = ?")
      .bind("https://127.0.0.1/hook", changedAfterSubscription.subscription.id)
      .run();
    await fanout.consume({
      ...event,
      id: "safety-event-2",
      idempotencyKey: "safety-event-2",
    });
    expect(await worker.runOne()).toBe(true);
    expect(receiver).toHaveBeenCalledTimes(1);
    const unsafeHistory = await service.history(
      actor,
      organizationId,
      changedAfterSubscription.subscription.id,
      { limit: 25 },
    );
    expect(unsafeHistory.history[0]?.attempts[0]).toMatchObject({
      outcome: "terminal_failure",
      errorCode: "WEBHOOK_DESTINATION_UNSAFE",
    });
  });

  it("preserves disjoint concurrent PATCHes and replays each committed response", async () => {
    const migrated = await createMigratedDatabase({ label: "webhook-patch-race", seed: true });
    runtime = migrated.runtime;
    const concrete = new D1WebhookRepository(migrated.database, await wrappingKeys());
    const egress = new FixtureEgress();
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new Proxy(concrete, {
      get(target, property, receiver) {
        if (property !== "get") return Reflect.get(target, property, receiver);
        return async (subscriptionId: string) => {
          const result = await target.get(subscriptionId);
          reads += 1;
          if (reads === 2) release();
          if (reads <= 2) await bothRead;
          return result;
        };
      },
    });
    const service = new WebhookService({
      repository,
      eventDirectory: {
        belongsToOrganization: async () => true,
        listEventIdsForOrganization: async () => [eventId],
      },
      egress,
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
    const created = await service.create(
      actor,
      {
        organizationId,
        eventId,
        url: "https://initial.example.com/hook",
        eventTypes: ["schedule.published"],
      },
      "race-create",
    );
    reads = 0;
    const [urlResult, scopeResult] = await Promise.all([
      service.update(
        actor,
        organizationId,
        created.subscription.id,
        { url: "https://updated.example.com/hook" },
        "race-url",
      ),
      service.update(
        actor,
        organizationId,
        created.subscription.id,
        { eventId: null },
        "race-scope",
      ),
    ]);
    const committed = await concrete.get(created.subscription.id);
    expect(committed).toMatchObject({
      url: "https://updated.example.com/hook",
      eventId: null,
      revision: 2,
    });
    expect(
      await service.update(
        actor,
        organizationId,
        created.subscription.id,
        { url: "https://updated.example.com/hook" },
        "race-url",
      ),
    ).toEqual(urlResult);
    expect(
      await service.update(
        actor,
        organizationId,
        created.subscription.id,
        { eventId: null },
        "race-scope",
      ),
    ).toEqual(scopeResult);
    expect([urlResult.revision, scopeResult.revision].sort()).toEqual([1, 2]);
  });

  it("denies organization access when communications capability was earned elsewhere", async () => {
    const migrated = await createMigratedDatabase({ label: "webhook-org-provenance", seed: true });
    runtime = migrated.runtime;
    const repository = new D1WebhookRepository(migrated.database, await wrappingKeys());
    const egress = new FixtureEgress();
    const foreignEvent = "00000000-0000-4000-8000-000000000099";
    const mixed: Actor = {
      ...actor,
      id: "mixed-webhook-actor",
      eventAccess: [
        {
          eventId: foreignEvent,
          role: "organizer",
          capabilities: new Set(["communications:manage"]),
        },
      ],
    };
    const service = new WebhookService({
      repository,
      eventDirectory: {
        belongsToOrganization: async () => true,
        listEventIdsForOrganization: async () => [eventId],
      },
      egress,
      newId: () => crypto.randomUUID(),
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });
    const sessions = memorySessionStore();
    const expiresAt = Date.parse("2026-08-14T12:00:00.000Z");
    sessions.seed({ id: "mixed-session", userId: mixed.id, issuedAt: 1, expiresAt });
    const app = createHttpAppFrom({
      events: new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      auth: {
        demoMode: false,
        sessionSecret: "mixed-webhook-secret",
        now: () => 2,
        sessions,
        resolveActor: async () => mixed,
        resolveApiClient: async () => mixed,
        resolveEmail: async () => null,
        sendLoginCode: async () => undefined,
        saveLoginChallenge: async () => undefined,
        consumeLoginChallenge: async () => null,
      },
      webhooks: service,
    });
    const body = JSON.stringify({
      url: "https://receiver.example.com/hook",
      eventTypes: ["schedule.published"],
    });
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "mixed-role",
    };
    const sessionToken = await createUserSession(
      "mixed-session",
      mixed.id,
      "mixed-webhook-secret",
      expiresAt,
    );
    for (const authorization of [
      { cookie: `greenroom_session=${sessionToken}` },
      { authorization: "Bearer grn_fixture.secret" },
    ]) {
      const response = await app.request(`/api/organizations/${organizationId}/webhooks`, {
        method: "POST",
        headers: { ...headers, ...authorization },
        body,
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "FORBIDDEN", message: "Your account cannot perform this action." },
      });
    }
    expect(egress.validations).toHaveLength(0);
  });

  it("returns a typed service-unavailable envelope when webhook security is not configured", async () => {
    const app = createHttpAppFrom({
      events: new EventService({
        repository: new MemoryEventRepository(),
        newId: () => crypto.randomUUID(),
        now: () => new Date("2026-08-13T12:00:00.000Z"),
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      auth: {
        demoMode: false,
        sessionSecret: "unconfigured-webhook-secret",
        now: () => Date.parse("2026-08-13T12:00:00.000Z"),
        sessions: memorySessionStore(),
        resolveActor: async () => actor,
        resolveApiClient: async () => apiClientActor,
        resolveEmail: async () => null,
        sendLoginCode: async () => undefined,
        saveLoginChallenge: async () => undefined,
        consumeLoginChallenge: async () => null,
      },
    });

    const response = await app.request(`/api/organizations/${organizationId}/webhooks`, {
      headers: { authorization: "Bearer grn_fixture.secret" },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "WEBHOOK_UNAVAILABLE",
        message: "Webhook delivery is not configured.",
      },
    });
  });
});
