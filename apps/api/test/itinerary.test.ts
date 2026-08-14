// @acceptance ACC-PUBLIC
import { describe, expect, it } from "vitest";
import type {
  ItineraryRepository,
  StoredItinerary,
} from "../src/application/publishing/itinerary-repository";
import {
  hashItineraryToken,
  type ItineraryPublicationQuery,
  ItineraryNotFoundError,
  ItineraryService,
} from "../src/application/publishing/itinerary-service";
import type { Publication, PublicEventProjection } from "../src/domain/publishing/publication";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";

const session = (slug: string) => ({
  slug,
  title: slug,
  abstract: "",
  format: "45-minute talk",
  track: "Platform",
  speakerSlugs: [],
});

/** Published in programme order: the itinerary is expected to read back in this order. */
const projection: PublicEventProjection = {
  event: {
    eventId: EVENT_ID,
    slug: "harbor-summit",
    name: "Harbor Summit",
    summary: "",
    startsOn: "2026-09-01",
    endsOn: "2026-09-02",
    timezone: "UTC",
    venue: "",
  },
  cfp: {
    title: "CFP",
    description: "",
    status: "closed",
    publishedAt: null,
    submissionUrl: "/events/harbor-summit/cfp",
  },
  sessions: [session("opening-keynote"), session("calm-conference"), session("closing-panel")],
  speakers: [],
};

function fixture(state: Publication["state"] = "published") {
  let publication: Publication = {
    eventId: EVENT_ID,
    slug: "harbor-summit",
    state,
    draft: projection,
    published: state === "published" ? projection : null,
    publishedAt: state === "published" ? "2026-08-01T00:00:00.000Z" : null,
  };
  const rows = new Map<string, StoredItinerary>();
  const pruneCalls: Array<{ emptyBefore: string; endedBefore: string }> = [];
  const publications: ItineraryPublicationQuery = {
    currentPublicBySlug: async (slug) =>
      slug === publication.slug && publication.state === "published" ? publication : null,
    currentPublicByEventId: async () => (publication.state === "published" ? publication : null),
  };
  const itineraries: ItineraryRepository = {
    create: async (tokenHash, eventId, sessionSlugs, now) => {
      const row = { eventId, sessionSlugs: [...sessionSlugs], updatedAt: now };
      rows.set(tokenHash, row);
      return row;
    },
    findByTokenHash: async (tokenHash) => rows.get(tokenHash) ?? null,
    save: async (tokenHash, sessionSlugs, now) => {
      const existing = rows.get(tokenHash);
      if (!existing) return null;
      const row = { ...existing, sessionSlugs: [...sessionSlugs], updatedAt: now };
      rows.set(tokenHash, row);
      return row;
    },
    prune: async (emptyBefore, endedBefore) => {
      pruneCalls.push({ emptyBefore, endedBefore });
    },
  };
  const service = new ItineraryService(
    itineraries,
    publications,
    () => new Date("2026-08-20T10:00:00.000Z"),
    (length) => new Uint8Array(length).fill(7),
  );
  return {
    service,
    rows,
    pruneCalls,
    unpublish() {
      publication = { ...publication, state: "unpublished", published: null, publishedAt: null };
    },
  };
}

describe("attendee itineraries", () => {
  it("prunes empty mints after one day and ended events only after a full-day grace", async () => {
    const { service, pruneCalls } = fixture();

    await service.prune();

    expect(pruneCalls).toEqual([
      {
        emptyBefore: "2026-08-19T10:00:00.000Z",
        endedBefore: "2026-08-19",
      },
    ]);
  });

  it("mints a token that is never stored in the clear", async () => {
    const { service, rows } = fixture();

    const { token, itinerary } = await service.create("harbor-summit");

    expect(token).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(itinerary).toMatchObject({ eventSlug: "harbor-summit", sessionSlugs: [] });
    // The row is addressed by the hash. A database dump therefore yields no working
    // itinerary URL, which is the property that makes the URL a capability at all.
    expect([...rows.keys()]).toEqual([await hashItineraryToken(token)]);
    expect([...rows.keys()]).not.toContain(token);
    expect(JSON.stringify([...rows.values()])).not.toContain(token);
  });

  it("survives a reload with exactly the chosen sessions, in programme order", async () => {
    const { service } = fixture();
    const { token } = await service.create("harbor-summit");

    // Starred in the order the attendee happened to click, which is not reading order.
    await service.save(token, ["closing-panel", "opening-keynote"]);

    expect((await service.read(token)).sessionSlugs).toEqual(["opening-keynote", "closing-panel"]);
  });

  it("drops sessions the published projection does not name, and collapses duplicates", async () => {
    const { service } = fixture();
    const { token } = await service.create("harbor-summit");

    const saved = await service.save(token, [
      "opening-keynote",
      "opening-keynote",
      // Never published: a withdrawn session, or a slug someone typed into the request.
      "a-session-that-was-withdrawn",
    ]);

    expect(saved.sessionSlugs).toEqual(["opening-keynote"]);
  });

  it("stops answering once the event is unpublished", async () => {
    const { service, unpublish } = fixture();
    const { token } = await service.create("harbor-summit");
    await service.save(token, ["opening-keynote"]);

    unpublish();

    // Taking the event down takes its itineraries with it. Otherwise the snapshot the
    // organizer retracted would stay readable through a side door.
    await expect(service.read(token)).rejects.toBeInstanceOf(ItineraryNotFoundError);
    await expect(service.save(token, [])).rejects.toBeInstanceOf(ItineraryNotFoundError);
  });

  it("answers an unknown token and an unpublished event identically", async () => {
    const { service } = fixture();
    await expect(service.read("a-token-that-was-never-minted")).rejects.toBeInstanceOf(
      ItineraryNotFoundError,
    );

    const draft = fixture("draft");
    await expect(draft.service.create("harbor-summit")).rejects.toBeInstanceOf(
      ItineraryNotFoundError,
    );
  });

  it("hashes with SHA-256, so a presented token is matched by hash and never by value", async () => {
    const hash = await hashItineraryToken("a-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashItineraryToken("a-token")).toBe(hash);
    expect(await hashItineraryToken("a-token ")).not.toBe(hash);
  });

  it("caps what one itinerary can store", async () => {
    const { service } = fixture();
    const { token } = await service.create("harbor-summit");
    const saved = await service.save(
      token,
      Array.from({ length: 5_000 }, (_unused, index) => `session-${index}`),
    );
    // Nothing in that request is published, so nothing is stored: the row can only ever
    // hold slugs the projection justifies, which bounds it by the programme's own size.
    expect(saved.sessionSlugs).toEqual([]);
  });

  it("reconciles the sessions a mint request arrives with, rather than trusting them", async () => {
    const { service } = fixture();

    const minted = await service.create("harbor-summit", [
      "closing-panel",
      "opening-keynote",
      "a-session-that-was-withdrawn",
    ]);

    // Same filter as `save`: the mint path is reachable by an anonymous caller too, so it
    // cannot be the one that writes unvalidated strings into the row.
    expect(minted.itinerary.sessionSlugs).toEqual(["opening-keynote", "closing-panel"]);
  });
});
