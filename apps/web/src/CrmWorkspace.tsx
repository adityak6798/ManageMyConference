import type { ProspectDto } from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  convertProspect,
  createProspect,
  CrmApiError,
  listProspects,
  updateProspect,
} from "./api/crm";

const localDateTimeValue = (instant: string | null) => {
  if (!instant) return "";
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

// @spec PRD-CRM-001
export function CrmWorkspace({ eventId, ownerId }: { eventId: string; ownerId: string }) {
  const loadSequence = useRef(0);
  const [prospects, setProspects] = useState<ProspectDto[]>([]),
    [filter, setFilter] = useState("all"),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [newDueAt, setNewDueAt] = useState(""),
    [selectedId, setSelectedId] = useState(""),
    [stage, setStage] = useState("identified"),
    [nextAction, setNextAction] = useState(""),
    [nextActionAt, setNextActionAt] = useState(""),
    [assignedOwner, setAssignedOwner] = useState(ownerId),
    [note, setNote] = useState(""),
    [contactName, setContactName] = useState(""),
    [contactEmail, setContactEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const loaded = await listProspects(eventId, filter);
      if (sequence === loadSequence.current) setProspects(loaded);
    } catch (reason) {
      if (sequence === loadSequence.current) throw reason;
    }
  }, [eventId, filter]);
  useEffect(() => {
    setError("");
    // ERROR-INTENT: React effects cannot await; the rejection renders a safe CRM error state.
    void load().catch((reason: unknown) =>
      setError(
        reason instanceof CrmApiError
          ? `${reason.message} Reference: ${reason.correlationId}`
          : "Could not load the speaker pipeline.",
      ),
    );
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (eventId) setSelectedId("");
  }, [eventId]);
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createProspect(eventId, {
        name,
        email,
        ownerId,
        nextActionAt: newDueAt ? new Date(newDueAt).toISOString() : undefined,
      });
      setName("");
      setEmail("");
      setNewDueAt("");
      if (filter === "all") await load();
      else setFilter("all");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add prospect.");
    } finally {
      setBusy(false);
    }
  }
  async function convert(id: string) {
    setBusy(true);
    setError("");
    try {
      await convertProspect(eventId, id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not convert prospect.");
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      await updateProspect(eventId, selectedId, {
        stage,
        ownerId: assignedOwner,
        nextAction: nextAction || null,
        nextActionAt: nextActionAt ? new Date(nextActionAt).toISOString() : null,
        activity: note ? { kind: "note", summary: note, private: true } : undefined,
      });
      setNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update prospect.");
    } finally {
      setBusy(false);
    }
  }
  async function addContact(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      await updateProspect(eventId, selectedId, {
        contact: { name: contactName, email: contactEmail, isPrimary: false },
      });
      setContactName("");
      setContactEmail("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add contact.");
    } finally {
      setBusy(false);
    }
  }
  const selected = prospects.find(({ id }) => id === selectedId);
  return (
    <section aria-labelledby="crm-title">
      <p className="eyebrow">Speaker CRM</p>
      <h2 id="crm-title">Prospect pipeline</h2>
      <div className="crm-toolbar">
        <label>
          Pipeline view
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All prospects</option>
            <option value="overdue">Overdue next actions</option>
            <option value="identified">Identified</option>
            <option value="contacted">Contacted</option>
            <option value="engaged">Engaged</option>
            <option value="invited">Invited</option>
            <option value="converted">Converted</option>
          </select>
        </label>
      </div>
      {prospects.length ? (
        <ul className="pipeline">
          {prospects.map((prospect) => (
            <li key={prospect.id}>
              <div>
                <strong>{prospect.name}</strong>
                <span>{prospect.stage}</span>
                <p>{prospect.nextAction ?? "No next action scheduled"}</p>
                <p>Owner: {prospect.ownerId}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(prospect.id);
                  setStage(prospect.stage === "converted" ? "invited" : prospect.stage);
                  setNextAction(prospect.nextAction ?? "");
                  setNextActionAt(localDateTimeValue(prospect.nextActionAt));
                  setAssignedOwner(prospect.ownerId);
                }}
              >
                Manage
              </button>
              {prospect.speakerId ? (
                <span className="converted">Speaker linked</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: React event handlers cannot await; convert renders failures.
                    void convert(prospect.id);
                  }}
                >
                  Convert to speaker
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">
          No prospects match this pipeline view. Add the first prospect or choose another filter.
        </p>
      )}
      {selected ? (
        <div className="prospect-detail">
          <h3>{selected.name} details</h3>
          <h4>Contacts</h4>
          <ul>
            {selected.contacts.map((contact) => (
              <li key={contact.id}>
                {contact.name} — {contact.email}
                {contact.isPrimary ? " (primary)" : ""}
              </li>
            ))}
          </ul>
          <h4>Activity timeline</h4>
          {selected.activities.length ? (
            <ol>
              {selected.activities.map((activity) => (
                <li key={activity.id}>
                  <strong>{activity.kind}</strong>: {activity.summary}{" "}
                  <time dateTime={activity.occurredAt}>
                    {new Date(activity.occurredAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">No activity recorded yet.</p>
          )}{" "}
          {!selected.speakerId ? (
            <form onSubmit={save}>
              <div className="form-row">
                <label>
                  Stage
                  <select value={stage} onChange={(event) => setStage(event.target.value)}>
                    <option value="identified">Identified</option>
                    <option value="contacted">Contacted</option>
                    <option value="engaged">Engaged</option>
                    <option value="invited">Invited</option>
                  </select>
                </label>
                <label>
                  Owner
                  <input
                    value={assignedOwner}
                    onChange={(event) => setAssignedOwner(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Next action
                  <input
                    value={nextAction}
                    onChange={(event) => setNextAction(event.target.value)}
                  />
                </label>
                <label>
                  Next action due
                  <input
                    type="datetime-local"
                    value={nextActionAt}
                    onChange={(event) => setNextActionAt(event.target.value)}
                  />
                </label>
                <label>
                  Private note
                  <input value={note} onChange={(event) => setNote(event.target.value)} />
                </label>
                <button type="submit" disabled={busy}>
                  Save prospect
                </button>
              </div>
            </form>
          ) : null}
          <form onSubmit={addContact}>
            <h4>Add contact</h4>
            <div className="form-row">
              <label>
                Contact name
                <input
                  value={contactName}
                  onChange={(event) => setContactName(event.target.value)}
                  required
                />
              </label>
              <label>
                Additional contact email
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  required
                />
              </label>
              <button type="submit" disabled={busy}>
                Add contact
              </button>
            </div>
          </form>
        </div>
      ) : null}
      <form onSubmit={add}>
        <h3>Add a prospect</h3>
        <div className="form-row">
          <label>
            Prospect name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Contact email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            First action due
            <input
              type="datetime-local"
              value={newDueAt}
              onChange={(event) => setNewDueAt(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Add prospect
          </button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
