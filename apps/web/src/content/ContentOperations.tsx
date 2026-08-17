/*
 * The occasional jobs of Sessions & speakers: authoring, imports, batch assignment and history.
 *
 * These used to be a four-column `grid-auto` band above the dashboard (#144). Equal-width columns
 * were the wrong container for all four: the columns hold jobs with different frequencies and
 * wildly different natural heights, so "Import speakers" left ~390px of dead space beside a
 * "Speaker workflow" column that stacked a full form per speaker and grew without bound.
 *
 * They are now full-width disclosures, closed by default and below the dashboard. Each opens in
 * one deliberate action, none reserves height it is not using, and nothing here renders a form
 * per row — Speaker workflow edits the one speaker chosen, so the panel is O(1) in roster size.
 */

import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  bulkRequestSpeakerTasks,
  configureContentWorkflowStatuses,
  createProfileShare,
  draftProfileRemix,
  importSpeakerCsv,
  listProfileShares,
  restoreContentRevision,
  revokeProfileShare,
  setProfileCollaborators,
  updateSpeakerWorkflow,
} from "../api/content";
import { IconClock, IconSearch, IconSpeakers } from "../ui/icons";
import { EmptyState, Notice, useActionFeedback } from "../ui/primitives";
import { AccelEventsSync } from "./AccelEventsSync";
import { ChecklistEditor } from "./ChecklistEditor";
import { DeliverableTracker } from "./DeliverableTracker";
import { ResourceEditor } from "./ResourceEditor";
import { memberName, type Run, SOCIAL_PLATFORMS, shortDateTime, type Workspace } from "./shared";

/**
 * One collapsed job.
 *
 * A native `<details>` rather than a state-driven panel: the disclosure keyboard behaviour, the
 * expanded state exposed to assistive technology, and the closed-by-default rendering all come
 * from the element. The heading inside the summary keeps the surface navigable by heading, which
 * is how the tools were reachable when each was a Card.
 */
function ToolPanel({
  title,
  hint,
  nested = false,
  children,
}: {
  title: string;
  hint?: string;
  /** A disclosure inside a disclosure: same behaviour, no second border. */
  nested?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="tool-panel">
      <summary>
        <span className="tool-heading">
          {nested ? <h4>{title}</h4> : <h3>{title}</h3>}
          {hint ? <span className="hint">{hint}</span> : null}
        </span>
      </summary>
      <div className="tool-body">{children}</div>
    </details>
  );
}

type WorkflowColumn = { key: string; label: string; category: "open" | "ready" | "blocked" };

const CATEGORY_OPTIONS: readonly { value: WorkflowColumn["category"]; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "ready", label: "Ready" },
  { value: "blocked", label: "Blocked" },
];

/**
 * The progress columns this event tracks speakers through, as rows.
 *
 * They used to be a textarea of `identifier|Name|status` lines, parsed on submit: a schema an
 * organizer had to be told about in a hint, with no way to see which part was wrong, and one
 * mistyped pipe silently dropping a whole column. Each column is now a row with three named
 * controls and its own Remove.
 */
function WorkflowColumnEditor({
  columns,
  busy,
  onSave,
}: {
  columns: readonly WorkflowColumn[];
  busy: boolean;
  onSave: (columns: readonly WorkflowColumn[]) => void;
}) {
  const [rows, setRows] = useState<readonly WorkflowColumn[]>(columns);
  const patch = (index: number, change: Partial<WorkflowColumn>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...change } : row)));
  const complete = rows.filter((row) => row.key.trim() && row.label.trim());

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(complete);
      }}
    >
      <ul className="editable-rows" aria-label="Progress columns">
        {rows.map((row, index) => (
          // The identifier is the stable key the server stores, so a row keeps its identity
          // across a rename; a blank one is new and is positioned instead.
          <li className="editable-row" key={row.key || `new-${index}`}>
            <label className="editable-field">
              <span>Name</span>
              <input
                className="control is-sm"
                value={row.label}
                disabled={busy}
                onChange={(changed) => patch(index, { label: changed.target.value })}
              />
            </label>
            <label className="editable-field">
              <span>Identifier</span>
              <input
                className="control is-sm figure"
                value={row.key}
                disabled={busy}
                onChange={(changed) => patch(index, { key: changed.target.value })}
              />
            </label>
            <label className="editable-field">
              <span>Counts as</span>
              <select
                className="control is-sm"
                value={row.category}
                disabled={busy}
                onChange={(changed) =>
                  patch(index, { category: changed.target.value as WorkflowColumn["category"] })
                }
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="danger small"
              disabled={busy}
              onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
            >
              Remove<span className="visually-hidden"> {row.label || "this column"}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            setRows((current) => [...current, { key: "", label: "", category: "open" }])
          }
        >
          Add a column
        </button>
        <button className="primary" type="submit" disabled={busy || !complete.length}>
          Save progress columns
        </button>
      </div>
    </form>
  );
}

/**
 * Who else may see or edit one speaker's profile, chosen from the people this event already has.
 *
 * It used to be a textarea of `user-id|edit` lines — an organizer was expected to know an
 * opaque identifier by heart, and a typo silently granted nothing to nobody.
 */
function CollaboratorEditor({
  collaborators,
  directory,
  busy,
  onSave,
}: {
  collaborators: readonly { userId: string; access: "view" | "edit" }[];
  directory: readonly { id: string; name: string }[];
  busy: boolean;
  onSave: (collaborators: readonly { userId: string; access: "view" | "edit" }[]) => void;
}) {
  const [rows, setRows] =
    useState<readonly { userId: string; access: "view" | "edit" }[]>(collaborators);
  const [adding, setAdding] = useState("");
  const nameOf = (userId: string) =>
    directory.find((member) => member.id === userId)?.name ?? userId;
  const available = directory.filter((member) => !rows.some((row) => row.userId === member.id));

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rows);
      }}
    >
      {rows.length ? (
        <ul className="editable-rows" aria-label="Collaborators">
          {rows.map((row) => (
            <li className="editable-row" key={row.userId}>
              <span className="editable-name">{nameOf(row.userId)}</span>
              <label className="editable-field">
                <span>Access</span>
                <select
                  className="control is-sm"
                  value={row.access}
                  disabled={busy}
                  onChange={(changed) =>
                    setRows((current) =>
                      current.map((entry) =>
                        entry.userId === row.userId
                          ? { ...entry, access: changed.target.value === "view" ? "view" : "edit" }
                          : entry,
                      ),
                    )
                  }
                >
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </select>
              </label>
              <button
                type="button"
                className="danger small"
                disabled={busy}
                onClick={() =>
                  setRows((current) => current.filter((entry) => entry.userId !== row.userId))
                }
              >
                Remove<span className="visually-hidden"> {nameOf(row.userId)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Nobody else can open this profile yet.</p>
      )}
      <div className="editable-row">
        <label className="editable-field">
          <span>Add a collaborator</span>
          <select
            className="control is-sm"
            value={adding}
            disabled={busy || !available.length}
            onChange={(changed) => setAdding(changed.target.value)}
          >
            <option value="">
              {available.length ? "Choose a member…" : "Everybody is already listed"}
            </option>
            {available.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary small"
          disabled={busy || !adding}
          onClick={() => {
            setRows((current) => [...current, { userId: adding, access: "edit" }]);
            setAdding("");
          }}
        >
          Add
        </button>
      </div>
      <button className="primary" type="submit" disabled={busy}>
        Save collaborators
      </button>
    </form>
  );
}

export function ContentOperations({
  eventId,
  workspace,
  busy,
  run,
  canAdministerShares,
}: {
  eventId: string;
  workspace: Workspace;
  busy: boolean;
  run: Run;
  canAdministerShares: boolean;
}) {
  const feedback = useActionFeedback();
  const [selectedSpeakers, setSelectedSpeakers] = useState<string[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof importSpeakerCsv>> | null>(null);
  const [workflowFilter, setWorkflowFilter] = useState("all");
  // Which speaker's workflow is being edited. One form is mounted at a time, so the panel does
  // not grow with the roster the way the old column did.
  const [workflowSpeakerId, setWorkflowSpeakerId] = useState("");
  const [profileShares, setProfileShares] = useState<Awaited<ReturnType<typeof listProfileShares>>>(
    [],
  );
  const [newShareUrl, setNewShareUrl] = useState("");
  const [remixDraft, setRemixDraft] = useState<Awaited<
    ReturnType<typeof draftProfileRemix>
  > | null>(null);
  const [collaborators, setCollaborators] = useState<
    readonly { userId: string; access: "view" | "edit" }[]
  >([]);
  function csv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const commit = data.get("mode") === "commit";
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(async () =>
      setPreview(await importSpeakerCsv(eventId, String(data.get("csv")), commit)),
    ).then((result) =>
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? commit
            ? "Import complete."
            : "Preview ready."
          : "CSV could not be validated.",
      ),
    );
  }

  function tasks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const sessionId = String(data.get("sessionId") ?? "");
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(() =>
      bulkRequestSpeakerTasks({
        profileIds: selectedSpeakers,
        title: String(data.get("title")),
        dueAt: new Date(String(data.get("dueAt"))).toISOString(),
        type: data.get("type") === "file-request" ? "file-request" : "general",
        instructions: String(data.get("instructions")),
        // Omitted rather than sent empty: "" is not a session id, and the schema would refuse
        // the whole request over a box the organizer deliberately left alone.
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  }

  function saveWorkflow(event: FormEvent<HTMLFormElement>, speakerId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const entries = (name: string) =>
      Object.fromEntries(
        String(data.get(name))
          .split("\n")
          .map((line) => line.split("=", 2).map((part) => part.trim()))
          .filter(([key, value]) => key && value),
      );
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(() =>
      updateSpeakerWorkflow(speakerId, {
        workflowStatus: String(data.get("workflowStatus")),
        logistics: entries("logistics"),
        customFields: entries("customFields"),
      }),
    );
  }

  function saveWorkflowStatuses(statuses: readonly WorkflowColumn[]) {
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(() => configureContentWorkflowStatuses(eventId, { statuses: [...statuses] }));
  }

  function refreshShares(profileId: string) {
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(async () => setProfileShares([...(await listProfileShares(profileId))]));
  }

  function shareProfile(event: FormEvent<HTMLFormElement>, profileId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(async () => {
      const created = await createProfileShare(profileId, {
        lifetimeHours: Number(form.get("lifetimeHours")),
        ...(form.get("viewLimit") ? { viewLimit: Number(form.get("viewLimit")) } : {}),
        ...(form.get("password") ? { password: String(form.get("password")) } : {}),
      });
      setNewShareUrl(created.url);
      setProfileShares([...(await listProfileShares(profileId))]);
    });
  }

  function remixProfile(event: FormEvent<HTMLFormElement>, profileId: string) {
    event.preventDefault();
    const instruction = String(new FormData(event.currentTarget).get("instruction"));
    // ERROR-INTENT: run() owns rejection handling and the returned text remains an explicit draft.
    void run(async () => setRemixDraft(await draftProfileRemix(profileId, instruction)));
  }

  function saveCollaborators(
    profileId: string,
    chosen: readonly { userId: string; access: "view" | "edit" }[],
  ) {
    // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
    void run(async () => setCollaborators(await setProfileCollaborators(profileId, [...chosen])));
  }

  const filteredSpeakers = workspace.speakers.filter(
    (speaker) => workflowFilter === "all" || speaker.workflowStatus === workflowFilter,
  );
  const workflowStatuses = workspace.workflowStatuses ?? [
    { key: "invited", label: "Invited", category: "open" as const },
    { key: "onboarding", label: "Onboarding", category: "open" as const },
    { key: "ready", label: "Ready", category: "ready" as const },
    { key: "blocked", label: "Blocked", category: "blocked" as const },
  ];
  // The chosen speaker, or the first one the filter still admits — so narrowing the filter past
  // the current selection lands on a real speaker rather than an empty form.
  //
  // The picker below writes `workflowSpeakerId` on mount-time default as well as on change, so
  // the selection is stored rather than derived. It used to fall through to `filteredSpeakers[0]`
  // whenever nothing had been picked, and the roster arrives `ORDER BY name`: committing a CSV
  // import that added an earlier name changed which speaker `[0]` was, remounted the form on its
  // `key`, and replaced logistics the organizer had typed but not saved.
  const workflowSpeaker =
    filteredSpeakers.find(({ id }) => id === workflowSpeakerId) ?? filteredSpeakers[0];
  // Commit the defaulted choice, so "whoever sorts first" becomes "the speaker on screen" and a
  // later refetch cannot move it. Re-runs only when the current selection is no longer offered.
  useEffect(() => {
    if (workflowSpeaker && workflowSpeaker.id !== workflowSpeakerId)
      setWorkflowSpeakerId(workflowSpeaker.id);
  }, [workflowSpeaker, workflowSpeakerId]);
  const revisions = workspace.revisions ?? [];

  return (
    <div className="tool-stack">
      {feedback.node}

      <ToolPanel
        title="Speaker resources"
        hint="Handbook and reference pages for the speaker portal."
      >
        <ResourceEditor eventId={eventId} workspace={workspace} busy={busy} run={run} />
      </ToolPanel>

      {/* Declared once as event configuration, then instantiated as dated work for named
          people. Beside Speaker resources because they are the same kind of job — what this
          event asks of every speaker — and both are set up rarely and read often. */}
      <ToolPanel
        title="Speaker checklist"
        hint="What every speaker is asked for, written once and assigned to the people who need it."
      >
        <ChecklistEditor eventId={eventId} workspace={workspace} busy={busy} run={run} />
      </ToolPanel>

      <ToolPanel
        title="Import speakers"
        hint="Validate first; duplicates and invalid rows are never silently imported."
      >
        <form className="form-stack" onSubmit={csv}>
          <label>
            CSV
            <textarea
              name="csv"
              rows={5}
              placeholder="name,email,workflowStatus"
              required
              onChange={() => setPreview(null)}
            />
          </label>
          <div className="row-actions">
            <button className="secondary" type="submit" name="mode" value="preview" disabled={busy}>
              Preview CSV
            </button>
            <button
              className="primary"
              type="submit"
              name="mode"
              value="commit"
              disabled={busy || !preview}
            >
              Import valid rows
            </button>
          </div>
        </form>
        {preview ? (
          <>
            <Notice tone={preview.invalid ? "warn" : "success"}>
              {preview.valid} valid · {preview.duplicates} duplicate · {preview.invalid} invalid
            </Notice>
            <ul className="plain-list">
              {preview.rows.map((row) => (
                <li key={`${row.row}-${row.email}`}>
                  Row {row.row}: {row.name || "Unnamed"} · {row.email || "No email"} ·{" "}
                  {row.errors.length ? row.errors.join("; ") : "Valid row"}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </ToolPanel>

      <ToolPanel
        title="Accelevents registrations"
        hint="One-way: registrations are read from Accelevents and become speaker profiles here. Nothing is sent back."
      >
        <AccelEventsSync eventId={eventId} busy={busy} run={run} />
      </ToolPanel>

      <ToolPanel
        title="Speaker workflow"
        hint="Filter progress and maintain logistics for one speaker at a time."
      >
        {/* Remounted whenever the server's answer changes, so the rows below are always the
            columns this event actually has rather than the ones it had when the panel opened. */}
        <WorkflowColumnEditor
          key={workflowStatuses.map((status) => status.key).join("|")}
          columns={workflowStatuses.map((status) => ({
            key: status.key,
            label: status.label,
            category: status.category ?? "open",
          }))}
          busy={busy}
          onSave={saveWorkflowStatuses}
        />
        <div className="workflow-picker">
          <label>
            Progress filter
            <select
              value={workflowFilter}
              onChange={(event) => setWorkflowFilter(event.target.value)}
            >
              <option value="all">All speakers</option>
              {workflowStatuses.map((status) => (
                <option key={status.key} value={status.key}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          {filteredSpeakers.length ? (
            <label>
              Speaker
              <select
                value={workflowSpeaker?.id ?? ""}
                onChange={(event) => setWorkflowSpeakerId(event.target.value)}
              >
                {filteredSpeakers.map((speaker) => (
                  <option key={speaker.id} value={speaker.id}>
                    {speaker.name} · {speaker.workflowStatus ?? "onboarding"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {workflowSpeaker ? (
          <>
            {canAdministerShares ? (
              <ToolPanel title="Private profile share links" nested>
                <form
                  className="stack"
                  onSubmit={(event) => shareProfile(event, workflowSpeaker.id)}
                >
                  <label>
                    Lifetime (hours)
                    <input name="lifetimeHours" type="number" min="1" max="720" defaultValue="72" />
                  </label>
                  <label>
                    View limit (optional)
                    <input name="viewLimit" type="number" min="1" max="1000" />
                  </label>
                  <label>
                    Password (optional)
                    <input name="password" type="password" minLength={8} maxLength={200} />
                  </label>
                  <div className="crm-form-actions">
                    <button className="primary" type="submit" disabled={busy}>
                      Create share link
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => refreshShares(workflowSpeaker.id)}
                    >
                      Refresh links
                    </button>
                  </div>
                </form>
                {newShareUrl ? (
                  <p>
                    <a href={newShareUrl}>Open newly created share link</a> — copy it now; its token
                    is not stored.
                  </p>
                ) : null}
                {profileShares.length ? (
                  <ul>
                    {profileShares.map((share) => (
                      <li key={share.id}>
                        {share.revokedAt
                          ? "Revoked"
                          : `${share.views}${share.viewLimit ? `/${share.viewLimit}` : ""} views · expires ${new Date(share.expiresAt).toLocaleString()}`}{" "}
                        {!share.revokedAt ? (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              // ERROR-INTENT: run owns rejection handling and visible feedback.
                              void run(async () => {
                                await revokeProfileShare(workflowSpeaker.id, share.id);
                                setProfileShares([
                                  ...(await listProfileShares(workflowSpeaker.id)),
                                ]);
                              });
                            }}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </ToolPanel>
            ) : null}
            <ToolPanel title="AI bio remix" nested>
              <form className="stack" onSubmit={(event) => remixProfile(event, workflowSpeaker.id)}>
                <label>
                  Drafting instruction
                  <textarea
                    name="instruction"
                    maxLength={1000}
                    placeholder="Make the bio concise and conference-ready"
                  />
                </label>
                <button type="submit" className="secondary" disabled={busy}>
                  Draft remix
                </button>
              </form>
              {remixDraft ? (
                <div>
                  <p className="hint">
                    Draft from {remixDraft.model}; it has not changed the speaker profile.
                  </p>
                  <textarea
                    readOnly
                    rows={8}
                    value={remixDraft.text}
                    aria-label="AI bio remix draft"
                  />
                </div>
              ) : null}
            </ToolPanel>
            <ToolPanel title="Profile collaborators" nested>
              <CollaboratorEditor
                // Remounted per speaker and per saved answer: the rows below belong to the
                // profile on screen, never to the one that was on screen a moment ago.
                key={`${workflowSpeaker.id}:${collaborators.map(({ userId }) => userId).join(",")}`}
                collaborators={collaborators}
                directory={workspace.actorDirectory ?? []}
                busy={busy}
                onSave={(chosen) => saveCollaborators(workflowSpeaker.id, chosen)}
              />
            </ToolPanel>
            {/*
             * What the speaker wrote, read-only, beside the workflow an organizer maintains.
             *
             * These four fields are the speaker's to write — the portal is the only surface that
             * may change them — but "the organizer sees exactly the same values" is only
             * checkable if the organizer can see them at all, and until now this panel showed
             * logistics and status and nothing the speaker had actually entered.
             */}
            <dl className="speaker-entered">
              <div>
                <dt>Pronouns</dt>
                <dd>{workflowSpeaker.pronouns || "—"}</dd>
              </div>
              <div>
                <dt>Organization</dt>
                <dd>{workflowSpeaker.organization || "—"}</dd>
              </div>
              <div className="speaker-entered-wide">
                <dt>Bio</dt>
                <dd>{workflowSpeaker.bio || "—"}</dd>
              </div>
              <div className="speaker-entered-wide">
                <dt>Links</dt>
                <dd>
                  {Object.keys(workflowSpeaker.socialLinks ?? {}).length ? (
                    <ul className="speaker-links">
                      {SOCIAL_PLATFORMS.filter(({ key }) => workflowSpeaker.socialLinks?.[key]).map(
                        ({ key, label }) => (
                          <li key={key}>
                            <a
                              href={workflowSpeaker.socialLinks?.[key] ?? ""}
                              rel="noreferrer noopener"
                              target="_blank"
                            >
                              {label}
                            </a>
                          </li>
                        ),
                      )}
                    </ul>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>
            <form
              // Remounted per speaker so the uncontrolled fields below reload from the speaker
              // chosen, instead of keeping the previous one's logistics on screen.
              key={workflowSpeaker.id}
              className="form-stack"
              onSubmit={(event) => saveWorkflow(event, workflowSpeaker.id)}
            >
              <label>
                Status
                <select
                  name="workflowStatus"
                  defaultValue={workflowSpeaker.workflowStatus ?? "onboarding"}
                >
                  {workflowStatuses.map((status) => (
                    <option key={status.key} value={status.key}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Logistics (one key=value per line)
                <textarea
                  name="logistics"
                  defaultValue={Object.entries(workflowSpeaker.logistics ?? {})
                    .map(([key, value]) => `${key}=${value}`)
                    .join("\n")}
                />
              </label>
              <label>
                Custom fields (one key=value per line)
                <textarea
                  name="customFields"
                  defaultValue={Object.entries(workflowSpeaker.customFields ?? {})
                    .map(([key, value]) => `${key}=${value}`)
                    .join("\n")}
                />
              </label>
              <button className="primary" type="submit" disabled={busy}>
                Save workflow
                <span className="visually-hidden"> for {workflowSpeaker.name}</span>
              </button>
            </form>
          </>
        ) : workspace.speakers.length ? (
          <EmptyState icon={<IconSearch size={20} />} title="No speakers match">
            Choose another progress filter to see the rest of the roster.
          </EmptyState>
        ) : (
          // Advice an organizer can act on. Telling somebody with an empty roster to change a
          // filter sends them round a loop no filter setting can end.
          <EmptyState icon={<IconSpeakers size={20} />} title="No speakers yet">
            Speaker records are created when you accept a proposal, import a CSV, or sync
            registrations.
          </EmptyState>
        )}
      </ToolPanel>

      <ToolPanel
        title="Bulk assignments"
        hint="Select speakers, then assign one dated task to all of them."
      >
        <label>
          Speakers
          <select
            multiple
            value={selectedSpeakers}
            onChange={(event) =>
              setSelectedSpeakers(
                Array.from(event.currentTarget.selectedOptions, (option) => option.value),
              )
            }
          >
            {workspace.speakers.map((speaker) => (
              <option key={speaker.id} value={speaker.id}>
                {speaker.name} · {speaker.workflowStatus ?? "onboarding"}
              </option>
            ))}
          </select>
        </label>
        <form className="form-stack" onSubmit={tasks}>
          <label>
            Task
            <input name="title" required />
          </label>
          <label>
            Due
            <input name="dueAt" type="datetime-local" required />
          </label>
          <label>
            Type
            <select name="type">
              <option value="general">General</option>
              <option value="file-request">File request</option>
            </select>
          </label>
          {/*
           * Which talk the request is about, when it is about one.
           *
           * `speaker_tasks.session_id` and `speaker_assets.session_id` both existed and nothing
           * in the product ever wrote either, so "the slides for the keynote" and "a headshot"
           * were the same shape of request and an organizer could only tell them apart by
           * reading the title. Choosing it here is what carries the session onto the upload the
           * speaker files against the task (#189).
           *
           * Optional on purpose: most requested work — a bio, a travel form — belongs to the
           * person rather than to a talk.
           */}
          <label>
            Session
            <select name="sessionId" defaultValue="">
              <option value="">Not about a session</option>
              {workspace.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Instructions
            <textarea name="instructions" />
          </label>
          <button className="primary" type="submit" disabled={busy || !selectedSpeakers.length}>
            Assign to selected
          </button>
        </form>
      </ToolPanel>

      <ToolPanel
        title="Requested work"
        hint="What every speaker still owes, what has arrived, and who to chase."
      >
        <DeliverableTracker
          eventId={eventId}
          workspace={workspace}
          busy={busy}
          run={run}
          announce={feedback.announce}
        />
      </ToolPanel>

      <ToolPanel
        title="Edit history"
        hint="Every profile and session edit records its actor and can be restored without deleting history."
      >
        {revisions.length ? (
          <div className="table-wrap">
            <table className="data content-table">
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Who</th>
                  <th scope="col">When</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision) => (
                  <tr key={revision.id}>
                    <td className="primary-cell" data-label="Record">
                      {revision.entityType}
                    </td>
                    <td data-label="Revision">{revision.revisionNumber}</td>
                    {/* Resolved through the directory the payload carries, so this reads
                        "Olivia Organizer" rather than the stored id `seed-organizer` (#154). */}
                    <td data-label="Who">{memberName(workspace, revision.actorId)}</td>
                    <td data-label="When">{shortDateTime(revision.createdAt)}</td>
                    <td data-label="Actions">
                      <button
                        type="button"
                        className="secondary small"
                        disabled={busy}
                        onClick={() => {
                          // ERROR-INTENT: run() owns rejection handling and exposes failures through shared action state.
                          void run(() => restoreContentRevision(revision.id));
                        }}
                      >
                        Restore
                        <span className="visually-hidden">
                          {" "}
                          {revision.entityType} revision {revision.revisionNumber}
                        </span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<IconClock size={20} />} title="No edits yet">
            Attributed revisions appear after the first edit.
          </EmptyState>
        )}
      </ToolPanel>
    </div>
  );
}
