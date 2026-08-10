import { conflictsFor, type AgendaDraft, type Placement } from "../../domain/agenda/agenda";
import { type Actor, CapabilityDeniedError, requireCapability } from "../identity/actor";
import type { AgendaRepository, PublishedSchedule } from "./agenda-repository";
import type { SchedulableContentQuery } from "../content/public";

export class AgendaConflictError extends Error {
  constructor(readonly conflicts: ReturnType<typeof conflictsFor>) {
    super("Schedule conflicts must be resolved before publication");
  }
}
export class AgendaNotFoundError extends Error {}
export class AgendaResourceInUseError extends Error {}

// @spec PRD-AGD-001
export class AgendaService {
  constructor(
    private readonly repository: AgendaRepository,
    private readonly now: () => Date,
    private readonly content: SchedulableContentQuery,
    private readonly canManageEvent: (
      actor: Actor,
      eventId: string,
    ) => Promise<boolean> = async () => false,
  ) {}

  private async organizer(actor: Actor | null, eventId: string): Promise<Actor> {
    const authorized = requireCapability(actor, "agenda:manage");
    const access = authorized.eventAccess.find(({ eventId: id }) => id === eventId);
    if (
      !access?.capabilities.has("agenda:manage") &&
      !(await this.canManageEvent(authorized, eventId))
    )
      throw new CapabilityDeniedError("Agenda access denied");
    return authorized;
  }

  async draft(actor: Actor | null, eventId: string) {
    await this.organizer(actor, eventId);
    const draft = await this.repository.getDraft(eventId);
    if (!draft) throw new AgendaNotFoundError("Agenda not found");
    const composed = { ...draft, sessions: await this.content.forEvent(eventId) };
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
}
