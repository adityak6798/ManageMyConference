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
 * be one-time, and never fetched again — beside the endpoint it signs, rather than in a banner at
 * the top of a page whose rows have since moved.
 *
 * **Rotation names its overlap.** The old secret keeps verifying until the instant the response
 * reports, which is the whole reason rotation is not replacement — a receiver needs time to
 * deploy. Printing that instant is the difference between a safe rotation and a broken one.
 *
 * **A failed delivery can be replayed, and the replay is idempotent at the receiver** because the
 * idempotency key travels with the payload. So the button is offered without a confirmation: the
 * worst case is a receiver seeing a key it has already processed. Removing the subscription is the
 * opposite — every unsent delivery goes with it and nothing reissues the secret — so that one
 * asks first.
 *
 * There is no read-only variant of this screen. All seven routes require `communications:manage`,
 * listing included, so an identity that can see anything here can do everything here; splitting
 * the controls behind a second flag would only claim a distinction the API does not make.
 *
 * @spec PRD-INT-001
 */
import { type FormEvent, useCallback, useState } from "react";
import { describeApiFailure } from "./api/config";
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
import { Checkbox, CopyableSecret, Field } from "./ui/fields";
import { IconLink, IconSend } from "./ui/icons";
import {
  Card,
  Drawer,
  EmptyState,
  GutterList,
  GutterRow,
  LoadFailure,
  Pill,
  Refusal,
  Section,
  SkeletonRows,
  useActionFeedback,
  useLoad,
} from "./ui/primitives";
import { DELIVERY_STATE_CONSEQUENCE, DELIVERY_STATE_TERMS } from "./ui/vocabulary";

const describe = (reason: unknown) =>
  describeApiFailure(reason, "The webhook service did not answer.").message;

/** The event types a subscription may ask for. The server's enum is the authority. */
const EVENT_TYPES = [{ id: "schedule.published", label: "Schedule published" }] as const;

/** What this organization calls an event type, so no row prints the wire spelling. */
const eventTypeLabel = (id: string) =>
  EVENT_TYPES.find((type) => type.id === id)?.label ?? id.replace(/[._]/g, " ");

/** A signing secret exists on screen exactly once, and belongs to the subscription that made it. */
type IssuedSecret = {
  subscriptionId: string;
  secret: string;
  /** Set by a rotation: the instant the previous secret stops verifying. */
  overlapExpiresAt: string | null;
};

export function WebhooksWorkspace({ organizationId }: { organizationId: string }) {
  const { announce, node: feedback } = useActionFeedback();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>(["schedule.published"]);
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const [openSubscription, setOpenSubscription] = useState<string | null>(null);
  const [history, setHistory] = useState<WebhookHistory | null>(null);
  const [historyFailure, setHistoryFailure] = useState<string | null>(null);
  /** The subscription a Remove press is asking about, never the one it has already removed. */
  const [removing, setRemoving] = useState<{ id: string; url: string } | null>(null);

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
    setOpenSubscription(subscriptionId);
    setHistory(null);
    setHistoryFailure(null);
    try {
      setHistory(await listWebhookDeliveries(organizationId, subscriptionId));
    } catch (reason) {
      // ERROR-INTENT: the drawer is already open and its body is where the reader is looking,
      // so the refusal is rendered there rather than announced behind the modal.
      setHistoryFailure(describe(reason));
    } finally {
      setBusy(false);
    }
  };

  if (subscriptions.loading && !subscriptions.data)
    return (
      <Card>
        <SkeletonRows rows={3} label="Loading the webhook subscriptions" />
      </Card>
    );
  /*
   * "Not configured" is not "broken", and it does not get an alert.
   *
   * The routes answer 503 `WEBHOOK_UNAVAILABLE` when the deployment has no egress endpoint or
   * wrapping keys — true of every local checkout. An organizer cannot fix that from this screen,
   * and shouting a red failure at them for a deployment choice teaches them to ignore the colour.
   */
  if (unconfigured)
    return (
      <Section labelledBy="webhooks-unconfigured" title="Outbound webhooks">
        <Refusal
          title="Webhooks are unavailable in this deployment"
          capability="outbound webhook delivery"
          grantedBy="Whoever runs this Greenroom deployment"
          action={
            // Not decoration. Configuration is an operator action taken elsewhere, and this is
            // how somebody who has just asked for it finds out it landed without reloading the
            // console — a screen with no control at all is a dead end for everybody, including
            // the keyboard user who tabs into it and finds nothing.
            <button
              className="secondary"
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
          No subscriptions can be created until the deployment has an egress endpoint and wrapping
          keys.
        </Refusal>
      </Section>
    );
  if (subscriptions.error)
    return (
      <LoadFailure
        what="the webhook subscriptions"
        error={subscriptions.error}
        onRetry={subscriptions.reload}
      />
    );
  const list =
    subscriptions.data === "unconfigured" ? [] : (subscriptions.data?.subscriptions ?? []);
  const openUrl = list.find((subscription) => subscription.id === openSubscription)?.url ?? "";

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    const wanted = { url, eventTypes: [...eventTypes] };
    await run("Webhook created.", async () => {
      const created = await createWebhook(organizationId, wanted);
      setIssued({
        subscriptionId: created.subscription.id,
        secret: created.secret,
        overlapExpiresAt: null,
      });
      setUrl("");
    });
  }

  return (
    <div className="members">
      {feedback}

      <Section
        labelledBy="webhooks-list"
        title="Outbound webhooks"
        description="Greenroom posts to these when something happens. Deliveries retry, and each carries an idempotency key."
      >
        {list.length === 0 ? (
          <EmptyState icon={<IconLink size={20} />} title="No webhooks yet">
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
                      {/*
                        The secret belongs beside the endpoint it signs. It used to be announced
                        at the top of the page, above a table whose rows had just been reloaded —
                        so with two subscriptions on screen nothing said which one it verified.
                      */}
                      {issued?.subscriptionId === subscription.id ? (
                        <div className="stack">
                          <CopyableSecret
                            label="Signing secret"
                            value={issued.secret}
                            hint={
                              issued.overlapExpiresAt
                                ? `Shown once. The previous secret keeps verifying until ${new Date(issued.overlapExpiresAt).toLocaleString()}, so deploy this before then.`
                                : "Shown once. Nothing can reissue it — only rotate it."
                            }
                          />
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => setIssued(null)}
                          >
                            I have stored it
                          </button>
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Events">
                      {subscription.eventTypes.map((type) => (
                        <Pill key={type} tone="info">
                          {eventTypeLabel(type)}
                        </Pill>
                      ))}
                    </td>
                    <td data-label="State">
                      <Pill tone={subscription.state === "active" ? "ok" : "warn"}>
                        {subscription.state === "active" ? "Active" : "Disabled"}
                      </Pill>
                      {subscription.disabledReason ? (
                        <span className="sub">{subscription.disabledReason}</span>
                      ) : null}
                    </td>
                    {/* Ending a subscription is not another row action, so `member-remove` holds
                        it at the far end of the cell rather than flush against "Deliveries". */}
                    <td data-label="Actions" className="member-actions">
                      <button
                        className="secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() => openHistory(subscription.id)}
                      >
                        Deliveries
                        <span className="visually-hidden"> for {subscription.url}</span>
                      </button>
                      <button
                        className="secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run("Signing secret rotated.", async () => {
                            const rotated = await rotateWebhookSecret(
                              organizationId,
                              subscription.id,
                            );
                            setIssued({
                              subscriptionId: subscription.id,
                              secret: rotated.secret,
                              overlapExpiresAt: rotated.overlapExpiresAt,
                            });
                          })
                        }
                      >
                        Rotate secret
                      </button>
                      <button
                        className="danger small member-remove"
                        type="button"
                        disabled={busy}
                        onClick={() => setRemoving({ id: subscription.id, url: subscription.url })}
                      >
                        Remove
                        <span className="visually-hidden"> {subscription.url}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        labelledBy="webhooks-add"
        title="Add an endpoint"
        description="The signing secret appears once, on the row this creates."
      >
        <form className="stack" onSubmit={submit}>
          <Field label="Endpoint URL" id="webhook-url" required>
            {(control) => (
              <input
                {...control}
                className="control"
                type="url"
                maxLength={2000}
                placeholder="https://example.test/hooks/greenroom"
                value={url}
                onChange={(changed) => setUrl(changed.target.value)}
              />
            )}
          </Field>
          <Field label="Events to send" labelAs="group">
            {(_control, labelId) => (
              // biome-ignore lint/a11y/useSemanticElements: `Field` already renders this group's caption and its id; a <fieldset> here would add a second grouping semantic, and its default min-inline-size: min-content stops the grid track shrinking.
              <div role="group" aria-labelledby={labelId} className="stack">
                {EVENT_TYPES.map((type) => (
                  <Checkbox
                    key={type.id}
                    label={type.label}
                    checked={eventTypes.includes(type.id)}
                    onChange={(checked) =>
                      setEventTypes((current) =>
                        checked
                          ? [...new Set([...current, type.id])]
                          : current.filter((held) => held !== type.id),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </Field>
          <div className="toolbar">
            <button
              className="primary"
              type="submit"
              disabled={busy || !url.trim() || eventTypes.length === 0}
            >
              Add webhook
            </button>
          </div>
        </form>
      </Section>

      {/*
        Delivery history is an inspection of one row, not a second page region. As a card below
        the table it opened 900px away from the button that asked for it and left the reader to
        find it; as a drawer the browser moves focus into it and Escape closes it.
      */}
      <Drawer
        open={openSubscription !== null}
        title="Recent deliveries"
        description={`Every attempt${openUrl ? ` made to ${openUrl}` : ""}, with its outcome. A replay carries the same idempotency key, so a receiver that already processed it can ignore it.`}
        busy={busy && history === null && historyFailure === null}
        onClose={() => {
          setOpenSubscription(null);
          setHistory(null);
          setHistoryFailure(null);
        }}
      >
        {historyFailure ? (
          <LoadFailure
            what="the delivery history"
            error={historyFailure}
            onRetry={() => (openSubscription ? openHistory(openSubscription) : undefined)}
          />
        ) : history === null ? (
          <SkeletonRows rows={3} label="Loading the delivery history" />
        ) : history.history.length === 0 ? (
          <EmptyState icon={<IconSend size={20} />} title="Nothing sent yet">
            Deliveries appear here once something this subscription listens for happens.
          </EmptyState>
        ) : (
          <GutterList label="Delivery attempts">
            {history.history.map(({ delivery, attempts }) => {
              const term = DELIVERY_STATE_TERMS[delivery.state];
              const lastError = attempts.at(-1)?.errorCode;
              return (
                <GutterRow
                  key={delivery.id}
                  measure={delivery.attemptCount}
                  measureLabel="Attempts"
                  title={eventTypeLabel(delivery.eventType)}
                  meta={new Date(delivery.createdAt).toLocaleString()}
                  status={<Pill tone={term.tone}>{term.label}</Pill>}
                  actions={
                    delivery.state === "succeeded" ? null : (
                      <button
                        className="secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run("Replay queued.", async () => {
                            await replayWebhookDelivery(organizationId, delivery.id);
                            if (openSubscription)
                              setHistory(
                                await listWebhookDeliveries(organizationId, openSubscription),
                              );
                          })
                        }
                      >
                        Replay
                      </button>
                    )
                  }
                >
                  {/* What the state means for the reader, which "terminal" never said. */}
                  {DELIVERY_STATE_CONSEQUENCE[delivery.state]}
                  {lastError ? ` Last error: ${lastError}.` : ""}
                </GutterRow>
              );
            })}
          </GutterList>
        )}
      </Drawer>

      <Drawer
        open={removing !== null}
        title="Remove this webhook?"
        busy={busy}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button
              type="button"
              className="danger primary"
              disabled={busy}
              onClick={() => {
                const target = removing;
                if (!target) return;
                setRemoving(null);
                // ERROR-INTENT: handlers cannot await; `run` announces both outcomes.
                void run("Webhook removed.", async () => {
                  await deleteWebhook(organizationId, target.id);
                  if (openSubscription === target.id) {
                    setOpenSubscription(null);
                    setHistory(null);
                  }
                  if (issued?.subscriptionId === target.id) setIssued(null);
                });
              }}
            >
              Remove the webhook
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Keep it
            </button>
          </>
        }
      >
        <p>
          <code>{removing?.url}</code> stops receiving anything from Greenroom immediately, and
          every delivery still queued for it is dropped. Its signing secret cannot be reissued, so
          re-adding the endpoint later means deploying a new one at the receiver.
        </p>
      </Drawer>
    </div>
  );
}
