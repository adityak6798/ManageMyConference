// @acceptance ACC-PUBLIC
/**
 * Sites against a real, migrated, seeded D1 database.
 *
 * Four claims are only true here.
 *
 * **A privacy-notice version and a consent record are immutable at the table.** Both are guarded
 * by triggers rather than by the one service that writes them, and the point of each is what it
 * makes the other mean: a consent names a version, so a version whose text a later `UPDATE` could
 * move would make every consent a claim about words nobody can produce.
 *
 * **A save rewrites four child collections atomically, or none of them.** Every statement after
 * the guarded `UPDATE` re-tests the stored revision, so a lost race leaves the previous
 * arrangement whole rather than half-replaced.
 *
 * **Two notices published at once produce two versions.** The next version is computed inside the
 * statement, so neither writer reads a number the other is about to take.
 *
 * **One address registers once.** `ON CONFLICT DO NOTHING` against a unique index is what makes a
 * repeated submission converge rather than grow a second consent row for one person.
 */
import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  D1SiteRepository,
  type SiteDatabasePort,
} from "../src/adapters/persistence/d1-site-repository";
import { SiteSlugTakenError } from "../src/application/publishing/site-service";
import type { Site } from "../src/domain/publishing/site";
import { createMigratedDatabase } from "./support/seeded-d1";

const DEMO_ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SITE = "00000000-0000-4000-8000-0000000000d0";
const NOW = "2026-08-14T09:00:00.000Z";

const siteOf = (over: Partial<Site> = {}): Site => ({
  id: SITE,
  organizationId: DEMO_ORGANIZATION,
  slug: "greenroom-portal",
  name: "Greenroom portal",
  tagline: "",
  landingHeading: "Speak with us",
  landingBody: "",
  loginHeading: "",
  loginBody: "",
  theme: "light",
  primaryColor: "#2f5d50",
  state: "draft",
  publishedAt: null,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  programs: [
    { kind: "event-cfp", ref: "00000000-0000-4000-8000-000000000001", label: "CFP", position: 0 },
  ],
  pages: [
    {
      id: "00000000-0000-4000-8000-0000000000d1",
      slug: "code-of-conduct",
      title: "Code of conduct",
      bodyHtml: "<p>Be kind.</p>",
      position: 0,
      visibility: "visible",
    },
  ],
  registrationFields: [
    {
      key: "dietary",
      label: "Dietary needs",
      kind: "text",
      required: true,
      options: [],
      position: 0,
    },
  ],
  privacyNotice: null,
  ...over,
});

describe("sites against D1", () => {
  let runtime: Miniflare | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  async function stack() {
    const migrated = await createMigratedDatabase({ seed: true, label: "sites" });
    runtime = migrated.runtime;
    const database = migrated.database as unknown as SiteDatabasePort;
    return { database, repository: new D1SiteRepository(database) };
  }

  it("round-trips a site with its four child collections", async () => {
    const { repository } = await stack();
    await repository.create(siteOf());
    const stored = await repository.find(DEMO_ORGANIZATION, SITE);
    expect(stored?.programs).toHaveLength(1);
    expect(stored?.pages[0]?.bodyHtml).toBe("<p>Be kind.</p>");
    expect(stored?.registrationFields[0]).toMatchObject({ key: "dietary", required: true });
    // Scoped by organization: another organization's id finds nothing rather than the row.
    expect(await repository.find("00000000-0000-4000-8000-000000000099", SITE)).toBeNull();
  });

  it("refuses a public address another site already holds", async () => {
    const { repository } = await stack();
    await repository.create(siteOf());
    await expect(
      repository.create(siteOf({ id: "00000000-0000-4000-8000-0000000000d9" })),
    ).rejects.toThrow(SiteSlugTakenError);
  });

  it("leaves the previous arrangement whole when a save loses the revision race", async () => {
    const { repository } = await stack();
    await repository.create(siteOf());
    const rearranged = siteOf({
      revision: 2,
      name: "Renamed",
      programs: [],
      pages: [],
      registrationFields: [],
    });
    expect(await repository.save(rearranged, 7)).toBe(0);
    const unchanged = await repository.find(DEMO_ORGANIZATION, SITE);
    expect(unchanged?.revision).toBe(1);
    expect(unchanged?.programs).toHaveLength(1);
    expect(unchanged?.pages).toHaveLength(1);
    expect(unchanged?.registrationFields).toHaveLength(1);

    expect(await repository.save(rearranged, 1)).toBe(1);
    const moved = await repository.find(DEMO_ORGANIZATION, SITE);
    expect(moved?.name).toBe("Renamed");
    expect(moved?.programs).toEqual([]);
    expect(moved?.pages).toEqual([]);
  });

  it("appends notice versions, and refuses an edit to one that has been given", async () => {
    const { database, repository } = await stack();
    await repository.create(siteOf());
    expect(await repository.appendPrivacyNotice(SITE, "<p>One.</p>", NOW)).toBe(1);
    expect(await repository.appendPrivacyNotice(SITE, "<p>Two.</p>", NOW)).toBe(2);
    expect((await repository.find(DEMO_ORGANIZATION, SITE))?.privacyNotice).toMatchObject({
      version: 2,
      bodyHtml: "<p>Two.</p>",
    });
    await expect(
      database
        .prepare("UPDATE site_privacy_notices SET body_html = ? WHERE site_id = ? AND version = 1")
        .bind("<p>Rewritten.</p>", SITE)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  it("records one consent per address, and refuses an edit to it", async () => {
    const { database, repository } = await stack();
    await repository.create(siteOf());
    await repository.appendPrivacyNotice(SITE, "<p>One.</p>", NOW);
    const consent = {
      id: "00000000-0000-4000-8000-0000000000e0",
      siteId: SITE,
      noticeVersion: 1,
      actorRef: "ada@example.test",
      acceptedAt: NOW,
      answers: { dietary: "None", name: "Ada" },
    };
    expect(await repository.recordConsent(consent)).toBe(true);
    // A repeat submission converges on the record already stored.
    expect(
      await repository.recordConsent({ ...consent, id: "00000000-0000-4000-8000-0000000000e1" }),
    ).toBe(false);
    expect(await repository.listConsents(SITE, 10)).toHaveLength(1);
    await expect(
      database
        .prepare("UPDATE site_consents SET notice_version = 9 WHERE id = ?")
        .bind(consent.id)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  it("refuses a consent naming a notice version this site never published", async () => {
    const { repository } = await stack();
    await repository.create(siteOf());
    await repository.appendPrivacyNotice(SITE, "<p>One.</p>", NOW);
    await expect(
      repository.recordConsent({
        id: "00000000-0000-4000-8000-0000000000e2",
        siteId: SITE,
        noticeVersion: 4,
        actorRef: "bea@example.test",
        acceptedAt: NOW,
        answers: {},
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("appends an immutable publish record, and none when the publish loses its race", async () => {
    const { database, repository } = await stack();
    await repository.create(siteOf());
    await repository.appendPrivacyNotice(SITE, "<p>One.</p>", NOW);
    expect(
      await repository.setState({
        siteId: SITE,
        expectedRevision: 7,
        state: "published",
        at: NOW,
        snapshot: { slug: "greenroom-portal" },
      }),
    ).toBe(0);
    // A publish that lost the revision race appends no history row, so the history cannot claim
    // a version that never served.
    expect(await repository.listPublications(SITE)).toEqual([]);

    expect(
      await repository.setState({
        siteId: SITE,
        expectedRevision: 1,
        state: "published",
        at: NOW,
        snapshot: { slug: "greenroom-portal" },
      }),
    ).toBe(1);
    expect(await repository.listPublications(SITE)).toEqual([{ version: 1, publishedAt: NOW }]);
    await expect(
      database.prepare("DELETE FROM site_publications WHERE site_id = ?").bind(SITE).run(),
    ).rejects.toThrow(/append-only/i);
  });
});
