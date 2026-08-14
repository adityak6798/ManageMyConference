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
import {
  REMINDER_BATCH_LIMIT,
  REMINDER_TEMPLATE_KEY,
  enqueueDueTaskReminders,
} from "../src/application/communications/task-reminders";
import { CommunicationsConflictError } from "../src/application/communications/errors";
import {
  lifecycleRecipient,
  REQUESTABLE_TRIGGERS,
  TRIGGER_CHANNELS,
} from "../src/domain/communications/delivery";
import type { Actor } from "../src/application/identity/actor";
import { requestTriggerTypeSchema, triggerChannels } from "@greenroom/contracts";

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
  // Read on every call rather than captured, so a test can change the roster between the count
  // an organizer confirms and the send they confirm — which is the whole point of #52's
  // audience snapshot.
  const directory = {
    listSpeakersForEvent: async () => options.speakers ?? speakers,
  };
  const service = new CommunicationsService({
    repository,
    eventDirectory: {
      belongsToOrganization: async (candidate, organization) =>
        candidate === eventId && organization === organizationId,
    },
    speakerDirectory: directory,
    newId: () => `id-${++id}`,
    now: () => now,
  });
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
    /*
     * And the *requestable* sets agree too, which the channel comparison above does not cover.
     * `REQUESTABLE_TRIGGERS` is derived by exclusion and `requestTriggerTypeSchema` is written out,
     * so the two drift silently: adding `proposal.submitted` to the domain put it in the derived
     * set while the contract deliberately withheld it, and nothing failed.
     */
    expect([...REQUESTABLE_TRIGGERS].sort()).toEqual([...requestTriggerTypeSchema.options].sort());
  });

  it("prefers the address an account proved over the one a form collected", () => {
    /*
     * The rule issue #190 narrowed #132 with, stated once here rather than at each call site.
     *
     * The order is the whole of it: an account address wins whenever there is one, because the
     * person proved control of that mailbox to sign in, while a form address is whatever
     * somebody typed. A decision notice is the message where that difference is worst — it names
     * an outcome the organizer has published nowhere else.
     */
    expect(
      lifecycleRecipient({
        account: { asked: true, email: "owner@example.test" },
        declaredEmail: "typed@example.test",
      }),
    ).toBe("owner@example.test");
    // The fallback is why #132 stays open rather than closing here: a guest submission is a
    // supported way to apply, and refusing to write to it would mean telling nobody.
    expect(
      lifecycleRecipient({
        account: { asked: true, email: null },
        declaredEmail: "typed@example.test",
      }),
    ).toBe("typed@example.test");
    // No account at all — a guest proposal.
    expect(lifecycleRecipient({ declaredEmail: "typed@example.test" })).toBe("typed@example.test");
    // An empty string is not an address. `||` is load-bearing here and `??` would not be.
    expect(
      lifecycleRecipient({
        account: { asked: true, email: "" },
        declaredEmail: "typed@example.test",
      }),
    ).toBe("typed@example.test");
    // Nobody to write to, reported as such rather than as an empty recipient a provider would
    // refuse with a message about its own syntax.
    expect(
      lifecycleRecipient({ account: { asked: true, email: null }, declaredEmail: null }),
    ).toBeNull();
    expect(lifecycleRecipient({})).toBeNull();
  });

  it("sends nothing when the account could not be asked, rather than falling back", () => {
    /*
     * The distinction the type exists for, and the reason it is a type rather than a comment.
     *
     * A failed identity lookup is not evidence that the account has no address. Treating it as
     * one falls through to the address a *public form* was told — so a transient read error at
     * the moment an organizer decides would deliver an accept or decline to whatever address an
     * applicant typed, which is precisely the exposure preferring the account address removes.
     * And it does not heal: the delivery key names the decision's occurrence, so a retry
     * converges on the row already addressed wrongly.
     */
    expect(
      lifecycleRecipient({ account: { asked: false }, declaredEmail: "typed@example.test" }),
    ).toBeNull();
    // Even with no fallback available, the answer is the same — silence, and a caller that
    // reports it, rather than a guess.
    expect(lifecycleRecipient({ account: { asked: false }, declaredEmail: null })).toBeNull();
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

describe("reminding a speaker about work that is coming due (issue #52)", () => {
  const task = (overrides: Partial<Record<string, string>> = {}) => ({
    eventId,
    profileId: "profile-sam",
    userId: "user-sam",
    speakerName: "Sam Speaker",
    email: "sam@example.test",
    taskId: "task-1",
    title: "Upload a headshot",
    dueAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  });

  const reminders = (
    test: ReturnType<typeof harness>,
    due: ReturnType<typeof task>[],
    now = "2026-08-10T12:00:00.000Z",
  ) =>
    enqueueDueTaskReminders({
      work: { listOpenSpeakerWork: async () => due },
      enqueue: test.service,
      organizationOf: async () => organizationId,
      now: () => new Date(now),
    });

  it("queues one reminder for a task inside the window", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      REMINDER_TEMPLATE_KEY,
      "{{speakerName}}: {{taskTitle}} is due {{dueAt}}",
    );

    const result = await reminders(test, [task()]);

    expect(result).toEqual({ considered: 1, enqueued: 1 });
    const queued = (await test.repository.list(organizationId, eventId)).filter(
      ({ triggerType }) => triggerType === "speaker.task_reminder",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.recipientRef).toBe("sam@example.test");
    expect(queued[0]?.renderedBody).toBe(
      "Sam Speaker: Upload a headshot is due 2026-08-12T12:00:00.000Z",
    );
  });

  it("queues nothing further however many times the cron fires", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      REMINDER_TEMPLATE_KEY,
      "{{speakerName}} {{taskTitle}} {{dueAt}}",
    );

    // The cron fires every sixty seconds. This is the property that stops that mailing somebody
    // fourteen hundred times a day, and it is the delivery's own key rather than bookkeeping.
    const first = await reminders(test, [task()]);
    const second = await reminders(test, [task()]);
    const third = await reminders(test, [task()]);

    expect([first.enqueued, second.enqueued, third.enqueued]).toEqual([1, 0, 0]);
    expect(
      (await test.repository.list(organizationId, eventId)).filter(
        ({ triggerType }) => triggerType === "speaker.task_reminder",
      ),
    ).toHaveLength(1);
  });

  it("reminds about an already-overdue task rather than skipping it", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      REMINDER_TEMPLATE_KEY,
      "{{speakerName}} {{taskTitle}} {{dueAt}}",
    );

    // A task whose window passed while nothing was running is exactly the one worth a reminder.
    const result = await reminders(test, [task({ dueAt: "2026-07-01T00:00:00.000Z" })]);

    expect(result.enqueued).toBe(1);
  });

  it("keeps going when one task's reminder cannot be built, and says which", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      REMINDER_TEMPLATE_KEY,
      "{{speakerName}} {{taskTitle}} {{eventName}}",
    );
    const failures: Record<string, unknown>[] = [];

    const result = await enqueueDueTaskReminders({
      // The template names a placeholder the reminder does not supply, so every one refuses.
      work: { listOpenSpeakerWork: async () => [task(), task({ taskId: "task-2" })] },
      enqueue: test.service,
      organizationOf: async () => organizationId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      onFailure: (fields) => failures.push(fields),
    });

    // Reported rather than thrown: this runs in the same tick as the outbox drain, and one
    // broken template must not stop every queued delivery from being sent.
    expect(result).toEqual({ considered: 2, enqueued: 0 });
    expect(failures.map(({ taskId }) => taskId)).toEqual(["task-1", "task-2"]);
    expect(String(failures[0]?.reason)).toContain("eventName");
  });

  it("skips a task whose event has no owning organization, and reports it", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      REMINDER_TEMPLATE_KEY,
      "{{speakerName}} {{taskTitle}} {{dueAt}}",
    );
    const failures: Record<string, unknown>[] = [];

    const result = await enqueueDueTaskReminders({
      work: { listOpenSpeakerWork: async () => [task()] },
      enqueue: test.service,
      organizationOf: async () => null,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      onFailure: (fields) => failures.push(fields),
    });

    expect(result.enqueued).toBe(0);
    expect(failures[0]).toMatchObject({ taskId: "task-1", reason: "no owning organization" });
  });

  it("does not take the outbox down with it when the task read fails", async () => {
    const test = harness();
    const failures: Record<string, unknown>[] = [];

    // `scheduled()` runs reminders before the drain, so this throwing would leave every queued
    // delivery unsent until the read started working again. Reported, and the tick goes on.
    const result = await enqueueDueTaskReminders({
      work: {
        listOpenSpeakerWork: async () => {
          throw new Error("D1 content query failed: connection lost");
        },
      },
      enqueue: test.service,
      organizationOf: async () => organizationId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      onFailure: (fields) => failures.push(fields),
    });

    expect(result).toEqual({ considered: 0, enqueued: 0 });
    expect(failures[0]).toMatchObject({ reason: "open speaker work could not be read" });
    expect(String(failures[0]?.detail)).toContain("connection lost");
  });

  it("asks only for work due inside the window", async () => {
    const test = harness();
    await seedTemplate(
      test.service,
      REMINDER_TEMPLATE_KEY,
      "{{speakerName}} {{taskTitle}} {{dueAt}}",
    );
    const asked: { dueBefore: string; limit: number }[] = [];

    await enqueueDueTaskReminders({
      work: {
        listOpenSpeakerWork: async (dueBefore, limit) => {
          asked.push({ dueBefore, limit });
          return [];
        },
      },
      enqueue: test.service,
      organizationOf: async () => organizationId,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      offsetDays: 3,
    });

    // Three days ahead of the tick, and bounded — a cron invocation meets the whole backlog on
    // its first run and must not try to work through it in one go.
    expect(asked[0]?.dueBefore).toBe("2026-08-13T12:00:00.000Z");
    expect(asked[0]?.limit).toBe(REMINDER_BATCH_LIMIT);
  });
});

describe("publishing a template version when somebody else is publishing too (issue #52)", () => {
  it("allocates the next version rather than making the caller guess it", async () => {
    const test = harness();

    const first = await test.service.createTemplate(organizer, {
      organizationId,
      key: "welcome",
      channel: "email",
      subject: "One",
      body: "Hello {{speakerName}}",
    });
    const second = await test.service.createTemplate(organizer, {
      organizationId,
      key: "welcome",
      channel: "email",
      subject: "Two",
      body: "Hello again {{speakerName}}",
    });

    expect([first.version, second.version]).toEqual([1, 2]);
  });

  it("gives both organizers a version when they publish the same key at once", async () => {
    const test = harness();

    // The failure this replaces: both read the same list, both proposed version 1, and the
    // loser's insert hit the unique constraint and became a 500.
    const [left, right] = await Promise.all([
      test.service.createTemplate(organizer, {
        organizationId,
        key: "welcome",
        channel: "email",
        subject: "Left",
        body: "Hello {{speakerName}}",
      }),
      test.service.createTemplate(organizer, {
        organizationId,
        key: "welcome",
        channel: "email",
        subject: "Right",
        body: "Hi {{speakerName}}",
      }),
    ]);

    expect([left.version, right.version].sort()).toEqual([1, 2]);
    expect(await test.repository.listTemplates(organizationId)).toHaveLength(2);
  });

  it("reports a version somebody explicitly named and already took as a conflict", async () => {
    const test = harness();
    await test.service.createTemplate(organizer, {
      organizationId,
      key: "welcome",
      version: 1,
      channel: "email",
      subject: "One",
      body: "Hello {{speakerName}}",
    });

    // Previously a 500. A caller who pins a version needs to be told it is taken.
    await expect(
      test.service.createTemplate(organizer, {
        organizationId,
        key: "welcome",
        version: 1,
        channel: "email",
        subject: "Clash",
        body: "Hello {{speakerName}}",
      }),
    ).rejects.toBeInstanceOf(CommunicationsConflictError);
  });
});

describe("confirming a send against an audience that then changes (issue #52)", () => {
  const template = (test: ReturnType<typeof harness>) =>
    seedTemplate(test.service, "welcome", "Hello {{speakerName}}");

  it("issues a version with the recipients and accepts a send that carries it back", async () => {
    const test = harness();
    await template(test);

    const audience = await test.service.recipients(organizer, organizationId, eventId);
    const result = await test.service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "welcome",
      audienceVersion: audience.audienceVersion,
    });

    expect(audience.recipients).toHaveLength(2);
    expect(result.enqueued).toBe(1);
  });

  it("refuses the send, and writes nothing, when a speaker was added in between", async () => {
    const roster = [...speakers];
    const test = harness({ speakers: roster });
    await template(test);
    const confirmed = await test.service.recipients(organizer, organizationId, eventId);

    // A speaker is added between the count the organizer approved and their click.
    roster.push({ id: "user-late", name: "Late Addition", email: "late@example.test" });

    await expect(
      test.service.broadcast(organizer, {
        organizationId,
        eventId,
        templateKey: "welcome",
        audienceVersion: confirmed.audienceVersion,
      }),
    ).rejects.toThrow(/changed since you confirmed/);
    // Refused before anything was written, so re-confirming is the whole recovery.
    expect(await test.repository.list(organizationId, eventId)).toHaveLength(0);
  });

  it("refuses when a speaker's address changed, not only when the count did", async () => {
    const roster = [...speakers];
    const test = harness({ speakers: roster });
    await template(test);
    const confirmed = await test.service.recipients(organizer, organizationId, eventId);

    // Same number of people, a different place the message lands. A count alone would miss it.
    roster[0] = { ...(roster[0] as (typeof speakers)[number]), email: "elsewhere@example.test" };

    await expect(
      test.service.broadcast(organizer, {
        organizationId,
        eventId,
        templateKey: "welcome",
        audienceVersion: confirmed.audienceVersion,
      }),
    ).rejects.toThrow(/changed since you confirmed/);
  });

  it("still sends for a caller that never saw a count", async () => {
    const test = harness();
    await template(test);

    // Optional, so a scripted API caller is not made to invent one. The protection is for the
    // organizer who confirmed against a number on screen.
    const result = await test.service.broadcast(organizer, {
      organizationId,
      eventId,
      templateKey: "welcome",
    });

    expect(result.enqueued).toBe(1);
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
