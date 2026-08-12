import type { Prospect, ProspectActivity, ProspectContact } from "../../domain/crm/prospect";
import type { CrmDirectoryRepository } from "./contact-repository";

export interface ProspectFilters {
  readonly stage?: Prospect["stage"] | undefined;
  readonly ownerId?: string | undefined;
  readonly overdueBefore?: string | undefined;
}

/**
 * One store for the domain, not two.
 *
 * Sourcing a directory contact into an event writes a prospect, its contact row and the
 * directory link together, so splitting these across two repositories would put a boundary
 * through the middle of a single durable operation. The interfaces stay in separate files
 * because they describe two different nouns; the implementation is one adapter.
 */
export interface CrmRepository extends CrmDirectoryRepository {
  list(eventId: string, filters: ProspectFilters): Promise<readonly Prospect[]>;
  findById(eventId: string, prospectId: string): Promise<Prospect | null>;
  /** Resolve an existing event prospect using conversion's normalized-address identity. */
  findByPrimaryEmail(eventId: string, email: string): Promise<Prospect | null>;
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
