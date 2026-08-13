// @acceptance ACC-OPS
/*
 * The seam publishing gained so that platform's audit timeline can account for a site going live.
 *
 * Kept in its own file rather than added to `publication.test.ts`: the port belongs to issue #99
 * and carries `ACC-OPS`, while everything in that file carries `ACC-PUBLIC`, and one file cannot
 * honestly claim both.
 *
 * The properties are the ones an observer depends on and the service can get wrong: the fact is
 * reported only after the change is durable, it carries publishing's own answer for the address
 * and the instant, and an unauthorized attempt reports nothing at all.
 *
 * What the service deliberately does **not** do is guard the observer. `eventPublished` is awaited
 * unguarded, which is why the port's own contract says an implementation must not throw — the last
 * test below pins that, so the contract is asserted rather than merely written down, and the
 * composition root's binding is wrapped precisely because of it.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import {
  type PublicationNotificationPort,
  PublicationService,
} from "../src/application/publishing/public";
import type { PublicationRepository } from "../src/application/publishing/publication-repository";
import type { Publication, PublicEventProjection } from "../src/domain/publishing/publication";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";

const projection = (slug: string): PublicEventProjection => ({
  event: {
    eventId: EVENT_ID,
    slug,
    name: "Greenroom Demo Summit",
    summary: "",
    startsOn: "2026-09-01",
    endsOn: "2026-09-01",
    timezone: "UTC",
    venue: "",
  },
  cfp: {
    title: "CFP",
    description: "",
    status: "open",
    publishedAt: null,
    submissionUrl: "/events/greenroom-demo-summit/cfp",
  },
  sessions: [],
  speakers: [],
});

/** A repository double that behaves like the D1 one for the two commands under test. */
function harness(
  options: { publishFails?: boolean; now?: () => Date; onUnpublish?: () => void } = {},
) {
  let record: Publication = {
    eventId: EVENT_ID,
    slug: "greenroom-demo-summit",
    state: "draft",
    draft: projection("greenroom-demo-summit"),
    published: null,
    publishedAt: null,
  };
  const repository = {
    findPublicBySlug: async () => (record.state === "published" ? record : null),
    findByEventId: async () => record,
    publish: async (_eventId: string, publishedAt: string, published: PublicEventProjection) => {
      if (options.publishFails) throw new Error("the projection could not be written");
      record = {
        ...record,
        slug: published.event.slug,
        state: "published",
        publishedAt,
        published,
      };
      return record;
    },
    unpublish: async () => {
      options.onUnpublish?.();
      if (record.state !== "published") return null;
      record = { ...record, state: "unpublished", published: null, publishedAt: null };
      return record;
    },
    findEventIdBySlug: async () => EVENT_ID,
    saveSettings: async () => record,
  } satisfies PublicationRepository;

  const notifications: PublicationNotificationPort = {
    eventPublished: vi.fn(async () => undefined),
    eventUnpublished: vi.fn(async () => undefined),
  };
  return {
    notifications,
    get state() {
      return record.state;
    },
    service: new PublicationService(
      repository,
      undefined,
      options.now ?? (() => new Date("2026-08-12T12:00:00.000Z")),
      notifications,
    ),
  };
}

describe("publishing's lifecycle port", () => {
  it("reports a page going live with publishing's own address and instant", async () => {
    const { service, notifications } = harness();
    const organizer = await resolveSeededDemoActor("organizer");

    await service.publish(organizer, EVENT_ID);

    expect(notifications.eventPublished).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      slug: "greenroom-demo-summit",
      publishedAt: "2026-08-12T12:00:00.000Z",
    });
    expect(notifications.eventUnpublished).not.toHaveBeenCalled();
  });

  it("reports a page being taken down", async () => {
    const { service, notifications } = harness();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.publish(organizer, EVENT_ID);

    await service.unpublish(organizer, EVENT_ID);

    expect(notifications.eventUnpublished).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      slug: "greenroom-demo-summit",
      unpublishedAt: "2026-08-12T12:00:00.000Z",
    });
  });

  it("reports only the transition when unpublish is repeated", async () => {
    const { service, notifications } = harness();
    const organizer = await resolveSeededDemoActor("organizer");
    await service.publish(organizer, EVENT_ID);

    await service.unpublish(organizer, EVENT_ID);
    await service.unpublish(organizer, EVENT_ID);

    expect(notifications.eventUnpublished).toHaveBeenCalledTimes(1);
  });

  it("captures the withdrawal instant before attempting the conditional write", async () => {
    const order: string[] = [];
    const { service } = harness({
      now: () => {
        order.push("clock");
        return new Date("2026-08-12T12:00:00.000Z");
      },
      onUnpublish: () => order.push("write"),
    });
    const organizer = await resolveSeededDemoActor("organizer");
    await service.publish(organizer, EVENT_ID);
    order.length = 0;

    await service.unpublish(organizer, EVENT_ID);

    expect(order).toEqual(["clock", "write"]);
  });
  it("says nothing when the write it would describe did not happen", async () => {
    const { service, notifications } = harness({ publishFails: true });
    const organizer = await resolveSeededDemoActor("organizer");

    // The fact is that a page *is* live. Announcing one that then failed to commit would put a
    // change on an audit timeline that never happened.
    await expect(service.publish(organizer, EVENT_ID)).rejects.toThrow();
    expect(notifications.eventPublished).not.toHaveBeenCalled();
  });

  it("says nothing for a caller who may not publish", async () => {
    const { service, notifications, state } = harness();

    // Refused by publishing's own rule, before anything is written or reported.
    await expect(
      service.publish(await resolveSeededDemoActor("reviewer"), EVENT_ID),
    ).rejects.toThrow(/events:settings:update/);
    await expect(
      service.unpublish(await resolveSeededDemoActor("speaker"), EVENT_ID),
    ).rejects.toThrow(/events:settings:update/);

    expect(notifications.eventPublished).not.toHaveBeenCalled();
    expect(notifications.eventUnpublished).not.toHaveBeenCalled();
    expect(state).toBe("draft");
  });

  it("lets a throwing observer through, which is why the port's contract forbids one", async () => {
    const { service, notifications } = harness();
    vi.mocked(notifications.eventPublished).mockRejectedValue(new Error("observer exploded"));

    // Not a defect to fix here: guarding inside the service would silently swallow a broken
    // observer. The contract puts the obligation on the implementation, and this is the test that
    // makes "must not throw" a checked statement rather than a comment.
    await expect(
      service.publish(await resolveSeededDemoActor("organizer"), EVENT_ID),
    ).rejects.toThrow("observer exploded");
  });

  it("publishes unchanged when nobody is observing", async () => {
    let record: Publication = {
      eventId: EVENT_ID,
      slug: "greenroom-demo-summit",
      state: "draft",
      draft: projection("greenroom-demo-summit"),
      published: null,
      publishedAt: null,
    };
    // Optional on purpose: a composition exercising only the projection behaves exactly as it did
    // before this port existed, which is what keeps every other suite honest without change.
    const service = new PublicationService({
      findPublicBySlug: async () => null,
      findByEventId: async () => record,
      publish: async (_eventId: string, publishedAt: string, published: PublicEventProjection) => {
        record = { ...record, state: "published", publishedAt, published };
        return record;
      },
      unpublish: async () => record,
      findEventIdBySlug: async () => EVENT_ID,
      saveSettings: async () => record,
    } satisfies PublicationRepository);

    await expect(
      service.publish(await resolveSeededDemoActor("organizer"), EVENT_ID),
    ).resolves.toMatchObject({ state: "published" });
  });
});
