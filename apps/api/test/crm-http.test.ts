// @acceptance ACC-CRM
import {
  contactDashboardResponseSchema,
  contactListResponseSchema,
  duplicateListResponseSchema,
  importContactsResponseSchema,
  importPreviewResponseSchema,
  organizationContactSchema,
  outreachPreviewResponseSchema,
  outreachResponseSchema,
  pushContactToEventResponseSchema,
  segmentResponseSchema,
} from "@greenroom/contracts";
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
/** The demo organization the seeded organizer belongs to, and its second event. */
const organizationId = "00000000-0000-4000-8000-000000000010";
const otherEventId = "00000000-0000-4000-8000-000000000002";
const outsideOrganizationId = "00000000-0000-4000-8000-000000000020";
const directory = (path: string) => `/api/organizations/${organizationId}/crm/${path}`;
const cookie = async (persona: "organizer" | "reviewer" | "speaker" | "public") => ({
  cookie: `greenroom_session=${await createDemoSession(persona, secret, 2_000)}`,
  "content-type": "application/json",
});
const setup = () => {
  const send = vi.fn(async () => ({ deliveryId: "delivery-http", created: true }));
  const prepare = vi.fn(async () => undefined);
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
    // The seeded staff, exactly as the identity directory reports them: the speaker persona is
    // absent, the reviewer staffs event one alone, and no event outside the organization has
    // anybody this organizer could name.
    identities: {
      listAssignableOwnersForEvent: async (scopedEventId) =>
        scopedEventId === eventId
          ? [
              { id: "seed-organizer", name: "Olivia Organizer" },
              { id: "seed-reviewer", name: "Ravi Reviewer" },
            ]
          : scopedEventId === otherEventId
            ? [{ id: "seed-organizer", name: "Olivia Organizer" }]
            : [],
    },
    // The events domain's answer, as the CRM consumes it: the two seeded events belong to the
    // demo organization and the outside event does not.
    events: {
      belongsToOrganization: async (event, organization) =>
        organization === organizationId && [eventId, otherEventId].includes(event),
      listEventIdsInOrganization: async (organization, candidates) =>
        organization === organizationId
          ? candidates.filter((event) => [eventId, otherEventId].includes(event))
          : [],
    },
    outreach: { prepare, send },
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
          { kind: "stage-change", summary: "Identified → Contacted", private: false },
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
        activities: [{ kind: "stage-change", summary: "Identified → Contacted", private: false }],
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

describe("ACC-CRM organization directory HTTP", () => {
  it("serves the directory, its filters, and a contact profile through validated contracts", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const created = await app.request(directory("contacts"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Ada Rivera",
        email: "ADA@Example.test",
        company: "Northwind",
        title: "Principal Engineer",
        tags: ["keynote", "ai"],
        fields: [{ key: "topic", value: "accessibility" }],
      }),
    });
    expect(created.status).toBe(201);
    const contact = organizationContactSchema.parse((await created.json()).contact);
    expect(contact.email).toBe("ada@example.test");

    const listed = await app.request(`${directory("contacts")}?tags=keynote,ai`, { headers });
    expect(listed.status).toBe(200);
    const body = contactListResponseSchema.parse(await listed.json());
    expect(body.contacts.map(({ id }) => id)).toEqual([contact.id]);
    // The echoed filters are what makes "no matches" distinguishable from "no filter".
    expect(body.filters).toEqual({ tags: ["keynote", "ai"] });

    const narrowed = await app.request(`${directory("contacts")}?company=Southwind`, { headers });
    expect((await narrowed.json()).contacts).toHaveLength(0);

    const noted = await app.request(`${directory(`contacts/${contact.id}`)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        notes: "Prefers a morning slot",
        activity: { kind: "note", summary: "Met at the meetup", private: true },
      }),
    });
    expect(noted.status).toBe(200);
    const profile = organizationContactSchema.parse((await noted.json()).contact);
    expect(profile.notes).toBe("Prefers a morning slot");
    expect(profile.activities.map(({ kind }) => kind)).toEqual(["note"]);

    // A second live contact on one address is a conflict the caller can act on, named on the
    // field, rather than a unique-index failure surfacing as a 500.
    const clash = await app.request(directory("contacts"), {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "A. Rivera", email: "ada@example.test" }),
    });
    expect(clash.status).toBe(409);
    await expect(clash.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", fieldErrors: { email: expect.any(Array) } },
    });
  });

  it("imports a file, merges the near duplicate it creates, and reports the dashboard", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const csv = [
      "name,email,company",
      "Ada Rivera,ada@example.test,Northwind",
      "Ada Rivera,ada.rivera@personal.test,Northwind",
    ].join("\n");

    const preview = await app.request(directory("imports/preview"), {
      method: "POST",
      headers,
      body: JSON.stringify({ filename: "speakers.csv", csv }),
    });
    expect(importPreviewResponseSchema.parse(await preview.json()).summary).toEqual({
      create: 2,
      update: 0,
      skip: 0,
    });
    const imported = await app.request(directory("imports"), {
      method: "POST",
      headers,
      body: JSON.stringify({ filename: "speakers.csv", csv }),
    });
    expect(imported.status).toBe(201);
    expect(importContactsResponseSchema.parse(await imported.json()).import.createdCount).toBe(2);

    const duplicates = duplicateListResponseSchema.parse(
      await (await app.request(directory("duplicates"), { headers })).json(),
    );
    expect(duplicates.groups).toHaveLength(1);
    const [group] = duplicates.groups;
    const merged = await app.request(directory("merges"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        primaryId: group?.suggestedPrimaryId,
        duplicateIds: group?.contactIds.filter((id) => id !== group.suggestedPrimaryId),
      }),
    });
    expect(merged.status).toBe(200);
    expect(organizationContactSchema.parse((await merged.json()).contact).aliases).toHaveLength(1);

    const dashboard = contactDashboardResponseSchema.parse(
      await (await app.request(directory("dashboard"), { headers })).json(),
    );
    // Counted over what was stored, not asserted as a constant: two rows arrived, one merged.
    expect(dashboard.contacts).toBe(1);
    expect(dashboard.imported).toBe(1);
    expect(dashboard.topCompanies).toEqual([{ company: "Northwind", contacts: 1 }]);
  });

  it("sources a contact into an event and sends segmented outreach", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const contact = organizationContactSchema.parse(
      (
        await (
          await app.request(directory("contacts"), {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: "Ada Rivera",
              email: "ada@example.test",
              tags: ["keynote"],
            }),
          })
        ).json()
      ).contact,
    );

    const pushed = await app.request(directory(`contacts/${contact.id}/events`), {
      method: "POST",
      headers,
      body: JSON.stringify({ eventId, ownerId: "seed-organizer", convert: true }),
    });
    expect(pushed.status).toBe(201);
    const result = pushContactToEventResponseSchema.parse(await pushed.json());
    expect(result.prospect.speakerId).not.toBeNull();
    expect(result.contact.events.map(({ eventId: id }) => id)).toEqual([eventId]);

    const segment = segmentResponseSchema.parse(
      await (
        await app.request(directory("segments"), {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Keynote shortlist", filters: { tags: ["keynote"] } }),
        })
      ).json(),
    );
    const previewed = outreachPreviewResponseSchema.parse(
      await (
        await app.request(directory("outreach/preview"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            eventId,
            templateKey: "speaker-invite",
            segmentId: segment.segment.id,
          }),
        })
      ).json(),
    );
    expect(previewed.recipients.map(({ email }) => email)).toEqual(["ada@example.test"]);

    const sent = outreachResponseSchema.parse(
      await (
        await app.request(directory("outreach"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            eventId,
            templateKey: "speaker-invite",
            segmentId: segment.segment.id,
          }),
        })
      ).json(),
    );
    expect(sent.sent[0]?.deliveryId).toBe("delivery-http");
  });

  it("refuses the directory to every identity outside this organization's CRM", async () => {
    const app = setup();
    expect((await app.request(directory("contacts"))).status).toBe(401);
    // Reviewer and speaker are staffed on this organization's event and hold no `crm:manage`;
    // the route refuses before the service is reached.
    for (const persona of ["reviewer", "speaker", "public"] as const)
      expect(
        (await app.request(directory("contacts"), { headers: await cookie(persona) })).status,
      ).toBe(403);
    // The organizer holds `crm:manage` and belongs to one organization. Naming another is not a
    // 404 that leaks whether it exists — it is a refusal.
    expect(
      (
        await app.request(`/api/organizations/${outsideOrganizationId}/crm/contacts`, {
          headers: await cookie("organizer"),
        })
      ).status,
    ).toBe(403);
  });

  it("refuses to source a contact into an event outside the organization", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    const contact = organizationContactSchema.parse(
      (
        await (
          await app.request(directory("contacts"), {
            method: "POST",
            headers,
            body: JSON.stringify({ name: "Ada Rivera", email: "ada@example.test" }),
          })
        ).json()
      ).contact,
    );
    // `seed-organizer` organizes both seeded events, so this reaches the organization check
    // rather than stopping at the capability one: event 2 is in the organization, event 99 is
    // not, and only the second is refused here.
    expect(
      (
        await app.request(directory(`contacts/${contact.id}/events`), {
          method: "POST",
          headers,
          body: JSON.stringify({ eventId: otherEventId, ownerId: "seed-organizer" }),
        })
      ).status,
    ).toBe(201);
    const outside = await app.request(directory(`contacts/${contact.id}/events`), {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventId: "00000000-0000-4000-8000-000000000099",
        ownerId: "seed-organizer",
      }),
    });
    expect(outside.status).toBe(403);
  });

  it("answers a malformed directory request as a refusal rather than a crash", async () => {
    const app = setup(),
      headers = await cookie("organizer");
    expect(
      (await app.request("/api/organizations/not-a-uuid/crm/contacts", { headers })).status,
    ).toBe(400);
    const unknown = await app.request(directory("contacts/00000000-0000-4000-8000-0000000000ff"), {
      headers,
    });
    expect(unknown.status).toBe(404);
    const emptyPatch = await app.request(
      directory("contacts/00000000-0000-4000-8000-0000000000ff"),
      { method: "PATCH", headers, body: JSON.stringify({}) },
    );
    expect(emptyPatch.status).toBe(400);
    const badFile = await app.request(directory("imports/preview"), {
      method: "POST",
      headers,
      body: JSON.stringify({ filename: "wrong.csv", csv: "first,last\nAda,Rivera" }),
    });
    expect(badFile.status).toBe(400);
    await expect(badFile.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", fieldErrors: { csv: expect.any(Array) } },
    });
  });
});
