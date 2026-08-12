// @acceptance ACC-INTEGRATION
/**
 * The path from a lifecycle event to a queued delivery (issue #66), and the `event` channel that
 * carries a domain event rather than a message (issue #22).
 *
 * What these assert that the existing outbox tests do not: that something in the product
 * *produces* a delivery. `communications-service.test.ts` proves the outbox works once a
 * delivery exists; before this, the only thing that made one exist was an organizer's POST.
 */
import { describe, expect, it } from "vitest";
import { MemoryCommunicationsRepository } from "../src/adapters/persistence/memory-communications-repository";
import { DeterministicProvider } from "../src/adapters/providers/deterministic-provider";
import { CommunicationsService } from "../src/application/communications/communications-service";
import { OutboxWorker } from "../src/application/communications/outbox-worker";
import {
  SCHEDULE_TEMPLATE_KEY,
  SchedulePublishedConsumer,
} from "../src/application/communications/schedule-published-consumer";
import { TRIGGER_CHANNELS } from "../src/domain/communications/delivery";
import type { Actor } from "../src/application/identity/actor";
import { triggerChannels } from "@greenroom/contracts";

const organizationId = "00000000-0000-4000-8000-000000000010";
const eventId = "00000000-0000-4000-8000-000000000001";
const organizer: Actor = {
  id: "organizer",
  name: "Organizer",
  persona: "organizer",
  organizations: [{ id: organizationId }],
  eventAccess: [
    { eventId, role: "organizer", capabilities: new Set(["events:read", "communications:manage"]) },
  ],
  capabilities: new Set(["communications:manage"]),
};

const speakers = [
  { id: "user-sam", name: "Sam Speaker", email: "sam@example.test" },
  { id: "user-jordan", name: "Jordan Bell", email: null },
];

const harness = (options: { speakers?: typeof speakers } = {}) => {
  let id = 0;
  const now = new Date("2026-08-10T12:00:00.000Z");
  const repository = new MemoryCommunicationsRepository();
  const service = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidate, organization) =>
        candidate === eventId && organization === organizationId,
    },
    newId: () => `id-${++id}`,
    now: () => now,
  });
  const directory = {
    listSpeakersForEvent: async () => options.speakers ?? speakers,
  };
  const consumer = new SchedulePublishedConsumer({
    enqueue: service,
    speakerDirectory: directory,
    calendarUrl: (event: string) => `https://greenroom.test/api/events/${event}/x.ics`,
  });
  const provider = new DeterministicProvider();
  const worker = new OutboxWorker(
    repository,
    { email: provider, airtable: provider, accelevents: provider },
    { newId: () => `id-${++id}`, now: () => now },
    undefined,
    consumer,
  );
  return { repository, service, consumer, provider, worker };
};

const seedTemplate = (service: CommunicationsService, key: string, body: string) =>
  service.createTemplate(organizer, {
    organizationId,
    key,
    version: 1,
    channel: "email",
    subject: "Subject",
    body,
  });

const publicationEvent = (test: ReturnType<typeof harness>, version = 1) =>
  test.service.enqueue({
    organizationId,
    eventId,
    idempotencyKey: `EVT-SCHEDULE-PUBLISHED:${eventId}:${version}`,
    triggerType: "schedule.published",
    channel: "event",
    recipientRef: `event:${eventId}`,
    payload: { publicationVersion: version, placementCount: 3 },
  });

describe("the trigger and channel vocabulary", () => {
  it("refuses a trigger sent over a channel it does not belong to", async () => {
    const test = harness();
    await seedTemplate(test.service, "speaker-invite", "Hello {{speakerName}}");
    await expect(
      test.service.enqueue({
        organizationId,
        eventId,
        idempotencyKey: "wrong-channel",
        // A schedule publication is a domain event; sending it to Airtable would queue a
        // fabricated external push and write projection state for something never projected.
        triggerType: "schedule.published",
        channel: "airtable",
        recipientRef: "session:1",
        payload: {},
        projectionVersion: 1,
      }),
    ).rejects.toThrow(/cannot be sent over the airtable channel/);
  });

  it("refuses an ordinary message on the event channel", async () => {
    const test = harness();
    await expect(
      test.service.enqueue({
        organizationId,
        eventId,
        idempotencyKey: "wrong-way",
        triggerType: "speaker.invited",
        channel: "event",
        recipientRef: "sam@example.test",
        payload: {},
      }),
    ).rejects.toThrow(/cannot be sent over the event channel/);
  });

  it("states the same trigger/channel mapping in the contract as in the domain", () => {
    // Two copies exist because the contracts package cannot import the API's domain. This is
    // what stops them drifting: a trigger added to one and forgotten in the other fails here,
    // rather than becoming a 400 nobody can explain or a CHECK violation in production.
    expect(triggerChannels).toEqual(TRIGGER_CHANNELS);
  });
});

describe("a schedule publication reaching the outbox", () => {
  it("fans out one confirmation per reachable speaker and names the unreachable nowhere", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      SCHEDULE_TEMPLATE_KEY,
      "Hello {{speakerName}}, calendar: {{calendarUrl}}",
    );
    await publicationEvent(test);

    expect(await test.worker.runOne()).toBe(true);

    const deliveries = await test.repository.list(organizationId, eventId);
    const confirmations = deliveries.filter(({ channel }) => channel === "email");
    // Jordan has no address; one delivery, not two, and no row addressed to null.
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.recipientRef).toBe("sam@example.test");
    expect(confirmations[0]?.triggerType).toBe("speaker.scheduled");
    expect(confirmations[0]?.renderedBody).toBe(
      `Hello Sam Speaker, calendar: https://greenroom.test/api/events/${eventId}/x.ics`,
    );
  });

  it("sends nobody twice when the same publication is consumed again", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      SCHEDULE_TEMPLATE_KEY,
      "Hello {{speakerName}} {{calendarUrl}}",
    );
    const record = await publicationEvent(test);

    // The outbox is at-least-once: a lease that expires mid-fan-out brings the same record back.
    const stored = await test.repository.get(record.id);
    if (!stored) throw new Error("the publication record was not stored");
    const first = await test.consumer.consume(stored);
    const second = await test.consumer.consume(stored);

    expect(first).toMatchObject({ kind: "success" });
    expect(second).toMatchObject({ kind: "success" });
    expect(
      (await test.repository.list(organizationId, eventId)).filter(
        ({ triggerType }) => triggerType === "speaker.scheduled",
      ),
    ).toHaveLength(1);
    // The second pass created nothing, and says so rather than claiming a fresh send.
    expect(second).toMatchObject({ providerReference: expect.stringContaining("enqueued=0") });
  });

  it("re-sends for a later publication, because that is a different schedule", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      SCHEDULE_TEMPLATE_KEY,
      "Hello {{speakerName}} {{calendarUrl}}",
    );
    await publicationEvent(test, 1);
    await publicationEvent(test, 2);

    await test.worker.runOne();
    await test.worker.runOne();

    expect(
      (await test.repository.list(organizationId, eventId)).filter(
        ({ triggerType }) => triggerType === "speaker.scheduled",
      ),
    ).toHaveLength(2);
  });

  it("fails terminally, not endlessly, when the schedule template does not exist", async () => {
    const test = harness();
    await publicationEvent(test);

    await test.worker.runOne();

    const record = (await test.repository.list(organizationId, eventId)).find(
      ({ channel }) => channel === "event",
    );
    expect(record?.state).toBe("terminal");
    const attempts = await test.repository.attempts(record?.id ?? "");
    expect(attempts.at(-1)?.errorCode).toBe("SCHEDULE_TEMPLATE_MISSING");
  });

  it("never hands an event delivery to a provider", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      SCHEDULE_TEMPLATE_KEY,
      "Hello {{speakerName}} {{calendarUrl}}",
    );
    await publicationEvent(test);

    await test.worker.runOne();

    // The whole point of the `event` channel: no outside system was called for a domain event.
    expect(test.provider.calls.filter(({ channel }) => channel === "event")).toHaveLength(0);
  });

  it("writes no projection state for an event delivery", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      SCHEDULE_TEMPLATE_KEY,
      "Hello {{speakerName}} {{calendarUrl}}",
    );
    await publicationEvent(test);

    await test.worker.runOne();

    // Modelling the publication as an `airtable` delivery would have written a row here claiming
    // the schedule had been pushed to Airtable. PR #113 refused to ship that; this is the guard.
    expect(test.repository.projections.size).toBe(0);
  });
});

describe("an event delivery with nothing bound to consume it", () => {
  it("fails terminally rather than sitting queued forever or claiming success", async () => {
    const test = harness();
    const unconsumed = new OutboxWorker(
      test.repository,
      {
        email: test.provider,
        airtable: test.provider,
        accelevents: test.provider,
      },
      { newId: () => "unconsumed", now: () => new Date("2026-08-10T12:00:00.000Z") },
    );
    await publicationEvent(test);

    expect(await unconsumed.runOne()).toBe(true);

    const record = (await test.repository.list(organizationId, eventId)).find(
      ({ channel }) => channel === "event",
    );
    expect(record?.state).toBe("terminal");
    expect((await test.repository.attempts(record?.id ?? "")).at(-1)?.errorCode).toBe(
      "NO_EVENT_CONSUMER",
    );
  });
});
