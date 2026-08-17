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
  CrmCampaignDto,
  OrganizationContactDto,
  ProspectOwnerDto,
} from "@greenroom/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commitImport,
  createContact,
  createCrmCampaign,
  cancelCrmCampaign,
  createSegment,
  crmFieldErrors,
  getContactDashboard,
  listContacts,
  listCrmCampaigns,
  listDuplicates,
  listProspectOwners,
  listSegments,
  mergeContacts,
  launchCrmCampaign,
  previewImport,
  previewOutreach,
  pushContactToEvent,
  sendOutreach,
  updateContact,
} from "./api/crm";
import { type ApiFailure, describeApiFailure } from "./api/config";
import { Inspector } from "./crm/inspector";
import "./styles/crm.css";
import { Checkbox, Select } from "./ui/fields";
import { IconCheck, IconClose, IconPlus, IconSend, IconSpeakers } from "./ui/icons";
import {
  Card,
  EmptyState,
  LoadFailure,
  Pill,
  SkeletonRows,
  Stat,
  Toolbar,
  useActionFeedback,
} from "./ui/primitives";

type Dashboard = Awaited<ReturnType<typeof getContactDashboard>>;
type ImportPreview = Awaited<ReturnType<typeof previewImport>> & {
  /** The exact input this preview describes, so the commit cannot send different bytes. */
  reviewed: { filename: string; csv: string };
};
type DuplicateGroup = Awaited<ReturnType<typeof listDuplicates>>[number];
type OutreachPreview = Awaited<ReturnType<typeof previewOutreach>> & {
  /** The exact command this preview resolved, so the send cannot target a different set. */
  reviewed: Parameters<typeof sendOutreach>[1];
};

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

/** What each criterion is called on screen, so an active one can be shown and taken off again. */
const CRITERION_LABELS: Record<keyof FilterForm, string> = {
  search: "Search",
  company: "Company",
  title: "Title",
  tags: "Tags",
  fieldKey: "Custom field",
  fieldValue: "Custom field value",
};

/**
 * The criteria actually in force, read from the server's echo rather than from the controls.
 *
 * The form holds what somebody has typed; this is what the list in front of them was filtered
 * by, which is the only thing worth showing as a removable chip.
 */
function activeCriteria(
  filters: ContactFiltersDto,
): { key: keyof FilterForm; label: string; value: string }[] {
  const active: { key: keyof FilterForm; label: string; value: string }[] = [];
  const add = (key: keyof FilterForm, value: string | undefined) => {
    if (value) active.push({ key, label: CRITERION_LABELS[key], value });
  };
  add("search", filters.search);
  add("company", filters.company);
  add("title", filters.title);
  add("tags", filters.tags?.length ? filters.tags.join(", ") : undefined);
  add("fieldKey", filters.fieldKey);
  add("fieldValue", filters.fieldValue);
  return active;
}

/** The same criteria with one taken off, so removing a chip is a filter rather than a reset. */
function withoutCriterion(filters: ContactFiltersDto, key: keyof FilterForm): ContactFiltersDto {
  const { [key]: _removed, ...rest } = filters as Record<string, unknown>;
  return rest as ContactFiltersDto;
}

const stampedTime = (instant: string) =>
  new Date(instant).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/*
 * The reference travels beside the sentence, never inside it.
 *
 * This used to answer "…could not be saved. Reference: 01JD…", which buries the one value the
 * reader is asked to quote in the one part of the message nobody reads character by character.
 * `Notice`, `LoadFailure` and `useActionFeedback` all take an `ApiFailure` and render its
 * reference as a selectable measure with its own copy control.
 */
const readCrmError = (reason: unknown, fallback: string) => describeApiFailure(reason, fallback);

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
  const [error, setError] = useState<ApiFailure | null>(null);
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
  const [campaigns, setCampaigns] = useState<CrmCampaignDto[]>([]);
  const [campaignName, setCampaignName] = useState("");
  const [campaignAt, setCampaignAt] = useState("");

  const directoryFeedback = useActionFeedback();
  const detailFeedback = useActionFeedback();

  /** The debounce, and the search the last request actually carried, so it is asked once. */
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedSearch = useRef("");
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  const reload = useCallback(
    async (filters: ContactFiltersDto, savedView: string) => {
      const sequence = ++loadSequence.current;
      const [list, savedViews, metrics, staff, campaignList] = await Promise.all([
        listContacts(organizationId, savedView ? { segmentId: savedView } : filters),
        listSegments(organizationId),
        getContactDashboard(organizationId),
        listProspectOwners(eventId),
        listCrmCampaigns(organizationId),
      ]);
      // A response that lands after the organizer changed organization describes the old one.
      if (sequence !== loadSequence.current) return;
      setContacts([...list.contacts]);
      setApplied(list.filters);
      setSegments([...savedViews]);
      setDashboard(metrics);
      setOwners([...staff]);
      setCampaigns([...campaignList]);
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
    setError(null);
    setLoading(true);
    setSelectedId("");
    setChosen([]);
    setDuplicates(null);
    setPreview(null);
    setOutreach(null);
    // The filters and the open saved view are organization-scoped too. Leaving them behind meant
    // the controls described the previous organization's criteria over this one's contacts, and
    // the next mutation reloaded with a segment id this organization does not have — a 404 from
    // an action that had nothing to do with segments.
    setForm(EMPTY_FILTERS);
    setApplied({});
    setSegmentId("");
    setSegmentName("");
    // The pending search belongs to the organization that was open when it was typed.
    if (searchTimer.current) clearTimeout(searchTimer.current);
    requestedSearch.current = "";
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
  const criteria = activeCriteria(applied);
  const allChosen = contacts.length > 0 && chosen.length === contacts.length;

  /*
   * The free-text box searches as it is typed; Apply belongs to the structured criteria beside it.
   *
   * Typing a name and then hunting for a button is the pipeline's answer to the same question,
   * and this surface is the one people arrive at knowing a name. The structured criteria keep
   * their explicit Apply because company, title, tags and a custom field are composed into one
   * question before it is asked, and re-asking it on every keystroke of a six-part form would be
   * six requests describing something nobody meant.
   *
   * A search leaves any open saved view, the same way Apply does: a view is a stored definition,
   * and a list that is "the keynote shortlist, but only the Riveras" is neither.
   */
  const searchAs = (typed: string) => {
    setForm((current) => ({ ...current, search: typed }));
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const trimmed = typed.trim();
      if (trimmed === requestedSearch.current) return;
      requestedSearch.current = trimmed;
      setSegmentId("");
      // ERROR-INTENT: guard owns rejection handling and visible feedback.
      void guard(async () => {
        await reload(
          { ...withoutCriterion(applied, "search"), ...(trimmed ? { search: trimmed } : {}) },
          "",
        );
        return trimmed ? `Showing contacts matching “${trimmed}”.` : "Search cleared.";
      }, directoryFeedback);
    }, 300);
  };

  /** Taking one chip off is a narrower question, not a reset back to everybody. */
  async function removeCriterion(key: keyof FilterForm) {
    const next = withoutCriterion(applied, key);
    setForm(fromFilters(next));
    if (key === "search") requestedSearch.current = "";
    setSegmentId("");
    await guard(async () => {
      await reload(next, "");
      return `${CRITERION_LABELS[key]} filter removed.`;
    }, directoryFeedback);
  }

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
    requestedSearch.current = form.search.trim();
    await guard(async () => {
      await reload(toFilters(form), "");
      return "Directory filtered.";
    }, directoryFeedback);
  }

  async function clearFilters() {
    setForm(EMPTY_FILTERS);
    setSegmentId("");
    if (searchTimer.current) clearTimeout(searchTimer.current);
    requestedSearch.current = "";
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
    if (searchTimer.current) clearTimeout(searchTimer.current);
    requestedSearch.current = saved?.filters.search?.trim() ?? "";
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
      const reviewed = { filename, csv };
      const result = await previewImport(organizationId, reviewed);
      setPreview({ ...result, reviewed });
      return `${result.summary.create} to add, ${result.summary.update} to update, ${result.summary.skip} refused.`;
    }, directoryFeedback);
  }

  async function runImport() {
    // The exact bytes the preview described, not whatever the textarea holds now. Both inputs
    // stay editable while the table is on screen, so committing the live values meant an
    // organizer could approve one file and import another without anything saying so.
    const reviewed = preview?.reviewed;
    if (!reviewed) return;
    await guard(async () => {
      const result = await commitImport(organizationId, reviewed);
      setPreview(null);
      setCsv("");
      await reload(applied, segmentId);
      const refused = result.rejected.length
        ? ` ${result.rejected.length} row${result.rejected.length === 1 ? "" : "s"} refused.`
        : "";
      return `Imported ${result.import.createdCount} new and updated ${result.import.updatedCount} contacts.${refused}`;
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
      const reviewed = { eventId, templateKey, ...outreachTarget() };
      const result = await previewOutreach(organizationId, reviewed);
      setOutreach({ ...result, reviewed });
      return `${result.recipients.length} recipient${result.recipients.length === 1 ? "" : "s"} would be contacted.`;
    }, directoryFeedback);
  }

  async function runOutreach() {
    // The command the preview resolved, for the same reason the import commits reviewed bytes:
    // the template box, the saved view and the row checkboxes all stay live while the recipient
    // list is on screen, so rebuilding the command here could send to a different set entirely.
    const reviewed = outreach?.reviewed;
    if (!reviewed) return;
    await guard(async () => {
      const result = await sendOutreach(organizationId, reviewed);
      setOutreach(null);
      await reload(applied, segmentId);
      const queued = result.sent.filter(({ created }) => created !== false).length;
      const converged = result.sent.length - queued;
      // A repeat converges on the delivery the first send created rather than sending twice, so
      // saying "queued" for those would claim something that did not happen.
      return converged
        ? `Queued ${queued}; ${converged} already had a delivery from an earlier send.`
        : `Queued ${queued} message${queued === 1 ? "" : "s"} through communications.`;
    }, directoryFeedback);
  }

  async function saveCampaign() {
    await guard(async () => {
      await createCrmCampaign(organizationId, {
        eventId,
        name: campaignName,
        templateKey,
        ...outreachTarget(),
        ...(campaignAt ? { scheduledAt: new Date(campaignAt).toISOString() } : {}),
      });
      setCampaignName("");
      setCampaignAt("");
      await reload(applied, segmentId);
      return campaignAt ? "Campaign scheduled." : "Campaign saved as a draft.";
    }, directoryFeedback);
  }

  async function launchCampaign(campaignId: string) {
    await guard(async () => {
      await launchCrmCampaign(organizationId, campaignId);
      await reload(applied, segmentId);
      return "Campaign completed; each recipient has a durable delivery record.";
    }, directoryFeedback);
  }

  async function cancelCampaign(campaignId: string) {
    await guard(async () => {
      await cancelCrmCampaign(organizationId, campaignId);
      await reload(applied, segmentId);
      return "Campaign cancelled.";
    }, directoryFeedback);
  }

  /**
   * Preview and send, defined once and rendered in exactly one place.
   *
   * With a selection they belong in the bar that reports it; with none they stay in the
   * disclosure that explains what "everybody in the list" means. Two copies would have been two
   * controls with one accessible name, which is a worse answer than either.
   */
  const outreachActions = (
    <>
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
          className="primary"
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
    </>
  );

  if (error)
    return (
      <LoadFailure
        what="the speaker directory"
        error={error.message}
        reference={error.reference}
        onRetry={() => {
          setError(null);
          setLoading(true);
          return reload(applied, segmentId)
            .catch((reason: unknown) =>
              setError(readCrmError(reason, "Could not load the speaker directory.")),
            )
            .finally(() => setLoading(false));
        }}
      />
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
        {/*
          The panel is named for what it holds, not for the page it sits on. It used to repeat
          the page title above it word for word and then restate the subtitle underneath —
          "Speaker directory / Everybody this organization knows, across all of its events."
          directly beneath "Speaker directory / Every speaker this organization knows, across all
          of its events." — so the first thing a reader saw twice was the one thing they already
          knew. The hint now carries what the list in front of them actually is.
        */}
        <Card
          labelledBy="crm-directory"
          title="Contacts"
          hint={
            loading
              ? undefined
              : `${contacts.length} contact${contacts.length === 1 ? "" : "s"} ${
                  activeSegment
                    ? `in the saved view “${activeSegment.name}”`
                    : criteria.length
                      ? "match the criteria below"
                      : "in this organization"
                }`
          }
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
                  <button className="primary" type="submit" disabled={busy}>
                    Add contact
                  </button>
                  <button type="button" className="secondary" onClick={() => setComposing(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            {directoryFeedback.node}

            {/* Search, the open view, and the selection: the three things that decide what the
                table below is showing, in one rail above it. */}
            <Toolbar label="Directory search and views">
              <div className="field search">
                <label htmlFor="crm-directory-search">Search directory</label>
                <input
                  className="control"
                  id="crm-directory-search"
                  type="search"
                  value={form.search}
                  onChange={(changeEvent) => searchAs(changeEvent.target.value)}
                  placeholder="Name, email, or a merged address"
                />
              </div>
              {/*
                A listbox trigger, not a select. The control this replaces applied a whole stored
                filter set the instant its value changed — so a keyboard user arrowing through a
                closed list ran one request per press, each one replacing what was on screen.
              */}
              <Select
                label="Saved views"
                value={segmentId}
                onChange={(id) => {
                  // ERROR-INTENT: handlers cannot await; openSegment announces both outcomes.
                  void openSegment(id);
                }}
                options={[
                  { value: "", label: "All contacts" },
                  ...segments.map((segment) => ({ value: segment.id, label: segment.name })),
                ]}
              />
            </Toolbar>

            {/*
              Its own grid rather than `.grid-auto`.
              `.grid-auto` floors a column at 240px, which in a 725px card body resolves to two
              columns — so five criteria became three rows and the table an organizer came for
              started 380px down the panel. These are short controls; four of the five hold a
              word. At a 180px floor the same five fit two rows, and the list leads.
            */}
            <form id="crm-directory-filters" onSubmit={applyFilters} aria-label="Directory filters">
              <div className="crm-filter-grid">
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
            </form>

            {/*
              One row for everything you do with the criteria above: run them, drop them, or keep
              them. Saving a view is its own `<form>` — a name and a submit cannot be nested
              inside the filter form — so Apply reaches its form by `form=` and the three land on
              one line instead of on three.
            */}
            <div className="crm-filter-actions">
              <button
                className="primary"
                type="submit"
                form="crm-directory-filters"
                disabled={busy}
              >
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
              <form onSubmit={saveSegment} className="field crm-save-view">
                <label htmlFor="crm-directory-segment-name">Save this view as</label>
                <input
                  className="control"
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

            {/* What is actually in force, and one press to take any of it off. A filter you
                cannot see is a filter you argue with. */}
            {criteria.length ? (
              <ul className="crm-criteria" aria-label="Filters in force">
                {criteria.map((criterion) => (
                  <li key={criterion.key}>
                    <span>
                      {criterion.label}: <strong>{criterion.value}</strong>
                    </span>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      onClick={() => {
                        // ERROR-INTENT: removeCriterion announces both outcomes.
                        void removeCriterion(criterion.key);
                      }}
                    >
                      <IconClose size={16} />
                      <span className="visually-hidden">Remove the {criterion.label} filter</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {loading ? (
            <div className="crm-loading">
              <SkeletonRows rows={4} label="Loading the speaker directory" />
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
                  <button className="primary" type="button" onClick={() => setComposing(true)}>
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
            <>
              {/*
                The selection, where the selection is made. It used to be reported only inside a
                collapsed disclosure hundreds of pixels below the table, so ticking eleven rows
                and then sending was an act of faith. The bar says how many, offers the way out,
                and carries the outreach actions themselves once there is something to act on.
              */}
              <div className={chosen.length ? "crm-bulk is-active" : "crm-bulk"}>
                {/*
                  The shared box, not a bare `<input type="checkbox">`. The control tier resets
                  `appearance` on every input so the product draws its own controls, which left a
                  raw checkbox as a 13px empty square — the select-all on this bar and the tick on
                  every row below rendered as faint dots with no box, no tick and no green.
                */}
                <Checkbox
                  className="crm-bulk-all"
                  label="Select every contact in this list"
                  checked={allChosen}
                  indeterminate={chosen.length > 0 && !allChosen}
                  onChange={(checked) => setChosen(checked ? contacts.map(({ id }) => id) : [])}
                />
                {chosen.length ? (
                  <>
                    <span className="crm-bulk-count">
                      <span className="figure">{chosen.length}</span> selected
                    </span>
                    <button type="button" className="ghost small" onClick={() => setChosen([])}>
                      Clear selection
                    </button>
                    {outreachActions}
                  </>
                ) : null}
              </div>
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
                      <th scope="col" className="num">
                        Events
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      /* `aria-selected` is the shared table system's one selection treatment;
                         this workspace's local `.is-selected` said the same thing differently. */
                      <tr
                        key={contact.id}
                        aria-selected={contact.id === selectedId ? true : undefined}
                      >
                        <td className="crm-select-cell" data-label="Selected">
                          <Checkbox
                            label={
                              <span className="visually-hidden">
                                Select {contact.name} for outreach
                              </span>
                            }
                            checked={chosen.includes(contact.id)}
                            onChange={(checked) =>
                              setChosen((current) =>
                                checked
                                  ? [...current, contact.id]
                                  : current.filter((id) => id !== contact.id),
                              )
                            }
                          />
                        </td>
                        <td className="primary-cell" data-label="Contact">
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
                        <td data-label="Company">
                          {contact.company ?? "—"}
                          {contact.title ? <span className="sub">{contact.title}</span> : null}
                        </td>
                        <td data-label="Tags">
                          {contact.tags?.length
                            ? contact.tags.map((tag) => (
                                <Pill key={tag} tone="info">
                                  {tag}
                                </Pill>
                              ))
                            : "—"}
                        </td>
                        <td className="num" data-label="Events">
                          <span className="figure">{contact.events.length}</span>
                          {contact.events.some(({ speakerId }) => speakerId) ? (
                            <span className="sub">Speaker linked</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <section className="crm-directory-tools" aria-labelledby="crm-directory-tools">
            <h3 id="crm-directory-tools">Directory tools</h3>
            {/*
              What these tools have already produced, stated where they are.

              It was a blue `info` banner pinned to the bottom of the page — a tone this product
              reserves for something a reader has to act on, spent on two standing counts — and
              it read "1 saved view are available", because the verb was outside the pluralised
              span. Both figures now sit above the two disclosures that made them.
            */}
            {dashboard && !loading ? (
              <p className="hint">
                {dashboard.imported} contact{dashboard.imported === 1 ? " has" : "s have"} arrived
                by import. {dashboard.segments} saved view
                {dashboard.segments === 1 ? " is" : "s are"} available.
              </p>
            ) : null}

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
                    className="primary"
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
              {/* The same two controls the selection bar carries, rendered here only when there
                  is no selection for the bar to act on — one Preview, one Send, one place. */}
              {chosen.length ? (
                <p className="hint">
                  The preview and send controls are with your selection, above the table.
                </p>
              ) : (
                <div className="crm-form-actions">{outreachActions}</div>
              )}
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
              <div className="field">
                <label htmlFor="crm-campaign-name">Campaign name</label>
                <input
                  id="crm-campaign-name"
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                  maxLength={160}
                />
                <label htmlFor="crm-campaign-at">Schedule (optional)</label>
                <input
                  id="crm-campaign-at"
                  type="datetime-local"
                  value={campaignAt}
                  onChange={(event) => setCampaignAt(event.target.value)}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !campaignName.trim()}
                  onClick={() => {
                    // ERROR-INTENT: guard owns rejection handling and visible feedback.
                    void saveCampaign();
                  }}
                >
                  {campaignAt ? "Schedule campaign" : "Save campaign draft"}
                </button>
              </div>
              {campaigns.length ? (
                <ul className="crm-contacts">
                  {campaigns.map((campaign) => (
                    <li key={campaign.id}>
                      <span className="crm-contact-name">{campaign.name}</span>
                      <span>
                        {campaign.state}
                        {campaign.scheduledAt
                          ? ` · ${new Date(campaign.scheduledAt).toLocaleString()}`
                          : ""}
                      </span>
                      {campaign.state === "draft" ? (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => {
                            // ERROR-INTENT: guard owns rejection handling and visible feedback.
                            void launchCampaign(campaign.id);
                          }}
                        >
                          Launch
                        </button>
                      ) : null}
                      {campaign.state === "draft" || campaign.state === "scheduled" ? (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => {
                            // ERROR-INTENT: guard owns rejection handling and visible feedback.
                            void cancelCampaign(campaign.id);
                          }}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          </section>
        </Card>

        {/* Opening a contact moves focus into the panel and the panel stays in view: a sticky
            column with its own scroll, and a drawer once the split has collapsed. */}
        <Inspector
          open={Boolean(selected)}
          focusKey={selectedId}
          labelledBy="crm-contact-detail"
          title={selected ? selected.name : "Contact profile"}
          {...(selected ? { hint: selected.company ?? "No company recorded" } : {})}
          closeLabel="Close contact"
          onClose={() => setSelectedId("")}
        >
          {selected ? (
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
                {selected.fields?.length ? (
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
                  <button className="primary" type="submit" disabled={busy}>
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
                <Checkbox
                  id="crm-contact-convert"
                  label="Convert to a speaker straight away"
                  checked={convertOnPush}
                  onChange={setConvertOnPush}
                />
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
          ) : (
            <EmptyState title="Select a contact" icon={<IconSpeakers size={20} />}>
              Open a name from the directory to see its notes, custom fields, event history across
              the organization, and the action that sources it into an event.
            </EmptyState>
          )}
        </Inspector>
      </div>

      {/*
        The one table on this surface that is nothing but a measure and its name, so it is the
        one that takes the cue gutter: the count leads in the 56px monospace column, the company
        follows the spine. It used to be a company column with the figure pushed to the far right
        edge of a 1150px card — the two halves of one fact a page apart — under a `<caption>`,
        which centres by default and so sat centred over left-aligned columns beneath a
        left-aligned heading. The sentence is the card's hint now, where the other cards keep
        theirs.
      */}
      {dashboard && dashboard.topCompanies.length > 0 ? (
        <Card
          labelledBy="crm-directory-metrics"
          title="Where this organization's speakers work"
          hint="Counted over the contacts stored above."
        >
          <table className="data">
            <caption className="visually-hidden">Contacts held per company, largest first</caption>
            <thead>
              <tr>
                <th scope="col" className="gutter">
                  Contacts
                </th>
                <th scope="col">Company</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.topCompanies.map((row) => (
                <tr key={row.company}>
                  <td className="gutter" data-label="Contacts">
                    <span className="figure">{row.contacts}</span>
                  </td>
                  <td className="primary-cell" data-label="Company">
                    {row.company}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
