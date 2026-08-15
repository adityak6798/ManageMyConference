import type {
  PipelineStage,
  Prospect,
  ProspectActivity,
  ProspectContact,
  ProspectTransition,
} from "../../domain/crm/prospect";
import type { ContactActivity } from "../../domain/crm/contact";
import type { CrmDirectoryRepository } from "./contact-repository";

export interface ProspectFilters {
  readonly stage?: Prospect["stage"] | undefined;
  readonly ownerId?: string | undefined;
  readonly overdueBefore?: string | undefined;
}

/**
 * Who moved a stage's prospects and when — everything a history entry needs except which
 * prospects those are, which only the write itself can know. See `deleteStage`.
 */
export interface StageMigration {
  readonly actorId: string;
  readonly source: ProspectTransition["source"];
  readonly occurredAt: string;
}

/**
 * What a deliberate card move asks the store to do.
 *
 * Deliberately no `fromStage`, transition id, or finished activity: only the write can know
 * which stage the row actually leaves after another organizer's concurrent move. The adapter
 * derives both histories from that committed row and mints their ids in the same operation.
 */
export interface ProspectMove extends StageMigration {
  readonly toStage: string;
}
export interface CrmCampaign {
  id: string;
  organizationId: string;
  eventId: string;
  name: string;
  templateKey: string;
  templateVersion: number | null;
  contactIds: readonly string[];
  segmentId: string | null;
  state: "draft" | "scheduled" | "running" | "completed" | "cancelled";
  scheduledAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface CrmEngagement {
  id: string;
  organizationId: string;
  eventId: string;
  campaignId: string | null;
  contactId: string;
  kind: "delivered" | "opened" | "clicked" | "replied" | "bounced" | "unsubscribed";
  providerRef: string;
  occurredAt: string;
  metadata: Readonly<Record<string, string>>;
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
  listCampaigns(organizationId: string): Promise<readonly CrmCampaign[]>;
  listDueCampaigns(now: string): Promise<readonly CrmCampaign[]>;
  findCampaign(organizationId: string, campaignId: string): Promise<CrmCampaign | null>;
  saveCampaign(campaign: CrmCampaign): Promise<void>;
  transitionCampaign(
    organizationId: string,
    campaignId: string,
    from: readonly CrmCampaign["state"][],
    to: CrmCampaign["state"],
    updatedAt: string,
  ): Promise<CrmCampaign | null>;
  saveEngagement(
    engagement: CrmEngagement,
    contactActivity: ContactActivity,
    prospectActivity: ProspectActivity,
  ): Promise<boolean>;
  suppressedContactIds(contactIds: readonly string[]): Promise<ReadonlySet<string>>;
  recordProspectEngagement(
    organizationId: string,
    contactId: string,
    eventId: string,
    activity: ProspectActivity,
  ): Promise<void>;
  list(eventId: string, filters: ProspectFilters): Promise<readonly Prospect[]>;
  findById(eventId: string, prospectId: string): Promise<Prospect | null>;
  /** Resolve an existing event prospect using conversion's normalized-address identity. */
  findByPrimaryEmail(eventId: string, email: string): Promise<Prospect | null>;
  /** The prospect and the transition that put it on the board, in one write. */
  create(prospect: Prospect, transition?: ProspectTransition): Promise<void>;
  /**
   * Persist the prospect together with everything this command produced. `activities` is a list
   * because one update can both move the stage and record a note; all of it must land or none of
   * it, so the caller never issues a second write to append the transition.
   *
   * `transition` is the same rule one level up: a move whose history did not commit is a move a
   * report cannot see, and a second request to append it is a second chance to lose it.
   */
  update(
    prospect: Prospect,
    activities?: readonly ProspectActivity[],
    contact?: ProspectContact,
    move?: ProspectMove,
  ): Promise<Prospect>;
  recordConversion(
    eventId: string,
    prospectId: string,
    speakerId: string,
    activity: ProspectActivity,
    transition?: ProspectTransition,
  ): Promise<Prospect>;

  /* ------------------------------ the board itself ------------------------------ */

  listStages(eventId: string): Promise<readonly PipelineStage[]>;
  /**
   * Write the default set for an event that has none, and answer with what the event now has.
   *
   * `INSERT OR IGNORE` against `UNIQUE (event_id, key)` rather than "read, then decide": two
   * organizers opening a new event's board at the same moment both read no stages, and a
   * read-then-write would have one of them fail on the other's insert. Existing rows are left
   * exactly as they are, so this can never undo a rename.
   */
  ensureStages(
    eventId: string,
    stages: readonly PipelineStage[],
  ): Promise<readonly PipelineStage[]>;
  /**
   * Replace this event's stage list wholesale, in one batch.
   *
   * Wholesale because adding, renaming and reordering are the same operation from the board's
   * point of view — a reorder moves every column — and three narrow writes would leave the
   * order half-applied if the second failed.
   */
  saveStages(eventId: string, stages: readonly PipelineStage[]): Promise<void>;
  /**
   * Move every prospect in one stage to another and delete the stage, in one batch.
   *
   * The migration and the delete cannot be two requests: between them the board would be
   * serving a stage key no column exists for, which is the state this refuses to create.
   *
   * The caller passes who is moving them and when, **not which prospects are moving**. It used
   * to pass a list of finished transition rows built from a separate read, and the gap between
   * that read and this write was a real defect in both directions: a card that left the stage in
   * between got a history entry for a move it never made, and a card that arrived was migrated
   * with no history at all. Only the implementation can know which rows its own `WHERE` matched,
   * so it writes the history from the same predicate it moves by, and the id of each entry is
   * its to mint.
   */
  deleteStage(
    eventId: string,
    stageKey: string,
    migrateTo: string,
    move: StageMigration,
    remaining: readonly PipelineStage[],
  ): Promise<void>;
  listTransitions(eventId: string): Promise<readonly ProspectTransition[]>;
}
