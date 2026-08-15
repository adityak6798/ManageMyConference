/**
 * Outbound webhooks: subscriptions, their delivery history, and the two controls that matter
 * when one goes wrong.
 *
 * **This is the caller a fully-built capability never had.** The subscription store, the retry
 * ladder, the secret-rotation overlap and the idempotent replay were all shipped and tested, and
 * nobody using the product could reach any of it. The sweep in this lane found it the same way
 * every previous instance was found — by asking which routes no browser calls.
 *
 * Three things are shaped by what the API actually promises.
 *
 * **The secret is shown once.** Creating a subscription answers it, and nothing can reissue it;
 * rotation is the only other time it appears. So it is displayed at the moment it exists, said to
 * be one-time, and never fetched again.
 *
 * **Rotation names its overlap.** The old secret keeps verifying until the instant the response
 * reports, which is the whole reason rotation is not replacement — a receiver needs time to
 * deploy. Printing that instant is the difference between a safe rotation and a broken one.
 *
 * **A failed delivery can be replayed, and the replay is idempotent at the receiver** because the
 * idempotency key travels with the payload. So the button is offered without a confirmation: the
 * worst case is a receiver seeing a key it has already processed.
 *
 * There is no read-only variant of this screen. All seven routes require `communications:manage`,
 * listing included, so an identity that can see anything here can do everything here; splitting
 * the controls behind a second flag would only claim a distinction the API does not make.
 *
 * @spec PRD-INT-001
 */
import { type FormEvent, useCallback, useState } from "react";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  replayWebhookDelivery,
  rotateWebhookSecret,
  WebhookApiError,
  type WebhookHistory,
  type WebhooksResponse,
} from "./api/webhooks";
import "./styles/identity.css";
import { Card, EmptyState, Notice, Pill, useActionFeedback, useLoad } from "./ui/primitives";

const describe = (reason: unknown) =>
  reason instanceof WebhookApiError
    ? `${reason.message} Reference: ${reason.correlationId}`
    : "Something went wrong. Please retry; if it continues, contact support.";

/** The event types a subscription may ask for. The server's enum is the authority. */
const EVENT_TYPES = [{ id: "schedule.published", label: "Schedule published" }] as const;

const STATE_TONE: Record<string, "ok" | "warn" | "neutral" | "danger"> = {
  succeeded: "ok",
  queued: "neutral",
  retrying: "warn",
  terminal: "danger",
};

export function WebhooksWorkspace({ organizationId }: { organizationId: string }) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>(["schedule.published"]);
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [rotation, setRotation] = useState<{ secret: string; overlapExpiresAt: string } | null>(
    null,
  );
  const [openSubscription, setOpenSubscription] = useState<string | null>(null);
  const [history, setHistory] = useState<WebhookHistory | null>(null);

  const subscriptions = useLoad<string, WebhooksResponse | "unconfigured">(
    organizationId,
    useCallback(async (id: string) => {
      try {
        return await listWebhooks(id);
      } catch (reason) {
        // Translated, not discarded: an unconfigured deployment is an answer this screen renders,
        // and everything else still rejects and reaches `describe`.
        if (reason instanceof WebhookApiError && reason.code === "WEBHOOK_UNAVAILABLE")
          return "unconfigured" as const;
        throw reason;
      }
    }, []),
    describe,
  );
  const unconfigured = subscriptions.data === "unconfigured";

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await subscriptions.reload();
      announce("success", what);
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (subscriptionId: string) => {
    setBusy(true);
    try {
      setOpenSubscription(subscriptionId);
      setHistory(await listWebhookDeliveries(organizationId, subscriptionId));
    } catch (reason) {
      announce("error", describe(reason));
    } finally {
      setBusy(false);
    }
  };

  if (subscriptions.loading && !subscriptions.data) return <Card>Loading webhooks…</Card>;
  /*
   * "Not configured" is not "broken", and it does not get an alert.
   *
   * The routes answer 503 `WEBHOOK_UNAVAILABLE` when the deployment has no egress endpoint or
   * wrapping keys — true of every local checkout. An organizer cannot fix that from this screen,
   * and shouting a red failure at them for a deployment choice teaches them to ignore the colour.
   */
  if (unconfigured)
    return (
      <Card title="Outbound webhooks">
        <EmptyState
          title="Webhook delivery is not configured here"
          action={
            // Not decoration. Configuration is an operator action taken elsewhere, and this is
            // how somebody who has just asked for it finds out it landed without reloading the
            // console — a screen with no control at all is a dead end for everybody, including
            // the keyboard user who tabs into it and finds nothing.
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                // ERROR-INTENT: `useLoad` stores the rejection in its own error state, which this
                // component renders; awaiting it here would only delay the handler's return.
                void subscriptions.reload()
              }
            >
              Check again
            </button>
          }
        >
          This deployment has no webhook egress configured, so subscriptions cannot be created or
          delivered. An operator enables it; nothing on this screen can.
        </EmptyState>
      </Card>
    );
  if (subscriptions.error) return <Notice tone="error">{subscriptions.error}</Notice>;
  const list =
    subscriptions.data === "unconfigured" ? [] : (subscriptions.data?.subscriptions ?? []);

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const wanted = { url, eventTypes: [...eventTypes] };
    await run("Webhook created.", async () => {
      const created = await createWebhook(organizationId, wanted);
      setIssuedSecret(created.secret);
      setUrl("");
    });
  }

  return (
    <div className="members">
      {feedback}

      {issuedSecret ? (
        <Notice tone="info">
          This signing secret is shown once — nothing can reissue it, only rotate it:{" "}
          <code>{issuedSecret}</code>
        </Notice>
      ) : null}
      {rotation ? (
        <Notice tone="info">
          New signing secret: <code>{rotation.secret}</code>. The previous one keeps verifying until{" "}
          {new Date(rotation.overlapExpiresAt).toLocaleString()}, so deploy this before then.
        </Notice>
      ) : null}

      <Card
        title="Outbound webhooks"
        hint="Greenroom posts to these when something happens. Deliveries retry, and each carries an idempotency key."
      >
        {list.length === 0 ? (
          <EmptyState title="No webhooks yet">
            Add an endpoint to receive events as they happen, instead of polling the API for them.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">Webhook subscriptions</caption>
              <thead>
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Events</th>
                  <th scope="col">State</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((subscription) => (
                  <tr key={subscription.id}>
                    <td className="primary-cell" data-label="Endpoint">
                      <code>{subscription.url}</code>
                      {subscription.eventId ? (
                        <span className="sub">Scoped to one event</span>
                      ) : (
                        <span className="sub">The whole organization</span>
                      )}
                    </td>
                    <td data-label="Events">
                      {subscription.eventTypes.map((type) => (
                        <Pill key={type} tone="info">
                          {type}
                        </Pill>
                      ))}
                    </td>
                    <td data-label="State">
                      <Pill tone={subscription.state === "active" ? "ok" : "warn"}>
                        {subscription.state}
                      </Pill>
                      {subscription.disabledReason ? (
                        <span className="sub">{subscription.disabledReason}</span>
                      ) : null}
                    </td>
                    <td data-label="Actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => openHistory(subscription.id)}
                      >
                        Deliveries
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run("Signing secret rotated.", async () => {
                            setRotation(await rotateWebhookSecret(organizationId, subscription.id));
                          })
                        }
                      >
                        Rotate secret
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run("Webhook removed.", async () => {
                            await deleteWebhook(organizationId, subscription.id);
                            if (openSubscription === subscription.id) {
                              setOpenSubscription(null);
                              setHistory(null);
                            }
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form className="stack" onSubmit={submit}>
          <label>
            Endpoint URL
            <input
              type="url"
              required
              maxLength={2000}
              placeholder="https://example.test/hooks/greenroom"
              value={url}
              onChange={(changed) => setUrl(changed.target.value)}
            />
          </label>
          <fieldset>
            <legend>Events to send</legend>
            {EVENT_TYPES.map((type) => (
              <label key={type.id} className="inline">
                <input
                  type="checkbox"
                  checked={eventTypes.includes(type.id)}
                  onChange={(changed) =>
                    setEventTypes((current) =>
                      changed.target.checked
                        ? [...new Set([...current, type.id])]
                        : current.filter((held) => held !== type.id),
                    )
                  }
                />
                {type.label}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy || !url.trim() || eventTypes.length === 0}>
            Add webhook
          </button>
        </form>
      </Card>

      {history && openSubscription ? (
        <Card
          title="Recent deliveries"
          hint="Every attempt, with its outcome. A replay carries the same idempotency key, so a receiver that already processed it can ignore it."
          actions={
            <button
              type="button"
              onClick={() => {
                setHistory(null);
                setOpenSubscription(null);
              }}
            >
              Close
            </button>
          }
        >
          {history.history.length === 0 ? (
            <EmptyState title="Nothing sent yet">
              Deliveries appear here once something this subscription listens for happens.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <caption className="visually-hidden">Delivery history</caption>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">State</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.history.map(({ delivery, attempts }) => (
                    <tr key={delivery.id}>
                      <td className="primary-cell" data-label="Event">
                        {delivery.eventType}
                        <span className="sub">{new Date(delivery.createdAt).toLocaleString()}</span>
                      </td>
                      <td data-label="State">
                        <Pill tone={STATE_TONE[delivery.state] ?? "neutral"}>{delivery.state}</Pill>
                      </td>
                      <td data-label="Attempts">
                        {delivery.attemptCount}
                        {attempts.at(-1)?.errorCode ? (
                          <span className="sub">Last error: {attempts.at(-1)?.errorCode}</span>
                        ) : null}
                      </td>
                      <td data-label="Actions">
                        {delivery.state !== "succeeded" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              run("Replay queued.", async () => {
                                await replayWebhookDelivery(organizationId, delivery.id);
                                setHistory(
                                  await listWebhookDeliveries(organizationId, openSubscription),
                                );
                              })
                            }
                          >
                            Replay
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
