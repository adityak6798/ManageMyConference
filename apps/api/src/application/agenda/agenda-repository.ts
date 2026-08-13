import type { AgendaDraft, Placement, SessionScheduleRevision } from "../../domain/agenda/agenda";

export interface PublishedSchedule {
  readonly eventId: string;
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly agenda: AgendaDraft;
  /**
   * The caller's idempotency key for the command that produced this publication.
   *
   * Absent means the command carried none, which is a statement about the *request*, not about
   * the publication: an organizer pressing Publish twice after editing means two intents and
   * gets two versions. A repeated key means one intent retried, and returns the first result.
   */
  readonly commandKey?: string | undefined;
}

export interface AgendaRepository {
  /**
   * The stored board, always carrying its occurrences.
   *
   * Part of the contract rather than the caller's problem: rows written before the occurrences
   * existed carry none and nothing backfilled them, and the response shape the console decodes
   * requires the field. An implementation normalizes on the way out — which also covers
   * `savePlacements` answering with the board it read when a plan seats nothing, the one write
   * method that returns a draft it did not write.
   */
  getDraft(eventId: string): Promise<AgendaDraft | null>;
  /**
   * Create a board, or replace one wholesale.
   *
   * The create path — a first `saveResources`, or a seed — and not an edit: it folds nothing,
   * because there is no previous board to fold against, so the occurrences it stores are empty.
   * An implementation must not route an edit through it, or that edit's occurrences are lost.
   * Stated here for the same reason `getDraft`'s guarantee is: two implementations agreeing by
   * habit is not a contract, and this one has a wrong answer available to it.
   */
  saveDraft(draft: AgendaDraft): Promise<void>;
  saveResources(
    eventId: string,
    resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">,
  ): Promise<boolean>;
  savePlacement(eventId: string, placement: Placement): Promise<AgendaDraft | null>;
  /**
   * Apply many placements as one revision, planned against the revision actually being written.
   *
   * Not a loop over `savePlacement`: that would cost a read and a write per session, which is
   * the per-placement round-trip cost issue #69 removed and which a bulk action is exactly the
   * place to reintroduce. One optimistic revision covers the whole set.
   *
   * `plan` rather than a fixed list because a plan is only conflict-free with respect to the
   * board it was computed from. Handing over placements chosen from an earlier read lets a
   * placement committed in between take one of the chosen cells, and the merge would then write
   * the overlap the plan existed to avoid. Re-planning inside the compare-and-set means a lost
   * revision re-plans instead of merging a stale answer, and it costs nothing extra when
   * uncontended because the callback runs against a draft the retry loop had already read.
   */
  savePlacements(
    eventId: string,
    plan: (draft: AgendaDraft) => readonly Placement[],
  ): Promise<AgendaDraft | null>;
  removePlacement(eventId: string, placementId: string): Promise<void>;
  /**
   * Commit one immutable publication, and with it the event announcing it.
   *
   * Returns `false` — rather than throwing — when `schedule.version` was already taken, which
   * is the ordinary outcome of two organizers publishing at once rather than an error either
   * of them can act on. The caller allocates the next version and retries; that loop is what
   * makes concurrent publications distinct and monotonic without a lost publication or an
   * overwritten snapshot.
   *
   * The publication and its `EVT-SCHEDULE-PUBLISHED` record are one durable operation. A
   * failure anywhere in it leaves neither, so no consumer can observe a published schedule
   * that was never announced, and no announcement can outlive the snapshot it describes.
   *
   * The event is not a parameter because it is a pure function of the publication
   * (`schedulePublishedEvent`). Deriving it here rather than accepting it is what makes "one
   * event per committed publication, describing that publication" a property of the type
   * rather than something every caller has to remember to get right.
   */
  publish(schedule: PublishedSchedule): Promise<PublishOutcome>;
  getPublished(eventId: string): Promise<PublishedSchedule | null>;
  /**
   * Where the schedule in force puts each session, and when that last meaningfully changed.
   *
   * Stored rather than replayed. The same answer is derivable by folding
   * `nextSessionScheduleRevisions` over every publication this event has ever committed, and
   * that is how it used to be produced — which meant transferring and parsing every board in
   * the history on every read that resolves a session's time, at a cost that grew without
   * bound as an event was republished (issue #141). An implementation maintains this in the
   * same durable operation as the publication that changes it, so a reader can never see a
   * revision for a snapshot that did not commit, nor miss one that did.
   */
  sessionScheduleRevisions(eventId: string): Promise<ReadonlyMap<string, SessionScheduleRevision>>;
  /** The publication a previous attempt of this command committed, if it got that far. */
  findByCommandKey(eventId: string, commandKey: string): Promise<PublishedSchedule | null>;
}

export type PublicSchedule = Omit<PublishedSchedule, "publishedBy">;

/**
 * What happened to a publication attempt, and what the caller should do next.
 *
 * The two refusals need telling apart or the retry loop misreads one as the other. A taken
 * *version* means another publication got this number first: allocate the next and try again.
 * A taken *command key* means this very command already committed: stop, and answer with what
 * it produced. Retrying the second would allocate versions forever, since the key can never
 * become free.
 */
export type PublishOutcome = "committed" | "version-taken" | "command-replayed";
