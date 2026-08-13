/**
 * The unified audit timeline at `/audit`.
 *
 * One ordered list of what happened on this event, across every domain that changed anything.
 * The page is deliberately plain: a log's job is to be read, and every column on it is a fact
 * the server recorded rather than something this component derives — the actor, whether it was a
 * person or a program, the action, what it acted on, and the correlation id that ties the record
 * back to the request in the logs.
 *
 * Paging is forward-only through the server's opaque cursor. There is no filter and no search
 * here: filtering a log you have only partly loaded is a way to be confidently wrong about what
 * is in it, and search over the event already exists one route away.
 *
 * @spec PRD-OPS-003
 */
import type { AuditRecordDto } from "@greenroom/contracts";
import { useCallback, useEffect, useState } from "react";
import { ResponseContractError } from "../api/config";
import { getAuditTimeline, PlatformApiError } from "../api/platform";
import { Card, EmptyState, Notice, Pill } from "../ui/primitives";

function describeFailure(reason: unknown): string {
  if (reason instanceof PlatformApiError)
    return `${reason.envelope.error.message} Reference: ${reason.envelope.error.correlationId}`;
  if (reason instanceof ResponseContractError) return reason.message;
  return "The timeline could not be read. Please retry.";
}

/** A person is not a program, and the badge is the only place that distinction is visible. */
function sourceTone(source: AuditRecordDto["source"]) {
  if (source === "human") return "strong" as const;
  return source === "system" ? ("neutral" as const) : ("info" as const);
}

export function AuditWorkspace({ eventId }: { eventId: string }) {
  const [records, setRecords] = useState<AuditRecordDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async (from?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await getAuditTimeline(eventId, from ? { cursor: from } : {});
        // Appended rather than replaced: this is one continuous list the reader is walking down,
        // and a page that replaced the previous one would lose their place in it.
        setRecords((current) => (from ? [...current, ...page.records] : [...page.records]));
        setCursor(page.nextCursor);
      } catch (reason: unknown) {
        // ERROR-INTENT: rendered rather than discarded — the message goes above the list, and
        // whatever already loaded stays on screen.
        setError(describeFailure(reason));
      } finally {
        setLoading(false);
      }
    },
    [eventId],
  );

  useEffect(() => {
    // ERROR-INTENT: effects cannot await; read() renders both outcomes into its own state.
    void read();
  }, [read]);

  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* `aria-live` without `role="status"`: a second polite region is the trap ACC-AGENDA
          records, and this page is mounted inside a shell that may already own one. */}
      <p className="palette-announce" aria-live="polite">
        {loading
          ? "Reading the timeline…"
          : `${records.length} ${records.length === 1 ? "record" : "records"} loaded.`}
      </p>

      {/*
        Refresh is always here, including on an empty log, and that is not decoration. This is a
        surface an organizer leaves open while work happens elsewhere, so re-reading from the top
        is the action it owes them — and a page whose only control appears once there is something
        to page through would offer a reader of an empty timeline nothing at all to do.
      */}
      <Card
        title="What happened on this event"
        labelledBy="audit-title"
        actions={
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              // ERROR-INTENT: handlers cannot await; read() renders both outcomes.
              void read();
            }}
          >
            {loading ? "Reading…" : "Refresh"}
          </button>
        }
      >
        {records.length === 0 && !loading ? (
          <EmptyState title="Nothing recorded yet">
            Records appear here as work happens: an accepted speaker, an assigned reviewer, a
            recorded decision, a published schedule, a message sent.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="audit-table">
              <caption className="visually-hidden">
                Audit records for this event, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Correlation</th>
                </tr>
              </thead>
              <tbody>
                {/*
                  `data-label` on every cell is what lets the row stop being a row below 780px —
                  the same recipe the content and review tables use. Five columns do not fit a
                  390px viewport, and a `.table-wrap` that merely scrolls would put the
                  correlation id behind an unhinted swipe.
                */}
                {records.map((record) => (
                  <tr key={record.id}>
                    <td data-label="When">{record.occurredAt}</td>
                    <td data-label="Who">
                      {record.actorName}{" "}
                      <Pill tone={sourceTone(record.source)}>{record.source}</Pill>
                    </td>
                    <td data-label="Action">{record.action}</td>
                    <td data-label="Target">
                      {record.targetType} <code>{record.targetId}</code>
                    </td>
                    <td data-label="Correlation">
                      <code>{record.correlationId ?? "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => {
              // ERROR-INTENT: handlers cannot await; read() renders both outcomes.
              void read(cursor);
            }}
          >
            {loading ? "Loading…" : "Load older records"}
          </button>
        ) : null}
      </Card>
    </>
  );
}
