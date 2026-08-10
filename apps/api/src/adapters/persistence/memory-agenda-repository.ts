import type {
  AgendaRepository,
  PublishedSchedule,
} from "../../application/agenda/agenda-repository";
import type { AgendaDraft, Placement } from "../../domain/agenda/agenda";

export class MemoryAgendaRepository implements AgendaRepository {
  private readonly drafts = new Map<string, AgendaDraft>();
  private readonly publications = new Map<string, PublishedSchedule>();

  constructor(drafts: readonly AgendaDraft[] = []) {
    for (const draft of drafts) this.drafts.set(draft.eventId, structuredClone(draft));
  }
  async getDraft(eventId: string) {
    return structuredClone(this.drafts.get(eventId) ?? null);
  }
  async saveDraft(draft: AgendaDraft) {
    this.drafts.set(draft.eventId, structuredClone(draft));
  }
  async savePlacement(eventId: string, placement: Placement) {
    const draft = this.drafts.get(eventId);
    if (!draft) return;
    this.drafts.set(eventId, {
      ...draft,
      placements: [...draft.placements.filter(({ id }) => id !== placement.id), placement],
    });
  }
  async removePlacement(eventId: string, placementId: string) {
    const draft = this.drafts.get(eventId);
    if (draft)
      this.drafts.set(eventId, {
        ...draft,
        placements: draft.placements.filter(({ id }) => id !== placementId),
      });
  }
  async publish(schedule: PublishedSchedule) {
    this.publications.set(schedule.eventId, structuredClone(schedule));
  }
  async getPublished(eventId: string) {
    return structuredClone(this.publications.get(eventId) ?? null);
  }
}
