import type { CommunicationsHistoryDto, EventDto } from "@greenroom/contracts";
import { useEffect, useRef, useState } from "react";
import { getCommunicationsHistory, retryDelivery } from "./api/communications";

interface CommunicationsWorkspaceProps {
  event: EventDto;
  onError(reason: unknown): void;
}

// @spec PRD-COM-001 PRD-INT-001
export function CommunicationsWorkspace({ event, onError }: CommunicationsWorkspaceProps) {
  const [history, setHistory] = useState<CommunicationsHistoryDto["history"] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eventIdRef = useRef(event.id);

  useEffect(() => {
    eventIdRef.current = event.id;
    setHistory(null);
    setCursor(null);
  }, [event.id]);

  async function load(nextCursor?: string) {
    const requestedEventId = event.id;
    setBusy(true);
    try {
      const page = await getCommunicationsHistory(
        event.organizationId,
        requestedEventId,
        nextCursor,
      );
      if (eventIdRef.current !== requestedEventId) return;
      setHistory((current) => (nextCursor ? [...(current ?? []), ...page.history] : page.history));
      setCursor(page.nextCursor);
    } catch (reason: unknown) {
      // ERROR-INTENT: The shared workspace error surface renders this request failure.
      if (eventIdRef.current === requestedEventId) onError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function recover(deliveryId: string) {
    const requestedEventId = event.id;
    setBusy(true);
    try {
      await retryDelivery(event.organizationId, deliveryId);
      await load();
    } catch (reason: unknown) {
      // ERROR-INTENT: The shared workspace error surface renders this retry failure.
      if (eventIdRef.current === requestedEventId) onError(reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="communications" aria-labelledby="communications-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Delivery operations</p>
          <h2 id="communications-title">Communications history</h2>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; load reports failures through onError.
            void load();
          }}
        >
          Inspect delivery history
        </button>
      </div>
      {history ? (
        <ul className="delivery-history">
          {history.map(({ delivery, attempts }) => (
            <li key={delivery.id}>
              <div>
                <strong>{delivery.recipientRef}</strong>
                <span className={`delivery-state state-${delivery.state}`}>{delivery.state}</span>
                <small>
                  {attempts.length} attempt{attempts.length === 1 ? "" : "s"}
                </small>
              </div>
              {delivery.state === "retrying" || delivery.state === "terminal" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: React event handlers cannot await; recover reports failures.
                    void recover(delivery.id);
                  }}
                >
                  Retry {delivery.recipientRef}
                </button>
              ) : null}
              {attempts.length ? (
                <ol className="attempt-history">
                  {attempts.map((attempt) => (
                    <li key={attempt.id}>
                      Attempt {attempt.sequence}: {attempt.outcome}
                      {attempt.errorCode ? ` — ${attempt.errorCode}` : ""}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">
          Inspect the outbox to see queued, retrying, succeeded, and terminal deliveries.
        </p>
      )}
      {cursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            // ERROR-INTENT: React event handlers cannot await; load reports failures through onError.
            void load(cursor);
          }}
        >
          Load more history
        </button>
      ) : null}
    </section>
  );
}
