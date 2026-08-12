import type {
  AgendaRepository,
  PublishedSchedule,
  PublishOutcome,
} from "../../application/agenda/agenda-repository";
import {
  schedulePublishedEvent,
  type AgendaDraft,
  type Placement,
  type SchedulePublishedEvent,
} from "../../domain/agenda/agenda";

export class MemoryAgendaRepository implements AgendaRepository {
  private readonly drafts = new Map<string, AgendaDraft>();
  private readonly publications = new Map<string, PublishedSchedule>();
  private readonly publicationHistory = new Map<string, PublishedSchedule[]>();
  /** Versions already taken per event, so a second publication cannot reuse one. */
  private readonly versions = new Map<string, Set<number>>();
  /** Publications by `eventId~commandKey`, mirroring D1's partial unique index. */
  private readonly byCommandKey = new Map<string, PublishedSchedule>();
  private readonly events: SchedulePublishedEvent[] = [];

  constructor(
    drafts: readonly AgendaDraft[] = [],
    /** Snapshots already in force, so a board can start out published. */
    publications: readonly PublishedSchedule[] = [],
  ) {
    for (const draft of drafts) this.drafts.set(draft.eventId, structuredClone(draft));
    for (const schedule of publications) {
      this.publications.set(schedule.eventId, structuredClone(schedule));
      this.publicationHistory.set(schedule.eventId, [structuredClone(schedule)]);
      // A seeded snapshot has taken its version too, so the next publication allocates past it.
      this.versions.set(
        schedule.eventId,
        (this.versions.get(schedule.eventId) ?? new Set<number>()).add(schedule.version),
      );
    }
  }
  async getDraft(eventId: string) {
    return structuredClone(this.drafts.get(eventId) ?? null);
  }
  async saveDraft(draft: AgendaDraft) {
    this.drafts.set(draft.eventId, structuredClone(draft));
  }
  async saveResources(eventId: string, resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">) {
    const current = this.drafts.get(eventId);
    const placements = current?.placements ?? [];
    if (
      placements.some(
        (placement) =>
          !resources.rooms.some(({ id }) => id === placement.roomId) ||
          !resources.tracks.some(({ id }) => id === placement.trackId) ||
          !resources.slots.some(({ id }) => id === placement.slotId),
      )
    )
      return false;
    this.drafts.set(eventId, { eventId, ...resources, sessions: [], placements });
    return true;
  }
  async savePlacement(eventId: string, placement: Placement) {
    const draft = this.drafts.get(eventId);
    if (!draft) return null;
    const updated = {
      ...draft,
      placements: [...draft.placements.filter(({ id }) => id !== placement.id), placement],
    };
    this.drafts.set(eventId, updated);
    return structuredClone(updated);
  }
  async savePlacements(eventId: string, plan: (draft: AgendaDraft) => readonly Placement[]) {
    const draft = this.drafts.get(eventId);
    if (!draft) return null;
    const placements = plan(structuredClone(draft));
    if (!placements.length) return structuredClone(draft);
    const replaced = new Set(placements.map(({ id }) => id));
    const updated = {
      ...draft,
      placements: [...draft.placements.filter(({ id }) => !replaced.has(id)), ...placements],
    };
    this.drafts.set(eventId, updated);
    return structuredClone(updated);
  }
  async removePlacement(eventId: string, placementId: string) {
    const draft = this.drafts.get(eventId);
    if (draft)
      this.drafts.set(eventId, {
        ...draft,
        placements: draft.placements.filter(({ id }) => id !== placementId),
      });
  }
  /**
   * Mirrors D1's contract: the version is unique per event, and the event commits with it.
   *
   * The in-memory double has to refuse a taken version too, or the allocation retry loop is
   * only ever exercised against real D1 and a service test could not tell a working loop from
   * one that overwrites history.
   */
  async publish(schedule: PublishedSchedule): Promise<PublishOutcome> {
    if (schedule.commandKey && this.byCommandKey.has(`${schedule.eventId}~${schedule.commandKey}`))
      return "command-replayed";
    const versions = this.versions.get(schedule.eventId) ?? new Set<number>();
    if (versions.has(schedule.version)) return "version-taken";
    versions.add(schedule.version);
    this.versions.set(schedule.eventId, versions);
    this.publications.set(schedule.eventId, structuredClone(schedule));
    this.publicationHistory.set(schedule.eventId, [
      ...(this.publicationHistory.get(schedule.eventId) ?? []),
      structuredClone(schedule),
    ]);
    if (schedule.commandKey)
      this.byCommandKey.set(
        `${schedule.eventId}~${schedule.commandKey}`,
        structuredClone(schedule),
      );
    this.events.push(schedulePublishedEvent(schedule));
    return "committed";
  }
  async findByCommandKey(eventId: string, commandKey: string) {
    return structuredClone(this.byCommandKey.get(`${eventId}~${commandKey}`) ?? null);
  }
  /** Every event this repository committed, for tests asserting one per publication. */
  publishedEvents(): readonly SchedulePublishedEvent[] {
    return structuredClone(this.events);
  }
  async getPublished(eventId: string) {
    return structuredClone(this.publications.get(eventId) ?? null);
  }
  async listPublished(eventId: string) {
    return structuredClone(this.publicationHistory.get(eventId) ?? []);
  }
}
