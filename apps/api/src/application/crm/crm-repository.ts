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
  /**
   * Persist the prospect together with everything this command produced. `activities` is a list
   * because one update can both move the stage and record a note; all of it must land or none of
   * it, so the caller never issues a second write to append the transition.
   */
  update(
    prospect: Prospect,
    activities?: readonly ProspectActivity[],
    contact?: ProspectContact,
  ): Promise<void>;
  recordConversion(
    eventId: string,
    prospectId: string,
    speakerId: string,
    activity: ProspectActivity,
  ): Promise<Prospect>;
}
