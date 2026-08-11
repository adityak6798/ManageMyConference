// @acceptance ACC-SPEAKER
/*
 * Which publication the speaker's calendar follows, and which one the public programme follows.
 *
 * These are two different publications and the product has been wrong about it in writing twice:
 * `ContentService` claimed the `.ics` "always says what the public schedule says", and
 * `ContentAgendaInterface` claimed its snapshot was "the same one `/api/public/events/{slug}/
 * schedule` serves". Neither is true. The `.ics` and the speaker portal read the **agenda**
 * publication live; the public programme reads the **site** publication, a projection frozen
 * when the organizer last published the event page (`PRD-PUB-001`). Republishing the agenda
 * alone therefore moves the speaker's calendar entry while the public page stays put, and they
 * reconverge only at the next site publish.
 *
 * This file exists so the rule is executable rather than merely written down: the divergence
 * window is measured, and so is the reconvergence. Everything below is composed from the real
 * `AgendaService`, `ContentService` and `PublicationService` over shared in-memory storage, so
 * no hand-written map can make the two sides agree when the product would not.
 */
import { describe, expect, it } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import {
  MemoryContentRepository,
  MemorySpeakerConversion,
} from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { ContentService } from "../src/application/content/content-service";
import { resolveSeededDemoActor } from "../src/application/identity/demo-session";
import type { PublicationRepository } from "../src/application/publishing/publication-repository";
import { PublicationService } from "../src/application/publishing/publication-service";
import { ProposalNotFoundError } from "../src/application/review/public";
import type { Publication, PublicEventProjection } from "../src/domain/publishing/publication";
import type { ContentSession, SpeakerProfile } from "../src/domain/content/content";

const eventId = "00000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";
const profileId = "10000000-0000-4000-8000-000000000001";
const slug = "greenroom-demo-summit";

const speaker: SpeakerProfile = {
  id: profileId,
  eventId,
  userId: "seed-speaker",
  sourcePersonId: "crm-email:sam@example.test",
  name: "Sam Speaker",
  email: "sam@example.test",
  bio: "",
  pronouns: "",
  organization: "",
};

const session: ContentSession = {
  id: sessionId,
  eventId,
  proposalId: "proposal-1",
  title: "Designing the calm conference",
  abstract: "Quiet rooms.",
  format: "Talk",
  speakerProfileIds: [profileId],
  tags: [],
  tracks: [],
  // Only a published session reaches the public projection at all, so the comparison below
  // is between two surfaces that both carry this session rather than one that withholds it.
  publicationState: "published",
};

const OPENING = {
  id: "slot-0900",
  startsAt: "2026-09-01T16:00:00.000Z",
  endsAt: "2026-09-01T17:00:00.000Z",
};
const LATER = {
  id: "slot-1000",
  startsAt: "2026-09-01T17:00:00.000Z",
  endsAt: "2026-09-01T18:00:00.000Z",
};

/** RFC 5545 section 3.1 unfolding, so a folded line can still be matched whole. */
const calendarLines = (document: string) => document.replaceAll("\r\n ", "").split("\r\n");

async function fixture() {
  const content = new MemoryContentRepository({
    sessions: [session],
    speakers: [speaker],
    tasks: [],
    assets: [],
    messages: [],
  });
  const agendaRepository = new MemoryAgendaRepository([
    {
      eventId,
      rooms: [{ id: "room-main", name: "Main stage" }],
      tracks: [{ id: "track-platform", name: "Platform", color: "#6257d9" }],
      slots: [OPENING, LATER],
      sessions: [],
      placements: [
        {
          id: "placement-opening",
          sessionId,
          roomId: "room-main",
          trackId: "track-platform",
          slotId: OPENING.id,
        },
      ],
    },
  ]);
  const agenda = new AgendaService(
    agendaRepository,
    () => new Date("2026-08-10T12:00:00.000Z"),
    content,
  );
  const calendar = new ContentService({
    repository: content,
    assetStorage: new DeterministicAssetStorage(),
    proposals: {
      acceptedProposal: async () => {
        throw new ProposalNotFoundError("Not used by this fixture");
      },
    },
    agenda,
    speakerConversion: new MemorySpeakerConversion(content, crypto.randomUUID),
    newId: crypto.randomUUID,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });

  let record: Publication = {
    eventId,
    slug,
    state: "draft",
    draft: {
      event: {
        eventId,
        slug,
        name: "Greenroom Demo Summit",
        summary: "",
        startsOn: "",
        endsOn: "",
        timezone: "UTC",
        venue: "",
      },
      cfp: {
        title: "Call for proposals",
        description: "",
        status: "closed",
        publishedAt: null,
        submissionUrl: `/events/${slug}/cfp`,
      },
      sessions: [],
      speakers: [],
    },
    published: null,
    publishedAt: null,
  };
  const repository: PublicationRepository = {
    findPublicBySlug: async (candidate) =>
      candidate === record.slug && record.state === "published" ? record : null,
    findByEventId: async () => record,
    publish: async (_eventId: string, publishedAt: string, published: PublicEventProjection) =>
      (record = { ...record, state: "published", publishedAt, published }),
    unpublish: async () =>
      (record = { ...record, state: "unpublished", published: null, publishedAt: null }),
  };
  const site = new PublicationService(
    repository,
    {
      event: async () => ({ name: "Greenroom Demo Summit", timezone: "UTC" }),
      cfp: async () => null,
      content,
      schedule: (id) => agenda.published(id),
    },
    () => new Date("2026-08-10T12:00:00.000Z"),
  );

  return {
    agenda,
    calendar,
    site,
    organizer: await resolveSeededDemoActor("organizer"),
    speaker: await resolveSeededDemoActor("speaker"),
    /** The instant the `.ics` a speaker downloads right now carries. */
    async calendarStart() {
      const document = await calendar.calendar(await resolveSeededDemoActor("speaker"), eventId);
      return calendarLines(document ?? "").find((line) => line.startsWith("DTSTART:")) ?? null;
    },
    /**
     * The instant the public programme carries right now. `/api/public/events/{slug}/schedule`
     * composes exactly this projection copy — the route joins it with the agenda publication's
     * identity only, never with the agenda's own placement detail.
     */
    async publicStart() {
      const projection = await site.publicBySlug(slug);
      return projection?.sessions[0]?.startsAt ?? null;
    },
  };
}

describe("the speaker calendar and the public programme", () => {
  it("agree while both publications are current, then diverge for exactly one site publish", async () => {
    const fixed = await fixture();

    await fixed.agenda.publish(fixed.organizer, eventId);
    await fixed.site.publish(fixed.organizer, eventId);

    // Same session, same instant, on both surfaces: this is the steady state.
    expect(await fixed.calendarStart()).toBe("DTSTART:20260901T160000Z");
    expect(await fixed.publicStart()).toBe("2026-09-01T16:00:00.000Z");

    // The organizer moves the session an hour later and publishes the *agenda* only.
    await fixed.agenda.place(fixed.organizer, eventId, {
      id: "placement-opening",
      sessionId,
      roomId: "room-main",
      trackId: "track-platform",
      slotId: LATER.id,
    });
    await fixed.agenda.publish(fixed.organizer, eventId);

    // The speaker's calendar follows the agenda publication immediately…
    expect(await fixed.calendarStart()).toBe("DTSTART:20260901T170000Z");
    // …and the public programme does not move, because a site snapshot is frozen until the
    // organizer publishes the site again. This assertion is the documented divergence: if a
    // future change makes these two agree here, the comments in content-service.ts,
    // agenda/public.ts and docs/interfaces/README.md are the things to update.
    expect(await fixed.publicStart()).toBe("2026-09-01T16:00:00.000Z");

    // Publishing the site closes the window. Nothing else does.
    await fixed.site.publish(fixed.organizer, eventId);
    expect(await fixed.publicStart()).toBe("2026-09-01T17:00:00.000Z");
    expect(await fixed.calendarStart()).toBe("DTSTART:20260901T170000Z");
  });

  it("keeps the calendar on the agenda publication while the board moves underneath it", async () => {
    const fixed = await fixture();
    await fixed.agenda.publish(fixed.organizer, eventId);
    await fixed.site.publish(fixed.organizer, eventId);

    // A drag on the board is not a publication. Neither surface may move for it — the
    // speaker was told 16:00 and nobody has committed to anything else yet.
    await fixed.agenda.place(fixed.organizer, eventId, {
      id: "placement-opening",
      sessionId,
      roomId: "room-main",
      trackId: "track-platform",
      slotId: LATER.id,
    });

    expect(await fixed.calendarStart()).toBe("DTSTART:20260901T160000Z");
    expect(await fixed.publicStart()).toBe("2026-09-01T16:00:00.000Z");
  });
});
