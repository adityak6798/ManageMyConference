import {
  type AgendaDraft,
  conflictsFor,
  EMPTY_BOARD_OCCURRENCES,
  type Placement,
  type SessionScheduleRevision,
} from "../../domain/agenda/agenda";
import {
  type AssistedPlacementPlan,
  planAssistedPlacements,
} from "../../domain/agenda/assisted-placement";
import type { AgendaContentQuery } from "../content/public";
import { type Actor, requireEventCapability } from "../identity/actor";
import type { AgendaRepository, PublishedSchedule } from "./agenda-repository";
import type { ContentAgendaInterface } from "./public";

export class AgendaConflictError extends Error {
  constructor(readonly conflicts: ReturnType<typeof conflictsFor>) {
    super("Schedule conflicts must be resolved before publication");
  }
}
export class AgendaNotFoundError extends Error {}
export class AgendaResourceInUseError extends Error {}
/** Version allocation kept losing to concurrent publications; the caller should retry. */
export class AgendaPublicationConflictError extends Error {}

/**
 * How many versions to try before giving up.
 *
 * Each attempt loses only to a publication that committed between this one's read and its
 * write, so exhausting five means five publications landed during one request. That is not
 * contention to wait out, it is a signal worth surfacing.
 */
const PUBLISH_ALLOCATION_ATTEMPTS = 5;

// @spec PRD-AGD-001
export class AgendaService implements ContentAgendaInterface {
  constructor(
    private readonly repository: AgendaRepository,
    private readonly now: () => Date,
    private readonly content: AgendaContentQuery,
    _canManageEvent: (actor: Actor, eventId: string) => Promise<boolean> = async () => false,
  ) {}

  private async organizer(actor: Actor | null, eventId: string): Promise<Actor> {
    return requireEventCapability(actor, eventId, "agenda:manage");
  }

  async draft(actor: Actor | null, eventId: string) {
    await this.organizer(actor, eventId);
    return this.readDraft(eventId);
  }

  private async readDraft(eventId: string) {
    return (await this.readSchedulingContext(eventId)).draft;
  }

  /**
   * The board plus the track each session declares.
   *
   * Assisted placement needs the declared tracks, and the draft projection deliberately does not
   * carry them: a track is a fact the content domain owns about a session, not part of the
   * published snapshot's shape. Reading both here keeps the cost at one draft read and one
   * schedulable-content read whether the caller wants the tracks or not.
   */
  private async readSchedulingContext(eventId: string) {
    const draft = await this.repository.getDraft(eventId);
    if (!draft) throw new AgendaNotFoundError("Agenda not found");
    const schedulable = await this.content.listSchedulableSessions(eventId);
    const sessions = schedulable.map((session) => ({
      id: session.id,
      title: session.title,
      speakerIds: session.speakerProfileIds,
    }));
    /*
     * `occurrences` is normalized here rather than left absent, so every consumer sees the same
     * shape whether or not the stored board predates them. A board that has never been edited
     * since it was created answers `0` for everything, which is the truth about it.
     */
    const composed = {
      ...draft,
      sessions,
      occurrences: draft.occurrences ?? EMPTY_BOARD_OCCURRENCES,
    };
    return {
      draft: { ...composed, conflicts: conflictsFor(composed) },
      trackHints: new Map(schedulable.map((session) => [session.id, session.tracks])),
    };
  }

  async place(actor: Actor | null, eventId: string, placement: Placement) {
    await this.organizer(actor, eventId);
    const draft = await this.readDraft(eventId);
    if (!draft.sessions.some(({ id }) => id === placement.sessionId))
      throw new AgendaNotFoundError("Session not found");
    if (!draft.rooms.some(({ id }) => id === placement.roomId))
      throw new AgendaNotFoundError("Room not found");
    if (!draft.tracks.some(({ id }) => id === placement.trackId))
      throw new AgendaNotFoundError("Track not found");
    if (!draft.slots.some(({ id }) => id === placement.slotId))
      throw new AgendaNotFoundError("Slot not found");
    const persisted = await this.repository.savePlacement(eventId, placement);
    if (!persisted) throw new AgendaNotFoundError("Agenda not found");
    const placed = {
      ...persisted,
      sessions: draft.sessions,
    };
    return { ...placed, conflicts: conflictsFor(placed) };
  }

  /**
   * Seat every unscheduled session in one action, and say what could not be seated.
   *
   * The result is draft state and nothing more: the placements are ordinary placements, the
   * board keeps its existing conflict panel, manual moves and removals still apply, and the
   * schedule reaches the public surface only through the explicit publish command. Nothing
   * about generating a draft publishes it.
   *
   * Costs the same two reads and one write as placing a single session by hand, regardless of
   * how many sessions it seats — the planning is a pure function over a board already in hand,
   * and the whole set commits as one revision (issue #69).
   */
  async autoPlace(actor: Actor | null, eventId: string, sessionIds?: readonly string[]) {
    await this.organizer(actor, eventId);
    const { draft, trackHints } = await this.readSchedulingContext(eventId);
    const unknown = sessionIds?.filter(
      (id) => !draft.sessions.some((session) => session.id === id),
    );
    if (unknown?.length) throw new AgendaNotFoundError("Session not found");
    /*
     * Planned inside the write, not before it. The repository runs this against the revision it
     * is about to replace, so a placement another organizer committed since this request read
     * the board is already present when cells are chosen — and a lost compare-and-set re-plans
     * rather than merging an answer computed from a board that no longer exists.
     *
     * `sessions` is safe to close over: it came from the content domain at the top of this
     * request and is not part of the stored draft, so re-reading the draft cannot change it.
     */
    let unplaced: AssistedPlacementPlan["unplaced"] = [];
    let planned: readonly Placement[] = [];
    const persisted = await this.repository.savePlacements(eventId, (current) => {
      const plan = planAssistedPlacements(
        { ...current, sessions: draft.sessions },
        { ...(sessionIds ? { sessionIds } : {}), trackHints },
      );
      unplaced = plan.unplaced;
      planned = plan.placements;
      return plan.placements;
    });
    if (!persisted) throw new AgendaNotFoundError("Agenda not found");
    const board = { ...persisted, sessions: draft.sessions };
    /*
     * What this pass seated, told by the only party that can know it — and read off the board
     * that was actually stored, not off the last plan this request computed.
     *
     * The caller cannot work it out: the board in this response also carries whatever another
     * organizer committed while the request was in flight, so a difference of boards credits
     * this action with their work. Nor is the plan itself the answer: the repository may run it
     * more than once behind a compare-and-set, and an attempt that lost the race planned
     * placements that were never written. A planned placement counts only if the stored board
     * came back holding it.
     */
    const stored = new Set(persisted.placements.map(({ id }) => id));
    const placed = planned.filter(({ id }) => stored.has(id)).map(({ sessionId }) => sessionId);
    return { ...board, conflicts: conflictsFor(board), placed, unplaced };
  }

  async configure(
    actor: Actor | null,
    eventId: string,
    resources: Pick<AgendaDraft, "rooms" | "tracks" | "slots">,
  ) {
    await this.organizer(actor, eventId);
    if (!(await this.repository.saveResources(eventId, resources)))
      throw new AgendaResourceInUseError("Remove affected placements before deleting resources");
    return this.readDraft(eventId);
  }

  async remove(actor: Actor | null, eventId: string, placementId: string) {
    await this.organizer(actor, eventId);
    await this.repository.removePlacement(eventId, placementId);
  }

  /**
   * Freeze the board into the next immutable snapshot, and announce it.
   *
   * Versions are allocated by attempt rather than reserved in advance: read the version in
   * force, try to commit the next one, and if a concurrent publication got there first, read
   * again and try the one after. Two organizers publishing at the same instant therefore end
   * up with two publications numbered `n` and `n+1` — both durable, neither overwriting the
   * other, and neither operator shown a constraint violation for a race they could not see.
   *
   * The alternative, allocating from the value read before the write, is what made the
   * previous version lose a publication: both attempts computed the same number and the second
   * insert failed against the primary key. Nothing here is retried on a *real* failure, only on
   * a taken version, so a broken publication surfaces immediately.
   *
   * The bound exists because an unbounded loop under sustained concurrent publication is a
   * request that never returns. Exhausting it means the event is being published faster than
   * this can allocate, which is a condition an organizer should be told about rather than one
   * to hide behind a spinner.
   */
  async publish(
    actor: Actor | null,
    eventId: string,
    commandKey?: string,
  ): Promise<PublishedSchedule> {
    const authorized = await this.organizer(actor, eventId);
    /*
     * A retried command answers with what its first attempt committed, rather than freezing the
     * board a second time. Checked before the conflict test as well as inside the loop: the
     * board may have moved into conflict since the publication this command already produced,
     * and refusing a retry for a conflict introduced afterwards would report a failure for
     * something that succeeded.
     */
    if (commandKey) {
      const replayed = await this.repository.findByCommandKey(eventId, commandKey);
      if (replayed) return replayed;
    }
    const draft = await this.readDraft(eventId);
    const conflicts = conflictsFor(draft);
    if (conflicts.length) throw new AgendaConflictError(conflicts);
    /*
     * Neither the conflicts nor the occurrences belong in a snapshot. Both are statements about
     * the *draft* — what is wrong with it now, and when each part of it last moved — while a
     * publication is a frozen programme that will be read years later by callers that have no
     * business knowing how it was edited — `publishedScheduleSchema` describes exactly that shape,
     * and two publications of an identical board should be identical bytes rather than differ by
     * the edit history behind them.
     */
    const { conflicts: _computedConflicts, occurrences: _draftOnly, ...agenda } = draft;
    const snapshot = structuredClone(agenda);
    for (let attempt = 0; attempt < PUBLISH_ALLOCATION_ATTEMPTS; attempt += 1) {
      const previous = await this.repository.getPublished(eventId);
      const schedule = {
        eventId,
        version: (previous?.version ?? 0) + 1,
        publishedAt: this.now().toISOString(),
        publishedBy: authorized.id,
        agenda: snapshot,
        ...(commandKey ? { commandKey } : {}),
      };
      const outcome = await this.repository.publish(schedule);
      if (outcome === "committed") return schedule;
      // A concurrent retry of this same command won the race; its publication is the answer.
      if (outcome === "command-replayed" && commandKey) {
        const replayed = await this.repository.findByCommandKey(eventId, commandKey);
        if (replayed) return replayed;
      }
    }
    throw new AgendaPublicationConflictError(
      "Another publication is in progress; try publishing again.",
    );
  }

  async published(eventId: string) {
    const schedule = await this.repository.getPublished(eventId);
    if (!schedule) return null;
    const { publishedBy: _auditOnly, ...publicSchedule } = schedule;
    return publicSchedule;
  }

  /**
   * `ContentAgendaInterface`: when and where the published snapshot puts each session.
   *
   * No actor is required, for the same reason `published` needs none — the snapshot in force is
   * what the event has already committed to publicly. Callers still authorize their own read of
   * the sessions they are asking about.
   *
   * One repository read. This used to replay the whole publication history on every call, which
   * cost O(publications x board size) on a path both the organizer content workspace and the
   * speaker calendar-invite send take. The fold now runs once per publication, in the batch that
   * commits it (issue #141); what is left here is the read.
   */
  async publishedSessionSchedules(
    eventId: string,
  ): Promise<ReadonlyMap<string, SessionScheduleRevision>> {
    return this.repository.sessionScheduleRevisions(eventId);
  }

  /**
   * `ContentAgendaInterface`: drop every draft placement of one session.
   *
   * Used when a session leaves the programme. Removing the placements is what keeps the board
   * from advertising — and `conflictsFor` from reporting `MISSING_SESSION` for — a session that
   * no longer exists. An event with no draft has nothing to remove and is not an error.
   */
  async unscheduleSession(actor: Actor | null, eventId: string, sessionId: string): Promise<void> {
    await this.organizer(actor, eventId);
    const draft = await this.repository.getDraft(eventId);
    if (!draft) return;
    for (const placement of draft.placements.filter((item) => item.sessionId === sessionId))
      await this.repository.removePlacement(eventId, placement.id);
  }
}
