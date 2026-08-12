import type { AgendaDraft, Placement } from "../../domain/agenda/agenda";

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

export interface AgendaRepository {
  getDraft(eventId: string): Promise<AgendaDraft | null>;
  saveDraft(draft: AgendaDraft): Promise<void>;
  saveResources(
    eventId: string,
    resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">,
  ): Promise<boolean>;
  savePlacement(eventId: string, placement: Placement): Promise<AgendaDraft | null>;
  removePlacement(eventId: string, placementId: string): Promise<void>;
  /**
   * Commit one immutable publication, and with it the event announcing it.
   *
   * Reports a taken version — rather than throwing — because it is the ordinary outcome of two
   * organizers publishing at once rather than an error either of them can act on. The caller
   * allocates the next version and retries; that loop is what makes concurrent publications
   * distinct and monotonic without a lost publication or an overwritten snapshot. A replayed
   * command key is reported separately and must not be retried at all.
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
  /** The publication a previous attempt of this command committed, if it got that far. */
  findByCommandKey(eventId: string, commandKey: string): Promise<PublishedSchedule | null>;
}

export type PublicSchedule = Omit<PublishedSchedule, "publishedBy">;
