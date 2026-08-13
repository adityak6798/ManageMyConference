// @acceptance ACC-EVENT-TEMPLATES
/*
 * The seeded template version, read back by the slices that wrote it.
 *
 * `apps/api/seed/domains/events/templates.sql` says its payload is not hand-written — it is what
 * the six slices exported when the demo event was captured through the running Worker, pasted
 * back into the seed. That is how it was produced, and until this file nothing held it true: a
 * slice whose payload shape moved would leave the seed silently stale, and the demo would offer
 * an organizer a template the slices can no longer read. `docs/quality/scorecard.md` states the
 * claim, so the claim needs a run behind it.
 *
 * Every slice is asked the one question that answers it: hand it its own stored payload and it
 * must read it and name what it would copy. The payload readers refuse an unreadable shape by
 * throwing, so a renamed field fails here rather than at a demo.
 *
 * The destination is unconfigured, and each slice's collaborator is stubbed to say so rather
 * than wired to a repository — what is under test is the payload, not the destination, and the
 * per-slice suites already assert what each one does to a destination that holds something.
 *
 * @spec PRD-EVT-002 ARC-FLOW-006
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sanitizeResourceEmbed,
  sanitizeResourceHtml,
} from "../src/adapters/content/sanitize-resource-html";
import { MemoryContentRepository } from "../src/adapters/persistence/memory-content-repository";
import { DeterministicAssetStorage } from "../src/adapters/storage/deterministic-asset-storage";
import { AgendaNotFoundError } from "../src/application/agenda/agenda-service";
import { agendaTemplateSlice } from "../src/application/agenda/public";
import { cfpTemplateSlice } from "../src/application/cfp/public";
import { ContentService } from "../src/application/content/content-service";
import {
  speakerChecklistTemplateSlice,
  speakerResourceTemplateSlice,
} from "../src/application/content/public";
import type { EventConfigurationSlice } from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import { publishingTemplateSlice } from "../src/application/publishing/public";
import { reviewTemplateSlice } from "../src/application/review/public";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SEEDED_TEMPLATE = "00000000-0000-4000-8000-000000000110";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";

/** The clone an organizer would confirm in the demo: a fresh range in the source's own zone. */
const REMAP = {
  destination: {
    startsOn: "2027-05-10",
    endsOn: "2027-05-12",
    eventId: DESTINATION,
    timezone: "America/Los_Angeles",
  },
  source: { eventId: SOURCE, timezone: "America/Los_Angeles" },
};

/** Nothing is applied before anything here: each slice is asked about its payload alone. */
const CONTEXT = { appliedBefore: [] };

const CAPABILITIES = [
  "events:read",
  "events:settings:read",
  "events:settings:update",
  "content:read",
  "content:manage",
] as const satisfies readonly Capability[];

const organizer: Actor = {
  id: "seed-organizer",
  name: "Olivia Organizer",
  persona: "organizer",
  organizations: [{ id: ORGANIZATION }],
  eventAccess: [{ eventId: DESTINATION, role: "organizer", capabilities: new Set(CAPABILITIES) }],
  capabilities: new Set<Capability>(CAPABILITIES),
};

interface SeededPayload {
  readonly capturedAt: string;
  readonly source: { readonly eventId: string; readonly eventName: string };
  readonly slices: Record<string, unknown>;
}

/**
 * The payload as the table holds it, read out of the seed rather than restated here.
 *
 * Restating it would make this suite assert a copy of the seed against itself, which is the
 * exact failure it exists to catch.
 */
function seededPayload(): SeededPayload {
  const sql = readFileSync(
    new URL("../seed/domains/events/templates.sql", import.meta.url),
    "utf8",
  );
  expect(sql).toContain(SEEDED_TEMPLATE);
  const stored = /^\s*'(\{"capturedAt".*\})',$/m.exec(sql)?.[1];
  if (!stored) throw new Error("The seeded template version no longer carries a payload column.");
  return JSON.parse(stored) as SeededPayload;
}

/**
 * The six slices the composition root builds, over a destination that holds nothing.
 *
 * Content's two are the real service against an empty repository: their previews run the import
 * itself — sanitizer, slug lookup and all — so a stub in their place would assert the payload
 * against nothing. The other four read their destination through one call each, and a stub is
 * the honest way to say "this event was never configured".
 */
function slices(): readonly EventConfigurationSlice[] {
  const content = new ContentService({
    repository: new MemoryContentRepository(),
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
    speakerConversion: {
      createOrLink: async () => {
        throw new Error("unused");
      },
    },
    newId: () => DESTINATION,
    now: () => new Date("2026-08-12T10:00:00.000Z"),
    sanitizeResourceHtml,
    sanitizeResourceEmbed,
  });
  return [
    reviewTemplateSlice({
      reviewConfiguration: async () => ({
        statuses: [],
        plan: null,
        statusesInUse: [],
        hasAssignments: false,
      }),
      configureStatuses: async () => {
        throw new Error("A preview writes nothing.");
      },
      configurePlan: async () => {
        throw new Error("A preview writes nothing.");
      },
    }),
    cfpTemplateSlice({
      getForOrganizer: async () => null,
      routingStatuses: async () => [],
      save: async () => {
        throw new Error("A preview writes nothing.");
      },
    }),
    agendaTemplateSlice({
      // The shape every never-configured destination has, which the slice reads as "no board".
      draft: async () => {
        throw new AgendaNotFoundError("This event has no agenda yet");
      },
      configure: async () => {
        throw new Error("A preview writes nothing.");
      },
    }),
    publishingTemplateSlice(
      {
        preview: async () => {
          throw new Error("A preview writes nothing.");
        },
        updateSettings: async () => {
          throw new Error("A preview writes nothing.");
        },
      },
      { findByEventId: async () => null, findEventIdBySlug: async () => null },
      async () => "Greenroom Demo Summit 2027",
    ),
    // The empty allowlist the composition root passes: an import authorizes no embed host.
    speakerResourceTemplateSlice(content, []),
    speakerChecklistTemplateSlice(content),
  ];
}

describe("the seeded event template", () => {
  it("was captured from the seeded demo event", () => {
    const payload = seededPayload();
    expect(payload.source).toMatchObject({ eventId: SOURCE, eventName: "Greenroom Demo Summit" });
    expect(payload.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries a payload every slice in the composition still reads", async () => {
    const payload = seededPayload();
    const keys = slices().map(({ key }) => key);
    // Both directions: a slice with nothing stored for it, and a stored category no slice claims,
    // are the two ways the seed and the composition drift apart.
    expect([...Object.keys(payload.slices)].sort()).toEqual([...keys].sort());

    for (const slice of slices()) {
      const stored = payload.slices[slice.key];
      const preview = await slice.preview(organizer, DESTINATION, stored, REMAP, CONTEXT);
      expect(preview.outcome, `${slice.key}: ${preview.reason}`).toBe("copies");
      expect(
        preview.copies.length,
        `${slice.key} read its payload and named nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("still names, category by category, what the seed says it holds", async () => {
    const payload = seededPayload();
    const named = new Map<string, string[]>();
    for (const slice of slices()) {
      const preview = await slice.preview(
        organizer,
        DESTINATION,
        payload.slices[slice.key],
        REMAP,
        CONTEXT,
      );
      named.set(
        slice.key,
        preview.copies.map(({ id }) => id),
      );
    }

    // The six triage statuses and the three-criterion rubric the seed's own header describes.
    expect(named.get("review")).toEqual(
      expect.arrayContaining([
        "status:submitted",
        "status:accepted",
        "criterion:relevance",
        "criterion:format",
        "criterion:feedback",
      ]),
    );
    expect(named.get("cfp")).toEqual(
      expect.arrayContaining(["form", "title", "abstract", "name", "email"]),
    );
    expect(named.get("agenda")).toEqual(
      expect.arrayContaining(["room-main", "room-lab", "track-platform", "track-practice"]),
    );
    expect(named.get("publishing")).toEqual(expect.arrayContaining(["summary", "venue"]));
    expect(named.get("content-resources")).toEqual(["speaker-handbook"]);
    expect(named.get("content-checklists")).toHaveLength(3);
  });
});
