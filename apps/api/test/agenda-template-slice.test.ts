// @acceptance ACC-EVENT-TEMPLATES
import { describe, expect, it, vi } from "vitest";
import { MemoryAgendaRepository } from "../src/adapters/persistence/memory-agenda-repository";
import { MemoryEventRepository } from "../src/adapters/persistence/memory-event-repository";
import { MemoryEventTemplateRepository } from "../src/adapters/persistence/memory-event-template-repository";
import { AgendaService } from "../src/application/agenda/agenda-service";
import { agendaTemplateSlice } from "../src/application/agenda/public";
import { FixtureSchedulableContentQuery } from "../src/application/content/public";
import { EventService } from "../src/application/events/event-service";
import { EventTemplateService, type SliceFault } from "../src/application/events/public";
import type { Actor, Capability } from "../src/application/identity/actor";
import type { AgendaDraft } from "../src/domain/agenda/agenda";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";
const SOURCE = "00000000-0000-4000-8000-000000000001";
const DESTINATION = "00000000-0000-4000-8000-000000000002";

const ORGANIZER_CAPABILITIES = [
  "events:read",
  "events:create",
  "events:settings:read",
  "events:settings:update",
  "agenda:manage",
] as const satisfies readonly Capability[];

/** Two days in May, in a different month and a different zone from the source's September. */
const DESTINATION_RANGE = { startsOn: "2027-05-10", endsOn: "2027-05-11" };

function organizer(capabilities: readonly Capability[] = ORGANIZER_CAPABILITIES): Actor {
  const granted = new Set<Capability>(capabilities);
  return {
    id: "seed-organizer",
    name: "Olivia Organizer",
    persona: "organizer",
    organizations: [{ id: ORGANIZATION }],
    eventAccess: [SOURCE, DESTINATION].map((eventId) => ({
      eventId,
      role: "organizer" as const,
      capabilities: granted,
    })),
    capabilities: granted,
  };
}

const SOURCE_ROOMS = [
  { id: "room-main", name: "Main stage" },
  { id: "room-lab", name: "Lab" },
];
const SOURCE_TRACKS = [{ id: "track-web", name: "Web", color: "#5b5bd6" }];

/**
 * Three conference days on the source event's own clock, written as the instants it stores.
 *
 * `slot-evening` is the one that makes the anchor testable: 20:00 in Los Angeles is already the
 * *next* date in UTC, so a remap that counted days in UTC would push it onto the destination's
 * second morning instead of leaving it on the first evening where the organizer put it.
 */
const SOURCE_SLOTS = [
  // Day 0, 09:00–10:00 PDT.
  { id: "slot-keynote", startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:00:00.000Z" },
  // Day 0, 20:00–21:00 PDT — the following date in UTC.
  { id: "slot-evening", startsAt: "2026-09-02T03:00:00.000Z", endsAt: "2026-09-02T04:00:00.000Z" },
  // Day 1, 09:00–10:00 PDT.
  { id: "slot-workshop", startsAt: "2026-09-02T16:00:00.000Z", endsAt: "2026-09-02T17:00:00.000Z" },
  // Day 2, 09:00–10:00 PDT — one day more than the destination event has.
  { id: "slot-closing", startsAt: "2026-09-03T16:00:00.000Z", endsAt: "2026-09-03T17:00:00.000Z" },
];
const SOURCE_SESSIONS = [
  { id: "session-keynote", title: "Opening keynote", speakerIds: ["speaker-1"] },
];
const SOURCE_PLACEMENTS = [
  {
    id: "place-keynote",
    sessionId: "session-keynote",
    roomId: "room-main",
    trackId: "track-web",
    slotId: "slot-keynote",
  },
];

async function setup(
  options: {
    sourceTimezone?: string;
    destinationTimezone?: string;
    source?: Partial<AgendaDraft>;
    destination?: AgendaDraft;
    onSliceFault?: (fault: SliceFault) => void;
  } = {},
) {
  let sequence = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => new Date("2026-08-12T10:00:00.000Z");

  const eventRepository = new MemoryEventRepository();
  for (const [id, name, timezone] of [
    [SOURCE, "Greenroom Demo Summit", options.sourceTimezone ?? "America/Los_Angeles"],
    [DESTINATION, "Greenroom Demo Summit 2027", options.destinationTimezone ?? "Europe/Berlin"],
  ] as const)
    await eventRepository.create({
      id,
      organizationId: ORGANIZATION,
      name,
      timezone,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  const events = new EventService({ repository: eventRepository, newId, now });

  const board: AgendaDraft = {
    eventId: SOURCE,
    rooms: SOURCE_ROOMS,
    tracks: SOURCE_TRACKS,
    slots: SOURCE_SLOTS,
    sessions: [],
    placements: SOURCE_PLACEMENTS,
    ...options.source,
  };
  const agendaRepository = new MemoryAgendaRepository([
    board,
    ...(options.destination ? [options.destination] : []),
  ]);
  // Sessions are the content domain's, not the draft's, exactly as they are in production.
  const agenda = new AgendaService(
    agendaRepository,
    now,
    new FixtureSchedulableContentQuery(new Map([[SOURCE, SOURCE_SESSIONS]])),
  );

  const templateRepository = new MemoryEventTemplateRepository();
  const templates = new EventTemplateService({
    repository: templateRepository,
    events,
    slices: [agendaTemplateSlice(agenda)],
    newId,
    now,
    ...(options.onSliceFault ? { onSliceFault: options.onSliceFault } : {}),
  });
  return { actor: organizer(), agenda, agendaRepository, templateRepository, templates };
}

const save = (templates: EventTemplateService, actor: Actor) =>
  templates.saveFromEvent(actor, {
    organizationId: ORGANIZATION,
    name: "Annual summit starter",
    sourceEventId: SOURCE,
  });

const apply = (
  templates: EventTemplateService,
  actor: Actor,
  templateId: string,
  destination = DESTINATION_RANGE,
) => templates.apply(actor, DESTINATION, { templateId, version: 1, destination });

const agendaSlice = <T extends { readonly key: string }>(report: {
  readonly slices: readonly T[];
}) => report.slices.find(({ key }) => key === "agenda");

describe("Event templates: the agenda slice", () => {
  it("captures the shape of the board and nothing that is standing on it", async () => {
    const { actor, templates } = await setup();

    const capture = await save(templates, actor);

    expect(capture.slices).toEqual([
      {
        key: "agenda",
        label: "Agenda rooms, tracks and time slots",
        outcome: "captured",
        reason: expect.any(String),
      },
    ]);
    expect(capture.version.payload.slices.agenda).toEqual({
      rooms: SOURCE_ROOMS,
      tracks: SOURCE_TRACKS,
      slots: SOURCE_SLOTS,
    });
    // The programme itself never enters the template: a placement names a session that exists
    // in the source event alone, and the destination would report every one as MISSING_SESSION.
    const stored = JSON.stringify(capture.version.payload);
    expect(stored).not.toContain("session");
    expect(stored).not.toContain("place");
  });

  it("previews every room, track and remapped slot, names the programme it leaves, and writes nothing", async () => {
    const { actor, agenda, templates } = await setup();
    const { template } = await save(templates, actor);

    const plan = await templates.preview(actor, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    expect(agendaSlice(plan)?.outcome).toBe("copies");
    expect(agendaSlice(plan)?.copies.map(({ id }) => id)).toEqual([
      "room-main",
      "room-lab",
      "track-web",
      "slot-keynote",
      "slot-evening",
      "slot-workshop",
    ]);
    expect(agendaSlice(plan)?.excludes.map(({ id }) => id)).toEqual(["sessions", "placements"]);
    expect(agendaSlice(plan)?.incompatible.map(({ id }) => id)).toEqual(["slot-closing"]);
    await expect(agenda.draft(actor, DESTINATION)).rejects.toThrow("Agenda not found");
  });

  it("copies rooms and tracks verbatim and moves each slot onto the destination's day, keeping its wall clock", async () => {
    const { actor, agenda, templates } = await setup();
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(agendaSlice(result)?.outcome).toBe("applied");
    const destination = await agenda.draft(actor, DESTINATION);
    expect(destination.rooms).toEqual(SOURCE_ROOMS);
    expect(destination.tracks).toEqual(SOURCE_TRACKS);
    /*
     * Every instant below reads 09:00, 20:00 and 09:00 on a Berlin clock, exactly as the source
     * reads 09:00, 20:00 and 09:00 on a Los Angeles one — across nine months and a nine-hour
     * change of offset. The evening slot stays on the destination's *first* day, which is the
     * anchor being read in the source event's zone rather than in UTC.
     */
    expect(destination.slots).toEqual([
      {
        id: "slot-keynote",
        startsAt: "2027-05-10T07:00:00.000Z",
        endsAt: "2027-05-10T08:00:00.000Z",
      },
      {
        id: "slot-evening",
        startsAt: "2027-05-10T18:00:00.000Z",
        endsAt: "2027-05-10T19:00:00.000Z",
      },
      {
        id: "slot-workshop",
        startsAt: "2027-05-11T07:00:00.000Z",
        endsAt: "2027-05-11T08:00:00.000Z",
      },
    ]);
  });

  it("keeps the wall clock across a daylight-saving change in the destination", async () => {
    // The destination's second day is the morning US clocks go forward, so the two 09:00 slots
    // are an hour apart in UTC. A remap that applied one offset difference to both would put the
    // second at 17:00Z, an hour after the one the organizer chose.
    const { actor, agenda, templates } = await setup({
      sourceTimezone: "UTC",
      destinationTimezone: "America/Los_Angeles",
      source: {
        slots: [
          {
            id: "slot-one",
            startsAt: "2026-09-01T09:00:00.000Z",
            endsAt: "2026-09-01T10:00:00.000Z",
          },
          {
            id: "slot-two",
            startsAt: "2026-09-02T09:00:00.000Z",
            endsAt: "2026-09-02T10:00:00.000Z",
          },
        ],
        placements: [],
      },
    });
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id, { startsOn: "2027-03-13", endsOn: "2027-03-14" });

    expect((await agenda.draft(actor, DESTINATION)).slots).toEqual([
      { id: "slot-one", startsAt: "2027-03-13T17:00:00.000Z", endsAt: "2027-03-13T18:00:00.000Z" },
      { id: "slot-two", startsAt: "2027-03-14T16:00:00.000Z", endsAt: "2027-03-14T17:00:00.000Z" },
    ]);
  });

  it("places a slot inside an hour the destination skips an hour to its side, as documented", async () => {
    const { actor, agenda, templates } = await setup({
      sourceTimezone: "UTC",
      destinationTimezone: "America/Los_Angeles",
      source: {
        slots: [
          {
            id: "slot-gap",
            startsAt: "2026-09-01T02:30:00.000Z",
            endsAt: "2026-09-01T03:30:00.000Z",
          },
        ],
        placements: [],
      },
    });
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id, { startsOn: "2027-03-14", endsOn: "2027-03-14" });

    // Los Angeles has no 02:30 that morning: the clocks go straight from 02:00 to 03:00. Landing
    // an hour to one side — 01:30, here — is the documented cost of a calendar that skips an
    // hour rather than a rounding the conversion could avoid, and pinning it keeps the next
    // reader from "fixing" it into something that silently invents an instant instead.
    expect((await agenda.draft(actor, DESTINATION)).slots).toEqual([
      { id: "slot-gap", startsAt: "2027-03-14T09:30:00.000Z", endsAt: "2027-03-14T10:30:00.000Z" },
    ]);
  });

  it("places a slot inside an hour Berlin skips an hour to the other side, as documented", async () => {
    const { actor, agenda, templates } = await setup({
      sourceTimezone: "UTC",
      source: {
        slots: [
          {
            id: "slot-gap",
            startsAt: "2026-09-01T02:30:00.000Z",
            endsAt: "2026-09-01T02:45:00.000Z",
          },
        ],
        placements: [],
      },
    });
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id, { startsOn: "2027-03-28", endsOn: "2027-03-28" });

    // Berlin has no 02:30 that morning either, and lands the slot on the *later* side where Los
    // Angeles lands it on the earlier one. Which side is a fact about the zone's offsets either
    // side of the change, not a preference this code holds, and the two are pinned together so
    // the documented asymmetry cannot quietly become a rule.
    expect((await agenda.draft(actor, DESTINATION)).slots).toEqual([
      { id: "slot-gap", startsAt: "2027-03-28T01:30:00.000Z", endsAt: "2027-03-28T01:45:00.000Z" },
    ]);
  });

  it("resolves a reading Los Angeles repeats to the instant before the clocks go back", async () => {
    const { actor, agenda, templates } = await setup({
      sourceTimezone: "UTC",
      destinationTimezone: "America/Los_Angeles",
      source: {
        slots: [
          {
            id: "slot-ambiguous",
            startsAt: "2026-09-01T01:30:00.000Z",
            endsAt: "2026-09-01T01:45:00.000Z",
          },
        ],
        placements: [],
      },
    });
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id, { startsOn: "2027-11-07", endsOn: "2027-11-07" });

    // 01:30 comes round twice that morning: 08:30Z on daylight time and 09:30Z on standard. The
    // earlier is the one this yields, and an organizer who chose 01:30 is an hour out either way,
    // so the assertion exists to keep the choice stable rather than to argue it is the right one.
    expect((await agenda.draft(actor, DESTINATION)).slots).toEqual([
      {
        id: "slot-ambiguous",
        startsAt: "2027-11-07T08:30:00.000Z",
        endsAt: "2027-11-07T08:45:00.000Z",
      },
    ]);
  });

  it("resolves a reading Berlin repeats to the instant after the clocks go back", async () => {
    const { actor, agenda, templates } = await setup({
      sourceTimezone: "UTC",
      source: {
        slots: [
          {
            id: "slot-ambiguous",
            startsAt: "2026-09-01T02:30:00.000Z",
            endsAt: "2026-09-01T02:45:00.000Z",
          },
        ],
        placements: [],
      },
    });
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id, { startsOn: "2027-10-31", endsOn: "2027-10-31" });

    // The same repeated hour, resolved the other way: 02:30 in Berlin is 00:30Z on summer time
    // and 01:30Z on winter, and this yields the later one — the opposite side from Los Angeles.
    expect((await agenda.draft(actor, DESTINATION)).slots).toEqual([
      {
        id: "slot-ambiguous",
        startsAt: "2027-10-31T01:30:00.000Z",
        endsAt: "2027-10-31T01:45:00.000Z",
      },
    ]);
  });

  it("names a slot past the destination's last day instead of clamping it onto that day", async () => {
    const { actor, agenda, templates } = await setup();
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(agendaSlice(result)?.incompatible).toEqual([
      {
        id: "slot-closing",
        label: expect.stringContaining("past the destination event's last day"),
      },
    ]);
    expect(agendaSlice(result)?.reason).toContain("falling past its last day were left out");
    // A shorter destination event is a real answer: the third day's slot is absent, and nothing
    // was squeezed onto the second day to make the count come out right.
    const { slots } = await agenda.draft(actor, DESTINATION);
    expect(slots.map(({ id }) => id)).toEqual(["slot-keynote", "slot-evening", "slot-workshop"]);
    expect(slots.every(({ startsAt }) => startsAt < "2027-05-12")).toBe(true);
  });

  it("leaves the source's sessions and placements behind", async () => {
    const { actor, agenda, templates } = await setup();
    const { template } = await save(templates, actor);

    await apply(templates, actor, template.id);

    const destination = await agenda.draft(actor, DESTINATION);
    expect(destination.sessions).toEqual([]);
    expect(destination.placements).toEqual([]);
    // And the source keeps its own programme: a clone reads the board, it does not move it.
    expect((await agenda.draft(actor, SOURCE)).placements).toEqual(SOURCE_PLACEMENTS);
  });

  it("converges on a second application without writing anything", async () => {
    const { actor, agenda, agendaRepository, templates } = await setup();
    const { template } = await save(templates, actor);
    await apply(templates, actor, template.id);
    const afterFirst = await agenda.draft(actor, DESTINATION);
    const saveResources = vi.spyOn(agendaRepository, "saveResources");

    const second = await apply(templates, actor, template.id);

    expect(agendaSlice(second)).toMatchObject({
      outcome: "applied",
      reason: "Already identical to the template; nothing needed to be written.",
    });
    // `configure` replaces all three lists on every call, so the only way to leave the board
    // byte-identical is not to call it at all.
    expect(saveResources).not.toHaveBeenCalled();
    expect(JSON.stringify(await agenda.draft(actor, DESTINATION))).toBe(JSON.stringify(afterFirst));
  });

  it("refuses a destination whose own placements the template's resources cannot hold", async () => {
    const { actor, agenda, templates } = await setup({
      destination: {
        eventId: DESTINATION,
        rooms: [{ id: "room-hall", name: "Community hall" }],
        tracks: [{ id: "track-ops", name: "Ops", color: "#16866b" }],
        slots: [
          {
            id: "slot-local",
            startsAt: "2027-05-10T07:00:00.000Z",
            endsAt: "2027-05-10T08:00:00.000Z",
          },
        ],
        sessions: [],
        placements: [
          {
            id: "place-local",
            sessionId: "session-local",
            roomId: "room-hall",
            trackId: "track-ops",
            slotId: "slot-local",
          },
        ],
      },
    });
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(agendaSlice(result)).toMatchObject({
      outcome: "incompatible",
      reason: expect.stringContaining("Remove those placements first"),
    });
    // Reported, not thrown, and nothing was half-written on the way to reporting it.
    expect((await agenda.draft(actor, DESTINATION)).rooms).toEqual([
      { id: "room-hall", name: "Community hall" },
    ]);
  });

  it("reports an actor who may not manage the destination's agenda as unauthorized", async () => {
    const { actor, agenda, templates } = await setup();
    const { template } = await save(templates, actor);
    // Enough to apply a template, and nothing at all on the agenda: the orchestrator's grant is
    // not the agenda's, and the slice reports the refusal instead of applying anyway.
    const settingsOnly = organizer([
      "events:read",
      "events:settings:read",
      "events:settings:update",
    ]);

    const result = await templates.apply(settingsOnly, DESTINATION, {
      templateId: template.id,
      version: 1,
      destination: DESTINATION_RANGE,
    });

    expect(agendaSlice(result)?.outcome).toBe("unauthorized");
    await expect(agenda.draft(actor, DESTINATION)).rejects.toThrow("Agenda not found");
  });

  it("leaves a populated destination standing rather than clearing it for an empty template", async () => {
    const { actor, agenda, agendaRepository, templateRepository, templates } = await setup({
      destination: {
        eventId: DESTINATION,
        rooms: [{ id: "room-hall", name: "Community hall" }],
        tracks: [{ id: "track-ops", name: "Ops", color: "#16866b" }],
        slots: [
          {
            id: "slot-local",
            startsAt: "2027-05-10T07:00:00.000Z",
            endsAt: "2027-05-10T08:00:00.000Z",
          },
        ],
        sessions: [],
        // Nothing standing on the board: a placement would be refused by the stranding rule
        // long before the emptiness of the payload was ever the reason.
        placements: [],
      },
    });
    const { template, version } = await save(templates, actor);
    // `export` refuses to capture an empty board, so this is a row an operator wrote or edited —
    // and `configure` replaces all three lists, so applying it would delete the three above.
    await templateRepository.createVersion({
      ...version,
      id: "00000000-0000-4000-8000-0000000000fe",
      version: 2,
      payload: { ...version.payload, slices: { agenda: { rooms: [], tracks: [], slots: [] } } },
    });
    const command = { templateId: template.id, version: 2, destination: DESTINATION_RANGE };
    const before = await agenda.draft(actor, DESTINATION);
    const saveResources = vi.spyOn(agendaRepository, "saveResources");

    const plan = await templates.preview(actor, DESTINATION, command);
    const result = await templates.apply(actor, DESTINATION, command);

    for (const slice of [agendaSlice(plan), agendaSlice(result)])
      expect(slice).toMatchObject({
        outcome: "skipped",
        reason: expect.stringContaining("would clear the destination's own board"),
      });
    expect(saveResources).not.toHaveBeenCalled();
    expect(JSON.stringify(await agenda.draft(actor, DESTINATION))).toBe(JSON.stringify(before));
  });

  /** A destination someone set up and never dragged a session onto: nothing to strand. */
  const UNTOUCHED_DESTINATION: AgendaDraft = {
    eventId: DESTINATION,
    rooms: [{ id: "room-hall", name: "Community hall" }],
    tracks: [{ id: "track-ops", name: "Ops", color: "#16866b" }],
    slots: [
      {
        id: "slot-local",
        startsAt: "2027-05-10T07:00:00.000Z",
        endsAt: "2027-05-10T08:00:00.000Z",
      },
    ],
    sessions: [],
    placements: [],
  };

  /** A source with rooms and nothing else — the state `export` captures the whole board from. */
  const ROOMS_ONLY = { rooms: SOURCE_ROOMS.slice(0, 1), tracks: [], slots: [], placements: [] };

  it("leaves the tracks and time slots a template says nothing about standing", async () => {
    const { actor, agenda, templates } = await setup({
      source: ROOMS_ONLY,
      destination: UNTOUCHED_DESTINATION,
    });
    const { template } = await save(templates, actor);
    const command = { templateId: template.id, version: 1, destination: DESTINATION_RANGE };

    const plan = await templates.preview(actor, DESTINATION, command);
    const result = await templates.apply(actor, DESTINATION, command);

    // The rooms the template does carry replace the destination's; the two categories it is
    // silent about are not a statement that the destination should have none.
    const destination = await agenda.draft(actor, DESTINATION);
    expect(destination.rooms).toEqual(ROOMS_ONLY.rooms);
    expect(destination.tracks).toEqual(UNTOUCHED_DESTINATION.tracks);
    expect(destination.slots).toEqual(UNTOUCHED_DESTINATION.slots);
    // And both sentences name only what was written. The stranding guard never fires here —
    // there are no placements — so a reason claiming all three categories was the only thing an
    // organizer would have had to go on.
    expect(agendaSlice(plan)).toMatchObject({
      outcome: "copies",
      reason:
        "Replaces the destination's rooms. Its tracks and time slots are not in this template " +
        "and stay as they are. Sessions stay where they are.",
    });
    expect(agendaSlice(plan)?.copies).toEqual([{ id: "room-main", label: "Room: Main stage" }]);
    expect(agendaSlice(result)).toMatchObject({
      outcome: "applied",
      reason:
        "Copied the rooms. Its tracks and time slots are not in this template and were left as " +
        "they were.",
    });
  });

  it("converges on a second application of a template that carries one category", async () => {
    const { actor, agenda, agendaRepository, templates } = await setup({
      source: ROOMS_ONLY,
      destination: UNTOUCHED_DESTINATION,
    });
    const { template } = await save(templates, actor);
    await apply(templates, actor, template.id);
    const afterFirst = await agenda.draft(actor, DESTINATION);
    const saveResources = vi.spyOn(agendaRepository, "saveResources");

    const second = await apply(templates, actor, template.id);

    // The preserved lists are part of what a re-application compares against, so keeping them
    // must not turn "already identical" into a rewrite every time the template is applied.
    expect(agendaSlice(second)).toMatchObject({
      outcome: "applied",
      reason: "Already identical to the template; nothing needed to be written.",
    });
    expect(saveResources).not.toHaveBeenCalled();
    expect(JSON.stringify(await agenda.draft(actor, DESTINATION))).toBe(JSON.stringify(afterFirst));
  });

  it("still replaces all three categories when the template carries all three", async () => {
    const { actor, agenda, templates } = await setup({
      source: { placements: [] },
      destination: UNTOUCHED_DESTINATION,
    });
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    // Preserving what a template is silent about must not become preserving what it speaks
    // about: the destination's own room, track and slot are gone, which is what applying a
    // template that names all three means.
    const destination = await agenda.draft(actor, DESTINATION);
    expect(destination.rooms).toEqual(SOURCE_ROOMS);
    expect(destination.tracks).toEqual(SOURCE_TRACKS);
    expect(destination.slots.map(({ id }) => id)).toEqual([
      "slot-keynote",
      "slot-evening",
      "slot-workshop",
    ]);
    expect(agendaSlice(result)?.reason).toBe(
      "Copied the rooms, tracks and time slots onto the destination's dates. Slots falling past " +
        "its last day were left out.",
    );
  });

  it("always keeps the earliest slot, so refusals can never empty a board", async () => {
    /*
     * The invariant behind the one emptiness guard: a payload carrying only slots, all of them
     * refused, would also reach `configure` with three empty lists — and cannot exist, because
     * the anchor is the earliest day any slot starts on, so that slot's offset is zero and it
     * lands on the destination's first day. Pinned here because it is the reason the slice needs
     * no second guard, and a change to the anchor would silently make one necessary.
     */
    const { actor, templates, templateRepository } = await setup();
    const { template, version } = await save(templates, actor);
    await templateRepository.createVersion({
      ...version,
      id: "00000000-0000-4000-8000-0000000000fd",
      version: 2,
      payload: {
        ...version.payload,
        slices: {
          agenda: {
            rooms: [],
            tracks: [],
            // Two days apart, onto a destination range one day shorter than they need.
            slots: [
              {
                id: "slot-first",
                startsAt: "2026-09-01T16:00:00.000Z",
                endsAt: "2026-09-01T17:00:00.000Z",
              },
              {
                id: "slot-third-day",
                startsAt: "2026-09-03T16:00:00.000Z",
                endsAt: "2026-09-03T17:00:00.000Z",
              },
            ],
          },
        },
      },
    });

    const result = await templates.apply(actor, DESTINATION, {
      templateId: template.id,
      version: 2,
      destination: DESTINATION_RANGE,
    });

    expect(agendaSlice(result)?.outcome).toBe("applied");
    expect(agendaSlice(result)?.applied.map(({ id }) => id)).toEqual(["slot-first"]);
    expect(agendaSlice(result)?.incompatible.map(({ id }) => id)).toEqual(["slot-third-day"]);
  });

  /*
   * An event can genuinely hold a zone `Intl` cannot read: `createEventInputSchema` accepts any
   * non-empty string where the update schema refines against `Intl`. Naming it is the whole
   * point — the organizer can correct the destination's timezone, whereas the orchestrator's
   * generic sentence would tell them to apply the same version again and get the same answer.
   * The fault sink stays silent because a stored zone is not this system malfunctioning.
   */
  it("names an unreadable timezone in its own words, and reports no fault for it", async () => {
    const onSliceFault = vi.fn();
    const { actor, templates } = await setup({ destinationTimezone: "Mars/Olympus", onSliceFault });
    const { template } = await save(templates, actor);

    const result = await apply(templates, actor, template.id);

    expect(agendaSlice(result)).toMatchObject({
      outcome: "failed",
      reason: "“Mars/Olympus” is not a timezone this system can read.",
    });
    expect(onSliceFault).not.toHaveBeenCalled();
  });

  it("reports a stored payload it cannot read rather than writing part of a board", async () => {
    const { actor, agenda, templateRepository, templates } = await setup();
    const { template, version } = await save(templates, actor);
    // A payload as an operator could leave it in the table, not as this slice wrote it.
    await templateRepository.createVersion({
      ...version,
      id: "00000000-0000-4000-8000-0000000000ff",
      version: 2,
      payload: {
        ...version.payload,
        slices: { agenda: { rooms: [{ id: "room-main" }], tracks: [], slots: [] } },
      },
    });

    const result = await templates.apply(actor, DESTINATION, {
      templateId: template.id,
      version: 2,
      destination: DESTINATION_RANGE,
    });

    // The agenda's own sentence, not the orchestrator's generic one: a payload at rest reads the
    // same way on every attempt, so "apply this version again" would be advice that cannot work.
    expect(agendaSlice(result)).toMatchObject({
      outcome: "failed",
      reason: "This template's stored agenda configuration could not be read.",
    });
    await expect(agenda.draft(actor, DESTINATION)).rejects.toThrow("Agenda not found");
  });
});
