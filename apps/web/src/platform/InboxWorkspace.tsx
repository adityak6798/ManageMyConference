/**
 * The operational inbox at `/inbox`.
 *
 * Five categories, each read from its owning domain on every load, so the page shows what is
 * true rather than what a queue last recorded. Two things it has to be careful about, and both
 * are visible in the code below.
 *
 * **A failed category must not blank the page.** Each category keeps the last value it was given
 * across a failed refresh and reports the failure beside it, following the `Panel<T>` shape
 * `OverviewPage` uses — a dashboard that goes blank because one of five reads failed is worse
 * than no dashboard, because it hides the four that worked.
 *
 * **A dismissal is optimistic but never a lie.** Pressing Dismiss marks the row immediately and
 * reloads; if the write is refused, the reload puts the row back open and the refusal is shown.
 * The item itself is never removed from the list, because "dismissed" is a state of the item and
 * an operator has to be able to undo it.
 *
 * @spec PRD-OPS-002
 */
import type { InboxItemDto, InboxResponseDto } from "@greenroom/contracts";
import { useCallback, useEffect, useState } from "react";
import { ResponseContractError } from "../api/config";
import { dismissInboxItem, getInbox, PlatformApiError, restoreInboxItem } from "../api/platform";
import { useLinkProps } from "../router";
import { Card, EmptyState, Notice, Pill, useActionFeedback } from "../ui/primitives";

type CategoryKey = keyof InboxResponseDto["categories"];

const CATEGORY_ORDER: readonly CategoryKey[] = [
  // Configuration first: an event cloned in part is wrong in a way none of the others describe,
  // and unlike them it is invisible from every surface but the one an operator opens on purpose
  // (issue #203).
  "configuration",
  "programme",
  "speakerWork",
  "reviews",
  "deliveries",
  "publication",
];

const CATEGORY_LABELS: Readonly<Record<CategoryKey, string>> = {
  configuration: "Event configuration",
  programme: "Programme",
  speakerWork: "Speaker work",
  reviews: "Reviews outstanding",
  deliveries: "Deliveries that failed",
  publication: "Publication",
};

/** What each category is *for*, so an empty one reads as good news rather than as a bug. */
const CATEGORY_EMPTY: Readonly<Record<CategoryKey, string>> = {
  configuration: "Every category this event was cloned from arrived.",
  programme: "Every session is placed and the board has no conflicts.",
  speakerWork: "No speaker has outstanding work.",
  reviews: "Every assignment has a completed evaluation.",
  deliveries: "Nothing has failed to reach its recipient.",
  publication: "The public page matches what you have composed.",
};

function describeFailure(reason: unknown): string {
  if (reason instanceof PlatformApiError)
    return `${reason.envelope.error.message} Reference: ${reason.envelope.error.correlationId}`;
  if (reason instanceof ResponseContractError) return reason.message;
  return "The inbox could not be read. Please retry.";
}

function priorityTone(priority: InboxItemDto["priority"]) {
  if (priority === "high") return "danger" as const;
  return priority === "low" ? ("neutral" as const) : ("warn" as const);
}

export function InboxWorkspace({ eventId }: { eventId: string }) {
  /** The last answer that arrived, kept across a failed refresh rather than blanked. */
  const [answer, setAnswer] = useState<InboxResponseDto | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const feedback = useActionFeedback();
  const linkProps = useLinkProps();

  const load = useCallback(async () => {
    try {
      setAnswer(await getInbox(eventId));
      setLoadFailure(null);
    } catch (reason: unknown) {
      // ERROR-INTENT: rendered rather than discarded — the message goes above the categories,
      // and the last answer stays on screen so a failed refresh does not blank a working page.
      setLoadFailure(describeFailure(reason));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    // ERROR-INTENT: effects cannot await; load() renders both outcomes into its own state.
    void load();
  }, [load]);

  async function setDismissed(item: InboxItemDto, dismissed: boolean) {
    setBusyKey(item.key);
    try {
      if (dismissed) await dismissInboxItem(eventId, item.key);
      else await restoreInboxItem(eventId, item.key);
      await load();
      feedback.announce("success", dismissed ? "Dismissed." : "Restored.");
    } catch (reason: unknown) {
      // The list is re-read either way, so a refusal leaves the row in the state the server
      // actually holds rather than in the one the click implied.
      await load();
      feedback.announce("error", describeFailure(reason));
    } finally {
      setBusyKey(null);
    }
  }

  if (loading && !answer)
    return (
      <Card>
        <p className="palette-announce" aria-live="polite">
          Reading everything waiting on this event…
        </p>
      </Card>
    );

  const open = CATEGORY_ORDER.reduce((count, key) => {
    const category = answer?.categories[key];
    return category?.state === "ok"
      ? count + category.items.filter((item) => item.status === "open").length
      : count;
  }, 0);
  const unauthorized = CATEGORY_ORDER.filter(
    (key) => answer?.categories[key].state === "unauthorized",
  );

  return (
    <>
      {feedback.node}

      {loadFailure ? <Notice tone="error">{loadFailure}</Notice> : null}

      <p className="palette-announce" aria-live="polite">
        {answer
          ? `${open} ${open === 1 ? "item is" : "items are"} waiting on this event.`
          : "The inbox could not be read."}
      </p>

      {unauthorized.length > 0 ? (
        <Notice tone="info">
          Not available to your role on this event:{" "}
          {unauthorized.map((key) => CATEGORY_LABELS[key]).join(", ")}.
        </Notice>
      ) : null}

      {answer
        ? CATEGORY_ORDER.map((key) => {
            const category = answer.categories[key];
            if (category.state === "unauthorized") return null;
            return (
              <Card key={key} title={CATEGORY_LABELS[key]} labelledBy={`inbox-${key}`}>
                {category.state === "failed" ? (
                  <Notice tone="error">
                    This could not be read just now. Reference: {category.error.correlationId}.
                    Every other category below is complete.
                  </Notice>
                ) : category.items.length === 0 ? (
                  <EmptyState title="Nothing waiting">{CATEGORY_EMPTY[key]}</EmptyState>
                ) : (
                  <ul className="plain-list">
                    {category.items.map((item) => (
                      <li
                        key={item.key}
                        className={
                          item.status === "dismissed" ? "inbox-item is-dismissed" : "inbox-item"
                        }
                      >
                        <a {...linkProps(item.href)}>{item.title}</a>{" "}
                        <Pill tone={priorityTone(item.priority)}>{item.priority}</Pill>
                        {item.status === "dismissed" ? <Pill>dismissed</Pill> : null}
                        <span className="sub">
                          {[item.subtitle, item.owner, item.dueAt ? `Due ${item.dueAt}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busyKey === item.key}
                          onClick={() => {
                            // ERROR-INTENT: handlers cannot await; setDismissed announces both
                            // outcomes through the live region above.
                            void setDismissed(item, item.status !== "dismissed");
                          }}
                        >
                          {item.status === "dismissed"
                            ? `Restore ${item.title}`
                            : `Dismiss ${item.title}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })
        : null}
    </>
  );
}
