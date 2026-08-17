/*
 * Communications outbox.
 *
 * Delivery state is the whole point of this surface, so the history loads with the
 * page instead of hiding behind an "inspect" button, and every delivery renders as a
 * row with its state pill, attempt count, and last provider error in line. Retrying
 * and terminal rows carry the recovery action next to the evidence that justifies it,
 * and the result of that retry is announced where the operator is looking.
 *
 * Every failure is rendered by this surface, including the failure to read it: a history that
 * never arrived puts the reason, its correlation id, and a retry where the rows would have
 * been, instead of leaving a skeleton up and explaining it somewhere else on the page.
 */

import type { CommunicationsHistoryDto, EventDto } from "@greenroom/contracts";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { getCommunicationsHistory, retryDelivery } from "./api/communications";
import { ComposePanel } from "./communications/ComposePanel";
import { type ApiFailure, describeApiFailure } from "./api/config";
import "./styles/communications.css";
import { IconChevronDown, IconChevronRight, IconSend } from "./ui/icons";
import {
  EmptyState,
  LoadFailure,
  Pill,
  Section,
  SkeletonRows,
  Tabs,
  useActionFeedback,
} from "./ui/primitives";
import { DELIVERY_STATE_CONSEQUENCE, DELIVERY_STATE_TERMS } from "./ui/vocabulary";

type HistoryEntry = CommunicationsHistoryDto["history"][number];
type DeliveryState = HistoryEntry["delivery"]["state"];

/*
 * The four states, named once for the whole product.
 *
 * This file used to keep its own list, so the same delivery was "Terminal" here, "Failed" in the
 * webhook history and `terminal` in the row underneath — three words for one fact, none of which
 * said what it means: nothing will try again until somebody retries it.
 */
const STATES: DeliveryState[] = ["queued", "retrying", "succeeded", "terminal"];

/** Only these two states are recoverable; the API rejects a retry on the others. */
const RECOVERABLE = new Set<DeliveryState>(["retrying", "terminal"]);

const stampedTime = (instant: string) =>
  new Date(instant).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/*
 * A template, named the way this product names things rather than the way storage does.
 *
 * The column printed `template-speaker-task-v1` — a row key, in the same weight as the
 * recipient beside it. Everything in that string is already on screen: the version has its own
 * line underneath, and `template-` is true of every row. What is left is the message, so that
 * is what the cell says; the key stays on the cell's `title` for anybody matching it against a
 * configuration file.
 */
const templateName = (id: string) =>
  technicalLabel(id.replace(/^template[-_]/, "").replace(/[-_]v\d+$/, "")) || id;

function templateLabel({ delivery }: HistoryEntry) {
  if (delivery.templateId)
    return {
      name: templateName(delivery.templateId),
      key: delivery.templateId,
      detail: delivery.templateVersion === null ? null : `Version ${delivery.templateVersion}`,
    };
  if (delivery.projectionVersion !== null)
    return { name: "Projection", key: null, detail: `Version ${delivery.projectionVersion}` };
  return { name: "—", key: null, detail: null };
}

function lastError({ attempts }: HistoryEntry) {
  const failed = [...attempts].reverse().find((attempt) => attempt.outcome !== "succeeded");
  return failed?.errorCode ?? null;
}

const DELIVERY_ERRORS: Readonly<Record<string, string>> = {
  PROVIDER_REJECTED: "Provider rejected the delivery",
  PROVIDER_TIMEOUT: "Provider timed out",
};

function deliveryErrorLabel(code: string) {
  return DELIVERY_ERRORS[code] ?? "Delivery failed";
}

function technicalLabel(value: string) {
  const words = value.replace(/[._-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

const readError = (reason: unknown, fallback: string) =>
  describeApiFailure(reason, fallback).message;

interface CommunicationsWorkspaceProps {
  event: EventDto;
}

// @spec PRD-COM-001 PRD-INT-001
export function CommunicationsWorkspace({ event }: CommunicationsWorkspaceProps) {
  const [history, setHistory] = useState<CommunicationsHistoryDto["history"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Why the outbox is not on screen. Only the read that leaves this surface empty is held
  // here; a refused refresh of an outbox already rendered is announced beside the control
  // that asked for it instead, because that is where the operator is looking.
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const eventIdRef = useRef(event.id);
  // `load` is memoized and drives the mount effect, so it cannot read render state; this
  // mirror answers "is there an outbox on screen to put the message beside?".
  const loadedRef = useRef(false);
  const feedback = useActionFeedback();

  // biome-ignore lint/correctness/useExhaustiveDependencies: feedback.announce is a fresh closure on every render, so depending on it would re-run the mount effect forever.
  const load = useCallback(
    async (nextCursor?: string) => {
      const requestedEventId = event.id;
      setBusy(true);
      try {
        const page = await getCommunicationsHistory(
          event.organizationId,
          requestedEventId,
          nextCursor,
        );
        if (eventIdRef.current !== requestedEventId) return;
        setHistory((current) =>
          nextCursor ? [...(current ?? []), ...page.history] : page.history,
        );
        loadedRef.current = true;
        setLoadFailure(null);
        setCursor(page.nextCursor);
      } catch (reason: unknown) {
        if (eventIdRef.current !== requestedEventId) return;
        const failure = describeApiFailure(reason, "The outbox could not be loaded.");
        // ERROR-INTENT: an outbox that is on screen keeps its rows and takes the refusal next
        // to the control that asked for the refresh; an outbox that never arrived renders the
        // refusal in its own place, because there is nothing else on this surface to explain.
        if (loadedRef.current) feedback.announce("error", failure);
        else setLoadFailure(failure);
      } finally {
        setBusy(false);
      }
    },
    [event.id, event.organizationId],
  );

  // The outbox is re-read whenever the event changes, and the retry feedback from the
  // previous event is cleared with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: feedback.clear is a fresh closure on every render, so depending on it would re-run this effect forever.
  useEffect(() => {
    eventIdRef.current = event.id;
    loadedRef.current = false;
    setHistory(null);
    setCursor(null);
    setExpanded({});
    setLoadFailure(null);
    feedback.clear();
    // ERROR-INTENT: React effects cannot await; load renders its own failure in place of
    // the outbox it could not read.
    void load();
  }, [load, event.id]);

  async function recover(deliveryId: string, recipientRef: string) {
    const requestedEventId = event.id;
    setBusy(true);
    try {
      await retryDelivery(event.organizationId, deliveryId);
      await load();
      if (eventIdRef.current === requestedEventId)
        feedback.announce(
          "success",
          `Retry queued for ${recipientRef}. The delivery is back in the outbox for the worker to pick up.`,
        );
    } catch (reason: unknown) {
      // ERROR-INTENT: a retry failure belongs next to the retry control, so it is
      // announced here instead of on the page-level error surface far below.
      if (eventIdRef.current === requestedEventId)
        feedback.announce(
          "error",
          readError(reason, `Could not retry the delivery to ${recipientRef}.`),
        );
    } finally {
      setBusy(false);
    }
  }

  const counts = new Map<string, number>();
  for (const entry of history ?? [])
    counts.set(entry.delivery.state, (counts.get(entry.delivery.state) ?? 0) + 1);

  const tabs = [
    { id: "all", label: "All", count: history?.length ?? 0 },
    ...STATES.map((state) => ({
      id: state,
      label: DELIVERY_STATE_TERMS[state].label,
      count: counts.get(state) ?? 0,
    })),
  ];

  const visible = (history ?? []).filter((entry) => tab === "all" || entry.delivery.state === tab);
  const recoverable = (history ?? []).filter((entry) => RECOVERABLE.has(entry.delivery.state));

  return (
    <div className="comms" id="communications">
      <ComposePanel
        organizationId={event.organizationId}
        eventId={event.id}
        onSent={() => {
          // ERROR-INTENT: handlers cannot await; load renders or announces its own failure.
          void load();
        }}
      />
      <Section
        labelledBy="communications-title"
        title="Delivery history"
        description={
          history
            ? `${history.length} ${history.length === 1 ? "delivery" : "deliveries"} loaded${
                recoverable.length ? ` · ${recoverable.length} awaiting recovery` : ""
              }`
            : loadFailure
              ? "The outbox could not be read"
              : "Loading the outbox…"
        }
        actions={
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              // ERROR-INTENT: handlers cannot await; load renders or announces its failure.
              void load();
            }}
          >
            <IconSend size={20} />
            {busy ? "Refreshing…" : "Refresh outbox"}
          </button>
        }
      >
        <div className="comms-toolbar">
          {feedback.node}
          <Tabs items={tabs} active={tab} onSelect={setTab} label="Delivery state" />
        </div>

        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {history === null && loadFailure ? (
            // The failure takes the skeleton's place: the outbox is the only thing this
            // surface has to say, so when it cannot be read that *is* the page.
            <LoadFailure
              what="the delivery history"
              error={loadFailure.message}
              reference={loadFailure.reference}
              retryLabel={busy ? "Trying again…" : "Try again"}
              onRetry={load}
            >
              {loadFailure.message} No delivery was changed by this.
            </LoadFailure>
          ) : history === null ? (
            <SkeletonRows rows={4} label="Loading the delivery history" />
          ) : visible.length === 0 ? (
            <EmptyState
              title={history.length ? "No deliveries in this state" : "The outbox is empty"}
              icon={<IconSend size={20} />}
              action={
                history.length ? (
                  <button type="button" className="secondary" onClick={() => setTab("all")}>
                    Show every delivery
                  </button>
                ) : null
              }
            >
              {history.length
                ? "Nothing is queued, retrying, delivered, or stopped in this filter."
                : "Speaker invitations, reviewer assignments, and projection pushes appear here as soon as they are triggered."}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data comms-table">
                <thead>
                  <tr>
                    {/* The cue gutter: the one figure a delivery row is about is how many times
                        it has been tried, and the count is also what opens the attempt history. */}
                    <th scope="col" className="gutter">
                      Tries
                    </th>
                    <th scope="col">Recipient</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Template</th>
                    <th scope="col">State</th>
                    <th scope="col">Last error</th>
                    <th scope="col">
                      <span className="visually-hidden">Recovery</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry) => {
                    const { delivery, attempts } = entry;
                    const term = DELIVERY_STATE_TERMS[delivery.state];
                    const template = templateLabel(entry);
                    const error = lastError(entry);
                    const open = expanded[delivery.id] === true;
                    return (
                      <Fragment key={delivery.id}>
                        <tr className={open ? "is-open" : undefined}>
                          <td className="gutter" data-label="Tries">
                            {attempts.length ? (
                              <button
                                type="button"
                                className="ghost comms-expand"
                                aria-expanded={open}
                                aria-controls={`attempts-${delivery.id}`}
                                onClick={() =>
                                  setExpanded((current) => ({
                                    ...current,
                                    [delivery.id]: !current[delivery.id],
                                  }))
                                }
                              >
                                <span className="figure">{attempts.length}</span>
                                <span className="visually-hidden">
                                  {open ? "Hide" : "Show"} attempt history for{" "}
                                  {delivery.recipientRef}
                                </span>
                                <span aria-hidden="true" className="comms-chevron">
                                  {open ? (
                                    <IconChevronDown size={10} />
                                  ) : (
                                    <IconChevronRight size={10} />
                                  )}
                                </span>
                              </button>
                            ) : (
                              <span className="figure comms-muted">0</span>
                            )}
                          </td>
                          <td className="primary-cell" data-label="Recipient">
                            {delivery.recipientRef}
                            <span className="sub">{technicalLabel(delivery.triggerType)}</span>
                          </td>
                          <td className="comms-channel" data-label="Channel">
                            {delivery.channel}
                          </td>
                          <td data-label="Template" title={template.key ?? undefined}>
                            {template.name}
                            {template.detail ? (
                              <span className="sub">{template.detail}</span>
                            ) : null}
                          </td>
                          <td data-label="State">
                            <Pill tone={term.tone}>{term.label}</Pill>
                            <span className="sub">
                              {delivery.state === "queued" || delivery.state === "retrying"
                                ? `Next attempt ${stampedTime(delivery.nextAttemptAt)}`
                                : `Updated ${stampedTime(delivery.updatedAt)}`}
                            </span>
                            {/* What the state means for somebody deciding whether to act. */}
                            <span className="sub">
                              {DELIVERY_STATE_CONSEQUENCE[delivery.state]}
                            </span>
                          </td>
                          <td data-label="Last error">
                            {error ? (
                              <span className="comms-error" title={error}>
                                {deliveryErrorLabel(error)}
                              </span>
                            ) : (
                              <span className="comms-muted">—</span>
                            )}
                          </td>
                          <td data-label="Actions">
                            {RECOVERABLE.has(delivery.state) ? (
                              <button
                                type="button"
                                className="secondary small"
                                disabled={busy}
                                onClick={() => {
                                  // ERROR-INTENT: handlers cannot await; recover announces both outcomes.
                                  void recover(delivery.id, delivery.recipientRef);
                                }}
                              >
                                <span aria-hidden="true">Retry</span>
                                <span className="visually-hidden">
                                  Retry delivery to {delivery.recipientRef}
                                </span>
                              </button>
                            ) : null}
                          </td>
                        </tr>
                        {open ? (
                          <tr className="comms-attempts-row">
                            <td colSpan={7}>
                              {/* The message as sent, not the template it came from: a
                                  delivery pins its rendered text, so this is what the
                                  recipient read even after the template moves on. */}
                              {delivery.renderedBody ? (
                                <article
                                  className="comms-sent-message"
                                  aria-label={`Message sent to ${delivery.recipientRef}`}
                                >
                                  <p className="comms-preview-subject">
                                    {delivery.renderedSubject ?? "(no subject)"}
                                  </p>
                                  <pre className="comms-preview-body">{delivery.renderedBody}</pre>
                                </article>
                              ) : null}
                              <ol className="attempt-history" id={`attempts-${delivery.id}`}>
                                {attempts.map((attempt) => (
                                  <li key={attempt.id}>
                                    Attempt {attempt.sequence}: {technicalLabel(attempt.outcome)}
                                    {attempt.errorCode
                                      ? ` — ${deliveryErrorLabel(attempt.errorCode)}`
                                      : ""}
                                    <span className="sub">
                                      {stampedTime(attempt.completedAt)}
                                      {attempt.providerReference
                                        ? ` · ${attempt.providerReference}`
                                        : ""}
                                    </span>
                                  </li>
                                ))}
                              </ol>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {cursor ? (
          <div className="comms-more">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; load renders or announces its failure.
                void load(cursor);
              }}
            >
              Load more history
            </button>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
