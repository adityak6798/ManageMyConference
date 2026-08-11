/*
 * Speaker CRM.
 *
 * Outreach is a pipeline, so the surface is a stage-filtered table with live counts
 * next to a detail panel: an organizer can answer "who is stuck, and in which stage"
 * without leaving the page. The whole pipeline is fetched once per event and filtered
 * in the browser because the tab counts have to be readable *before* a stage is
 * picked, and the list endpoint returns one stage at a time.
 *
 * Owner is a select rather than free text: an owner id that does not exist violates the
 * crm_prospects.owner_id foreign key and surfaces to the organizer as a 500, so the UI
 * never lets an arbitrary string be sent. The set of offerable owners is deliberately
 * narrow — see the note on ownerOptions below.
 */

import type { ProspectDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CrmApiError,
  convertProspect,
  createProspect,
  listProspects,
  updateProspect,
} from "./api/crm";
import "./styles/crm.css";
import { IconCheck, IconClock, IconPlus, IconSpeakers, IconWarning } from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Stat, Tabs, useActionFeedback } from "./ui/primitives";

type PillTone = "neutral" | "ok" | "warn" | "danger" | "info" | "strong";

const STAGES: { id: ProspectDto["stage"]; label: string; tone: PillTone }[] = [
  { id: "identified", label: "Identified", tone: "neutral" },
  { id: "contacted", label: "Contacted", tone: "info" },
  { id: "engaged", label: "Engaged", tone: "info" },
  { id: "invited", label: "Invited", tone: "warn" },
  { id: "converted", label: "Converted", tone: "ok" },
];

/** The API refuses to move a prospect back out of "converted", so it is not offered. */
const EDITABLE_STAGES = STAGES.filter(({ id }) => id !== "converted");

const ACTIVITY_TONES: Record<ProspectDto["activities"][number]["kind"], PillTone> = {
  note: "neutral",
  email: "info",
  call: "info",
  meeting: "info",
  "stage-change": "warn",
  conversion: "ok",
};

const localDateTimeValue = (instant: string | null) => {
  if (!instant) return "";
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const shortDate = (instant: string) =>
  new Date(instant).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const stampedTime = (instant: string) =>
  new Date(instant).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Mirrors the server's overdue filter: a future speaker never counts as overdue. */
const isOverdue = (prospect: ProspectDto, now: number) =>
  !prospect.speakerId &&
  prospect.nextActionAt !== null &&
  new Date(prospect.nextActionAt).getTime() < now;

function readCrmError(reason: unknown, fallback: string) {
  if (reason instanceof CrmApiError) return `${reason.message} Reference: ${reason.correlationId}`;
  return reason instanceof Error ? reason.message : fallback;
}

// @spec PRD-CRM-001
export function CrmWorkspace({ eventId, ownerId }: { eventId: string; ownerId: string }) {
  const loadSequence = useRef(0);
  const [prospects, setProspects] = useState<ProspectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingConvert, setConfirmingConvert] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [newDueAt, setNewDueAt] = useState("");
  const [newOwner, setNewOwner] = useState(ownerId);

  const [stage, setStage] = useState<ProspectDto["stage"]>("identified");
  const [assignedOwner, setAssignedOwner] = useState(ownerId);
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [note, setNote] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const pipelineFeedback = useActionFeedback();
  const detailFeedback = useActionFeedback();

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const loaded = await listProspects(eventId);
    // A response that lands after the organizer switched events describes the old
    // workspace; rendering it would show another event's pipeline.
    if (sequence === loadSequence.current) setProspects(loaded);
  }, [eventId]);

  useEffect(() => {
    let active = true;
    setError("");
    setLoading(true);
    setSelectedId("");
    setConfirmingConvert(false);
    // ERROR-INTENT: React effects cannot await; both outcomes are rendered below.
    void reload()
      .catch((reason: unknown) => {
        if (active) setError(readCrmError(reason, "Could not load the speaker pipeline."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      loadSequence.current += 1;
    };
  }, [reload]);

  const now = Date.now();
  const selected = prospects.find(({ id }) => id === selectedId);

  // Listing every eligible owner needs an identity-access query that does not exist yet.
  // Borrowing the review workspace's reviewer list would couple the CRM to review:manage
  // and cross a domain boundary, so until that query ships the select offers the signed-in
  // organizer plus whoever already owns a prospect. Tracked by issue #67.
  const ownerOptions = useMemo(() => {
    const options = new Map<string, string>();
    options.set(ownerId, "You");
    // An owner already stored on the prospect stays selectable, otherwise saving an
    // unrelated field would silently reassign the prospect to somebody else.
    for (const prospect of prospects)
      if (!options.has(prospect.ownerId)) options.set(prospect.ownerId, prospect.ownerId);
    return [...options].map(([id, label]) => ({ id, name: label }));
  }, [ownerId, prospects]);

  const ownerName = useCallback(
    (id: string) => ownerOptions.find((owner) => owner.id === id)?.name ?? id,
    [ownerOptions],
  );

  const counts = useMemo(() => {
    const byStage = new Map<string, number>();
    for (const prospect of prospects)
      byStage.set(prospect.stage, (byStage.get(prospect.stage) ?? 0) + 1);
    return {
      all: prospects.length,
      overdue: prospects.filter((prospect) => isOverdue(prospect, now)).length,
      byStage,
    };
  }, [prospects, now]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return prospects.filter((prospect) => {
      if (tab === "overdue" ? !isOverdue(prospect, now) : tab !== "all" && prospect.stage !== tab)
        return false;
      if (!query) return true;
      return (
        prospect.name.toLowerCase().includes(query) ||
        prospect.contacts.some(
          (contact) =>
            contact.email.toLowerCase().includes(query) ||
            contact.name.toLowerCase().includes(query),
        )
      );
    });
  }, [prospects, tab, search, now]);

  const timeline = useMemo(
    () =>
      [...(selected?.activities ?? [])].sort(
        (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
      ),
    [selected],
  );

  function open(prospect: ProspectDto) {
    setSelectedId(prospect.id);
    setConfirmingConvert(false);
    detailFeedback.clear();
    setStage(prospect.stage === "converted" ? "invited" : prospect.stage);
    setAssignedOwner(prospect.ownerId);
    setNextAction(prospect.nextAction ?? "");
    setNextActionAt(localDateTimeValue(prospect.nextActionAt));
    setNote("");
    setContactName("");
    setContactEmail("");
  }

  async function add(formEvent: FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    try {
      const created = await createProspect(eventId, {
        name,
        email,
        ownerId: newOwner,
        nextActionAt: newDueAt ? new Date(newDueAt).toISOString() : undefined,
      });
      setName("");
      setEmail("");
      setNewDueAt("");
      setComposing(false);
      await reload();
      pipelineFeedback.announce("success", `${created.name} added to the pipeline as identified.`);
    } catch (reason) {
      pipelineFeedback.announce("error", readCrmError(reason, "Could not add the prospect."));
    } finally {
      setBusy(false);
    }
  }

  async function save(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await updateProspect(eventId, selected.id, {
        stage,
        ownerId: assignedOwner,
        nextAction: nextAction || null,
        nextActionAt: nextActionAt ? new Date(nextActionAt).toISOString() : null,
        activity: note ? { kind: "note", summary: note, private: true } : undefined,
      });
      setNote("");
      await reload();
      detailFeedback.announce(
        "success",
        `Saved. ${selected.name} is in the ${stage} stage, owned by ${ownerName(assignedOwner)}.`,
      );
    } catch (reason) {
      detailFeedback.announce("error", readCrmError(reason, "Could not update the prospect."));
    } finally {
      setBusy(false);
    }
  }

  async function addContact(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await updateProspect(eventId, selected.id, {
        contact: { name: contactName, email: contactEmail, isPrimary: false },
      });
      const added = contactEmail;
      setContactName("");
      setContactEmail("");
      await reload();
      detailFeedback.announce("success", `Added ${added} as a contact.`);
    } catch (reason) {
      detailFeedback.announce("error", readCrmError(reason, "Could not add the contact."));
    } finally {
      setBusy(false);
    }
  }

  async function convert(prospect: ProspectDto) {
    setBusy(true);
    try {
      await convertProspect(eventId, prospect.id);
      setConfirmingConvert(false);
      await reload();
      detailFeedback.announce("success", `${prospect.name} is now a speaker.`);
    } catch (reason) {
      detailFeedback.announce("error", readCrmError(reason, "Could not convert the prospect."));
    } finally {
      setBusy(false);
    }
  }

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "overdue", label: "Overdue", count: counts.overdue },
    ...STAGES.map((item) => ({
      id: item.id,
      label: item.label,
      count: counts.byStage.get(item.id) ?? 0,
    })),
  ];

  const inPipeline = prospects.filter((prospect) => prospect.stage !== "converted").length;
  const converted = counts.byStage.get("converted") ?? 0;

  if (error)
    return (
      <Card>
        <EmptyState title="The pipeline could not be loaded" icon={<IconWarning size={20} />}>
          {error}
        </EmptyState>
      </Card>
    );

  return (
    <div className="crm">
      <dl className="grid-auto">
        <Stat
          label="In pipeline"
          value={loading ? "—" : inPipeline}
          hint={`${counts.all} prospect${counts.all === 1 ? "" : "s"} tracked`}
          icon={<IconSpeakers size={15} />}
        />
        <Stat
          label="Overdue next actions"
          value={loading ? "—" : counts.overdue}
          hint={counts.overdue ? "Chase these first" : "Nothing has slipped"}
          icon={<IconClock size={15} />}
          attention={counts.overdue > 0}
        />
        <Stat
          label="Converted to speakers"
          value={loading ? "—" : converted}
          hint="Linked speaker profiles"
          icon={<IconCheck size={15} />}
        />
      </dl>

      <div className="split">
        <Card
          labelledBy="crm-pipeline"
          title="Prospect pipeline"
          hint="Filter by stage, then open a prospect to work its next action."
          actions={
            <button
              type="button"
              className="secondary"
              aria-expanded={composing}
              onClick={() => {
                setComposing((open) => !open);
                pipelineFeedback.clear();
              }}
            >
              <IconPlus size={15} />
              {composing ? "Close new prospect" : "New prospect"}
            </button>
          }
          tight
        >
          <div className="crm-toolbar-row">
            {composing ? (
              <form className="crm-create" onSubmit={add}>
                <div className="grid-auto">
                  <div className="field">
                    <label htmlFor="crm-new-name">Prospect name</label>
                    <input
                      id="crm-new-name"
                      value={name}
                      onChange={(changeEvent) => setName(changeEvent.target.value)}
                      placeholder="Dr. Ada Rivera"
                      required
                      maxLength={160}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="crm-new-email">Contact email</label>
                    <input
                      id="crm-new-email"
                      type="email"
                      value={email}
                      onChange={(changeEvent) => setEmail(changeEvent.target.value)}
                      placeholder="ada@example.test"
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="crm-new-owner">Owner</label>
                    <select
                      id="crm-new-owner"
                      value={newOwner}
                      onChange={(changeEvent) => setNewOwner(changeEvent.target.value)}
                    >
                      {ownerOptions.map((owner) => (
                        <option key={owner.id} value={owner.id}>
                          {owner.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="crm-new-due">First action due</label>
                    <input
                      id="crm-new-due"
                      type="datetime-local"
                      value={newDueAt}
                      onChange={(changeEvent) => setNewDueAt(changeEvent.target.value)}
                    />
                    <p className="hint">Outreach is scheduled as "Send introductory outreach".</p>
                  </div>
                </div>
                <div className="crm-form-actions">
                  <button type="submit" disabled={busy}>
                    {busy ? "Adding…" : "Add prospect"}
                  </button>
                  <button type="button" className="secondary" onClick={() => setComposing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
            {pipelineFeedback.node}
            <div className="toolbar">
              <div className="field search">
                <label className="visually-hidden" htmlFor="crm-search">
                  Search prospects
                </label>
                <input
                  id="crm-search"
                  type="search"
                  value={search}
                  onChange={(changeEvent) => setSearch(changeEvent.target.value)}
                  placeholder="Search name or contact email"
                />
              </div>
            </div>
            <Tabs items={tabs} active={tab} onSelect={setTab} label="Pipeline stage" />
          </div>

          <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {loading ? (
              <div className="crm-skeletons">
                <div aria-hidden="true">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="skeleton" style={{ height: 44 }} />
                  ))}
                </div>
                <p className="visually-hidden" role="status">
                  Loading the speaker pipeline.
                </p>
              </div>
            ) : visible.length === 0 ? (
              <EmptyState
                title={counts.all ? "No prospects in this view" : "No prospects yet"}
                icon={<IconSpeakers size={20} />}
                action={
                  counts.all ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setTab("all");
                        setSearch("");
                      }}
                    >
                      Show every prospect
                    </button>
                  ) : (
                    <button type="button" onClick={() => setComposing(true)}>
                      <IconPlus size={15} />
                      New prospect
                    </button>
                  )
                }
              >
                {counts.all
                  ? "Nobody matches this stage and search. Clear the filters to see the whole pipeline."
                  : "Track the speakers you are courting here, then convert them once they accept."}
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data crm-table">
                  <thead>
                    <tr>
                      <th scope="col">Prospect</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Next action</th>
                      <th scope="col" className="num">
                        Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((prospect) => {
                      const overdue = isOverdue(prospect, now);
                      const meta = STAGES.find(({ id }) => id === prospect.stage);
                      const primary =
                        prospect.contacts.find((contact) => contact.isPrimary) ??
                        prospect.contacts[0];
                      return (
                        <tr
                          key={prospect.id}
                          className={prospect.id === selectedId ? "is-selected" : undefined}
                        >
                          <td className="primary-cell">
                            <button
                              type="button"
                              className="ghost crm-row-open"
                              aria-current={prospect.id === selectedId ? "true" : undefined}
                              onClick={() => open(prospect)}
                            >
                              {prospect.name}
                            </button>
                            {primary ? <span className="sub">{primary.email}</span> : null}
                          </td>
                          <td>
                            <Pill tone={meta?.tone ?? "neutral"}>
                              {meta?.label ?? prospect.stage}
                            </Pill>
                            {prospect.speakerId ? (
                              <span className="sub">Speaker linked</span>
                            ) : null}
                          </td>
                          <td>{ownerName(prospect.ownerId)}</td>
                          <td>
                            {prospect.nextAction ?? "No next action scheduled"}
                            {prospect.nextActionAt ? (
                              <span className="sub">
                                {overdue ? (
                                  <Pill tone="danger">
                                    <IconClock size={12} />
                                    Overdue {shortDate(prospect.nextActionAt)}
                                  </Pill>
                                ) : (
                                  `Due ${shortDate(prospect.nextActionAt)}`
                                )}
                              </span>
                            ) : null}
                          </td>
                          <td className="num">
                            {prospect.activities.length}
                            <span className="sub">{shortDate(prospect.updatedAt)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>

        {selected ? (
          <Card
            labelledBy="crm-detail"
            title={selected.name}
            hint={`Owned by ${ownerName(selected.ownerId)}`}
            actions={
              <button type="button" className="ghost" onClick={() => setSelectedId("")}>
                Close
              </button>
            }
          >
            <div className="crm-detail">
              {detailFeedback.node}

              {selected.speakerId ? (
                <Notice tone="success">
                  <IconCheck size={15} />
                  <span>
                    Converted on {stampedTime(selected.convertedAt ?? selected.updatedAt)}.
                    Converted prospects are read-only so the outreach history stays intact.
                  </span>
                </Notice>
              ) : null}

              <section aria-labelledby="crm-contacts">
                <h3 id="crm-contacts">Contacts</h3>
                <ul className="crm-contacts">
                  {selected.contacts.map((contact) => (
                    <li key={contact.id}>
                      <span className="crm-contact-name">{contact.name}</span>
                      <a href={`mailto:${contact.email}`}>{contact.email}</a>
                      {contact.isPrimary ? <Pill tone="info">Primary</Pill> : null}
                    </li>
                  ))}
                </ul>
                {selected.speakerId ? null : (
                  <details className="crm-details">
                    <summary>Add another contact</summary>
                    <form onSubmit={addContact}>
                      <div className="field">
                        <label htmlFor="crm-contact-name">Contact name</label>
                        <input
                          id="crm-contact-name"
                          value={contactName}
                          onChange={(changeEvent) => setContactName(changeEvent.target.value)}
                          required
                          maxLength={160}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="crm-contact-email">Additional contact email</label>
                        <input
                          id="crm-contact-email"
                          type="email"
                          value={contactEmail}
                          onChange={(changeEvent) => setContactEmail(changeEvent.target.value)}
                          required
                        />
                      </div>
                      <button type="submit" className="secondary" disabled={busy}>
                        Add contact
                      </button>
                    </form>
                  </details>
                )}
              </section>

              {selected.speakerId ? null : (
                <section aria-labelledby="crm-working">
                  <h3 id="crm-working">Stage and next action</h3>
                  <form onSubmit={save}>
                    <div className="field">
                      <label htmlFor="crm-stage">Stage</label>
                      <select
                        id="crm-stage"
                        value={stage}
                        onChange={(changeEvent) =>
                          setStage(changeEvent.target.value as ProspectDto["stage"])
                        }
                      >
                        {EDITABLE_STAGES.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="crm-owner">Owner</label>
                      <select
                        id="crm-owner"
                        value={assignedOwner}
                        onChange={(changeEvent) => setAssignedOwner(changeEvent.target.value)}
                      >
                        {ownerOptions.map((owner) => (
                          <option key={owner.id} value={owner.id}>
                            {owner.name}
                          </option>
                        ))}
                      </select>
                      <p className="hint">
                        Only organizers and reviewers on this event can own a prospect.
                      </p>
                    </div>
                    <div className="field">
                      <label htmlFor="crm-next-action">Next action</label>
                      <input
                        id="crm-next-action"
                        value={nextAction}
                        onChange={(changeEvent) => setNextAction(changeEvent.target.value)}
                        placeholder="Send formal invitation"
                        maxLength={300}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="crm-next-action-at">Next action due</label>
                      <input
                        id="crm-next-action-at"
                        type="datetime-local"
                        value={nextActionAt}
                        onChange={(changeEvent) => setNextActionAt(changeEvent.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="crm-note">Private note</label>
                      <input
                        id="crm-note"
                        value={note}
                        onChange={(changeEvent) => setNote(changeEvent.target.value)}
                        placeholder="Available after 2pm"
                        maxLength={1000}
                      />
                      <p className="hint">
                        Saved to the timeline. Stage changes are not logged automatically yet, so
                        record the reason here.
                      </p>
                    </div>
                    <button type="submit" disabled={busy}>
                      {busy ? "Saving…" : "Save prospect"}
                    </button>
                  </form>
                </section>
              )}

              {selected.speakerId ? null : (
                <section aria-labelledby="crm-convert">
                  <h3 id="crm-convert">Convert to speaker</h3>
                  {confirmingConvert ? (
                    <>
                      <Notice tone="warn">
                        <IconWarning size={15} />
                        <span>
                          Convert {selected.name}? This creates a speaker profile from the primary
                          contact and locks the prospect record.
                        </span>
                      </Notice>
                      <div className="crm-form-actions">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            // ERROR-INTENT: handlers cannot await; convert announces both outcomes.
                            void convert(selected);
                          }}
                        >
                          {busy ? "Converting…" : `Yes, convert ${selected.name}`}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setConfirmingConvert(false)}
                        >
                          Keep as a prospect
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="crm-help">
                        Creates the speaker profile, links it to this prospect, and hands the
                        onboarding tasks to the speaker portal.
                      </p>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => setConfirmingConvert(true)}
                      >
                        <IconCheck size={15} />
                        Convert to speaker
                      </button>
                    </>
                  )}
                </section>
              )}

              <section aria-labelledby="crm-timeline">
                <h3 id="crm-timeline">Activity timeline</h3>
                {timeline.length ? (
                  <ol className="crm-timeline">
                    {timeline.map((activity) => (
                      <li key={activity.id}>
                        <div className="crm-timeline-head">
                          <Pill tone={ACTIVITY_TONES[activity.kind]}>
                            {activity.kind.replace("-", " ")}
                          </Pill>
                          <time dateTime={activity.occurredAt}>
                            {stampedTime(activity.occurredAt)}
                          </time>
                          {activity.private ? <span className="crm-private">Private</span> : null}
                        </div>
                        <p>{activity.summary}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="crm-help">
                    No activity recorded yet. Saving a private note adds the first entry.
                  </p>
                )}
              </section>
            </div>
          </Card>
        ) : (
          <Card labelledBy="crm-detail-empty" title="Prospect detail">
            <EmptyState title="Select a prospect" icon={<IconSpeakers size={20} />}>
              Open a name from the pipeline to see its contacts, activity timeline, next action, and
              the convert-to-speaker action.
            </EmptyState>
          </Card>
        )}
      </div>
    </div>
  );
}
