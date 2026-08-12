/*
 * Composing a message and sending it to an event's speakers.
 *
 * The outbox has always been able to carry a delivery; until now nothing in the console could
 * create one, so a template could only be made by hand-crafting a POST and the "Communications"
 * workspace was a read-only window onto rows somebody else had written.
 *
 * Two things this surface refuses to do. It does not send without saying how many people it is
 * about to send to — the count comes from the server's own recipient resolution, not from a
 * number typed here — and it does not hide the speakers it cannot reach. A send to "the
 * speakers" that silently reaches three of four is the failure mode worth designing against;
 * an organizer who has to be told about Alan can go and link his address.
 *
 * Template versions are immutable, so there is no edit control: changing a message publishes the
 * next version of the same key, the previous one stays readable, and a delivery sent last week
 * still names the version it used.
 */
import type { BroadcastRecipientDto, MessageTemplateDto } from "@greenroom/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  CommunicationsApiError,
  createTemplate,
  getRecipients,
  getTemplates,
  sendToSpeakers,
} from "../api/communications";
import { IconSend, IconWarning } from "../ui/icons";
import { Card, Notice, useActionFeedback } from "../ui/primitives";

interface ComposePanelProps {
  organizationId: string;
  eventId: string;
  /** Called after a send so the history beside this panel shows the new deliveries. */
  onSent: () => void;
}

const readError = (reason: unknown, fallback: string) => {
  if (reason instanceof CommunicationsApiError)
    return `${reason.message} Reference: ${reason.envelope.error.correlationId}`;
  return reason instanceof Error ? reason.message : fallback;
};

/** The newest version of each key: what "send this template" means without a version picker. */
const latestByKey = (templates: readonly MessageTemplateDto[]) => {
  const newest = new Map<string, MessageTemplateDto>();
  for (const template of templates) {
    const held = newest.get(template.key);
    if (!held || template.version > held.version) newest.set(template.key, template);
  }
  return [...newest.values()].sort((left, right) => left.key.localeCompare(right.key));
};

// @spec PRD-COM-001
export function ComposePanel({ organizationId, eventId, onSent }: ComposePanelProps) {
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipientDto[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ key: "", subject: "", body: "" });
  const feedback = useActionFeedback();

  // biome-ignore lint/correctness/useExhaustiveDependencies: feedback.announce is a fresh closure every render, so depending on it would re-run the mount effect forever.
  const load = useCallback(async () => {
    try {
      const [loadedTemplates, loadedRecipients] = await Promise.all([
        getTemplates(organizationId),
        getRecipients(organizationId, eventId),
      ]);
      setTemplates(loadedTemplates);
      setRecipients(loadedRecipients);
      setLoadFailure(null);
      setSelectedKey((current) =>
        current && loadedTemplates.some((template) => template.key === current)
          ? current
          : (latestByKey(loadedTemplates)[0]?.key ?? ""),
      );
    } catch (reason: unknown) {
      // ERROR-INTENT: this panel renders its own read failure in place of the controls it
      // could not populate; sending is impossible without knowing the recipients anyway.
      setLoadFailure(readError(reason, "Templates and recipients could not be loaded."));
    }
  }, [organizationId, eventId]);

  useEffect(() => {
    setTemplates(null);
    setRecipients(null);
    setConfirming(false);
    // ERROR-INTENT: React effects cannot await; load renders its own failure.
    void load();
  }, [load]);

  const available = latestByKey(templates ?? []);
  const selected = available.find((template) => template.key === selectedKey) ?? null;
  const reachable = (recipients ?? []).filter((recipient) => recipient.address !== null);
  const unreachable = (recipients ?? []).filter((recipient) => recipient.address === null);

  async function publish() {
    setBusy(true);
    try {
      const created = await createTemplate({
        organizationId,
        key: draft.key.trim(),
        // Publishing the next version of an existing key is how a message is corrected;
        // a key nobody has used starts at 1.
        version:
          Math.max(
            0,
            ...(templates ?? [])
              .filter((template) => template.key === draft.key.trim())
              .map((template) => template.version),
          ) + 1,
        channel: "email",
        subject: draft.subject.trim() ? draft.subject.trim() : null,
        body: draft.body,
      });
      await load();
      setSelectedKey(created.key);
      setComposing(false);
      setDraft({ key: "", subject: "", body: "" });
      feedback.announce(
        "success",
        `Saved ${created.key} version ${created.version}. Earlier versions stay readable.`,
      );
    } catch (reason: unknown) {
      // ERROR-INTENT: announced beside the form that produced it, so the draft survives.
      feedback.announce("error", readError(reason, "The template could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await sendToSpeakers({
        organizationId,
        eventId,
        templateKey: selected.key,
        templateVersion: selected.version,
      });
      setConfirming(false);
      onSent();
      // What happened, not what was attempted. A repeat send of the same template version
      // writes nothing, and saying "queued" about it would promise mail that will never go.
      const queued = result.enqueued
        ? `Queued ${result.enqueued} ${result.enqueued === 1 ? "delivery" : "deliveries"} for ${selected.key} version ${selected.version}. The outbox sends ${result.enqueued === 1 ? "it" : "them"} on its next run.`
        : `Nothing new to send: every reachable speaker already has ${selected.key} version ${selected.version}. Save a new version to send a correction.`;
      const repeated =
        result.enqueued && result.alreadySent
          ? ` ${result.alreadySent} already had this version and ${result.alreadySent === 1 ? "was" : "were"} not sent again.`
          : "";
      const missing = result.unreachable.length
        ? ` ${result.unreachable.length} speaker${result.unreachable.length === 1 ? "" : "s"} had no address and ${result.unreachable.length === 1 ? "was" : "were"} not sent to.`
        : "";
      feedback.announce("success", `${queued}${repeated}${missing}`);
    } catch (reason: unknown) {
      // ERROR-INTENT: a refused send belongs next to the Send control. A template whose
      // placeholders the payload cannot fill fails here, naming the placeholder.
      feedback.announce("error", readError(reason, "The send was refused."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      labelledBy="communications-compose-title"
      title="Send to speakers"
      hint={
        recipients === null
          ? "Resolving this event's speakers…"
          : `${reachable.length} of ${recipients.length} ${recipients.length === 1 ? "speaker" : "speakers"} can be reached by email`
      }
      actions={
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setComposing((current) => !current);
            setConfirming(false);
          }}
        >
          {composing ? "Cancel" : "New template"}
        </button>
      }
    >
      <div className="comms-compose">
        {feedback.node}

        {loadFailure ? (
          <div className="comms-compose-failure">
            <Notice tone="error">{loadFailure}</Notice>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                // ERROR-INTENT: handlers cannot await; load renders its own failure.
                void load();
              }}
            >
              Try again
            </button>
          </div>
        ) : composing ? (
          <form
            className="comms-compose-form"
            onSubmit={(event) => {
              event.preventDefault();
              // ERROR-INTENT: handlers cannot await; publish announces both outcomes.
              void publish();
            }}
          >
            <label htmlFor="template-key">
              Template name
              <input
                id="template-key"
                value={draft.key}
                required
                maxLength={80}
                placeholder="speaker-welcome"
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              />
            </label>
            <label htmlFor="template-subject">
              Subject
              <input
                id="template-subject"
                value={draft.subject}
                maxLength={200}
                placeholder="You're speaking at Greenroom"
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              />
            </label>
            <label htmlFor="template-body">
              Message
              <textarea
                id="template-body"
                value={draft.body}
                required
                rows={6}
                placeholder={"Hi {{speakerName}},\n\nYour session is confirmed."}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
            </label>
            <p className="hint">
              <code>{"{{speakerName}}"}</code> is filled in per recipient. Any other placeholder
              must have a value, or the send is refused rather than mailing half a sentence.
            </p>
            <button type="submit" className="primary" disabled={busy || !draft.body.trim()}>
              {busy ? "Saving…" : "Save template version"}
            </button>
          </form>
        ) : available.length === 0 ? (
          <p className="comms-compose-empty">
            No templates yet. Create one to send this event's speakers a message.
          </p>
        ) : (
          <>
            <label htmlFor="template-select">
              Template
              <select
                id="template-select"
                value={selectedKey}
                disabled={busy}
                onChange={(event) => {
                  setSelectedKey(event.target.value);
                  setConfirming(false);
                }}
              >
                {available.map((template) => (
                  <option key={template.key} value={template.key}>
                    {template.key} · version {template.version}
                  </option>
                ))}
              </select>
            </label>

            {selected ? (
              <article className="comms-preview" aria-label="Message preview">
                <p className="comms-preview-subject">{selected.subject ?? "(no subject)"}</p>
                <pre className="comms-preview-body">{selected.body}</pre>
              </article>
            ) : null}

            {unreachable.length ? (
              <p className="comms-unreachable">
                <IconWarning size={14} />
                {unreachable.length === 1
                  ? `${unreachable[0]?.name} has no email address on their identity and will not be sent to.`
                  : `${unreachable.length} speakers have no email address and will not be sent to: ${unreachable.map(({ name }) => name).join(", ")}.`}
              </p>
            ) : null}

            {confirming ? (
              // The confirmation names the count and the version, because "Send" on its own
              // does not say how many people are about to receive this.
              <fieldset className="comms-confirm" aria-label="Confirm send">
                <p>
                  Send <strong>{selected?.key}</strong> version {selected?.version} to{" "}
                  <strong>
                    {reachable.length} {reachable.length === 1 ? "speaker" : "speakers"}
                  </strong>
                  ? Each gets their own delivery you can track and retry.
                </p>
                <div className="comms-confirm-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      // ERROR-INTENT: handlers cannot await; send announces both outcomes.
                      void send();
                    }}
                  >
                    {busy
                      ? "Queueing…"
                      : `Yes, send to ${reachable.length} ${reachable.length === 1 ? "speaker" : "speakers"}`}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                  >
                    Keep editing
                  </button>
                </div>
              </fieldset>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || !selected || reachable.length === 0}
                onClick={() => setConfirming(true)}
              >
                <IconSend size={15} />
                {reachable.length === 0
                  ? "No speaker can be reached by email"
                  : `Send to ${reachable.length} ${reachable.length === 1 ? "speaker" : "speakers"}`}
              </button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
