// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it, vi } from "vitest";
import { MemoryCfpRepository } from "../src/adapters/persistence/memory-cfp-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { MemorySubmittedProposalAdapter } from "../src/adapters/persistence/memory-submitted-proposal-adapter";
import { CfpService } from "../src/application/cfp/cfp-service";
import { cfpTemplateSlice } from "../src/application/cfp/public";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService } from "../src/application/events/public";
import {
  createDemoSession,
  type DemoPersona,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpAppFrom } from "../src/transport/http/app";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-000000000020";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";
const OUTSIDE = "00000000-0000-4000-8000-000000000099";
const SECRET = "event-template-test-secret";
const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-12" };

async function setup() {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  const eventRepository = new MemoryEventRepository();
  for (const [id, organizationId, name] of [
    [SOURCE, ORGANIZATION, "Greenroom Demo Summit"],
    [DESTINATION, ORGANIZATION, "Greenroom Demo Summit 2027"],
    [OUTSIDE, OTHER_ORGANIZATION, "Private Outside Event"],
  ] as const)
    await eventRepository.create({
      id,
      organizationId,
      name,
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  const events = new EventService({ repository: eventRepository, newId, now });
  const cfp = new CfpService(
    new MemoryCfpRepository(),
    newId,
    now,
    new MemorySubmittedProposalAdapter(),
  );
  await cfp.save(await resolveSeededDemoActor("organizer"), {
    eventId: SOURCE,
    title: "Share your conference story",
    description: "Submit a practical session.",
    fields: [
      {
        id: "title",
        type: "short_text",
        label: "Proposal title",
        guidance: "Keep it specific",
        required: true,
        options: [],
      },
    ],
    expectedVersion: 0,
  });

  const app = createHttpAppFrom({
    events,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: {
      demoMode: true,
      sessionSecret: SECRET,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    cfp,
    eventTemplates: new EventTemplateService({
      repository: new MemoryEventTemplateRepository(),
      events,
      slices: [cfpTemplateSlice(cfp)],
      newId,
      now,
    }),
  });
  const headers = async (persona: DemoPersona) => ({
    cookie: `greenroom_session=${await createDemoSession(persona, SECRET, 2_000)}`,
    "content-type": "application/json",
  });
  return { app, headers };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

const post = (app: App, path: string, headers: Record<string, string>, body: unknown) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

async function saveTemplate(app: App, headers: Record<string, string>, name = "Annual summit") {
  const response = await post(app, `/api/organizations/${ORGANIZATION}/event-templates`, headers, {
    name,
    sourceEventId: SOURCE,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    template: { id: string; name: string; state: string };
    version: { id: string; version: number; slices: string[] };
    slices: { key: string; outcome: string }[];
  };
}

describe("Event template HTTP journey", () => {
  it("saves, lists, versions, renames, archives and duplicates a template", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");

    const created = await saveTemplate(app, organizer);
    expect(created.version.slices).toEqual(["cfp"]);
    expect(created.slices).toEqual([
      {
        key: "cfp",
        label: "CFP form and routing",
        outcome: "captured",
        reason: expect.any(String),
      },
    ]);

    const listed = await app.request(`/api/organizations/${ORGANIZATION}/event-templates`, {
      headers: organizer,
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      templates: [expect.objectContaining({ id: created.template.id, name: "Annual summit" })],
    });

    const versioned = await post(
      app,
      `/api/event-templates/${created.template.id}/versions`,
      organizer,
      { sourceEventId: SOURCE },
    );
    expect(versioned.status).toBe(201);

    const renamed = await app.request(`/api/event-templates/${created.template.id}`, {
      method: "PATCH",
      headers: organizer,
      body: JSON.stringify({ name: "Annual summit v2", state: "archived" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toEqual({
      template: expect.objectContaining({ name: "Annual summit v2", state: "archived" }),
    });

    const duplicated = await post(
      app,
      `/api/event-templates/${created.template.id}/duplications`,
      organizer,
      { name: "Regional summit" },
    );
    expect(duplicated.status).toBe(201);

    const detail = await app.request(`/api/event-templates/${created.template.id}`, {
      headers: organizer,
    });
    const body = (await detail.json()) as { versions: { version: number; slices: string[] }[] };
    expect(body.versions.map(({ version }) => version)).toEqual([2, 1]);
    // The stored payloads never cross this boundary; a version is described, not dumped.
    expect(JSON.stringify(body)).not.toContain("Proposal title");
  });

  it("previews without writing, then applies and converges on a repeat", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");
    const created = await saveTemplate(app, organizer);
    const command = {
      templateId: created.template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    };

    const preview = await post(
      app,
      `/api/events/${DESTINATION}/template-application-previews`,
      organizer,
      command,
    );
    expect(preview.status).toBe(200);
    const plan = (await preview.json()) as {
      plan: { slices: { key: string; outcome: string; excludes: { id: string }[] }[] };
    };
    expect(plan.plan.slices.map(({ key, outcome }) => [key, outcome])).toEqual([
      ["cfp", "copies"],
      ["communications", "skipped"],
    ]);
    const readCfp = async () =>
      await app.request(`/api/events/${DESTINATION}/cfp`, { headers: organizer });
    expect((await readCfp()).status).toBe(404);

    const first = await post(
      app,
      `/api/events/${DESTINATION}/template-applications`,
      organizer,
      command,
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ application: { outcome: "applied" } });

    const applied = await (await readCfp()).text();
    const second = await post(
      app,
      `/api/events/${DESTINATION}/template-applications`,
      organizer,
      command,
    );
    expect(second.status).toBe(200);
    // Byte-identical, version counter included: applying again converged instead of rewriting.
    await expect((await readCfp()).text()).resolves.toBe(applied);
  });

  it("answers 409 for a name another active template already holds", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");
    await saveTemplate(app, organizer);

    const clash = await post(app, `/api/organizations/${ORGANIZATION}/event-templates`, organizer, {
      name: "Annual summit",
      sourceEventId: SOURCE,
    });

    expect(clash.status).toBe(409);
    await expect(clash.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("answers 400 for a destination range that ends before it starts", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");
    const created = await saveTemplate(app, organizer);

    const refused = await post(app, `/api/events/${DESTINATION}/template-applications`, organizer, {
      templateId: created.template.id,
      version: 1,
      destination: { startsOn: "2027-05-12", endsOn: "2027-05-10" },
    });

    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("answers 404 for a version that does not exist", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");
    const created = await saveTemplate(app, organizer);

    const missing = await post(app, `/api/events/${DESTINATION}/template-applications`, organizer, {
      templateId: created.template.id,
      version: 7,
      destination: DESTINATION_RANGE,
    });

    expect(missing.status).toBe(404);
  });

  it("denies a speaker and refuses an anonymous caller", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");
    const created = await saveTemplate(app, organizer);
    const speaker = await headers("speaker");

    const denied = await post(app, `/api/events/${SOURCE}/template-applications`, speaker, {
      templateId: created.template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });
    const anonymous = await app.request(`/api/organizations/${ORGANIZATION}/event-templates`, {
      headers: { "content-type": "application/json" },
    });

    expect(denied.status).toBe(403);
    expect(anonymous.status).toBe(401);
  });

  it("hides another organization's template behind the same 404 as an unknown id", async () => {
    const { app, headers } = await setup();
    const organizer = await headers("organizer");
    const created = await saveTemplate(app, organizer);
    // The reviewer holds no organization membership at all, which is the closest the seeded
    // demo identities come to a caller outside this template's organization.
    const outsider = await headers("reviewer");

    const foreign = await app.request(`/api/event-templates/${created.template.id}`, {
      headers: outsider,
    });
    const unknown = await app.request("/api/event-templates/00000000-0000-4000-8000-0000000000ff", {
      headers: outsider,
    });

    // Byte-identical apart from the correlation id, which is per request by construction. A
    // caller who can tell the two apart can enumerate another organization's templates.
    const withoutCorrelation = async (response: Response) => {
      const { error } = (await response.json()) as { error: Record<string, unknown> };
      const { correlationId: _ignored, ...rest } = error;
      return rest;
    };
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await withoutCorrelation(foreign)).toEqual(await withoutCorrelation(unknown));
  });
});
