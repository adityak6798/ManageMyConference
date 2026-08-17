/*
 * Composing a message and sending it to an event's speakers.
 *
 * The outbox has always been able to carry a delivery; until now nothing in the console could
 * create one, so a template could only be made by hand-crafting a POST and the "Communications"
 * workspace was a read-only window onto rows somebody else had written.
 *
 * **The message is the subject line.** Everything on this panel is arranged around the sentence a
 * speaker will read in their inbox. Choosing what to send used to mean picking from a list of
 * `speaker-welcome · version 3`, and writing one began by asking for a primary key — so the first
 * thing an organizer did before writing an email was name a database row. The key is still real,
 * still immutable and still what a delivery records; it is derived from the subject and shown
 * under Details, where somebody who needs it can change it.
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
import type {
  BroadcastPreviewEntryDto,
  BroadcastRecipientDto,
  MessageTemplateDto,
  SpeakerMergeFieldDto,
} from "@greenroom/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTemplate,
  getMergeFields,
  getRecipients,
  getTemplates,
  previewBroadcast,
  sendToSpeakers,
} from "../api/communications";
import { type ApiFailure, describeApiFailure } from "../api/config";
import { Field, Select } from "../ui/fields";
import { IconSend, IconWarning } from "../ui/icons";
import { EmptyState, LoadFailure, Notice, Section, useActionFeedback } from "../ui/primitives";

interface ComposePanelProps {
  organizationId: string;
  eventId: string;
  /** Called after a send so the history beside this panel shows the new deliveries. */
  onSent: () => void;
}

/** The newest version of each key: what "send this template" means without a version picker. */
const latestByKey = (templates: readonly MessageTemplateDto[]) => {
  const newest = new Map<string, MessageTemplateDto>();
  for (const template of templates) {
    const held = newest.get(template.key);
    if (!held || template.version > held.version) newest.set(template.key, template);
  }
  return [...newest.values()].sort((left, right) => left.key.localeCompare(right.key));
};

/**
 * The storage name a subject implies.
 *
 * A key is a stable identity across versions, so it has to be derivable and it has to be stable
 * once chosen — which is why the disclosure lets it be overridden rather than recomputing it from
 * every keystroke after the first save.
 */
const keyFromSubject = (subject: string) =>
  subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

// @spec PRD-COM-001
export function ComposePanel({ organizationId, eventId, onSent }: ComposePanelProps) {
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipientDto[] | null>(null);
  /**
   * The server's name for the audience the count on screen describes.
   *
   * Sent back with the broadcast. If the event's speakers changed in between, the send is
   * refused and nothing goes out, rather than reaching a different set of people than the number
   * the organizer approved.
   */
  const [audienceVersion, setAudienceVersion] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>("");
  /**
   * Who this send is for.
   *
   * `null` means "everybody reachable", which is what this panel did before a selection
   * existed and is still the common case — distinct from an empty set, which is nobody and is
   * refused. The distinction matters because the roster changes: "everybody" re-resolves on the
   * server at send time, a named list does not.
   */
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<BroadcastPreviewEntryDto[] | null>(null);
  const [mergeFields, setMergeFields] = useState<SpeakerMergeFieldDto[]>([]);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const [composing, setComposing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ subject: "", body: "" });
  /** Null until somebody opens Details and types one: otherwise the subject decides. */
  const [keyOverride, setKeyOverride] = useState<string | null>(null);
  /**
   * A refused save, preview or send.
   *
   * Held rather than announced, because `useActionFeedback` carries a sentence and nothing else:
   * a refusal's correlation reference is the one part of it read character by character, and
   * glued onto the end of a paragraph it cannot be selected. `Notice` puts it on its own line
   * with a copy button, and `tone="error"` still interrupts.
   */
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const feedback = useActionFeedback();

  const load = useCallback(async () => {
    try {
      const [loadedTemplates, loadedRecipients, fields] = await Promise.all([
        getTemplates(organizationId),
        getRecipients(organizationId, eventId),
        getMergeFields(),
      ]);
      setMergeFields([...fields]);
      setTemplates(loadedTemplates);
      setRecipients(loadedRecipients.recipients);
      setAudienceVersion(loadedRecipients.audienceVersion);
      setLoadFailure(null);
      setSelectedKey((current) =>
        current && loadedTemplates.some((template) => template.key === current)
          ? current
          : (latestByKey(loadedTemplates)[0]?.key ?? ""),
      );
    } catch (reason: unknown) {
      // ERROR-INTENT: this panel renders its own read failure in place of the controls it
      // could not populate; sending is impossible without knowing the recipients anyway.
      setLoadFailure(describeApiFailure(reason, "Templates and recipients could not be loaded."));
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
  const needle = search.trim().toLowerCase();
  const matching = reachable.filter(
    (recipient) =>
      !needle || `${recipient.name} ${recipient.address ?? ""}`.toLowerCase().includes(needle),
  );
  /*
   * The people this send would actually reach.
   *
   * A selection is filtered against the reachable roster rather than trusted, so a speaker who
   * left the event between ticking and sending is not counted in the number being approved —
   * the server refuses that send anyway, and the count on screen should not disagree with it.
   */
  const audience = chosen
    ? reachable.filter((recipient) => chosen.includes(recipient.userId))
    : reachable;
  const audienceLabel = `${audience.length} ${audience.length === 1 ? "speaker" : "speakers"}`;
  const toggle = (userId: string) =>
    setChosen((current) => {
      // The first tick turns "everybody" into a list, starting from everybody: unticking one
      // person should not silently drop the rest.
      const base = current ?? reachable.map((recipient) => recipient.userId);
      const next = base.includes(userId) ? base.filter((id) => id !== userId) : [...base, userId];
      setPreview(null);
      return next;
    });

  const draftKey = keyOverride ?? keyFromSubject(draft.subject);
  /** The template this draft would add a version to, if its key is one that already exists. */
  const supersedes = available.find((template) => template.key === draftKey) ?? null;

  /**
   * Put a merge token where the caret is.
   *
   * The tokens used to be a read-only list under the box, so writing one meant reading it,
   * remembering the braces and typing it — and a token typed one character wrong is a send the
   * renderer refuses rather than a message with a gap in it.
   */
  function insertToken(token: string) {
    const snippet = `{{${token}}}`;
    const node = bodyRef.current;
    if (!node) {
      setDraft((current) => ({ ...current, body: `${current.body}${snippet}` }));
      return;
    }
    const start = node.selectionStart ?? node.value.length;
    const end = node.selectionEnd ?? start;
    const next = `${node.value.slice(0, start)}${snippet}${node.value.slice(end)}`;
    setDraft((current) => ({ ...current, body: next }));
    const caret = start + snippet.length;
    // After React has written the new value back, or the caret lands in the old string.
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  }

  async function publish() {
    setBusy(true);
    setFailure(null);
    try {
      const created = await createTemplate({
        organizationId,
        key: draftKey,
        // No version. The server allocates the next one next to the constraint that arbitrates
        // it, so two organizers publishing the same key at once both succeed with consecutive
        // versions instead of one being refused for proposing a number this panel guessed.
        channel: "email",
        subject: draft.subject.trim() ? draft.subject.trim() : null,
        body: draft.body,
      });
      await load();
      setSelectedKey(created.key);
      setComposing(false);
      setDraft({ subject: "", body: "" });
      setKeyOverride(null);
      feedback.announce(
        "success",
        `Saved “${created.subject ?? created.key}” as version ${created.version}. Earlier versions stay readable.`,
      );
    } catch (reason: unknown) {
      // ERROR-INTENT: announced beside the form that produced it, so the draft survives.
      // Re-read first so the list behind the panel reflects whatever else has been published.
      await load();
      setFailure(describeApiFailure(reason, "The message could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Resolve what each chosen recipient would receive, then ask for confirmation.
   *
   * The preview is a request rather than a client-side substitution, so what is approved is what
   * the delivery will store. A template whose placeholder has no value is refused here — on the
   * screen showing the message — instead of after the first delivery is queued.
   */
  async function resolve() {
    if (!selected) return;
    setBusy(true);
    setFailure(null);
    try {
      const resolved = await previewBroadcast({
        organizationId,
        eventId,
        templateKey: selected.key,
        templateVersion: selected.version,
        ...(chosen ? { recipientIds: audience.map(({ userId }) => userId) } : {}),
      });
      setPreview([...resolved.entries]);
      // The audience the *preview* named, so the send confirms against what was on screen.
      setAudienceVersion(resolved.audienceVersion);
      setConfirming(true);
    } catch (reason: unknown) {
      // ERROR-INTENT: announced beside the control that asked for it. A placeholder with no
      // value names itself here, which is the whole reason the preview happens server-side.
      setPreview(null);
      setConfirming(false);
      setFailure(describeApiFailure(reason, "The message could not be resolved."));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!selected) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await sendToSpeakers({
        organizationId,
        eventId,
        templateKey: selected.key,
        templateVersion: selected.version,
        ...(audienceVersion ? { audienceVersion } : {}),
        ...(chosen ? { recipientIds: audience.map(({ userId }) => userId) } : {}),
      });
      setConfirming(false);
      setPreview(null);
      onSent();
      // What happened, not what was attempted. A repeat send of the same template version
      // writes nothing, and saying "queued" about it would promise mail that will never go.
      const named = selected.subject ?? selected.key;
      const queued = result.enqueued
        ? `Queued ${result.enqueued} ${result.enqueued === 1 ? "delivery" : "deliveries"} for “${named}”. The outbox sends ${result.enqueued === 1 ? "it" : "them"} on its next run.`
        : `Nothing new to send: every reachable speaker already has version ${selected.version} of “${named}”. Save a new version to send a correction.`;
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
      //
      // A stale audience lands here too, and re-reading is what makes the refusal actionable:
      // the panel comes back showing the count that is true now, and the organizer confirms
      // against that rather than pressing Send into the same refusal. `setConfirming(false)`
      // sends them back through the confirmation deliberately — a send refused because the
      // audience changed must be re-approved, not retried.
      setConfirming(false);
      setPreview(null);
      await load();
      setFailure(describeApiFailure(reason, "The send was refused."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      labelledBy="communications-compose-title"
      // The whole region sets to the composer's measure, heading and action included: capping
      // only the body would leave "Write a message" hanging 600px to the right of the form it
      // opens.
      className="comms-compose-region"
      title="Send to speakers"
      description={
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
          {composing ? "Cancel" : "Write a message"}
        </button>
      }
    >
      <div className="comms-compose">
        {feedback.node}
        {failure ? (
          <Notice tone="error" reference={failure.reference} onDismiss={() => setFailure(null)}>
            {failure.message}
          </Notice>
        ) : null}

        {loadFailure ? (
          <LoadFailure
            what="the templates and recipients"
            error={loadFailure.message}
            reference={loadFailure.reference}
            onRetry={load}
            retryLabel="Try again"
          />
        ) : composing ? (
          <form
            className="comms-compose-form"
            onSubmit={(event) => {
              event.preventDefault();
              // ERROR-INTENT: handlers cannot await; publish announces both outcomes.
              void publish();
            }}
          >
            {/* Subject first, and required: it is what a speaker sees, and it is now what
                names the template. */}
            <Field label="Subject" id="message-subject" required>
              {(control) => (
                <input
                  {...control}
                  className="control"
                  value={draft.subject}
                  maxLength={200}
                  placeholder="You're speaking at Greenroom"
                  onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                />
              )}
            </Field>
            <Field label="Message" id="message-body" required>
              {(control) => (
                <textarea
                  {...control}
                  ref={bodyRef}
                  className="control"
                  value={draft.body}
                  rows={8}
                  placeholder={"Hi {{speakerName}},\n\nYour session is confirmed."}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                />
              )}
            </Field>
            {/*
             * The vocabulary comes from the server that resolves it.
             *
             * A hard-coded list here would go stale the moment a token is added, and an author
             * who cannot see the real list writes a template that cannot be sent — the renderer
             * refuses a placeholder with no value rather than mailing half a sentence.
             */}
            <div className="comms-merge">
              <p className="hint">
                These placeholders are filled in per recipient. Any other placeholder must have a
                value, or the send is refused rather than mailing half a sentence.
              </p>
              {mergeFields.length ? (
                <dl className="comms-merge-list">
                  {mergeFields.map((field) => (
                    <div key={field.token}>
                      <dt>
                        <button
                          type="button"
                          className="secondary small comms-merge-insert"
                          disabled={busy}
                          aria-label={`Insert ${field.token} — ${field.describes}`}
                          onClick={() => insertToken(field.token)}
                        >
                          <code className="figure">{`{{${field.token}}}`}</code>
                        </button>
                      </dt>
                      <dd>{field.describes}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>

            {/*
             * The storage name, where somebody who needs it can find it.
             *
             * This used to be the first field on the form: writing an email began by naming a
             * primary key. It is still real — a delivery records the key and the version, and
             * saving the same key again publishes the next version of it — so it is derived,
             * shown, and editable, rather than hidden or invented.
             */}
            <details className="comms-compose-details">
              <summary>Details</summary>
              <div className="comms-compose-details-body">
                <Field
                  label="Template name"
                  id="message-key"
                  hint={
                    supersedes
                      ? `Saving publishes version ${supersedes.version + 1} of this template. Every earlier version stays readable.`
                      : "Derived from the subject. It identifies this message across every version of it."
                  }
                >
                  {(control) => (
                    <input
                      {...control}
                      className="control figure"
                      value={draftKey}
                      maxLength={80}
                      onChange={(event) => setKeyOverride(event.target.value)}
                    />
                  )}
                </Field>
              </div>
            </details>

            <div className="toolbar">
              <button
                type="submit"
                className="primary"
                disabled={busy || !draft.body.trim() || !draftKey}
              >
                {busy ? "Saving…" : "Save this message"}
              </button>
            </div>
          </form>
        ) : available.length === 0 ? (
          <EmptyState icon={<IconSend size={20} />} title="No messages yet">
            Write one and it becomes a message you can send to this event's speakers, and send again
            — with a correction — as a new version.
          </EmptyState>
        ) : (
          <>
            {/*
             * What is being sent, named the way a speaker sees it.
             *
             * The picker used to list `speaker-welcome · version 3`, so choosing what to mail
             * forty people meant recognising a storage key. The subject is the option; the key
             * and version ride along underneath it, because a delivery records both.
             */}
            <Select
              label="Message"
              value={selectedKey || null}
              onChange={(next) => {
                setSelectedKey(next);
                setConfirming(false);
                // A resolved preview belongs to the template that produced it. Leaving it on
                // screen under a different template would show the organizer one message and
                // send another.
                setPreview(null);
              }}
              options={available.map((template) => ({
                value: template.key,
                label: template.subject ?? "(no subject)",
                hint: `${template.key} · v${template.version}`,
              }))}
            />

            {/*
             * Who this send is for.
             *
             * Only reachable speakers are tickable: a box beside somebody with no address would
             * be a control that cannot do anything, and the notice below already names them. The
             * search filters what is listed and never the selection — a speaker ticked before
             * typing stays in the audience, because a filter that silently unticked people would
             * send to fewer than the count says.
             */}
            {reachable.length ? (
              <fieldset className="comms-audience" aria-label="Recipients">
                <div className="comms-audience-head">
                  <label className="comms-audience-search" htmlFor="recipient-search">
                    Find a speaker
                    <input
                      id="recipient-search"
                      className="control is-sm"
                      type="search"
                      value={search}
                      disabled={busy}
                      placeholder="Name or address"
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  {/*
                   * Neither control is disabled once it has been used: disabling the button under
                   * the pointer that just pressed it drops keyboard focus to the document, and
                   * both are safe to press twice.
                   */}
                  <div className="comms-audience-bulk">
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => {
                        // Back to null rather than to a list of everyone: "everybody" re-resolves
                        // on the server at send time, so a speaker added in between is included.
                        setChosen(null);
                        setPreview(null);
                      }}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="secondary small"
                      disabled={busy}
                      onClick={() => {
                        setChosen([]);
                        setPreview(null);
                      }}
                    >
                      Clear selection
                    </button>
                  </div>
                </div>
                {/* Ticking a box changes this line and nothing else moves, so it is announced
                    rather than left for a screen-reader user to go looking for. */}
                <p className="comms-audience-count" aria-live="polite">
                  Sending to <strong>{audienceLabel}</strong>
                  {chosen === null
                    ? " — everyone this event can reach, resolved again when you send."
                    : "."}
                </p>
                {matching.length ? (
                  <ul className="comms-audience-list">
                    {matching.map((recipient) => (
                      <li key={recipient.userId}>
                        <label className="comms-audience-row">
                          <input
                            type="checkbox"
                            checked={chosen === null || chosen.includes(recipient.userId)}
                            disabled={busy}
                            onChange={() => toggle(recipient.userId)}
                          />
                          <span className="comms-audience-name">{recipient.name}</span>
                          <span className="comms-audience-address">{recipient.address}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="comms-audience-empty">
                    No reachable speaker matches that search. The selection is unchanged.
                  </p>
                )}
              </fieldset>
            ) : null}

            {/*
             * What was resolved, or the template it will be resolved from.
             *
             * The two are labelled apart on purpose. The template is instructions — it still
             * carries its placeholders — and showing it under the word "preview" invited an organizer
             * to approve a message nobody will receive. Once the server has rendered it, every
             * recipient's own copy is on screen, which is the only version of this that can be
             * trusted to match what the delivery stores.
             */}
            {preview ? (
              <div className="comms-previews">
                <h3 className="comms-previews-title">
                  What each speaker receives ({preview.length})
                </h3>
                <ul
                  className="comms-previews-scroll"
                  aria-label="Resolved messages"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: this list scrolls and holds nothing focusable, so without a tab stop a keyboard reaches the Send button but not the messages it would send.
                  tabIndex={0}
                >
                  {preview.map((entry) => (
                    <li key={entry.userId}>
                      <article className="comms-preview" aria-label={`Message for ${entry.name}`}>
                        <p className="comms-preview-to">
                          <span className="comms-preview-name">{entry.name}</span>
                          <span className="comms-preview-address">{entry.address}</span>
                        </p>
                        <p className="comms-preview-subject">{entry.subject ?? "(no subject)"}</p>
                        <pre className="comms-preview-body">{entry.body}</pre>
                      </article>
                    </li>
                  ))}
                </ul>
              </div>
            ) : selected ? (
              <article className="comms-preview is-template" aria-label="Template text">
                <p className="comms-preview-kind">
                  Template — placeholders are filled in per recipient when you send.
                </p>
                <p className="comms-preview-subject">{selected.subject ?? "(no subject)"}</p>
                <pre className="comms-preview-body">{selected.body}</pre>
              </article>
            ) : null}

            {unreachable.length ? (
              <p className="comms-unreachable">
                <IconWarning size={20} />
                {unreachable.length === 1
                  ? `${unreachable[0]?.name} has no email address on their identity and will not be sent to.`
                  : `${unreachable.length} speakers have no email address and will not be sent to: ${unreachable.map(({ name }) => name).join(", ")}.`}
              </p>
            ) : null}

            {/*
             * `preview` gates the confirmation as well as `confirming`, so changing the audience
             * — which clears the preview — puts the organizer back in front of the button rather
             * than in front of a confirmation describing a resolution that no longer holds.
             */}
            {confirming && preview ? (
              // The confirmation names the count and the message, because "Send" on its own
              // does not say how many people are about to receive this.
              <fieldset className="comms-confirm" aria-label="Confirm send">
                <p>
                  Send <strong>{selected?.subject ?? selected?.key}</strong> to{" "}
                  <strong>{audienceLabel}</strong>? Each gets their own delivery you can track and
                  retry.
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
                    {busy ? "Queueing…" : `Yes, send to ${audienceLabel}`}
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
                disabled={busy || !selected || audience.length === 0}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; resolve announces its own failure and
                  // only opens the confirmation once the server has rendered every message.
                  void resolve();
                }}
              >
                <IconSend size={20} />
                {busy
                  ? "Preparing each message…"
                  : reachable.length === 0
                    ? "No speaker can be reached by email"
                    : audience.length === 0
                      ? "Select at least one speaker to send to"
                      : `Send to ${audienceLabel}`}
              </button>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
