import type { CrmRepository, ProspectFilters } from "../../application/crm/crm-repository";
import type { Prospect, ProspectActivity } from "../../domain/crm/prospect";

export class MemoryCrmRepository implements CrmRepository {
  private readonly prospects = new Map<string, Prospect>();
  async list(eventId: string, filters: ProspectFilters): Promise<readonly Prospect[]> {
    return [...this.prospects.values()].filter(
      (item) =>
        item.eventId === eventId &&
        (!filters.stage || item.stage === filters.stage) &&
        (!filters.ownerId || item.ownerId === filters.ownerId) &&
        (!filters.overdueBefore ||
          (!!item.nextActionAt && item.nextActionAt < filters.overdueBefore && !item.speakerId)),
    );
  }
  async findById(eventId: string, prospectId: string) {
    const item = this.prospects.get(prospectId);
    return item?.eventId === eventId ? item : null;
  }
  async create(prospect: Prospect) {
    this.prospects.set(prospect.id, prospect);
  }
  async update(prospect: Prospect) {
    this.prospects.set(prospect.id, prospect);
  }
  async recordConversion(
    eventId: string,
    prospectId: string,
    speakerId: string,
    activity: ProspectActivity,
  ) {
    const prospect = await this.findById(eventId, prospectId);
    if (!prospect) throw new Error("Prospect not found");
    if (prospect.speakerId) return prospect;
    const converted = {
      ...prospect,
      stage: "converted" as const,
      speakerId,
      convertedAt: activity.occurredAt,
      updatedAt: activity.occurredAt,
      activities: [...prospect.activities, activity],
    };
    this.prospects.set(prospectId, converted);
    return converted;
  }
}
