// @acceptance ACC-PUBLIC
/**
 * Composing, publishing and registering against a portal.
 *
 * The interesting assertions are all about the seam between what an organizer arranged and what a
 * visitor is served: draft copy never reaches the public composition, a program whose source has
 * gone keeps its place rather than vanishing, page markup is sanitized before it is stored, and a
 * consent record names the notice version in force at the instant it was given rather than the
 * one current when somebody later reads it.
 */
import { describe, expect, it, vi } from "vitest";
import type { Actor, Capability } from "../src/application/identity/actor";
import { CapabilityDeniedError } from "../src/application/identity/actor";
import {
  SiteAlreadyRegisteredError,
  SiteConflictError,
  SiteInvalidError,
  SiteNotFoundError,
  type SiteRepository,
  SiteService,
} from "../src/application/publishing/site-service";
import type { Site } from "../src/domain/publishing/site";

const ORGANIZATION = "00000000-0000-4000-8000-0000000000a0";
const EVENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-0000000000b0";
const NOW = new Date("2026-08-14T09:00:00.000Z");

const organizer: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Odele Organizer",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [
    {
      eventId: EVENT,
      role: "organizer",
      capabilities: new Set<Capability>(["events:read", "events:settings:update"]),
    },
  ],
  capabilities: new Set<Capability>(["events:read", "events:settings:update"]),
};

/** A sanitizer stub that removes exactly what the real one removes, so the test can see it work. */
const sanitize = (input: string) => input.replace(/<script[\s\S]*?<\/script>/gi, "");

function harness(
  over: { resolve?: Map<string, { title: string; state: string }>; seed?: Site } = {},
) {
  const stored = new Map<string, Site>();
  let nextId = 0;
  const notices = new Map<string, { version: number; bodyHtml: string; effectiveAt: string }[]>();
  const consents: {
    id: string;
    siteId: string;
    noticeVersion: number;
    actorRef: string;
    acceptedAt: string;
  }[] = [];
  const publications: { siteId: string; version: number; publishedAt: string }[] = [];
  if (over.seed) stored.set(over.seed.id, over.seed);

  const repository: SiteRepository = {
    listForOrganization: async (organizationId) =>
      [...stored.values()].filter((site) => site.organizationId === organizationId),
    find: async (organizationId, siteId) => {
      const site = stored.get(siteId);
      return site && site.organizationId === organizationId ? site : null;
    },
    findBySlug: async (slug) => [...stored.values()].find((site) => site.slug === slug) ?? null,
    create: async (site) => {
      stored.set(site.id, site);
    },
    save: async (site, expectedRevision) => {
      const held = stored.get(site.id);
      if (!held || held.revision !== expectedRevision) return 0;
      stored.set(site.id, site);
      return 1;
    },
    appendPrivacyNotice: async (siteId, bodyHtml, effectiveAt) => {
      const list = notices.get(siteId) ?? [];
      const version = (list.at(-1)?.version ?? 0) + 1;
      list.push({ version, bodyHtml, effectiveAt });
      notices.set(siteId, list);
      const site = stored.get(siteId);
      if (site) stored.set(siteId, { ...site, privacyNotice: { version, bodyHtml, effectiveAt } });
      return version;
    },
    setState: async ({ siteId, expectedRevision, state, at }) => {
      const site = stored.get(siteId);
      if (!site || site.revision !== expectedRevision) return 0;
      stored.set(siteId, {
        ...site,
        state,
        publishedAt: state === "published" ? at : site.publishedAt,
        revision: site.revision + 1,
      });
      if (state === "published")
        publications.push({ siteId, version: publications.length + 1, publishedAt: at });
      return 1;
    },
    recordConsent: async (consent) => {
      if (
        consents.some(
          (held) => held.siteId === consent.siteId && held.actorRef === consent.actorRef,
        )
      )
        return false;
      consents.push(consent);
      return true;
    },
    listConsents: async (siteId) => consents.filter((consent) => consent.siteId === siteId),
    listPublications: async (siteId) => publications.filter((entry) => entry.siteId === siteId),
  };

  const service = new SiteService({
    repository,
    events: {
      listEventIdsInOrganization: async (organizationId, candidates) =>
        organizationId === ORGANIZATION ? [...candidates] : [],
    },
    sanitize,
    newId: () => `00000000-0000-4000-8000-00000000c0${(nextId++).toString().padStart(2, "0")}`,
    now: () => NOW,
    ...(over.resolve
      ? { programs: { resolve: vi.fn(async () => over.resolve ?? new Map()) } }
      : {}),
  });
  return { service, repository, stored, consents, publications };
}

const draft = {
  slug: "greenroom-portal",
  name: "Greenroom portal",
  landingHeading: "Speak with us",
  programs: [{ kind: "event-cfp" as const, ref: EVENT, label: "Call for proposals" }],
  pages: [
    {
      slug: "code-of-conduct",
      title: "Code of conduct",
      bodyHtml: "<p>Be kind.</p><script>alert(1)</script>",
    },
  ],
  registrationFields: [
    { key: "dietary", label: "Dietary needs", kind: "text" as const, required: false },
  ],
};

describe("composing a portal", () => {
  it("sanitizes page markup before it is stored, not on render", async () => {
    const { service, stored } = harness();
    const site = await service.create(organizer, ORGANIZATION, draft);
    // The durable copy is the safe one: a later reader that forgot to sanitize would still be
    // serving safe markup, which is the whole reason this happens on the way in.
    expect(stored.get(site.id)?.pages[0]?.bodyHtml).toBe("<p>Be kind.</p>");
  });

  it("refuses an organizer of another organization", async () => {
    const { service } = harness();
    await expect(service.create(organizer, OTHER_ORGANIZATION, draft)).rejects.toThrow(
      CapabilityDeniedError,
    );
  });

  it("refuses a custom field that would shadow an identity field", async () => {
    const { service } = harness();
    await expect(
      service.create(organizer, ORGANIZATION, {
        ...draft,
        registrationFields: [{ key: "email", label: "Your address", kind: "text" }],
      }),
    ).rejects.toThrow(SiteInvalidError);
  });

  it("refuses a stale edit rather than interleaving it", async () => {
    const { service } = harness();
    const site = await service.create(organizer, ORGANIZATION, draft);
    await expect(
      service.update(organizer, ORGANIZATION, site.id, { ...draft, expectedRevision: 7 }),
    ).rejects.toThrow(SiteConflictError);
    const saved = await service.update(organizer, ORGANIZATION, site.id, {
      ...draft,
      name: "Renamed",
      expectedRevision: site.revision,
    });
    expect(saved.name).toBe("Renamed");
    expect(saved.revision).toBe(site.revision + 1);
  });
});

describe("publishing a portal", () => {
  it("refuses to go live before a privacy notice exists", async () => {
    const { service } = harness();
    const site = await service.create(organizer, ORGANIZATION, draft);
    // Registration records the version somebody accepted, so a live portal with no notice is a
    // portal that would have to record consent to nothing.
    await expect(service.publish(organizer, ORGANIZATION, site.id, site.revision)).rejects.toThrow(
      SiteInvalidError,
    );
  });

  it("serves nothing at the address until it is published, then serves the composition", async () => {
    const { service } = harness({
      resolve: new Map([[`event-cfp:${EVENT}`, { title: "Call for proposals", state: "open" }]]),
    });
    const site = await service.create(organizer, ORGANIZATION, draft);
    // A draft, an unpublished site and an unknown address are one answer.
    expect(await service.publicSite(draft.slug)).toBeNull();
    await service.publishPrivacyNotice(organizer, ORGANIZATION, site.id, "<p>We keep it.</p>");
    const published = await service.publish(organizer, ORGANIZATION, site.id, site.revision);
    const composed = await service.publicSite(draft.slug);
    expect(composed?.programs[0]).toMatchObject({
      kind: "event-cfp",
      title: "Call for proposals",
      href: `/public/events/${EVENT}/cfp`,
    });
    expect(composed?.pages).toEqual([{ slug: "code-of-conduct", title: "Code of conduct" }]);

    await service.unpublish(organizer, ORGANIZATION, site.id, published.revision);
    expect(await service.publicSite(draft.slug)).toBeNull();
  });

  it("keeps a program whose source has gone, and names it as unresolved to the organizer", async () => {
    const { service } = harness({ resolve: new Map() });
    const site = await service.create(organizer, ORGANIZATION, draft);
    await service.publishPrivacyNotice(organizer, ORGANIZATION, site.id, "<p>We keep it.</p>");
    await service.publish(organizer, ORGANIZATION, site.id, site.revision);
    const composed = await service.publicSite(draft.slug);
    // Its place in the order survives; only the resolved title is missing.
    expect(composed?.programs).toHaveLength(1);
    expect(composed?.programs[0]?.title).toBeUndefined();
    expect(composed?.programs[0]?.label).toBe("Call for proposals");
    const organizerView = await service.get(organizer, ORGANIZATION, site.id);
    expect(organizerView.unresolvedPrograms).toEqual([{ kind: "event-cfp", ref: EVENT }]);
  });

  it("hides a hidden page from the visitor's list and from the page route", async () => {
    const { service } = harness();
    const site = await service.create(organizer, ORGANIZATION, {
      ...draft,
      pages: [{ slug: "draft-notes", title: "Notes", bodyHtml: "<p>x</p>", visibility: "hidden" }],
    });
    await service.publishPrivacyNotice(organizer, ORGANIZATION, site.id, "<p>We keep it.</p>");
    await service.publish(organizer, ORGANIZATION, site.id, site.revision);
    expect((await service.publicSite(draft.slug))?.pages).toEqual([]);
    expect(await service.publicPage(draft.slug, "draft-notes")).toBeNull();
  });
});

describe("registering against a portal", () => {
  async function livePortal() {
    const harnessed = harness();
    const site = await harnessed.service.create(organizer, ORGANIZATION, {
      ...draft,
      registrationFields: [
        { key: "dietary", label: "Dietary needs", kind: "text", required: true },
      ],
    });
    await harnessed.service.publishPrivacyNotice(
      organizer,
      ORGANIZATION,
      site.id,
      "<p>Version one.</p>",
    );
    await harnessed.service.publish(organizer, ORGANIZATION, site.id, site.revision);
    return { ...harnessed, site };
  }

  it("records the version in force at that instant, not the one current later", async () => {
    const { service, consents, site } = await livePortal();
    await service.register(draft.slug, {
      name: "Ada",
      email: "Ada@Example.test",
      accepted: true,
      answers: { dietary: "None" },
    });
    expect(consents[0]).toMatchObject({ noticeVersion: 1, actorRef: "ada@example.test" });

    // A second notice version leaves the first consent naming version 1.
    await service.publishPrivacyNotice(organizer, ORGANIZATION, site.id, "<p>Version two.</p>");
    await service.register(draft.slug, {
      name: "Bea",
      email: "bea@example.test",
      accepted: true,
      answers: { dietary: "Vegan" },
    });
    expect(consents.map(({ noticeVersion }) => noticeVersion)).toEqual([1, 2]);
  });

  it("refuses a registration that did not accept, and one missing a required answer", async () => {
    const { service } = await livePortal();
    await expect(
      service.register(draft.slug, {
        name: "Ada",
        email: "ada@example.test",
        accepted: false,
        answers: { dietary: "None" },
      }),
    ).rejects.toThrow(SiteInvalidError);
    await expect(
      service.register(draft.slug, {
        name: "Ada",
        email: "ada@example.test",
        accepted: true,
        answers: {},
      }),
    ).rejects.toThrow(SiteInvalidError);
  });

  it("drops an answer the form does not ask for", async () => {
    const { service, consents } = await livePortal();
    await service.register(draft.slug, {
      name: "Ada",
      email: "ada@example.test",
      accepted: true,
      answers: { dietary: "None", salary: "secret" },
    });
    // A registration is bounded by the form, not by what a caller chose to send.
    expect(Object.keys((consents[0] as unknown as { answers: object }).answers ?? {})).toEqual([
      "dietary",
      "name",
    ]);
  });

  it("converges on one record when the same address registers twice", async () => {
    const { service, consents } = await livePortal();
    const submission = {
      name: "Ada",
      email: "ada@example.test",
      accepted: true,
      answers: { dietary: "None" },
    };
    await service.register(draft.slug, submission);
    await expect(service.register(draft.slug, submission)).rejects.toThrow(
      SiteAlreadyRegisteredError,
    );
    expect(consents).toHaveLength(1);
  });

  it("refuses a registration against a portal that is not live", async () => {
    const { service } = harness();
    const site = await service.create(organizer, ORGANIZATION, draft);
    await service.publishPrivacyNotice(organizer, ORGANIZATION, site.id, "<p>x</p>");
    await expect(
      service.register(draft.slug, {
        name: "Ada",
        email: "ada@example.test",
        accepted: true,
        answers: {},
      }),
    ).rejects.toThrow(SiteNotFoundError);
  });
});
