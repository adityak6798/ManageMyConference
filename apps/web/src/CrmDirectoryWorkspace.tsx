/*
 * The organization-wide speaker directory.
 *
 * Deliberately a second workspace rather than a tab inside the event CRM. The pipeline answers
 * "who is stuck on this event"; this answers "who do we know", and the two have different
 * scopes, different authorization and different natural filters. Putting them on one surface
 * would have made the event switcher silently change the meaning of a cross-event list.
 *
 * The surface reads the organization from the selected event and asks the server for it. If
 * this identity may not see that organization's directory, the server refuses and the refusal
 * is rendered in place of the list — the workspace does not try to predict the answer, because
 * the rule (`crm:manage` earned inside *this* organization) needs data the browser does not have.
 *
 * Sourcing a contact into an event and sending outreach both target the event currently
 * selected in the shell, so the event a write lands on is the one named in the switcher above
 * rather than a second, contradictable choice inside the page.
 */

import type {
  ContactFiltersDto,
  ContactSegmentDto,
  OrganizationContactDto,
  ProspectOwnerDto,
} from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CrmApiError,
  commitImport,
  createContact,
  createSegment,
  crmFieldErrors,
  getContactDashboard,
  listContacts,
  listDuplicates,
  listProspectOwners,
  listSegments,
  mergeContacts,
  previewImport,
  previewOutreach,
  pushContactToEvent,
  sendOutreach,
  updateContact,
} from "./api/crm";
import "./styles/crm.css";
import { IconCheck, IconPlus, IconSend, IconSpeakers, IconWarning } from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Stat } from "./ui/primitives";
import { useActionFeedback } from "./ui/primitives";

type Dashboard = Awaited<ReturnType<typeof getContactDashboard>>;
type ImportPreview = Awaited<ReturnType<typeof previewImport>>;
type DuplicateGroup = Awaited<ReturnType<typeof listDuplicates>>[number];
type OutreachPreview = Awaited<ReturnType<typeof previewOutreach>>;

/** The filter form's own shape: every control is a string, which is what a form can hold. */
interface FilterForm {
  search: string;
  company: string;
  title: string;
  tags: string;
  fieldKey: string;
  fieldValue: string;
}
const EMPTY_FILTERS: FilterForm = {
  search: "",
  company: "",
  title: "",
  tags: "",
  fieldKey: "",
  fieldValue: "",
};

/** The form as the API reads it: blank controls are absent criteria, not empty ones. */
function toFilters(form: FilterForm): ContactFiltersDto {
  const tags = form.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    ...(form.search.trim() ? { search: form.search.trim() } : {}),
    ...(form.company.trim() ? { company: form.company.trim() } : {}),
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    ...(tags.length ? { tags } : {}),
    ...(form.fieldKey.trim() ? { fieldKey: form.fieldKey.trim() } : {}),
    ...(form.fieldValue.trim() ? { fieldValue: form.fieldValue.trim() } : {}),
  };
}

/** A saved view reopened: its stored definition rendered back into the form controls. */
function fromFilters(filters: ContactFiltersDto): FilterForm {
  return {
    search: filters.search ?? "",
    company: filters.company ?? "",
    title: filters.title ?? "",
    tags: (filters.tags ?? []).join(", "),
    fieldKey: filters.fieldKey ?? "",
    fieldValue: filters.fieldValue ?? "",
  };
}

const stampedTime = (instant: string) =>
  new Date(instant).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function readCrmError(reason: unknown, fallback: string) {
  if (reason instanceof CrmApiError) return `${reason.message} Reference: ${reason.correlationId}`;
  return reason instanceof Error ? reason.message : fallback;
}

// @spec PRD-CRM-001
export function CrmDirectoryWorkspace({
  organizationId,
  eventId,
  eventName,
  ownerId,
}: {
  organizationId: string;
  eventId: string;
  eventName: string;
  ownerId: string;
}) {
  const loadSequence = useRef(0);
  const [contacts, setContacts] = useState<OrganizationContactDto[]>([]);
  const [segments, setSegments] = useState<ContactSegmentDto[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [owners, setOwners] = useState<ProspectOwnerDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<FilterForm>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<ContactFiltersDto>({});
  const [segmentId, setSegmentId] = useState("");
  const [segmentName, setSegmentName] = useState("");

  const [selectedId, setSelectedId] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [notes, setNotes] = useState("");
  const [note, setNote] = useState("");
  const [pushOwner, setPushOwner] = useState(ownerId);
  const [convertOnPush, setConvertOnPush] = useState(false);

  const [composing, setComposing] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newEmailErrors, setNewEmailErrors] = useState<string[]>([]);

  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("speakers.csv");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[] | null>(null);
  const [templateKey, setTemplateKey] = useState("speaker-invite");
  const [outreach, setOutreach] = useState<OutreachPreview | null>(null);

  const directoryFeedback = useActionFeedback();
  const detailFeedback = useActionFeedback();

  const reload = useCallback(
    async (filters: ContactFiltersDto, savedView: string) => {
      const sequence = ++loadSequence.current;
      const [list, savedViews, metrics, staff] = await Promise.all([
        listContacts(organizationId, savedView ? { segmentId: savedView } : filters),
        listSegments(organizationId),
        getContactDashboard(organizationId),
        listProspectOwners(eventId),
      ]);
      // A response that lands after the organizer changed organization describes the old one.
      if (sequence !== loadSequence.current) return;
      setContacts([...list.contacts]);
      setApplied(list.filters);
      setSegments([...savedViews]);
      setDashboard(metrics);
      setOwners([...staff]);
      setPushOwner((current) =>
        staff.some(({ id }) => id === current)
          ? current
          : (staff.find(({ id }) => id === ownerId)?.id ?? staff[0]?.id ?? current),
      );
    },
    [organizationId, eventId, ownerId],
  );

  useEffect(() => {
    let active = true;
    setError("");
    setLoading(true);
    setSelectedId("");
    setChosen([]);
    setDuplicates(null);
    setPreview(null);
    setOutreach(null);
    // ERROR-INTENT: React effects cannot await; both outcomes are rendered below.
    void reload({}, "")
      .catch((reason: unknown) => {
        if (active) setError(readCrmError(reason, "Could not load the speaker directory."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      loadSequence.current += 1;
    };
  }, [reload]);

  const selected = contacts.find(({ id }) => id === selectedId);
  const activeSegment = segments.find(({ id }) => id === segmentId);
  const filtered = Object.keys(applied).length > 0;

  const timeline = useMemo(
    () =>
      [...(selected?.activities ?? [])].sort(
        (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
      ),
    [selected],
  );

  async function guard(work: () => Promise<string>, feedback: typeof directoryFeedback) {
    setBusy(true);
    try {
      feedback.announce("success", await work());
    } catch (reason) {
      feedback.announce("error", readCrmError(reason, "That action could not be completed."));
    } finally {
      setBusy(false);
    }
  }

  async function applyFilters(formEvent: FormEvent) {
    formEvent.preventDefault();
    setSegmentId("");
    await guard(async () => {
      await reload(toFilters(form), "");
      return "Directory filtered.";
    }, directoryFeedback);
  }

  async function clearFilters() {
    setForm(EMPTY_FILTERS);
    setSegmentId("");
    await guard(async () => {
      await reload({}, "");
      return "Filters cleared. Showing every contact.";
    }, directoryFeedback);
  }

  async function openSegment(id: string) {
    setSegmentId(id);
    const saved = segments.find((segment) => segment.id === id);
    // A saved view reopens from its stored definition, so the controls show what it selects.
    setForm(saved ? fromFilters(saved.filters) : EMPTY_FILTERS);
    await guard(async () => {
      await reload(saved ? saved.filters : {}, id);
      return saved ? `Opened the saved view "${saved.name}".` : "Showing every contact.";
    }, directoryFeedback);
  }

  async function saveSegment(formEvent: FormEvent) {
    formEvent.preventDefault();
    await guard(async () => {
      const saved = await createSegment(organizationId, {
        name: segmentName,
        filters: toFilters(form),
      });
      setSegmentName("");
      setSegmentId(saved.id);
      await reload(saved.filters, saved.id);
      return `Saved "${saved.name}" as a reusable view.`;
    }, directoryFeedback);
  }

  async function add(formEvent: FormEvent) {
    formEvent.preventDefault();
    setNewEmailErrors([]);
    setBusy(true);
    try {
      const created = await createContact(organizationId, {
        name: newName,
        email: newEmail,
        ...(newCompany ? { company: newCompany } : {}),
      });
      setNewName("");
      setNewEmail("");
      setNewCompany("");
      setComposing(false);
      await reload(applied, segmentId);
      directoryFeedback.announce("success", `${created.name} added to the directory.`);
    } catch (reason) {
      setNewEmailErrors(crmFieldErrors(reason).email ?? []);
      directoryFeedback.announce("error", readCrmError(reason, "Could not add the contact."));
    } finally {
      setBusy(false);
    }
  }

  function open(contact: OrganizationContactDto) {
    setSelectedId(contact.id);
    setNotes(contact.notes ?? "");
    setNote("");
    setConvertOnPush(false);
    detailFeedback.clear();
  }

  async function saveProfile(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!selected) return;
    await guard(async () => {
      await updateContact(organizationId, selected.id, {
        notes: notes.trim() ? notes.trim() : null,
        ...(note.trim() ? { activity: { kind: "note", summary: note.trim(), private: true } } : {}),
      });
      setNote("");
      await reload(applied, segmentId);
      return `Saved ${selected.name}'s profile.`;
    }, detailFeedback);
  }

  async function sourceIntoEvent() {
    if (!selected) return;
    await guard(async () => {
      const result = await pushContactToEvent(organizationId, selected.id, {
        eventId,
        ownerId: pushOwner,
        convert: convertOnPush,
      });
      await reload(applied, segmentId);
      return convertOnPush && result.prospect.speakerId
        ? `${selected.name} is now a speaker on ${eventName}.`
        : `${selected.name} is in the ${eventName} pipeline.`;
    }, detailFeedback);
  }

  async function runImportPreview(formEvent: FormEvent) {
    formEvent.preventDefault();
    await guard(async () => {
      const result = await previewImport(organizationId, { filename, csv });
      setPreview(result);
      return `${result.summary.create} to add, ${result.summary.update} to update, ${result.summary.skip} refused.`;
    }, directoryFeedback);
  }

  async function runImport() {
    await guard(async () => {
      const result = await commitImport(organizationId, { filename, csv });
      setPreview(null);
      setCsv("");
      await reload(applied, segmentId);
      return `Imported ${result.import.createdCount} new and updated ${result.import.updatedCount} contacts.`;
    }, directoryFeedback);
  }

  async function findDuplicates() {
    await guard(async () => {
      const groups = await listDuplicates(organizationId);
      setDuplicates([...groups]);
      return groups.length
        ? `${groups.length} possible duplicate group${groups.length === 1 ? "" : "s"} found.`
        : "No near duplicates found.";
    }, directoryFeedback);
  }

  async function merge(group: DuplicateGroup) {
    await guard(async () => {
      const survivor = await mergeContacts(organizationId, {
        primaryId: group.suggestedPrimaryId,
        duplicateIds: group.contactIds.filter((id) => id !== group.suggestedPrimaryId),
      });
      setDuplicates(null);
      await reload(applied, segmentId);
      return `Merged into ${survivor.name}. The other addresses are kept as aliases.`;
    }, directoryFeedback);
  }

  /** Either the open saved view, or whichever rows were ticked. Never both. */
  const outreachTarget = () =>
    segmentId
      ? { segmentId }
      : { contactIds: chosen.length ? chosen : contacts.map(({ id }) => id) };

  async function runOutreachPreview() {
    await guard(async () => {
      const result = await previewOutreach(organizationId, {
        eventId,
        templateKey,
        ...outreachTarget(),
      });
      setOutreach(result);
      return `${result.recipients.length} recipient${result.recipients.length === 1 ? "" : "s"} would be contacted.`;
    }, directoryFeedback);
  }

  async function runOutreach() {
    await guard(async () => {
      const result = await sendOutreach(organizationId, {
        eventId,
        templateKey,
        ...outreachTarget(),
      });
      setOutreach(null);
      await reload(applied, segmentId);
      return `Queued ${result.sent.length} message${result.sent.length === 1 ? "" : "s"} through communications.`;
    }, directoryFeedback);
  }

  if (error)
    return (
      <Card>
        <EmptyState
          title="The speaker directory could not be loaded"
          icon={<IconWarning size={20} />}
        >
          {error}
        </EmptyState>
      </Card>
    );

  return (
    <div className="crm">
      <dl className="grid-auto">
        <Stat
          label="Contacts"
          value={loading || !dashboard ? "—" : dashboard.contacts}
          hint="Across every event in this organization"
          icon={<IconSpeakers size={15} />}
        />
        <Stat
          label="At more than one event"
          value={loading || !dashboard ? "—" : dashboard.contactsInMultipleEvents}
          hint="Held once, with every history"
        />
        <Stat
          label="Converted to speakers"
          value={loading || !dashboard ? "—" : dashboard.convertedContacts}
          hint="Through the conversion boundary"
          icon={<IconCheck size={15} />}
        />
        <Stat
          label="Possible duplicates"
          value={loading || !dashboard ? "—" : dashboard.duplicateGroups}
          hint={dashboard?.duplicateGroups ? "Review and merge" : "Nothing to reconcile"}
          attention={Boolean(dashboard?.duplicateGroups)}
        />
      </dl>

      <div className="split">
        <Card
          labelledBy="crm-directory"
          title="Speaker directory"
          hint="Everybody this organization knows, across all of its events."
          actions={
            <button
              type="button"
              className="secondary"
              aria-expanded={composing}
              onClick={() => setComposing((open) => !open)}
            >
              <IconPlus size={15} />
              {composing ? "Close new contact" : "New contact"}
            </button>
          }
          tight
        >
          <div className="crm-toolbar-row">
            {composing ? (
              <form className="crm-create" onSubmit={add}>
                <div className="grid-auto">
                  <div className="field">
                    <label htmlFor="crm-contact-new-name">Contact name</label>
                    <input
                      id="crm-contact-new-name"
                      value={newName}
                      onChange={(changeEvent) => setNewName(changeEvent.target.value)}
                      required
                      maxLength={160}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="crm-contact-new-email">Contact email</label>
                    <input
                      id="crm-contact-new-email"
                      type="email"
                      value={newEmail}
                      onChange={(changeEvent) => {
                        setNewEmail(changeEvent.target.value);
                        setNewEmailErrors([]);
                      }}
                      aria-invalid={Boolean(newEmailErrors.length)}
                      aria-describedby={
                        newEmailErrors.length ? "crm-contact-new-email-error" : undefined
                      }
                      required
                    />
                    {newEmailErrors.length ? (
                      <p className="error-text" id="crm-contact-new-email-error">
                        {newEmailErrors.join(" ")}
                      </p>
                    ) : null}
                  </div>
                  <div className="field">
                    <label htmlFor="crm-contact-new-company">Company</label>
                    <input
                      id="crm-contact-new-company"
                      value={newCompany}
                      onChange={(changeEvent) => setNewCompany(changeEvent.target.value)}
                      maxLength={160}
                    />
                  </div>
                </div>
                <div className="crm-form-actions">
                  <button type="submit" disabled={busy}>
                    Add contact
                  </button>
                  <button type="button" className="secondary" onClick={() => setComposing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            {directoryFeedback.node}

            <form onSubmit={applyFilters} aria-label="Directory filters">
              <div className="grid-auto">
                <div className="field">
                  <label htmlFor="crm-directory-search">Search directory</label>
                  <input
                    id="crm-directory-search"
                    type="search"
                    value={form.search}
                    onChange={(changeEvent) =>
                      setForm({ ...form, search: changeEvent.target.value })
                    }
                    placeholder="Name, email, or a merged address"
                  />
                </div>
                <div className="field">
                  <label htmlFor="crm-directory-company">Company</label>
                  <input
                    id="crm-directory-company"
                    value={form.company}
                    onChange={(changeEvent) =>
                      setForm({ ...form, company: changeEvent.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="crm-directory-title">Title</label>
                  <input
                    id="crm-directory-title"
                    value={form.title}
                    onChange={(changeEvent) =>
                      setForm({ ...form, title: changeEvent.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="crm-directory-tags">Tags</label>
                  <input
                    id="crm-directory-tags"
                    value={form.tags}
                    onChange={(changeEvent) => setForm({ ...form, tags: changeEvent.target.value })}
                    placeholder="keynote, accessibility"
                  />
                  <p className="hint">Comma separated. A contact must carry every tag listed.</p>
                </div>
                <div className="field">
                  <label htmlFor="crm-directory-field-key">Custom field</label>
                  <input
                    id="crm-directory-field-key"
                    value={form.fieldKey}
                    onChange={(changeEvent) =>
                      setForm({ ...form, fieldKey: changeEvent.target.value })
                    }
                    placeholder="topic"
                  />
                </div>
                <div className="field">
                  <label htmlFor="crm-directory-field-value">Custom field value</label>
                  <input
                    id="crm-directory-field-value"
                    value={form.fieldValue}
                    onChange={(changeEvent) =>
                      setForm({ ...form, fieldValue: changeEvent.target.value })
                    }
                  />
                </div>
              </div>
              <div className="crm-form-actions">
                <button type="submit" disabled={busy}>
                  Apply filters
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; clearFilters announces both outcomes.
                    void clearFilters();
                  }}
                >
                  Clear filters
                </button>
              </div>
            </form>

            <div className="toolbar">
              <div className="field">
                <label htmlFor="crm-directory-segment">Saved views</label>
                <select
                  id="crm-directory-segment"
                  value={segmentId}
                  onChange={(changeEvent) => {
                    // ERROR-INTENT: handlers cannot await; openSegment announces both outcomes.
                    void openSegment(changeEvent.target.value);
                  }}
                >
                  <option value="">All contacts</option>
                  {segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.name}
                    </option>
                  ))}
                </select>
              </div>
              <form onSubmit={saveSegment} className="field">
                <label htmlFor="crm-directory-segment-name">Save this view as</label>
                <input
                  id="crm-directory-segment-name"
                  value={segmentName}
                  onChange={(changeEvent) => setSegmentName(changeEvent.target.value)}
                  placeholder="Keynote shortlist"
                  maxLength={80}
                />
                <button type="submit" className="secondary" disabled={busy || !segmentName.trim()}>
                  Save this view
                </button>
              </form>
            </div>
          </div>

          {loading ? (
            <div className="crm-skeletons">
              <div aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="skeleton" style={{ height: 44 }} />
                ))}
              </div>
              <p className="visually-hidden" role="status">
                Loading the speaker directory.
              </p>
            </div>
          ) : contacts.length === 0 ? (
            <EmptyState
              title={filtered ? "No contacts match these filters" : "No contacts yet"}
              icon={<IconSpeakers size={20} />}
              action={
                filtered ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      // ERROR-INTENT: handlers cannot await; clearFilters announces both outcomes.
                      void clearFilters();
                    }}
                  >
                    Clear filters
                  </button>
                ) : (
                  <button type="button" onClick={() => setComposing(true)}>
                    <IconPlus size={15} />
                    New contact
                  </button>
                )
              }
            >
              {filtered
                ? "Nobody carries every criterion above. Clear the filters to see the whole directory."
                : "Add somebody, or import a spreadsheet, to start the organization's speaker database."}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data crm-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="visually-hidden">Select for outreach</span>
                    </th>
                    <th scope="col">Contact</th>
                    <th scope="col">Company</th>
                    <th scope="col">Tags</th>
                    <th scope="col">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((contact) => (
                    <tr
                      key={contact.id}
                      className={contact.id === selectedId ? "is-selected" : undefined}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${contact.name} for outreach`}
                          checked={chosen.includes(contact.id)}
                          onChange={(changeEvent) =>
                            setChosen((current) =>
                              changeEvent.target.checked
                                ? [...current, contact.id]
                                : current.filter((id) => id !== contact.id),
                            )
                          }
                        />
                      </td>
                      <td className="primary-cell">
                        <button
                          type="button"
                          className="ghost crm-row-open"
                          aria-current={contact.id === selectedId ? "true" : undefined}
                          onClick={() => open(contact)}
                        >
                          {contact.name}
                        </button>
                        <span className="sub">{contact.email}</span>
                      </td>
                      <td>
                        {contact.company ?? "—"}
                        {contact.title ? <span className="sub">{contact.title}</span> : null}
                      </td>
                      <td>
                        {contact.tags.length
                          ? contact.tags.map((tag) => (
                              <Pill key={tag} tone="info">
                                {tag}
                              </Pill>
                            ))
                          : "—"}
                      </td>
                      <td>
                        {contact.events.length}
                        {contact.events.some(({ speakerId }) => speakerId) ? (
                          <span className="sub">Speaker linked</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <section aria-labelledby="crm-directory-tools">
            <h3 id="crm-directory-tools">Directory tools</h3>

            <details className="crm-details">
              <summary>Import contacts from a spreadsheet</summary>
              <form onSubmit={runImportPreview}>
                <div className="field">
                  <label htmlFor="crm-import-filename">File name</label>
                  <input
                    id="crm-import-filename"
                    value={filename}
                    onChange={(changeEvent) => setFilename(changeEvent.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="field">
                  <label htmlFor="crm-import-csv">Paste CSV</label>
                  <textarea
                    id="crm-import-csv"
                    value={csv}
                    onChange={(changeEvent) => setCsv(changeEvent.target.value)}
                    rows={4}
                    placeholder="name,email,company,title,tags"
                  />
                  <p className="hint">
                    A header row with at least name and email. Optional: company, title, notes, tags
                    (semicolon separated), and any <code>field:key</code> column.
                  </p>
                </div>
                <button type="submit" className="secondary" disabled={busy || !csv.trim()}>
                  Preview import
                </button>
              </form>
              {preview ? (
                <>
                  <table className="data">
                    <caption>
                      {preview.summary.create} to add, {preview.summary.update} to update,{" "}
                      {preview.summary.skip} refused
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Line</th>
                        <th scope="col">Contact</th>
                        <th scope="col">Action</th>
                        <th scope="col">Why not</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.line}>
                          <td>{row.line}</td>
                          <td>
                            {row.name || "—"}
                            <span className="sub">{row.email}</span>
                          </td>
                          <td>
                            <Pill tone={row.action === "skip" ? "danger" : "ok"}>{row.action}</Pill>
                          </td>
                          <td>{row.errors.join(" ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.notices.map((notice) => (
                    <p className="hint" key={notice}>
                      {notice}
                    </p>
                  ))}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // ERROR-INTENT: handlers cannot await; runImport announces both outcomes.
                      void runImport();
                    }}
                  >
                    Import contacts
                  </button>
                </>
              ) : null}
            </details>

            <details className="crm-details">
              <summary>Find and merge duplicates</summary>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  // ERROR-INTENT: handlers cannot await; findDuplicates announces both outcomes.
                  void findDuplicates();
                }}
              >
                Review duplicates
              </button>
              {duplicates?.length ? (
                <ul className="crm-contacts">
                  {duplicates.map((group) => {
                    const members = group.contactIds
                      .map((id) => contacts.find((contact) => contact.id === id))
                      .filter(Boolean);
                    const primary = members.find(
                      (contact) => contact?.id === group.suggestedPrimaryId,
                    );
                    return (
                      <li key={group.key}>
                        <span className="crm-contact-name">
                          {members.map((contact) => contact?.email).join(" and ")}
                        </span>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            // ERROR-INTENT: handlers cannot await; merge announces both outcomes.
                            void merge(group);
                          }}
                        >
                          Merge into {primary?.email ?? "the oldest record"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : duplicates ? (
                <p className="crm-help">No near duplicates found.</p>
              ) : null}
            </details>

            <details className="crm-details">
              <summary>Send outreach through communications</summary>
              <div className="field">
                <label htmlFor="crm-outreach-template">Template key</label>
                <input
                  id="crm-outreach-template"
                  value={templateKey}
                  onChange={(changeEvent) => setTemplateKey(changeEvent.target.value)}
                  maxLength={80}
                />
                <p className="hint">
                  {activeSegment
                    ? `Sends to everybody in "${activeSegment.name}".`
                    : chosen.length
                      ? `Sends to the ${chosen.length} selected contact${chosen.length === 1 ? "" : "s"}.`
                      : "Sends to every contact in the list above."}{" "}
                  Delivery is recorded against {eventName}.
                </p>
              </div>
              <div className="crm-form-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; the preview announces both outcomes.
                    void runOutreachPreview();
                  }}
                >
                  Preview outreach
                </button>
                {outreach ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // ERROR-INTENT: handlers cannot await; runOutreach announces both outcomes.
                      void runOutreach();
                    }}
                  >
                    <IconSend size={15} />
                    Send to {outreach.recipients.length}
                  </button>
                ) : null}
              </div>
              {outreach ? (
                <ul className="crm-contacts">
                  {outreach.recipients.map((recipient) => (
                    <li key={recipient.contactId}>
                      <span className="crm-contact-name">{recipient.name}</span>
                      <span>{recipient.email}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          </section>
        </Card>

        {selected ? (
          <Card
            labelledBy="crm-contact-detail"
            title={selected.name}
            hint={selected.company ?? "No company recorded"}
            actions={
              <button type="button" className="ghost" onClick={() => setSelectedId("")}>
                Close
              </button>
            }
          >
            <div className="crm-detail">
              {detailFeedback.node}

              <section aria-labelledby="crm-contact-identity">
                <h3 id="crm-contact-identity">Identity</h3>
                <ul className="crm-contacts">
                  <li>
                    <a href={`mailto:${selected.email}`}>{selected.email}</a>
                    <Pill tone="info">Primary</Pill>
                  </li>
                  {selected.aliases.map((alias) => (
                    <li key={alias.id}>
                      <span>{alias.email}</span>
                      <Pill tone="neutral">Merged {stampedTime(alias.mergedAt)}</Pill>
                    </li>
                  ))}
                </ul>
                {selected.fields.length ? (
                  <dl className="grid-auto">
                    {selected.fields.map((field) => (
                      <div key={field.key}>
                        <dt>{field.key}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </section>

              <section aria-labelledby="crm-contact-notes">
                <h3 id="crm-contact-notes">Internal notes</h3>
                <form onSubmit={saveProfile}>
                  <div className="field">
                    <label htmlFor="crm-contact-notes-field">Notes</label>
                    <textarea
                      id="crm-contact-notes-field"
                      value={notes}
                      onChange={(changeEvent) => setNotes(changeEvent.target.value)}
                      rows={3}
                      maxLength={4000}
                    />
                    <p className="hint">
                      Kept on the contact across every event, and never published.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="crm-contact-note">Add to the timeline</label>
                    <input
                      id="crm-contact-note"
                      value={note}
                      onChange={(changeEvent) => setNote(changeEvent.target.value)}
                      maxLength={1000}
                    />
                  </div>
                  <button type="submit" disabled={busy}>
                    Save profile
                  </button>
                </form>
              </section>

              <section aria-labelledby="crm-contact-events">
                <h3 id="crm-contact-events">Event history</h3>
                {selected.events.length ? (
                  <ul className="crm-contacts">
                    {selected.events.map((link) => (
                      <li key={link.eventId}>
                        <span className="crm-contact-name">
                          {link.eventId === eventId ? eventName : link.eventId}
                        </span>
                        <Pill tone={link.speakerId ? "ok" : "info"}>{link.stage}</Pill>
                        {link.speakerId ? <span className="sub">Speaker linked</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="crm-help">Not yet courted for any event.</p>
                )}

                <div className="field">
                  <label htmlFor="crm-contact-push-owner">Owner on {eventName}</label>
                  <select
                    id="crm-contact-push-owner"
                    value={pushOwner}
                    onChange={(changeEvent) => setPushOwner(changeEvent.target.value)}
                  >
                    {owners.map((owner) => (
                      <option key={owner.id} value={owner.id}>
                        {owner.id === ownerId ? `${owner.name} (you)` : owner.name}
                      </option>
                    ))}
                  </select>
                  <p className="hint">Only organizers and reviewers on that event can own it.</p>
                </div>
                <div className="field">
                  <label htmlFor="crm-contact-convert">
                    <input
                      id="crm-contact-convert"
                      type="checkbox"
                      checked={convertOnPush}
                      onChange={(changeEvent) => setConvertOnPush(changeEvent.target.checked)}
                    />
                    Convert to a speaker straight away
                  </label>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    // ERROR-INTENT: handlers cannot await; sourceIntoEvent announces both outcomes.
                    void sourceIntoEvent();
                  }}
                >
                  <IconPlus size={15} />
                  Add to {eventName}
                </button>
              </section>

              <section aria-labelledby="crm-contact-timeline">
                <h3 id="crm-contact-timeline">Activity timeline</h3>
                {timeline.length ? (
                  <ol className="crm-timeline">
                    {timeline.map((activity) => (
                      <li key={activity.id}>
                        <div className="crm-timeline-head">
                          <Pill tone="neutral">{activity.kind}</Pill>
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
                  <p className="crm-help">Nothing recorded yet.</p>
                )}
              </section>
            </div>
          </Card>
        ) : (
          <Card labelledBy="crm-contact-empty" title="Contact profile">
            <EmptyState title="Select a contact" icon={<IconSpeakers size={20} />}>
              Open a name from the directory to see its notes, custom fields, event history across
              the organization, and the action that sources it into an event.
            </EmptyState>
          </Card>
        )}
      </div>

      {dashboard && dashboard.topCompanies.length > 0 ? (
        <Card labelledBy="crm-directory-metrics" title="Where this organization's speakers work">
          <table className="data">
            <caption>Counted over the contacts stored above.</caption>
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col" className="num">
                  Contacts
                </th>
              </tr>
            </thead>
            <tbody>
              {dashboard.topCompanies.map((row) => (
                <tr key={row.company}>
                  <td>{row.company}</td>
                  <td className="num">{row.contacts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {dashboard && !loading ? (
        <Notice tone="info">
          <span>
            {dashboard.imported} contact{dashboard.imported === 1 ? "" : "s"} arrived by import, and{" "}
            {dashboard.segments} saved view{dashboard.segments === 1 ? "" : "s"} are available.
          </span>
        </Notice>
      ) : null}
    </div>
  );
}
