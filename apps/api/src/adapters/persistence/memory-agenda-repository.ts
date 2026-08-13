import type {
  AgendaRepository,
  PublishedSchedule,
  PublishOutcome,
} from "../../application/agenda/agenda-repository";
import {
  advanceBoardOccurrences,
  EMPTY_BOARD_OCCURRENCES,
  nextSessionScheduleRevisions,
  schedulePublishedEvent,
  type AgendaDraft,
  type Placement,
  type SchedulePublishedEvent,
  type SessionScheduleRevision,
} from "../../domain/agenda/agenda";

export class MemoryAgendaRepository implements AgendaRepository {
  private readonly drafts = new Map<string, AgendaDraft>();
  /**
   * The board revision D1 keeps in its own column, kept here for the same reason the session
   * schedules are: it is the clock the occurrences are expressed in, and a double that did not
   * advance it would let a service suite pass against a repository that never moved them.
   */
  private readonly revisions = new Map<string, number>();
  private readonly publications = new Map<string, PublishedSchedule>();
  /**
   * The same materialized answer D1 stores, maintained by the same domain function.
   *
   * Held per event rather than re-derived from a kept history, because that is the contract
   * being doubled: D1 advances these rows inside the publication's batch and never replays.
   * A double that folded a history on read would keep passing if the write path stopped
   * maintaining the table at all.
   */
  private readonly sessionSchedules = new Map<
    string,
    ReadonlyMap<string, SessionScheduleRevision>
  >();
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
    for (const draft of drafts) {
      this.drafts.set(draft.eventId, structuredClone(draft));
      /*
       * A seeded board's occurrences are already expressed in revisions, so the counter starts
       * above the highest of them. Starting at zero would let the first edit write a number
       * lower than one the fixture already holds, which D1 cannot do — the revision lives in its
       * own column there and is read back before every fold — and a double that can go backwards
       * is a double that proves less than the thing it stands for.
       */
      const seeded = draft.occurrences;
      if (seeded)
        this.revisions.set(
          draft.eventId,
          Math.max(0, ...Object.values(seeded.sessions), ...Object.values(seeded.slots)),
        );
    }
    for (const schedule of publications) {
      this.publications.set(schedule.eventId, structuredClone(schedule));
      // A seeded snapshot has taken its version too, so the next publication allocates past it.
      this.versions.set(
        schedule.eventId,
        (this.versions.get(schedule.eventId) ?? new Set<number>()).add(schedule.version),
      );
    }
    /*
     * Seeded snapshots are folded in version order, not in argument order, because the fold is
     * only meaningful oldest-first: applied out of order an absence would reset a session that
     * a later-numbered publication had already placed. Sorting by version is enough — the sort
     * is stable, so each event's own subsequence keeps its relative order.
     */
    for (const schedule of [...publications].sort((left, right) => left.version - right.version))
      this.sessionSchedules.set(
        schedule.eventId,
        nextSessionScheduleRevisions(
          this.sessionSchedules.get(schedule.eventId) ?? new Map(),
          schedule,
        ),
      );
  }
  async getDraft(eventId: string) {
    const draft = this.drafts.get(eventId);
    // Normalized on the way out, exactly as D1 does: a fixture — like a row written before the
    // occurrences existed — may carry none, and no caller should have to know that.
    return draft
      ? structuredClone({ ...draft, occurrences: draft.occurrences ?? EMPTY_BOARD_OCCURRENCES })
      : null;
  }
  async saveDraft(draft: AgendaDraft) {
    // The create path, as in D1: a board that has only just appeared has no occurrences yet.
    this.drafts.set(draft.eventId, {
      ...structuredClone(draft),
      occurrences: draft.occurrences ?? EMPTY_BOARD_OCCURRENCES,
    });
  }
  /**
   * Store one edited board, advancing the revision and the occurrences with it.
   *
   * The single write path, so that no mutator can forget the fold — which is the arrangement D1
   * gets from `updateDraft` and which the double has to match, or a service suite would prove a
   * property the real repository does not have.
   */
  private commit(eventId: string, previous: AgendaDraft, next: AgendaDraft): AgendaDraft {
    const revision = (this.revisions.get(eventId) ?? 0) + 1;
    this.revisions.set(eventId, revision);
    const stored: AgendaDraft = {
      ...next,
      occurrences: advanceBoardOccurrences(previous, next, revision),
    };
    this.drafts.set(eventId, stored);
    return structuredClone(stored);
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
    if (!current) {
      await this.saveDraft({ eventId, ...resources, sessions: [], placements });
      return true;
    }
    this.commit(eventId, current, { ...current, ...resources, sessions: [] });
    return true;
  }
  async savePlacement(eventId: string, placement: Placement) {
    const draft = this.drafts.get(eventId);
    if (!draft) return null;
    return this.commit(eventId, draft, {
      ...draft,
      placements: [...draft.placements.filter(({ id }) => id !== placement.id), placement],
    });
  }
  async savePlacements(eventId: string, plan: (draft: AgendaDraft) => readonly Placement[]) {
    const draft = this.drafts.get(eventId);
    if (!draft) return null;
    const placements = plan(structuredClone(draft));
    // The board as a caller must see it, occurrences included — a plan that seats nothing is an
    // ordinary answer on a full board, and the one path that returns a board it did not write.
    if (!placements.length) return this.getDraft(eventId);
    const replaced = new Set(placements.map(({ id }) => id));
    return this.commit(eventId, draft, {
      ...draft,
      placements: [...draft.placements.filter(({ id }) => !replaced.has(id)), ...placements],
    });
  }
  async removePlacement(eventId: string, placementId: string) {
    const draft = this.drafts.get(eventId);
    if (draft)
      this.commit(eventId, draft, {
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
    // Advanced with the publication, exactly as D1 advances it inside the publication's batch.
    this.sessionSchedules.set(
      schedule.eventId,
      nextSessionScheduleRevisions(
        this.sessionSchedules.get(schedule.eventId) ?? new Map(),
        schedule,
      ),
    );
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
  async sessionScheduleRevisions(
    eventId: string,
  ): Promise<ReadonlyMap<string, SessionScheduleRevision>> {
    return new Map(this.sessionSchedules.get(eventId) ?? new Map());
  }
}
