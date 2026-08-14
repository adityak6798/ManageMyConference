import type {
  PipelineStage,
  Prospect,
  ProspectActivity,
  ProspectContact,
  ProspectTransition,
} from "../../domain/crm/prospect";
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
    transition?: ProspectTransition,
  ): Promise<void>;
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
  /** How many prospects sit in each stage key, so a delete knows what it would strand. */
  countByStage(eventId: string): Promise<ReadonlyMap<string, number>>;
  /**
   * Move every prospect in one stage to another and delete the stage, in one batch.
   *
   * The migration and the delete cannot be two requests: between them the board would be
   * serving a stage key no column exists for, which is the state this refuses to create.
   */
  deleteStage(
    eventId: string,
    stageKey: string,
    migrateTo: string,
    transitions: readonly ProspectTransition[],
    remaining: readonly PipelineStage[],
  ): Promise<void>;
  listTransitions(eventId: string): Promise<readonly ProspectTransition[]>;
}
