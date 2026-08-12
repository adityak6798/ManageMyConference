import type { AgendaDraft, Placement } from "../../domain/agenda/agenda";

export interface PublishedSchedule {
  readonly eventId: string;
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly agenda: AgendaDraft;
}

export interface AgendaRepository {
  getDraft(eventId: string): Promise<AgendaDraft | null>;
  saveDraft(draft: AgendaDraft): Promise<void>;
  saveResources(
    eventId: string,
    resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">,
  ): Promise<boolean>;
  savePlacement(eventId: string, placement: Placement): Promise<AgendaDraft | null>;
  removePlacement(eventId: string, placementId: string): Promise<void>;
  publish(schedule: PublishedSchedule): Promise<void>;
  getPublished(eventId: string): Promise<PublishedSchedule | null>;
}

export type PublicSchedule = Omit<PublishedSchedule, "publishedBy">;
