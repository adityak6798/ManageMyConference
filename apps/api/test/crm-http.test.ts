// @acceptance ACC-CRM
import { describe, expect, it, vi } from "vitest";
import { MemoryCrmRepository } from "../src/adapters/persistence/memory-crm-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { CrmService } from "../src/application/crm/crm-service";
import { EventService } from "../src/application/events/event-service";
import {
  createDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createHttpApp } from "../src/transport/http/app";

const secret = "crm-http-secret",
  eventId = "00000000-0000-4000-8000-000000000001";
const cookie = async (persona: "organizer" | "reviewer" | "speaker" | "public") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
  "content-type": "application/json",
});
const setup = () => {
  const ids = [
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000001",
  ];
  const crm = new CrmService({
    repository: new MemoryCrmRepository(),
    speakerConversion: {
      createOrLink: async () => ({ speakerId: "40000000-0000-4000-8000-000000000001" }),
    },
    // The seeded staff of event one, exactly as the identity directory reports them: the
    // speaker persona is absent, and nobody from another event appears.
    identities: {
      listAssignableOwnersForEvent: async (scopedEventId) =>
        scopedEventId === eventId
          ? [
              { id: "seed-organizer", name: "Olivia Organizer" },
              { id: "seed-reviewer", name: "Ravi Reviewer" },
            ]
          : [],
    },
    newId: () => ids.shift() ?? crypto.randomUUID(),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  const events = new EventService({
    repository: new MemoryEventRepository(),
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
  return createHttpApp(
    events,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      demoMode: true,
      sessionSecret: secret,
      now: () => 1_000,
      resolveActor: resolveSeededDemoActor,
    },
    crm,
  );
};

describe("ACC-CRM HTTP", () => {
  it("creates, updates, lists, and converts through validated contracts", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const created = await app.request(`/api/events/${eventId}/prospects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "HTTP Prospect",
        ownerId: "seed-organizer",
        contact: { name: "Primary", email: "primary@example.test" },
      }),
    });
    expect(created.status).toBe(201);
    const prospect = (await created.json()).prospect;
    const updated = await app.request(`/api/events/${eventId}/prospects/${prospect.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        stage: "contacted",
        nextAction: "Call tomorrow",
        activity: { kind: "note", summary: "Private note", private: true },
        contact: { name: "Assistant", email: "assistant@example.test", isPrimary: false },
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      prospect: {
        stage: "contacted",
        nextAction: "Call tomorrow",
        contacts: [{ email: "primary@example.test" }, { email: "assistant@example.test" }],
        activities: [
          { kind: "stage-change", summary: "identified → contacted", private: false },
          { summary: "Private note", private: true },
        ],
      },
    });
    expect(
      (await app.request(`/api/events/${eventId}/prospects?stage=contacted`, { headers })).status,
    ).toBe(200);
    const converted = await app.request(`/api/events/${eventId}/prospects/${prospect.id}/convert`, {
      method: "POST",
      headers,
    });
    await expect(converted.json()).resolves.toMatchObject({
      prospect: { stage: "converted", speakerId: expect.any(String) },
    });
    expect(
      (
        await app.request(`/api/events/${eventId}/prospects/${prospect.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ stage: "contacted" }),
        })
      ).status,
    ).toBe(409);
  });

  it("refuses a client-authored stage-change and narrates the real one itself", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const created = await app.request(`/api/events/${eventId}/prospects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Timeline Prospect",
        ownerId: "seed-organizer",
        contact: { name: "Primary", email: "primary@example.test" },
      }),
    });
    const prospect = (await created.json()).prospect;
    const path = `/api/events/${eventId}/prospects/${prospect.id}`;

    // `stage-change` is written by the service as it applies the transition. A client that
    // could submit one could put a transition on the timeline that never happened — three
    // of them, on a prospect that moved once.
    const forged = await app.request(path, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        activity: { kind: "stage-change", summary: "invited → converted", private: false },
      }),
    });
    expect(forged.status).toBe(400);
    await expect(forged.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { "activity.kind": expect.any(Array) } },
    });
    // `conversion` is the service's word too, and the refusal costs nothing else: the
    // prospect is untouched and still holds an empty timeline.
    expect(
      (
        await app.request(path, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            activity: { kind: "conversion", summary: "Converted", private: false },
          }),
        })
      ).status,
    ).toBe(400);
    await expect((await app.request(path, { headers })).json()).resolves.toMatchObject({
      prospect: { stage: "identified", activities: [] },
    });

    // One real transition, narrated once, by the only writer allowed to narrate it.
    const moved = await app.request(path, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ stage: "contacted" }),
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      prospect: {
        stage: "contacted",
        activities: [{ kind: "stage-change", summary: "identified → contacted", private: false }],
      },
    });
  });

  it("serves the assignable owners and refuses one it did not offer with a field error", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const owners = await app.request(`/api/events/${eventId}/prospects/owners`, { headers });
    expect(owners.status).toBe(200);
    await expect(owners.json()).resolves.toEqual({
      owners: [
        { id: "seed-organizer", name: "Olivia Organizer" },
        { id: "seed-reviewer", name: "Ravi Reviewer" },
      ],
    });

    // Free text used to reach the `crm_prospects.owner_id` foreign key and surface as a 500.
    const refused = await app.request(`/api/events/${eventId}/prospects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "HTTP Prospect",
        ownerId: "not-a-real-user-at-all",
        contact: { name: "Primary", email: "primary@example.test" },
      }),
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: { ownerId: ["Choose an organizer or reviewer assigned to this event."] },
      },
    });

    const created = await app.request(`/api/events/${eventId}/prospects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "HTTP Prospect",
        ownerId: "seed-organizer",
        contact: { name: "Primary", email: "primary@example.test" },
      }),
    });
    const prospect = (await created.json()).prospect;
    // A speaker-only identity is not staff, so it cannot own a prospect either.
    const speakerOwner = await app.request(`/api/events/${eventId}/prospects/${prospect.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ownerId: "seed-speaker" }),
    });
    expect(speakerOwner.status).toBe(400);
    await expect(speakerOwner.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { ownerId: expect.any(Array) } },
    });
  });

  it("denies every non-organizer and cross-event request before lookup", async () => {
    const app = setup();
    expect((await app.request(`/api/events/${eventId}/prospects`)).status).toBe(401);
    for (const persona of ["reviewer", "speaker", "public"] as const)
      expect(
        (await app.request(`/api/events/${eventId}/prospects`, { headers: await cookie(persona) }))
          .status,
      ).toBe(403);
    expect(
      (
        await app.request("/api/events/00000000-0000-4000-8000-000000000099/prospects", {
          headers: await cookie("organizer"),
        })
      ).status,
    ).toBe(403);
  });
});
