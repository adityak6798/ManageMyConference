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
  importSpeakerCsv,
  restoreContentRevision,
  updateSpeakerWorkflow,
} from "../api/content";
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
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <details className="tool-panel">
      <summary>
        <span className="tool-heading">
          <h3>{title}</h3>
          <span className="hint">{hint}</span>
        </span>
      </summary>
      <div className="tool-body">{children}</div>
    </details>
  );
}

export function ContentOperations({
  eventId,
  workspace,
  busy,
  run,
}: {
  eventId: string;
  workspace: Workspace;
  busy: boolean;
  run: Run;
}) {
  const feedback = useActionFeedback();
  const [selectedSpeakers, setSelectedSpeakers] = useState<string[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof importSpeakerCsv>> | null>(null);
  const [workflowFilter, setWorkflowFilter] = useState("all");
  // Which speaker's workflow is being edited. One form is mounted at a time, so the panel does
  // not grow with the roster the way the old column did.
  const [workflowSpeakerId, setWorkflowSpeakerId] = useState("");
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
        workflowStatus: String(data.get("workflowStatus")) as
          | "invited"
          | "onboarding"
          | "ready"
          | "blocked",
        logistics: entries("logistics"),
        customFields: entries("customFields"),
      }),
    );
  }

  const filteredSpeakers = workspace.speakers.filter(
    (speaker) => workflowFilter === "all" || speaker.workflowStatus === workflowFilter,
  );
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
            <button type="submit" name="mode" value="preview" disabled={busy}>
              Preview CSV
            </button>
            <button type="submit" name="mode" value="commit" disabled={busy || !preview}>
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
        <div className="workflow-picker">
          <label>
            Progress filter
            <select
              value={workflowFilter}
              onChange={(event) => setWorkflowFilter(event.target.value)}
            >
              <option value="all">All speakers</option>
              <option value="invited">Invited</option>
              <option value="onboarding">Onboarding</option>
              <option value="ready">Ready</option>
              <option value="blocked">Blocked</option>
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
                  <option value="invited">Invited</option>
                  <option value="onboarding">Onboarding</option>
                  <option value="ready">Ready</option>
                  <option value="blocked">Blocked</option>
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
              <button type="submit" disabled={busy}>
                Save workflow
                <span className="visually-hidden"> for {workflowSpeaker.name}</span>
              </button>
            </form>
          </>
        ) : workspace.speakers.length ? (
          <EmptyState title="No speakers match">
            Choose another progress filter to see the rest of the roster.
          </EmptyState>
        ) : (
          // Advice an organizer can act on. Telling somebody with an empty roster to change a
          // filter sends them round a loop no filter setting can end.
          <EmptyState title="No speakers yet">
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
          <button type="submit" disabled={busy || !selectedSpeakers.length}>
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
          <EmptyState title="No edits yet">
            Attributed revisions appear after the first edit.
          </EmptyState>
        )}
      </ToolPanel>
    </div>
  );
}
