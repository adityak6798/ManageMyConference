import {
  conflictsFor,
  placedSessionTimes,
  type AgendaDraft,
  type PlacedSessionTime,
  type Placement,
} from "../../domain/agenda/agenda";
import { type Actor, requireEventCapability } from "../identity/actor";
import type { AgendaRepository, PublishedSchedule } from "./agenda-repository";
import type { AgendaContentQuery } from "../content/public";
import type { ContentAgendaInterface } from "./public";

export class AgendaConflictError extends Error {
  constructor(readonly conflicts: ReturnType<typeof conflictsFor>) {
    super("Schedule conflicts must be resolved before publication");
  }
}
export class AgendaNotFoundError extends Error {}
export class AgendaResourceInUseError extends Error {}

// @spec PRD-AGD-001
export class AgendaService implements ContentAgendaInterface {
  constructor(
    private readonly repository: AgendaRepository,
    private readonly now: () => Date,
    private readonly content: AgendaContentQuery,
    _canManageEvent: (actor: Actor, eventId: string) => Promise<boolean> = async () => false,
  ) {}

  private async organizer(actor: Actor | null, eventId: string): Promise<Actor> {
    return requireEventCapability(actor, eventId, "agenda:manage");
  }

  async draft(actor: Actor | null, eventId: string) {
    await this.organizer(actor, eventId);
    const draft = await this.repository.getDraft(eventId);
    if (!draft) throw new AgendaNotFoundError("Agenda not found");
    const sessions = (await this.content.listSchedulableSessions(eventId)).map((session) => ({
      id: session.id,
      title: session.title,
      speakerIds: session.speakerProfileIds,
    }));
    const composed = { ...draft, sessions };
    return { ...composed, conflicts: conflictsFor(composed) };
  }

  async place(actor: Actor | null, eventId: string, placement: Placement) {
    await this.organizer(actor, eventId);
    const draft = await this.draft(actor, eventId);
    if (!draft) throw new AgendaNotFoundError("Agenda not found");
    if (!draft.sessions.some(({ id }) => id === placement.sessionId))
      throw new AgendaNotFoundError("Session not found");
    if (!draft.rooms.some(({ id }) => id === placement.roomId))
      throw new AgendaNotFoundError("Room not found");
    if (!draft.tracks.some(({ id }) => id === placement.trackId))
      throw new AgendaNotFoundError("Track not found");
    if (!draft.slots.some(({ id }) => id === placement.slotId))
      throw new AgendaNotFoundError("Slot not found");
    await this.repository.savePlacement(eventId, placement);
    return this.draft(actor, eventId);
  }

  async configure(
    actor: Actor | null,
    eventId: string,
    resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">,
  ) {
    await this.organizer(actor, eventId);
    if (!(await this.repository.saveResources(eventId, resources)))
      throw new AgendaResourceInUseError("Remove affected placements before deleting resources");
    return this.draft(actor, eventId);
  }

  async remove(actor: Actor | null, eventId: string, placementId: string) {
    await this.organizer(actor, eventId);
    await this.repository.removePlacement(eventId, placementId);
  }

  async publish(actor: Actor | null, eventId: string): Promise<PublishedSchedule> {
    const authorized = await this.organizer(actor, eventId);
    const draft = await this.draft(actor, eventId);
    if (!draft) throw new AgendaNotFoundError("Agenda not found");
    const conflicts = conflictsFor(draft);
    if (conflicts.length) throw new AgendaConflictError(conflicts);
    const previous = await this.repository.getPublished(eventId);
    const { conflicts: _computedConflicts, ...agenda } = draft;
    const schedule = {
      eventId,
      version: (previous?.version ?? 0) + 1,
      publishedAt: this.now().toISOString(),
      publishedBy: authorized.id,
      agenda: structuredClone(agenda),
    };
    await this.repository.publish(schedule);
    return schedule;
  }

  async published(eventId: string) {
    const schedule = await this.repository.getPublished(eventId);
    if (!schedule) return null;
    const { publishedBy: _auditOnly, ...publicSchedule } = schedule;
    return publicSchedule;
  }

  /**
   * `ContentAgendaInterface`: when and where the published snapshot puts each session.
   *
   * No actor is required, for the same reason `published` needs none — the snapshot in force is
   * what the event has already committed to publicly. Callers still authorize their own read of
   * the sessions they are asking about.
   */
  async publishedSessionSchedules(
    eventId: string,
  ): Promise<ReadonlyMap<string, PlacedSessionTime>> {
    const published = await this.repository.getPublished(eventId);
    return published ? placedSessionTimes(published.agenda) : new Map();
  }

  /**
   * `ContentAgendaInterface`: drop every draft placement of one session.
   *
   * Used when a session leaves the programme. Removing the placements is what keeps the board
   * from advertising — and `conflictsFor` from reporting `MISSING_SESSION` for — a session that
   * no longer exists. An event with no draft has nothing to remove and is not an error.
   */
  async unscheduleSession(actor: Actor | null, eventId: string, sessionId: string): Promise<void> {
    await this.organizer(actor, eventId);
    const draft = await this.repository.getDraft(eventId);
    if (!draft) return;
    for (const placement of draft.placements.filter((item) => item.sessionId === sessionId))
      await this.repository.removePlacement(eventId, placement.id);
  }
}
