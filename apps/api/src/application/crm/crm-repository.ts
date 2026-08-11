import type { Prospect, ProspectActivity, ProspectContact } from "../../domain/crm/prospect";

export interface ProspectFilters {
  readonly stage?: Prospect["stage"] | undefined;
  readonly ownerId?: string | undefined;
  readonly overdueBefore?: string | undefined;
}

export interface CrmRepository {
  list(eventId: string, filters: ProspectFilters): Promise<readonly Prospect[]>;
  findById(eventId: string, prospectId: string): Promise<Prospect | null>;
  create(prospect: Prospect): Promise<void>;
  update(prospect: Prospect, activity?: ProspectActivity, contact?: ProspectContact): Promise<void>;
  recordConversion(
    eventId: string,
    prospectId: string,
    speakerId: string,
    activity: ProspectActivity,
  ): Promise<Prospect>;
}
