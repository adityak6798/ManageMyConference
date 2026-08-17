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
import { type ApiFailure, describeApiFailure } from "../api/config";
import { getAuditTimeline } from "../api/platform";
import { IconClock } from "../ui/icons";
import { Card, EmptyState, LoadFailure, Pill, SkeletonRows } from "../ui/primitives";

/** A person is not a program, and the badge is the only place that distinction is visible. */
function sourceTone(source: AuditRecordDto["source"]) {
  if (source === "human") return "strong" as const;
  return source === "system" ? ("neutral" as const) : ("info" as const);
}

const sourceLabel: Record<AuditRecordDto["source"], string> = {
  human: "Person",
  system: "Automated",
  api: "API client",
  agent: "Automation",
};

const readableToken = (value: string) => {
  const words = value.replace(/[._-]+/g, " ").trim();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : value;
};

const readableTime = (instant: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(instant));

export function AuditWorkspace({ eventId }: { eventId: string }) {
  const [records, setRecords] = useState<AuditRecordDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const read = useCallback(
    async (from?: string) => {
      setLoading(true);
      setFailure(null);
      try {
        const page = await getAuditTimeline(eventId, from ? { cursor: from } : {});
        // Appended rather than replaced: this is one continuous list the reader is walking down,
        // and a page that replaced the previous one would lose their place in it.
        setRecords((current) => (from ? [...current, ...page.records] : [...page.records]));
        setCursor(page.nextCursor);
      } catch (reason: unknown) {
        // ERROR-INTENT: rendered rather than discarded — the message goes above the list, and
        // whatever already loaded stays on screen.
        setFailure(describeApiFailure(reason, "The timeline could not be read."));
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
      {failure ? (
        <LoadFailure
          what="the timeline"
          error={failure.message}
          reference={failure.reference}
          onRetry={() => read()}
        />
      ) : null}

      {/*
        `aria-live` without `role="status"`: a second polite region is the trap ACC-AGENDA
        records, and this page is mounted inside a shell that may already own one. It stays
        silent while the skeleton below is up, because that skeleton is itself a live region and
        two of them announcing one wait is the same defect from the other side.
      */}
      <p className="hint" aria-live="polite">
        {loading ? "" : `${records.length} ${records.length === 1 ? "record" : "records"} loaded.`}
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
        {records.length === 0 && loading ? (
          <SkeletonRows rows={4} label="Reading what happened on this event" />
        ) : records.length === 0 ? (
          /*
            The shared compact shape, asked for by name. This surface used to restate it locally
            in platform.css (`.audit-empty .empty`), which is how one component came to render two
            different left-aligned states on two pages of the same console. `terse` defaults on
            for a state with no body copy; this one has a sentence, so it says so.
          */
          <EmptyState terse icon={<IconClock size={20} />} title="Nothing recorded yet">
            Activity will appear here as people review proposals, update the schedule, and publish
            the event.
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
                  <th scope="col">Change</th>
                  <th scope="col">Item</th>
                  <th scope="col">Reference</th>
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
                    <td data-label="When">{readableTime(record.occurredAt)}</td>
                    <td data-label="Who">
                      {record.actorName}{" "}
                      <Pill tone={sourceTone(record.source)}>{sourceLabel[record.source]}</Pill>
                    </td>
                    <td data-label="Change">{readableToken(record.action)}</td>
                    <td data-label="Item">
                      {readableToken(record.targetType)} <code>{record.targetId}</code>
                      {record.targetVersion !== undefined ? (
                        <>
                          {" "}
                          <span>{`v${record.targetVersion}`}</span>
                        </>
                      ) : null}
                    </td>
                    <td data-label="Reference">
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
