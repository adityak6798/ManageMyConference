/**
 * The semantic meaning of a stage, which is the part a filter or a report may rely on.
 *
 * Closed, and separate from the stage's name for one reason: an organizer renaming Confirmed to
 * Locked In must not break anything that asked "did we win this one". The key is stable, the
 * label is theirs to edit, and this is what everything downstream reads (`1501`).
 */
export const stageCategories = ["open", "won", "nurture", "lost"] as const;
export type StageCategory = (typeof stageCategories)[number];

/** One column of an event's board. */
export interface PipelineStage {
  readonly id: string;
  readonly eventId: string;
  /** Stable across renames. What a prospect row stores and what history refers to. */
  readonly key: string;
  readonly label: string;
  readonly category: StageCategory;
  readonly sortOrder: number;
  readonly createdAt: string;
}

/**
 * The board every event starts with, and the set the migration, the seed and the service all
 * agree on.
 *
 * Named after the documented SessionBoard lifecycle. `identified` and `converted` keep the keys
 * `0015` gave them so no existing prospect row has to be rewritten, and `converted` is `won`
 * because reaching it is the *effect* of a conversion rather than a move somebody makes.
 */
export const DEFAULT_PIPELINE_STAGES: readonly Omit<
  PipelineStage,
  "id" | "eventId" | "createdAt"
>[] = [
  { key: "identified", label: "Identified", category: "open", sortOrder: 0 },
  { key: "contacted", label: "Contacted", category: "open", sortOrder: 1 },
  { key: "engaged", label: "Engaged", category: "open", sortOrder: 2 },
  { key: "invited", label: "Invited", category: "open", sortOrder: 3 },
  { key: "confirmed", label: "Confirmed", category: "won", sortOrder: 4 },
  { key: "converted", label: "Converted", category: "won", sortOrder: 5 },
  { key: "future-fit", label: "Future fit", category: "nurture", sortOrder: 6 },
  { key: "declined", label: "Declined", category: "lost", sortOrder: 7 },
];

/**
 * The one stage the product writes rather than the organizer.
 *
 * Converting a prospect is what puts it here — `crm_activities_one_conversion_idx` makes that a
 * once-ever fact — so a board that let somebody drag a card into it would produce a card that
 * says Converted with no speaker behind it. It cannot be renamed away either: the key is what
 * `convert` writes.
 */
export const CONVERTED_STAGE_KEY = "converted";

/** A stage key an organizer may move a card into. */
export const isMovableStage = (key: string) => key !== CONVERTED_STAGE_KEY;

export interface ProspectContact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly isPrimary: boolean;
}

export interface ProspectActivity {
  readonly id: string;
  readonly kind:
    | "note"
    | "email"
    | "call"
    | "meeting"
    | "engagement"
    | "stage-change"
    | "conversion";
  readonly summary: string;
  readonly private: boolean;
  readonly occurredAt: string;
  readonly actorId: string;
}

/**
 * What moved a card, recorded because "who dragged this and when" is the question a sourcing
 * report is actually asked. `created` and `migration` are not moves anybody made: one is the
 * prospect arriving, the other is the row this history was derived for.
 */
export const transitionSources = [
  "board",
  "detail",
  "created",
  "interest",
  "conversion",
  "migration",
] as const;
export type TransitionSource = (typeof transitionSources)[number];

export interface ProspectTransition {
  readonly id: string;
  readonly eventId: string;
  readonly prospectId: string;
  /** Null for the transition that created the prospect: it came from nowhere. */
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly actorId: string;
  readonly source: TransitionSource;
  readonly occurredAt: string;
}

// @spec PRD-CRM-001
export interface Prospect {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  /** A key from this event's `crm_pipeline_stages`; the service refuses anything else. */
  readonly stage: string;
  readonly ownerId: string;
  readonly nextAction: string | null;
  readonly nextActionAt: string | null;
  readonly contacts: readonly ProspectContact[];
  readonly activities: readonly ProspectActivity[];
  readonly speakerId: string | null;
  readonly convertedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reorder a stage list so the keys are contiguous from zero.
 *
 * Sort order is presentation, and a board that stores it sparsely gets one whose columns drift
 * apart after a few edits. Normalizing on every write means "third from the left" is `2` for
 * everybody, which is also what makes a move-left/move-right control expressible as a swap.
 */
export function normalizeStageOrder<T extends { sortOrder: number; key: string }>(
  stages: readonly T[],
): T[] {
  return stages
    .toSorted(
      (left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key),
    )
    .map((stage, index) => ({ ...stage, sortOrder: index }));
}
