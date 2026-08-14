// @acceptance ACC-SPEAKER

/**
 * The deliverables export, opened rather than assumed.
 *
 * `bulkDownload` hands the organizer a file nobody in this repository reads back, so every claim
 * the export makes — that it carries the newest version, that two speakers' identically named
 * decks both survive, that the same selection is the same bytes — was until now a claim about
 * code that no test could tell apart from a working one. These unzip the archive and assert its
 * entry names and their contents (#189).
 */

import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { createDeliverablesZip } from "../src/adapters/content/create-deliverables-zip";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { ContentService } from "../src/application/content/content-service";
import type { Actor } from "../src/application/identity/actor";
import type { SpeakerProfile } from "../src/domain/content/content";

const eventId = "00000000-0000-4000-8000-000000000001";
const samProfileId = "10000000-0000-4000-8000-000000000001";
const adaProfileId = "10000000-0000-4000-8000-000000000002";

const speakerActor = (id: string): Actor => ({
  id,
  name: id,
  persona: "speaker",
  organizations: [],
  capabilities: new Set(["content:read"]),
  eventAccess: [{ eventId, role: "speaker", capabilities: new Set(["content:read"]) }],
});
const sam = speakerActor("sam-user");
const ada = speakerActor("ada-user");
const organizer: Actor = {
  id: "organizer-user",
  name: "Ona Organizer",
  persona: "organizer",
  organizations: [],
  capabilities: new Set(["content:read", "content:manage"]),
  eventAccess: [
    { eventId, role: "organizer", capabilities: new Set(["content:read", "content:manage"]) },
  ],
};

const profile = (id: string, userId: string, name: string): SpeakerProfile => ({
  id,
  eventId,
  userId,
  sourcePersonId: `source-${name.toLowerCase()}`,
  name,
  email: `${name.toLowerCase()}@example.test`,
  bio: "",
  pronouns: "",
  organization: "",
});

function fixture() {
  const repository = new MemoryContentRepository({
    sessions: [],
    speakers: [profile(samProfileId, sam.id, "Sam"), profile(adaProfileId, ada.id, "Ada")],
    tasks: [],
    assets: [],
    messages: [],
  });
  let sequence = 0;
  const service = new ContentService({
    repository,
    assetStorage: new DeterministicAssetStorage(),
    proposals: {
      acceptedProposal: async () => {
        throw new Error("unused");
      },
    },
    agenda: {
      publishedSessionSchedules: async () => new Map(),
      unscheduleSession: async () => undefined,
    },
    speakerConversion: { createOrLink: async () => ({ speakerId: samProfileId }) },
    newId: () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    createDeliverablesZip,
  });
  /** One deliverable, identified by its bytes so the archive can be traced back to the upload. */
  const upload = (actor: Actor, profileId: string, name: string, byte: number) =>
    service.upload(actor, {
      profileId,
      name,
      contentType: "application/pdf",
      bytes: new Uint8Array([byte]),
    });
  return { repository, service, upload };
}

describe("latest-only deliverables export", () => {
  it("carries the newest version's bytes, not the name of the newest over older bytes", async () => {
    const { service, upload } = fixture();
    await upload(sam, samProfileId, "slides.pdf", 1);
    const second = await upload(sam, samProfileId, "slides.pdf", 2);

    const entries = unzipSync(await service.bulkDownload(organizer, eventId, [second.id]));

    // Both versions are called `slides.pdf`, so a name assertion alone cannot tell an export of
    // v2 from an export of v1 under v2's name. The bytes are what the organizer opens.
    expect(Object.keys(entries)).toEqual(["slides.pdf"]);
    expect(entries["slides.pdf"]).toEqual(new Uint8Array([2]));
    expect(second.versionNumber).toBe(2);
  });

  it("refuses a superseded version rather than exporting it beside its replacement", async () => {
    const { service, upload } = fixture();
    const first = await upload(sam, samProfileId, "slides.pdf", 1);
    const second = await upload(sam, samProfileId, "slides.pdf", 2);

    // "Latest-only" has to be a refusal, not a filter: an export that silently dropped the
    // superseded id would hand back an archive the organizer believes holds two files, and
    // "which slides.pdf is this?" is exactly the ambiguity the export exists to remove.
    await expect(service.bulkDownload(organizer, eventId, [first.id])).rejects.toThrow();
    await expect(service.bulkDownload(organizer, eventId, [first.id, second.id])).rejects.toThrow();
  });

  it("refuses a selection it cannot serve whole", async () => {
    const { service, upload } = fixture();
    const slides = await upload(sam, samProfileId, "slides.pdf", 1);

    // A missing id must not shrink the archive quietly. The organizer counted what they selected.
    await expect(
      service.bulkDownload(organizer, eventId, [slides.id, "90000000-0000-4000-8000-000000000999"]),
    ).rejects.toThrow();
    // And an export is an organizer action: a speaker holds `content:read`, never `content:manage`.
    await expect(service.bulkDownload(sam, eventId, [slides.id])).rejects.toThrow();
  });

  it("keeps two speakers' identically named decks apart", async () => {
    const { service, upload } = fixture();
    const samSlides = await upload(sam, samProfileId, "slides.pdf", 1);
    const adaSlides = await upload(ada, adaProfileId, "slides.pdf", 2);

    const entries = unzipSync(
      await service.bulkDownload(organizer, eventId, [samSlides.id, adaSlides.id]),
    );

    // A ZIP is keyed by name, so a collision does not error — it overwrites, and one speaker's
    // work disappears from an archive that still reports success. Two selected, two delivered,
    // and the disambiguated one names the speaker it belongs to rather than a bare counter.
    expect(Object.keys(entries).toSorted()).toEqual(
      [`slides-${adaProfileId}-1.pdf`, "slides.pdf"].toSorted(),
    );
    expect(entries["slides.pdf"]).toEqual(new Uint8Array([1]));
    expect(entries[`slides-${adaProfileId}-1.pdf`]).toEqual(new Uint8Array([2]));
  });

  it("flattens a name that would otherwise unzip outside the folder it was extracted into", async () => {
    const { service, upload } = fixture();
    // The file name is the speaker's, typed at upload time and never inspected since. Every
    // extractor writes these entry names straight to disk, so a separator surviving into the
    // archive is a path traversal with the organizer's own permissions.
    const traversal = await upload(sam, samProfileId, "../../etc/passwd", 7);

    const entries = unzipSync(await service.bulkDownload(organizer, eventId, [traversal.id]));

    expect(Object.keys(entries)).toEqual(["..-..-etc-passwd"]);
    expect(entries["..-..-etc-passwd"]).toEqual(new Uint8Array([7]));
  });

  it("makes the same archive from the same selection, whenever and in whatever order", async () => {
    const { service, upload } = fixture();
    const samSlides = await upload(sam, samProfileId, "slides.pdf", 1);
    const adaSlides = await upload(ada, adaProfileId, "handout.pdf", 2);

    /*
     * The archive is a function of the selection and nothing else. `createDeliverablesZip` pins
     * the entry mtime and the compression level for exactly this reason — fflate stamps
     * `Date.now()` on every entry otherwise — and `bulkDownload` orders the selection by asset id
     * rather than by the order the ids arrived. Both are asserted at once by moving the clock a
     * year forward and reversing the selection: same bytes, or the export is not reproducible and
     * two organizers comparing checksums of "the same" download disagree.
     */
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
      const morning = await service.bulkDownload(organizer, eventId, [samSlides.id, adaSlides.id]);
      vi.setSystemTime(new Date("2027-01-02T03:04:05.000Z"));
      // fflate reads the global clock through `Date.now`, so a fake that did not reach it would
      // leave the comparison below true for the wrong reason.
      expect(Date.now()).toBe(new Date("2027-01-02T03:04:05.000Z").getTime());
      const nextYear = await service.bulkDownload(organizer, eventId, [adaSlides.id, samSlides.id]);
      expect(nextYear).toEqual(morning);
      expect(Object.keys(unzipSync(nextYear))).toEqual(["handout.pdf", "slides.pdf"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
