import type {
  AgendaDraft,
  Placement,
  SessionScheduleDrift,
  SessionScheduleRevision,
} from "../../domain/agenda/agenda";

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
   *
   * **Never serves an answer it knows to be stale.** Maintaining the stored form is the write
   * path's job; noticing that some *other* writer moved the history is this one's. An
   * implementation that stores the answer must check, cheaply, that it still describes the
   * publication history — and re-derive it before answering if it does not (issue #169). What
   * "cheaply" has to mean is one indexed row: a check that replayed the history on every read
   * would reinstate exactly the cost #141 removed.
   */
  sessionScheduleRevisions(eventId: string): Promise<ReadonlyMap<string, SessionScheduleRevision>>;
  /**
   * Replay the publication history and say how the stored revisions differ from it — and,
   * optionally, make them agree.
   *
   * The expensive, exact counterpart to the cheap check above. The watermark can only notice that
   * the history moved; this recomputes the fold from the immutable snapshots and compares every
   * field of every row, so it also catches a table that was corrupted without the history moving
   * at all. That is why the on-demand surface runs this rather than trusting the watermark.
   *
   * `repair: false` is a pure read and writes nothing, including the watermark: an operator
   * asking "is this event sound" must be able to ask without changing the answer.
   */
  reconcileSessionSchedules(
    eventId: string,
    options: { readonly repair: boolean },
  ): Promise<ScheduleReconciliation>;
  /**
   * Events whose stored revisions are known to lag their publication history, newest first is
   * *not* promised — the order is the storage's own and the caller repairs all of them.
   *
   * Bounded by `limit` because this feeds a one-minute tick: a sweep that tried to repair every
   * event of a large deployment in one tick would replay every history in one invocation. Drift
   * left behind by the bound is picked up by the next tick, and is in the meantime still repaired
   * on demand by any read of that event's schedule.
   */
  driftedEvents(limit: number): Promise<readonly string[]>;
  /** The publication a previous attempt of this command committed, if it got that far. */
  findByCommandKey(eventId: string, commandKey: string): Promise<PublishedSchedule | null>;
}

/**
 * What a reconciliation found, and whether it acted.
 *
 * The two watermarks are reported alongside the drift because they answer different questions.
 * The drift says what is wrong *now*; the watermarks say whether anything had noticed — a
 * divergence with equal watermarks is a table that was written behind the fold's back, which is a
 * different problem from a publication the fold never saw.
 */
export interface ScheduleReconciliation {
  readonly eventId: string;
  /**
   * How many writes this event's publication history has taken, as storage counts them; null if
   * it has never taken one. A counter rather than a version, because two writes can carry the
   * same version and the question being asked is whether *anything* happened.
   */
  readonly publicationWatermark: number | null;
  /** What that counter held when the stored revisions were last derived; null means never. */
  readonly materializedWatermark: number | null;
  /** How many publications the replay walked, which is the cost this call actually paid. */
  readonly publications: number;
  readonly drift: SessionScheduleDrift;
  /**
   * Whether the stored answer can be believed — the rows agree with the history *and* the
   * watermark says so.
   *
   * Both halves, and reported by storage rather than derived by each caller, because they can
   * disagree: an event backfilled by migration `1602` has correct rows and an unclaimed
   * watermark, and a surface that read only `drift` would call it sound while the reconciler
   * still queues it for repair. It describes what this call *found*, so a repairing call answers
   * `inSync: false` with `repaired: true` and the next call answers `inSync: true`.
   */
  readonly inSync: boolean;
  /** Whether this call wrote the replayed answer back. False when asked not to, or when sound. */
  readonly repaired: boolean;
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
