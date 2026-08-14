/**
 * Generating agenda drafts, comparing them with the board, and accepting the parts you want.
 *
 * Issue #192's residual Private-set agenda-generation epic. `assistedPlacement` already seats
 * unscheduled sessions by first fit and writes straight onto the live board; this is the other
 * half, and every difference is deliberate.
 *
 * **A generated draft never touches the board.** Generating one is a read plus an insert into
 * `agenda_generated_drafts`. Only `accept` writes placements, and only the ones the organizer
 * named. That is what makes "generate three arrangements and compare them" possible at all — the
 * existing action can only be run by already having changed things.
 *
 * **Accepting re-plans inside the compare-and-set.** `savePlacements` takes a callback rather
 * than a list precisely because a plan is only conflict-free with respect to the board it was
 * computed from; a placement committed in between would otherwise be merged over. So the accept
 * recomputes its placements against the draft actually being written, and a board that moved
 * produces a refusal the organizer can act on rather than a silent overlap.
 *
 * **Staleness is reported rather than hidden.** A draft records the board revision it was
 * generated against, and a comparison against a board that has since moved says so. Proposing
 * placements into slots that no longer exist, without saying the board changed, is the failure
 * this exists to avoid.
 *
 * **Provenance survives acceptance.** An accepted draft keeps its row, its criteria and its
 * explanations, so "why is the keynote in Hall B" has an answer months later.
 *
 * @spec PRD-AGD-001 ARC-DOM-001
 */
import type { AgendaDraft, Placement } from "../../domain/agenda/agenda";
import {
  type AvailabilityWindow,
  comparePlan,
  CRITERION_KEYS,
  type Criterion,
  type CriterionKey,
  DEFAULT_CRITERIA,
  generateAgendaDraft,
  type PlacementChange,
  type UnplacedExplanation,
} from "../../domain/agenda/draft-generation";
import { type Actor, requireEventCapability } from "../identity/actor";

export class GeneratedDraftNotFoundError extends Error {}
export class GeneratedDraftInvalidError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
/** The board moved after the draft was generated, so accepting it would apply a stale plan. */
export class GeneratedDraftStaleError extends Error {
  constructor(readonly boardRevision: number) {
    super(
      "The board has changed since this draft was generated. Re-run it to compare against the board as it stands.",
    );
  }
}

export interface GeneratedDraft {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly boardRevision: number;
  readonly criteria: readonly Criterion[];
  readonly placements: readonly Placement[];
  readonly unplaced: readonly UnplacedExplanation[];
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly status: "proposed" | "accepted" | "discarded";
  readonly acceptedAt: string | null;
}

export interface GenerationRepository {
  listDrafts(eventId: string): Promise<readonly GeneratedDraft[]>;
  findDraft(eventId: string, draftId: string): Promise<GeneratedDraft | null>;
  createDraft(draft: GeneratedDraft): Promise<void>;
  setDraftStatus(
    eventId: string,
    draftId: string,
    status: "accepted" | "discarded",
    at: string | null,
  ): Promise<number>;
  /** Null means the event has never configured a library, which reads as the defaults. */
  listCriteria(eventId: string): Promise<readonly Criterion[] | null>;
  replaceCriteria(eventId: string, criteria: readonly Criterion[]): Promise<void>;
  listAvailability(eventId: string): Promise<readonly AvailabilityWindow[]>;
  replaceAvailability(eventId: string, windows: readonly AvailabilityWindow[]): Promise<void>;
}

/** The board reads and the one write this service needs, stated as the narrowest shape. */
export interface GenerationBoard {
  getDraft(eventId: string): Promise<AgendaDraft | null>;
  /** The board's optimistic revision, for recording what a generated draft was made against. */
  boardRevision(eventId: string): Promise<number>;
  savePlacements(
    eventId: string,
    plan: (draft: AgendaDraft) => readonly Placement[],
  ): Promise<AgendaDraft | null>;
  removePlacement(eventId: string, placementId: string): Promise<void>;
}

export interface GenerationDependencies {
  repository: GenerationRepository;
  board: GenerationBoard;
  /** Each session's declared tracks, from content's own read. Optional; absent means no hint. */
  declaredTracks?: (
    actor: Actor | null,
    eventId: string,
  ) => Promise<Readonly<Record<string, readonly string[]>>>;
  newId(): string;
  now(): Date;
}

const MAX_AVAILABILITY_WINDOWS = 200;

export class AgendaGenerationService {
  constructor(private readonly dependencies: GenerationDependencies) {}

  private authorize(actor: Actor | null, eventId: string): Actor {
    return requireEventCapability(actor, eventId, "agenda:manage");
  }

  /** The library in priority order, defaulted for an event that has never configured one. */
  async criteria(actor: Actor | null, eventId: string): Promise<readonly Criterion[]> {
    this.authorize(actor, eventId);
    const stored = await this.dependencies.repository.listCriteria(eventId);
    return stored ?? DEFAULT_CRITERIA;
  }

  /**
   * Replace the library.
   *
   * Whole-set replacement, and every key present exactly once: a library missing a criterion is
   * a criterion whose priority is undefined, and the generator would then have to invent one.
   * Positions are renumbered from the order supplied, so the caller sends an order rather than
   * having to compute contiguous integers.
   */
  async setCriteria(
    actor: Actor | null,
    eventId: string,
    entries: readonly { criterion: string; enabled?: boolean | undefined }[],
  ): Promise<readonly Criterion[]> {
    this.authorize(actor, eventId);
    const seen = new Set<string>();
    const ordered: Criterion[] = [];
    for (const entry of entries) {
      if (!CRITERION_KEYS.includes(entry.criterion as CriterionKey))
        throw new GeneratedDraftInvalidError(`${entry.criterion} is not a scheduling criterion.`, {
          criteria: [`${entry.criterion} is not a scheduling criterion.`],
        });
      if (seen.has(entry.criterion)) continue;
      seen.add(entry.criterion);
      ordered.push({
        criterion: entry.criterion as CriterionKey,
        position: ordered.length,
        enabled: entry.enabled ?? true,
      });
    }
    // Anything the caller left out keeps its default relative order, after everything they named.
    for (const criterion of CRITERION_KEYS)
      if (!seen.has(criterion))
        ordered.push({ criterion, position: ordered.length, enabled: true });
    await this.dependencies.repository.replaceCriteria(eventId, ordered);
    return ordered;
  }

  async availability(actor: Actor | null, eventId: string) {
    this.authorize(actor, eventId);
    return this.dependencies.repository.listAvailability(eventId);
  }

  async setAvailability(
    actor: Actor | null,
    eventId: string,
    windows: readonly AvailabilityWindow[],
  ): Promise<readonly AvailabilityWindow[]> {
    this.authorize(actor, eventId);
    if (windows.length > MAX_AVAILABILITY_WINDOWS)
      throw new GeneratedDraftInvalidError(
        `An event carries at most ${MAX_AVAILABILITY_WINDOWS} availability windows.`,
      );
    // A window that ends before it starts refuses every cell for that speaker, silently. The
    // table refuses it too; this is the half that can say which one was wrong.
    for (const window of windows)
      if (!(Date.parse(window.startsAt) < Date.parse(window.endsAt)))
        throw new GeneratedDraftInvalidError(
          `A window for ${window.speakerId} ends before it starts.`,
          { availability: ["A window has to end after it starts."] },
        );
    await this.dependencies.repository.replaceAvailability(eventId, windows);
    return windows;
  }

  /**
   * Generate one candidate arrangement and store it.
   *
   * The board is read once, and the revision recorded with the draft is the one that read saw.
   * Nothing is written to the board.
   */
  async generate(actor: Actor | null, eventId: string, name: string): Promise<GeneratedDraft> {
    const authorized = this.authorize(actor, eventId);
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 120)
      throw new GeneratedDraftInvalidError("A draft name is 1 to 120 characters.", {
        name: ["A draft name is 1 to 120 characters."],
      });
    const board = await this.dependencies.board.getDraft(eventId);
    if (!board) throw new GeneratedDraftNotFoundError("That event has no agenda board");
    const [criteria, availability, boardRevision, declaredTracks] = await Promise.all([
      this.criteria(actor, eventId),
      this.dependencies.repository.listAvailability(eventId),
      this.dependencies.board.boardRevision(eventId),
      this.dependencies.declaredTracks?.(actor, eventId) ?? Promise.resolve({}),
    ]);
    const plan = generateAgendaDraft(board, { criteria, availability, declaredTracks });
    const draft: GeneratedDraft = {
      id: this.dependencies.newId(),
      eventId,
      name: trimmed,
      boardRevision,
      // Copied rather than referenced: the library is editable, and a draft that named it would
      // change its own explanation the next time somebody reordered a rule.
      criteria: plan.criteria,
      placements: plan.placements,
      unplaced: plan.unplaced,
      generatedBy: authorized.id,
      generatedAt: this.dependencies.now().toISOString(),
      status: "proposed",
      acceptedAt: null,
    };
    await this.dependencies.repository.createDraft(draft);
    return draft;
  }

  async list(actor: Actor | null, eventId: string) {
    this.authorize(actor, eventId);
    return this.dependencies.repository.listDrafts(eventId);
  }

  /**
   * The draft beside the board, session by session.
   *
   * `stale` is the whole reason the board revision is stored: a comparison against a board that
   * has moved is a comparison with something that no longer exists, and proposing placements into
   * vanished slots without saying so is exactly the failure this reports.
   */
  async compare(
    actor: Actor | null,
    eventId: string,
    draftId: string,
  ): Promise<{
    draft: GeneratedDraft;
    changes: readonly PlacementChange[];
    stale: boolean;
    boardRevision: number;
  }> {
    this.authorize(actor, eventId);
    const draft = await this.requireDraft(eventId, draftId);
    const board = await this.dependencies.board.getDraft(eventId);
    if (!board) throw new GeneratedDraftNotFoundError("That event has no agenda board");
    const boardRevision = await this.dependencies.board.boardRevision(eventId);
    return {
      draft,
      changes: comparePlan(board, {
        criteria: draft.criteria,
        placements: draft.placements,
        unplaced: draft.unplaced,
      }),
      stale: boardRevision !== draft.boardRevision,
      boardRevision,
    };
  }

  /**
   * Apply the changes the organizer named, and nothing else.
   *
   * `sessionIds` is the accept list: per-change acceptance is the unit the epic asks for, and
   * it is expressed as sessions because that is the decision an organizer makes. A session they
   * did not name keeps whatever the board says about it.
   *
   * The plan is recomputed *inside* `savePlacements` against the draft actually being written.
   * That is what makes a concurrent edit produce a coherent board rather than a merge of two
   * arrangements: the placements chosen here were conflict-free against the board this draft was
   * generated from, and only re-planning can keep them conflict-free against the board now.
   */
  async accept(
    actor: Actor | null,
    eventId: string,
    draftId: string,
    sessionIds: readonly string[],
  ): Promise<{ applied: number; unscheduled: number }> {
    this.authorize(actor, eventId);
    const draft = await this.requireDraft(eventId, draftId);
    if (draft.status === "discarded")
      throw new GeneratedDraftInvalidError("That draft was discarded.");
    const wanted = new Set(sessionIds);
    const proposed = new Map(
      draft.placements
        .filter((placement) => wanted.has(placement.sessionId))
        .map((placement) => [placement.sessionId, placement]),
    );

    const board = await this.dependencies.board.getDraft(eventId);
    if (!board) throw new GeneratedDraftNotFoundError("That event has no agenda board");
    /*
     * A session the organizer accepted that the draft could not seat is an *unschedule*, not a
     * no-op — the comparison listed it as a removal and they said yes to it. Doing it first, and
     * outside the placement write, keeps the two decisions separable: a failed unplace does not
     * roll back placements the organizer also accepted.
     */
    const toUnschedule = board.placements.filter(
      (placement) => wanted.has(placement.sessionId) && !proposed.has(placement.sessionId),
    );
    for (const placement of toUnschedule)
      await this.dependencies.board.removePlacement(eventId, placement.id);

    let applied = 0;
    if (proposed.size > 0) {
      const written = await this.dependencies.board.savePlacements(eventId, (current) => {
        // Re-derived against the board being written. A proposed placement whose room, track or
        // slot has since disappeared is dropped rather than written: the organizer is told how
        // many landed, and the draft is still there to re-run.
        const rooms = new Set(current.rooms.map(({ id }) => id));
        const tracks = new Set(current.tracks.map(({ id }) => id));
        const slots = new Set(current.slots.map(({ id }) => id));
        const sessions = new Set(current.sessions.map(({ id }) => id));
        const kept = [...proposed.values()].filter(
          (placement) =>
            rooms.has(placement.roomId) &&
            tracks.has(placement.trackId) &&
            slots.has(placement.slotId) &&
            sessions.has(placement.sessionId),
        );
        applied = kept.length;
        return kept;
      });
      if (!written)
        throw new GeneratedDraftStaleError(await this.dependencies.board.boardRevision(eventId));
    }

    // The draft stays, marked, so "where did this arrangement come from" has an answer later.
    await this.dependencies.repository.setDraftStatus(
      eventId,
      draftId,
      "accepted",
      this.dependencies.now().toISOString(),
    );
    return { applied, unscheduled: toUnschedule.length };
  }

  async discard(actor: Actor | null, eventId: string, draftId: string): Promise<number> {
    this.authorize(actor, eventId);
    return this.dependencies.repository.setDraftStatus(eventId, draftId, "discarded", null);
  }

  private async requireDraft(eventId: string, draftId: string): Promise<GeneratedDraft> {
    const draft = await this.dependencies.repository.findDraft(eventId, draftId);
    if (!draft) throw new GeneratedDraftNotFoundError("That draft was not found");
    return draft;
  }
}
