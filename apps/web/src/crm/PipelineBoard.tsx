/*
 * The sourcing board: one column per configured stage, one card per prospect.
 *
 * A board is the surface an organizer actually works a pipeline on, and the table this sits
 * beside answers a different question — "who is stuck" rather than "where is everybody". Both
 * read the same stages, so a rename or a reorder moves them together.
 *
 * ## Moving a card, twice over
 *
 * Pointer *and* keyboard, and neither is a decoration. #145 is this repository's own cautionary
 * tale: a drag handle rendered with no drag behaviour attached, shipped, and nobody noticed
 * because the handle looked like it worked. So the pointer path is real HTML5 drag-and-drop with
 * a drop target per column, and the keyboard path is not a fallback but the same command reached
 * a different way — focus a card, press an arrow, it moves and says so.
 *
 * Every move is a request. There is no optimistic reorder: the server decides whether the target
 * stage exists and whether the prospect may leave where it is, and a card that snapped into a
 * column and then snapped back would be the most confusing possible way to learn that.
 */

import type { PipelineStageDto, ProspectDto } from "@greenroom/contracts";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, Pill } from "../ui/primitives";

/** The tone each semantic category is drawn in, so a board reads as a funnel at a glance. */
const CATEGORY_TONE: Record<PipelineStageDto["category"], "neutral" | "info" | "ok" | "warn"> = {
  open: "info",
  won: "ok",
  nurture: "warn",
  lost: "neutral",
};
const CATEGORY_LABEL: Record<PipelineStageDto["category"], string> = {
  open: "Open",
  won: "Won",
  nurture: "Nurture",
  lost: "Lost",
};

/**
 * The one stage the product writes rather than the organizer.
 *
 * Converting a prospect is what puts a card here, so the column accepts no drops and the arrow
 * keys skip it. The server refuses it too — this only avoids inviting a gesture that would be
 * refused, which is the other half of what #145's disabled-looking control got wrong.
 */
const CONVERTED = "converted";

export function PipelineBoard({
  stages,
  prospects,
  selectedId,
  busy,
  onOpen,
  onMove,
}: {
  stages: readonly PipelineStageDto[];
  prospects: readonly ProspectDto[];
  selectedId: string;
  busy: boolean;
  onOpen: (prospect: ProspectDto) => void;
  /** Answers with what to announce, so the board does not own the wording of a refusal. */
  onMove: (prospect: ProspectDto, toStage: PipelineStageDto) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /*
   * Which card should hold focus once a move has landed.
   *
   * A moved card leaves one column's list and joins another's, so React unmounts and remounts
   * its button — and a keyboard user who pressed an arrow would otherwise be standing on the
   * document body, able to move a card exactly once. Restoring focus is what makes the second
   * press possible, which is the difference between a keyboard path and a keyboard gesture.
   *
   * A ref callback cannot do this: it fires on the render *before* the reload lands, consumes
   * the token, and the remount that actually matters then has nothing to act on. Verified by
   * driving it — the first arrow moved a card and the second went to `<body>`.
   */
  const [refocus, setRefocus] = useState<{ id: string; toStage: string } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    // Only once the *data* says the move landed. The card exists in its old column the whole
    // time, so waiting for the element alone focuses it one render too early — the reload then
    // moves it and focus goes to `<body>`, which is what driving this actually showed.
    const landed = prospects.find(({ id }) => id === refocus.id)?.stage === refocus.toStage;
    if (!landed) return;
    document
      .querySelector<HTMLButtonElement>(`.pipeline-card[data-prospect="${CSS.escape(refocus.id)}"]`)
      ?.focus();
    setRefocus(null);
  }, [refocus, prospects]);

  const byStage = useMemo(() => {
    const columns = new Map<string, ProspectDto[]>(stages.map(({ key }) => [key, []]));
    for (const prospect of prospects) {
      const column = columns.get(prospect.stage);
      if (column) column.push(prospect);
    }
    return columns;
  }, [stages, prospects]);

  /*
   * Cards whose stage is not a column on this board.
   *
   * Only reachable when a stage was deleted underneath a stale tab — the delete moves everything
   * out first — but rendering nothing would silently lose a prospect from the surface that
   * exists to show all of them, which is exactly the class #206 is about.
   */
  const stranded = prospects.filter(
    (prospect) => !stages.some(({ key }) => key === prospect.stage),
  );

  const movable = stages.filter(({ key }) => key !== CONVERTED);

  const move = (prospect: ProspectDto, target: PipelineStageDto | undefined) => {
    if (!target || busy || target.key === prospect.stage) return;
    setRefocus({ id: prospect.id, toStage: target.key });
    onMove(prospect, target);
  };

  /** Arrow keys walk the movable columns; Home and End jump to the ends of the board. */
  const onCardKeyDown = (event: React.KeyboardEvent, prospect: ProspectDto) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = movable.findIndex(({ key }) => key === prospect.stage);
    if (index < 0) return;
    const target =
      event.key === "ArrowRight"
        ? movable[index + 1]
        : event.key === "ArrowLeft"
          ? movable[index - 1]
          : event.key === "Home"
            ? movable[0]
            : event.key === "End"
              ? movable.at(-1)
              : undefined;
    if (!target) return;
    // Only once a key this board actually handles was pressed, so a page-scrolling arrow on a
    // card at either end still scrolls.
    event.preventDefault();
    move(prospect, target);
  };

  if (!stages.length)
    return (
      <EmptyState title="This board has no stages yet">
        Add a stage to start sourcing speakers for this event.
      </EmptyState>
    );

  return (
    <div className="pipeline-board">
      <p className="pipeline-board-help" id="pipeline-board-help">
        Drag a card to another stage, or focus one and use the arrow keys. Converted is reached by
        converting a prospect, not by moving one.
      </p>
      <div className="pipeline-columns">
        {stages.map((stage) => {
          const cards = byStage.get(stage.key) ?? [];
          const accepts = stage.key !== CONVERTED;
          return (
            <section
              key={stage.key}
              className={`pipeline-column${over === stage.key ? " is-over" : ""}${accepts ? "" : " is-closed"}`}
              aria-labelledby={`pipeline-stage-${stage.key}`}
              onDragOver={(event) => {
                if (!accepts || !dragging) return;
                // Without this the browser refuses the drop and the card springs back, which is
                // indistinguishable from a board that ignored it.
                event.preventDefault();
                setOver(stage.key);
              }}
              onDragLeave={() => setOver((current) => (current === stage.key ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const id = event.dataTransfer.getData("text/plain") || dragging;
                const prospect = prospects.find((item) => item.id === id);
                if (accepts && prospect) move(prospect, stage);
                setDragging(null);
              }}
            >
              <header className="pipeline-column-head">
                <h3 id={`pipeline-stage-${stage.key}`}>{stage.label}</h3>
                <span className="pipeline-column-meta">
                  <Pill tone={CATEGORY_TONE[stage.category]}>{CATEGORY_LABEL[stage.category]}</Pill>
                  <span className="pipeline-count">{cards.length}</span>
                </span>
              </header>
              {cards.length ? (
                <ul className="pipeline-cards">
                  {cards.map((prospect) => (
                    <li key={prospect.id}>
                      {/* The card is the control: one thing to focus, drag and press. A card
                          that opened on click but dragged from a separate handle would give
                          the keyboard two targets for one object. */}
                      <button
                        type="button"
                        className={`pipeline-card${prospect.id === selectedId ? " is-selected" : ""}`}
                        draggable={accepts && !busy}
                        aria-describedby="pipeline-board-help"
                        aria-current={prospect.id === selectedId ? "true" : undefined}
                        data-prospect={prospect.id}
                        onDragStart={(event) => {
                          setDragging(prospect.id);
                          event.dataTransfer.setData("text/plain", prospect.id);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        onKeyDown={(event) => onCardKeyDown(event, prospect)}
                        onClick={() => onOpen(prospect)}
                      >
                        <span className="pipeline-card-name">{prospect.name}</span>
                        <span className="pipeline-card-meta">
                          {prospect.contacts.find(({ isPrimary }) => isPrimary)?.email ??
                            prospect.contacts[0]?.email ??
                            "No contact"}
                        </span>
                        {prospect.nextAction ? (
                          <span className="pipeline-card-next">{prospect.nextAction}</span>
                        ) : null}
                        {/* The stage is on the card as well as above the column: a screen
                            reader reaching a card by heading or by list does not necessarily
                            have the column header in earshot. */}
                        <span className="visually-hidden">In {stage.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pipeline-column-empty">Nobody here yet</p>
              )}
            </section>
          );
        })}
      </div>
      {stranded.length ? (
        <p className="pipeline-stranded" role="status">
          {stranded.length} prospect{stranded.length === 1 ? "" : "s"} sit in a stage this board no
          longer has. Reload to see where they were moved.
        </p>
      ) : null}
    </div>
  );
}
