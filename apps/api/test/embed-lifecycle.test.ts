// @acceptance ACC-PUBLIC
/**
 * The embed lifecycle, and the five outputs.
 *
 * The lifecycle assertions are the point of the issue's residual epic. Before this, an embed had
 * no identity: it could not be revisited, changed, or withdrawn, and the only way to stop a URL
 * somebody had pasted into their site was to unpublish the whole event. So the tests below
 * construct each of those — a withdrawal that silences one embed and not its sibling, an output
 * change refused in favour of a duplicate that leaves the old address working, and an embed that
 * goes quiet the moment its event does.
 *
 * The renderers are asserted on what a host page can rely on: an iCal that folds its lines, an
 * XML document that escapes, HTML that escapes, and JSON that carries only the selected fields.
 */
import { describe, expect, it } from "vitest";
import type { Actor, Capability } from "../src/application/identity/actor";
import {
  EmbedConflictError,
  EmbedInvalidError,
  EmbedNotFoundError,
  type EmbedRepository,
  EmbedService,
} from "../src/application/publishing/embed-service";
import type { PublicationEmbed } from "../src/domain/publishing/embed";
import type { Publication, PublicEventProjection } from "../src/domain/publishing/publication";

const EVENT = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-08-14T09:00:00.000Z");

const organizer: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: "00000000-0000-4000-8000-0000000000a0" }],
  eventAccess: [
    {
      eventId: EVENT,
      role: "organizer",
      capabilities: new Set<Capability>(["events:read", "events:settings:update"]),
    },
  ],
  capabilities: new Set<Capability>(["events:read", "events:settings:update"]),
};

const projection: PublicEventProjection = {
  event: {
    eventId: EVENT,
    slug: "greenroom-conf",
    name: "Greenroom <Conf>",
    summary: "",
    startsOn: "2026-09-01",
    endsOn: "2026-09-02",
    timezone: "Europe/London",
    venue: "",
  },
  sessions: [
    {
      slug: "opening-keynote",
      title: 'Opening & "keynote"',
      abstract: "Why <it> matters",
      format: "Keynote",
      track: "Main",
      speakerSlugs: ["ada-lovelace"],
      startsAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T10:00:00.000Z",
      room: "Hall A",
    },
    {
      slug: "workshop",
      title: "Workshop",
      abstract: "Hands on",
      format: "Workshop",
      track: "Side",
      speakerSlugs: [],
      startsAt: "2026-09-02T09:00:00.000Z",
      endsAt: "2026-09-02T11:00:00.000Z",
    },
  ],
  speakers: [],
  cfp: null,
} as unknown as PublicEventProjection;

function harness(over: { state?: Publication["state"] } = {}) {
  const stored = new Map<string, PublicationEmbed & { tokenHash: string }>();
  let nextId = 0;
  const repository: EmbedRepository = {
    list: async (eventId) => [...stored.values()].filter((embed) => embed.eventId === eventId),
    find: async (eventId, embedId) => {
      const held = stored.get(embedId);
      return held && held.eventId === eventId ? held : null;
    },
    findLiveByTokenHash: async (tokenHash) =>
      [...stored.values()].find(
        (embed) => embed.tokenHash === tokenHash && embed.revokedAt === null,
      ) ?? null,
    create: async (embed, tokenHash) => {
      stored.set(embed.id, { ...embed, tokenHash });
    },
    update: async (embed, expectedRevision) => {
      const held = stored.get(embed.id);
      if (!held || held.revision !== expectedRevision || held.revokedAt) return 0;
      stored.set(embed.id, { ...embed, tokenHash: held.tokenHash });
      return 1;
    },
    revoke: async (eventId, embedId, at) => {
      const held = stored.get(embedId);
      if (!held || held.eventId !== eventId || held.revokedAt) return 0;
      stored.set(embedId, { ...held, revokedAt: at });
      return 1;
    },
  };
  const service = new EmbedService({
    repository,
    publications: {
      findByEventId: async () =>
        ({
          eventId: EVENT,
          slug: "greenroom-conf",
          state: over.state ?? "published",
          draft: projection,
          published: (over.state ?? "published") === "published" ? projection : null,
          publishedAt: NOW.toISOString(),
        }) as unknown as Publication,
      findPublicBySlug: async () => null,
    },
    schedule: async () => ({ version: 3, publishedAt: NOW.toISOString() }),
    mintToken: async () => {
      const token = `embedtoken${nextId++}`.padEnd(20, "x");
      return { token, tokenHash: `hash:${token}` };
    },
    hash: async (value) => `hash:${value}`,
    embedBaseUrl: "https://api.greenroom.test",
    newId: () => `00000000-0000-4000-8000-0000000000${(nextId++).toString().padStart(2, "0")}`,
    now: () => NOW,
  });
  return { service, stored };
}

const draft = {
  name: "Programme",
  view: "schedule" as const,
  output: "json" as const,
  fields: ["time", "room"],
};

describe("the embed lifecycle", () => {
  it("issues an address once, and answers it while the event is published", async () => {
    const { service } = harness();
    const created = await service.create(organizer, EVENT, draft);
    expect(created.url).toBe(
      `https://api.greenroom.test/api/public/embeds/${"embedtoken0".padEnd(20, "x")}`,
    );
    const rendered = await service.resolve("embedtoken0".padEnd(20, "x"));
    expect(rendered?.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(rendered?.body ?? "{}").sessions).toHaveLength(2);
  });

  it("withdraws one embed without touching its sibling", async () => {
    const { service } = harness();
    const first = await service.create(organizer, EVENT, draft);
    const second = await service.create(organizer, EVENT, { ...draft, name: "Second" });
    expect(await service.revoke(organizer, EVENT, first.embed.id)).toBe(1);
    // This is the whole point of the epic: before it, the only way to stop one URL was to
    // unpublish the event, which stopped every other surface too.
    expect(await service.resolve(first.url.split("/").at(-1) ?? "")).toBeNull();
    expect(await service.resolve(second.url.split("/").at(-1) ?? "")).not.toBeNull();
    // Withdrawal is idempotent; a second attempt reports that nothing changed.
    expect(await service.revoke(organizer, EVENT, first.embed.id)).toBe(0);
  });

  it("goes quiet the moment its event is unpublished", async () => {
    const { service } = harness({ state: "unpublished" });
    const created = await service.create(organizer, EVENT, draft);
    // An embed renders the published projection and nothing else, so there is nothing left to
    // serve — and an unknown token answers the same way, so neither can probe the other.
    expect(await service.resolve(created.url.split("/").at(-1) ?? "")).toBeNull();
    expect(await service.resolve("never-existed-token")).toBeNull();
  });

  it("refuses to change an output type, and duplicates instead", async () => {
    const { service } = harness();
    const created = await service.create(organizer, EVENT, draft);
    await expect(
      service.update(organizer, EVENT, created.embed.id, {
        ...draft,
        output: "ical",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(EmbedInvalidError);
    const copy = await service.duplicate(organizer, EVENT, created.embed.id, {
      name: "Programme (calendar)",
      output: "ical",
    });
    expect(copy.embed.output).toBe("ical");
    expect(copy.url).not.toBe(created.url);
    // The old address keeps working: whoever pasted it in is not broken by somebody else's
    // decision, and can be asked to move at their own pace.
    expect(await service.resolve(created.url.split("/").at(-1) ?? "")).not.toBeNull();
  });

  it("refuses a stale edit and an edit to a withdrawn embed", async () => {
    const { service } = harness();
    const created = await service.create(organizer, EVENT, draft);
    await expect(
      service.update(organizer, EVENT, created.embed.id, { ...draft, expectedRevision: 7 }),
    ).rejects.toThrow(EmbedConflictError);
    await service.revoke(organizer, EVENT, created.embed.id);
    await expect(
      service.update(organizer, EVENT, created.embed.id, { ...draft, expectedRevision: 1 }),
    ).rejects.toThrow(EmbedInvalidError);
  });

  it("refuses an unknown field, an unknown view and a colour that is not one", async () => {
    const { service } = harness();
    for (const bad of [
      { ...draft, fields: ["salary"] },
      { ...draft, view: "everything" },
      { ...draft, accent: "chartreuse" },
      { ...draft, filters: { day: "next tuesday" } },
    ])
      await expect(service.create(organizer, EVENT, bad)).rejects.toThrow(EmbedInvalidError);
  });

  it("reports an embed on another event as absent", async () => {
    const { service } = harness();
    await expect(
      service.update(organizer, EVENT, "no-such-embed", { ...draft, expectedRevision: 1 }),
    ).rejects.toThrow(EmbedNotFoundError);
  });
});

describe("what a host page receives", () => {
  const render = async (output: string, extra: Record<string, unknown> = {}) => {
    const { service } = harness();
    const created = await service.create(organizer, EVENT, { ...draft, output, ...extra });
    return service.resolve(created.url.split("/").at(-1) ?? "");
  };

  it("carries only the selected fields in JSON, and says what version it is", async () => {
    const rendered = await render("json");
    const body = JSON.parse(rendered?.body ?? "{}");
    expect(body.schemaVersion).toBe(1);
    expect(body.agenda).toEqual({ version: 3, publishedAt: NOW.toISOString() });
    // `time` and `room` were selected; nothing else should be present.
    expect(Object.keys(body.sessions[0]).sort()).toEqual([
      "endsAt",
      "room",
      "slug",
      "startsAt",
      "title",
    ]);
  });

  it("escapes in XML and in HTML rather than emitting the source text", async () => {
    const xml = await render("xml");
    expect(xml?.contentType).toBe("application/xml; charset=utf-8");
    expect(xml?.body).toContain("Opening &amp; &quot;keynote&quot;");
    expect(xml?.body).not.toContain('"keynote"');

    const html = await render("styled-html");
    expect(html?.contentType).toBe("text/html; charset=utf-8");
    expect(html?.body).toContain("Opening &amp; &quot;keynote&quot;");
    // The accent reaches an inline stylesheet, which is only safe because it is hex-validated.
    expect(html?.body).toContain("--accent:#2f5d50");
  });

  it("emits a fragment for basic-html and a document for styled-html", async () => {
    expect((await render("basic-html"))?.body.startsWith("<div")).toBe(true);
    expect((await render("styled-html"))?.body.startsWith("<!doctype html>")).toBe(true);
  });

  it("emits a calendar whose lines fold and whose text is escaped", async () => {
    const ical = await render("ical");
    expect(ical?.contentType).toBe("text/calendar; charset=utf-8");
    const lines = (ical?.body ?? "").split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    // RFC 5545: a content line carries at most 75 octets before its CRLF.
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ical?.body).toContain("DTSTART:20260901T090000Z");
    // A session with no room emits no LOCATION rather than an empty one.
    expect((ical?.body.match(/LOCATION:/g) ?? []).length).toBe(1);
  });

  it("narrows to the filtered day rather than widening the query", async () => {
    const rendered = await render("json", { filters: { day: "2026-09-02" } });
    const body = JSON.parse(rendered?.body ?? "{}");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].slug).toBe("workshop");
  });
});
