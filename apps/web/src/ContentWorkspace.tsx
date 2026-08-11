/*
 * Sessions & speakers — one component, two audiences.
 *
 * Organizers get a two-pane operations view: the accepted-content table on the left
 * and the people who still owe work on the right. Speakers get a portal that leads
 * with the work assigned to them, because that is the only reason they sign in.
 *
 * Every mutation runs through `run`, which refetches the workspace and reports the
 * outcome through useActionFeedback so the confirmation lands next to the control
 * that caused it instead of at the bottom of the page.
 */

import type { ContentWorkspaceDto, UpdateContentSessionInput } from "@greenroom/contracts";
import { type FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptContent,
  completeSpeakerTask,
  getContent,
  publishSpeakerAsset,
  recordSpeakerMessage,
  requestSpeakerTask,
  updateContentSession,
  updateSpeakerProfile,
  uploadSpeakerAsset,
} from "./api/content";
import "./styles/content.css";
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconInbox,
  IconLink,
  IconPlus,
  IconSend,
  IconSessions,
  IconSpeakers,
  IconTask,
  IconWarning,
} from "./ui/icons";
import { Card, EmptyState, Notice, Pill, Stat, Tabs, useActionFeedback } from "./ui/primitives";

interface Props {
  eventId: string;
  role: "organizer" | "speaker";
  onError: (error: unknown) => void;
}

type Workspace = ContentWorkspaceDto;
type ContentSession = Workspace["sessions"][number];
type SpeakerProfile = Workspace["speakers"][number];
type PublicationState = ContentSession["publicationState"];

/** Resolves to true when the mutation succeeded, so callers can announce an outcome. */
type Run = (action: () => Promise<unknown>) => Promise<boolean>;

const PUBLICATION_TONE: Record<PublicationState, "neutral" | "info" | "ok"> = {
  draft: "neutral",
  ready: "info",
  published: "ok",
};

const PUBLICATION_LABEL: Record<PublicationState, string> = {
  draft: "Draft",
  ready: "Ready",
  published: "Published",
};

export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function plural(count: number, singular: string, many = `${singular}s`) {
  return count === 1 ? singular : many;
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function daysUntil(iso: string, now: number) {
  return Math.round((new Date(iso).getTime() - now) / 86_400_000);
}

function dueLabel(days: number) {
  if (days < 0) return `${Math.abs(days)} ${plural(Math.abs(days), "day")} overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} ${plural(days, "day")}`;
}

function DueStatus({ days }: { days: number }) {
  if (days < 0) return <Pill tone="danger">Overdue</Pill>;
  if (days <= 3)
    return (
      <Pill tone="warn">
        <IconClock size={12} />
        Due soon
      </Pill>
    );
  return <Pill tone="info">Open</Pill>;
}

/* ========================= organizer: session editor ========================= */

type SessionDraft = {
  title: string;
  abstract: string;
  format: string;
  tags: string;
  tracks: string;
  speakerProfileIds: string[];
  publicationState: PublicationState;
};

function sessionDraft(session: ContentSession): SessionDraft {
  return {
    title: session.title,
    abstract: session.abstract,
    format: session.format,
    tags: session.tags.join(", "),
    tracks: session.tracks.join(", "),
    speakerProfileIds: session.speakerProfileIds,
    publicationState: session.publicationState,
  };
}

function commaList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function SessionEditor({
  session,
  speakers,
  busy,
  onSave,
  onClose,
}: {
  session: ContentSession;
  speakers: SpeakerProfile[];
  busy: boolean;
  onSave: (input: UpdateContentSessionInput) => void;
  onClose: () => void;
}) {
  // Controlled fields, re-seeded whenever the saved session changes. The previous
  // uncontrolled form silently kept stale values after any refetch.
  const saved = useMemo(() => sessionDraft(session), [session]);
  const savedSignature = JSON.stringify(saved);
  const [draft, setDraft] = useState<SessionDraft>(saved);
  const [syncedTo, setSyncedTo] = useState(savedSignature);
  if (syncedTo !== savedSignature) {
    setSyncedTo(savedSignature);
    setDraft(saved);
  }
  const dirty = JSON.stringify(draft) !== savedSignature;
  const field = (name: string) => `session-${session.id}-${name}`;

  function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    onSave({
      title: draft.title,
      abstract: draft.abstract,
      format: draft.format,
      speakerProfileIds: draft.speakerProfileIds,
      tags: commaList(draft.tags),
      tracks: commaList(draft.tracks),
      publicationState: draft.publicationState,
    });
  }

  return (
    <form className="session-editor" onSubmit={submit}>
      <div className="field">
        <label htmlFor={field("title")}>Session title</label>
        <input
          id={field("title")}
          value={draft.title}
          onChange={(changeEvent) => setDraft({ ...draft, title: changeEvent.target.value })}
          required
          maxLength={160}
        />
      </div>
      <div className="field session-editor-wide">
        <label htmlFor={field("abstract")}>Abstract</label>
        <textarea
          id={field("abstract")}
          value={draft.abstract}
          onChange={(changeEvent) => setDraft({ ...draft, abstract: changeEvent.target.value })}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={field("format")}>Format</label>
        <input
          id={field("format")}
          value={draft.format}
          onChange={(changeEvent) => setDraft({ ...draft, format: changeEvent.target.value })}
          required
        />
      </div>
      <div className="field">
        <label htmlFor={field("publication")}>Publication readiness</label>
        <select
          id={field("publication")}
          value={draft.publicationState}
          onChange={(changeEvent) =>
            setDraft({
              ...draft,
              publicationState: changeEvent.target.value as PublicationState,
            })
          }
        >
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="published">Published</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={field("tags")}>Tags</label>
        <input
          id={field("tags")}
          value={draft.tags}
          onChange={(changeEvent) => setDraft({ ...draft, tags: changeEvent.target.value })}
          aria-describedby={field("tags-hint")}
        />
        <p className="hint" id={field("tags-hint")}>
          Comma separated.
        </p>
      </div>
      <div className="field">
        <label htmlFor={field("tracks")}>Tracks</label>
        <input
          id={field("tracks")}
          value={draft.tracks}
          onChange={(changeEvent) => setDraft({ ...draft, tracks: changeEvent.target.value })}
          aria-describedby={field("tracks-hint")}
        />
        <p className="hint" id={field("tracks-hint")}>
          Comma separated.
        </p>
      </div>
      <fieldset className="session-editor-wide speaker-checks">
        <legend>Speakers on this session</legend>
        {speakers.length ? (
          speakers.map((speaker) => (
            <label className="check-label" key={speaker.id}>
              <input
                type="checkbox"
                checked={draft.speakerProfileIds.includes(speaker.id)}
                onChange={(changeEvent) =>
                  setDraft({
                    ...draft,
                    speakerProfileIds: changeEvent.target.checked
                      ? [...draft.speakerProfileIds, speaker.id]
                      : draft.speakerProfileIds.filter((id) => id !== speaker.id),
                  })
                }
              />
              <span>
                {speaker.name}
                {speaker.organization ? <small>{speaker.organization}</small> : null}
              </span>
            </label>
          ))
        ) : (
          <p className="hint">No speaker profiles exist for this event yet.</p>
        )}
      </fieldset>
      <div className="session-editor-actions session-editor-wide">
        <button type="submit" aria-disabled={busy}>
          {busy ? "Saving…" : "Save session"}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close editor
        </button>
        {dirty ? <span className="hint">Unsaved changes</span> : null}
      </div>
    </form>
  );
}

/* ============================== organizer view ============================== */

function OrganizerView({
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
  const sessionFeedback = useActionFeedback();
  const outreachFeedback = useActionFeedback();
  const assetFeedback = useActionFeedback();

  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | PublicationState>("all");
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  // The organizer picks who the task or message is for; this used to be hardcoded to
  // the first speaker in the workspace, which made both actions unusable in practice.
  const [speakerChoice, setSpeakerChoice] = useState("");
  const [taskTitle, setTaskTitle] = useState("Upload final presentation");
  const [taskDue, setTaskDue] = useState("2026-09-01");
  const [messageSubject, setMessageSubject] = useState("Speaker preparation reminder sent");
  const taskTitleRef = useRef<HTMLInputElement>(null);

  const now = Date.now();
  const openTasks = workspace.tasks.filter(({ status }) => status === "open");

  // Deriving the selection instead of storing it keeps the picker valid when a refetch
  // adds or removes speakers.
  const selectedSpeaker =
    workspace.speakers.find(({ id }) => id === speakerChoice) ?? workspace.speakers[0];

  const speakerById = useMemo(
    () => new Map(workspace.speakers.map((speaker) => [speaker.id, speaker])),
    [workspace.speakers],
  );

  const speakerRows = useMemo(
    () =>
      workspace.speakers.map((speaker) => ({
        speaker,
        open: workspace.tasks.filter(
          (task) => task.speakerProfileId === speaker.id && task.status === "open",
        ).length,
        assets: workspace.assets.filter((asset) => asset.speakerProfileId === speaker.id).length,
        overdue: workspace.tasks.filter(
          (task) =>
            task.speakerProfileId === speaker.id &&
            task.status === "open" &&
            daysUntil(task.dueAt, now) < 0,
        ).length,
      })),
    [workspace.speakers, workspace.tasks, workspace.assets, now],
  );

  const counts = useMemo(() => {
    const byState = { draft: 0, ready: 0, published: 0 };
    for (const session of workspace.sessions) byState[session.publicationState] += 1;
    return byState;
  }, [workspace.sessions]);

  const needle = search.trim().toLowerCase();
  const visibleSessions = workspace.sessions.filter((session) => {
    if (stateFilter !== "all" && session.publicationState !== stateFilter) return false;
    if (!needle) return true;
    const speakerNames = session.speakerProfileIds
      .map((id) => speakerById.get(id)?.name ?? "")
      .join(" ");
    return `${session.title} ${session.format} ${session.tags.join(" ")} ${session.tracks.join(" ")} ${speakerNames}`
      .toLowerCase()
      .includes(needle);
  });

  function acceptDemoProposal() {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() =>
      acceptContent(eventId, {
        proposalId: "demo-accepted-proposal",
        title: "A newly accepted session",
        abstract: "Accepted once and linked without duplicate entry.",
        format: "Talk",
        tags: ["community"],
        tracks: ["Main"],
        speakers: [
          {
            userId: "seed-speaker",
            sourcePersonId: "proposal-person-sam",
            name: "Sam Speaker",
            email: "sam@example.test",
          },
        ],
      }),
    ).then((ok) =>
      sessionFeedback.announce(
        ok ? "success" : "error",
        ok ? "Accepted proposal linked as a session." : "The proposal could not be accepted.",
      ),
    );
  }

  function saveSession(sessionId: string, input: UpdateContentSessionInput) {
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() => updateContentSession(sessionId, input)).then((ok) =>
      sessionFeedback.announce(
        ok ? "success" : "error",
        ok ? `Saved “${input.title}”.` : "That session could not be saved.",
      ),
    );
  }

  function requestTask(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy || !selectedSpeaker) return;
    const name = selectedSpeaker.name;
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() =>
      requestSpeakerTask({
        profileId: selectedSpeaker.id,
        title: taskTitle,
        // The picker collects a day; speakers are given until the end of it.
        dueAt: new Date(`${taskDue}T23:59:00.000Z`).toISOString(),
      }),
    ).then((ok) =>
      outreachFeedback.announce(
        ok ? "success" : "error",
        ok ? `Requested “${taskTitle}” from ${name}.` : "That task could not be requested.",
      ),
    );
  }

  function recordMessage(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy || !selectedSpeaker) return;
    const name = selectedSpeaker.name;
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() =>
      recordSpeakerMessage({ profileId: selectedSpeaker.id, subject: messageSubject }),
    ).then((ok) =>
      outreachFeedback.announce(
        ok ? "success" : "error",
        ok ? `Logged a message to ${name}.` : "That message could not be recorded.",
      ),
    );
  }

  function publishAsset(assetId: string, name: string) {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() => publishSpeakerAsset(assetId)).then((ok) =>
      assetFeedback.announce(
        ok ? "success" : "error",
        ok ? `“${name}” is now publishable.` : "That asset could not be published.",
      ),
    );
  }

  const tabItems = [
    { id: "all", label: "All sessions", count: workspace.sessions.length },
    { id: "draft", label: "Draft", count: counts.draft },
    { id: "ready", label: "Ready", count: counts.ready },
    { id: "published", label: "Published", count: counts.published },
  ];

  return (
    <div className="content-workspace">
      <dl className="grid-auto">
        <Stat
          label="Accepted sessions"
          value={workspace.sessions.length}
          hint={`${counts.published} published`}
          icon={<IconSessions size={15} />}
        />
        <Stat
          label="Speakers"
          value={workspace.speakers.length}
          hint={`${speakerRows.filter((row) => row.open > 0).length} with open work`}
          icon={<IconSpeakers size={15} />}
        />
        <Stat
          label="Open speaker tasks"
          value={openTasks.length}
          hint={
            openTasks.filter((task) => daysUntil(task.dueAt, now) < 0).length
              ? `${openTasks.filter((task) => daysUntil(task.dueAt, now) < 0).length} overdue`
              : "All on track"
          }
          icon={<IconTask size={15} />}
          attention={openTasks.some((task) => daysUntil(task.dueAt, now) < 0)}
        />
        <Stat
          label="Speaker assets"
          value={workspace.assets.length}
          hint={`${workspace.assets.filter((asset) => asset.visibility === "publishable").length} publishable`}
          icon={<IconInbox size={15} />}
        />
      </dl>

      <div className="split">
        <div className="content-stack">
          <Card
            labelledBy="accepted-sessions"
            title="Accepted sessions"
            hint="Content that survived review. Edit a row to change how it will be published."
            actions={
              <button type="button" aria-disabled={busy} onClick={acceptDemoProposal}>
                <IconPlus size={15} />
                Accept demo proposal
              </button>
            }
            tight
          >
            <div className="content-tabs">
              <Tabs
                items={tabItems}
                active={stateFilter}
                onSelect={(id) => setStateFilter(id as "all" | PublicationState)}
                label="Filter sessions by publication state"
              />
            </div>
            <div className="content-toolbar toolbar">
              <div className="field search">
                <label className="visually-hidden" htmlFor="session-search">
                  Search sessions
                </label>
                <input
                  id="session-search"
                  type="search"
                  value={search}
                  placeholder="Search title, speaker, track…"
                  onChange={(changeEvent) => setSearch(changeEvent.target.value)}
                />
              </div>
              <p className="hint" aria-live="polite">
                {visibleSessions.length} of {workspace.sessions.length}{" "}
                {plural(workspace.sessions.length, "session")}
              </p>
            </div>
            <div className="content-feedback">{sessionFeedback.node}</div>
            <div
              className="table-wrap"
              id={`panel-${stateFilter}`}
              role="tabpanel"
              aria-labelledby={`tab-${stateFilter}`}
            >
              {visibleSessions.length ? (
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Session</th>
                      <th scope="col">Format</th>
                      <th scope="col">Speakers</th>
                      <th scope="col">Publication</th>
                      <th scope="col">Schedule</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSessions.map((session) => {
                      const expanded = expandedSessionId === session.id;
                      return (
                        <Fragment key={session.id}>
                          <tr>
                            <td className="primary-cell">
                              {session.title}
                              {session.tags.length ? (
                                <span className="sub">{session.tags.join(" · ")}</span>
                              ) : null}
                            </td>
                            <td>{session.format}</td>
                            <td>
                              {session.speakerProfileIds.length ? (
                                session.speakerProfileIds
                                  .map((id) => speakerById.get(id)?.name ?? "Unknown speaker")
                                  .join(", ")
                              ) : (
                                <span className="hint">Unassigned</span>
                              )}
                            </td>
                            <td>
                              <Pill tone={PUBLICATION_TONE[session.publicationState]}>
                                {PUBLICATION_LABEL[session.publicationState]}
                              </Pill>
                            </td>
                            <td>
                              {session.schedule ? (
                                <>
                                  {shortDateTime(session.schedule.startsAt)}
                                  <span className="sub">{session.schedule.location}</span>
                                </>
                              ) : (
                                <span className="hint">Not scheduled</span>
                              )}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="secondary small"
                                aria-expanded={expanded}
                                aria-controls={`session-editor-${session.id}`}
                                onClick={() => setExpandedSessionId(expanded ? null : session.id)}
                              >
                                {expanded ? "Close" : "Edit"}
                                <span className="visually-hidden"> {session.title}</span>
                              </button>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr className="editor-row">
                              <td colSpan={6} id={`session-editor-${session.id}`}>
                                <SessionEditor
                                  session={session}
                                  speakers={workspace.speakers}
                                  busy={busy}
                                  onSave={(input) => saveSession(session.id, input)}
                                  onClose={() => setExpandedSessionId(null)}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              ) : workspace.sessions.length ? (
                <EmptyState title="No sessions match" icon={<IconSessions size={20} />}>
                  Clear the search or choose another publication state to see the rest of the
                  programme.
                </EmptyState>
              ) : (
                <EmptyState title="No accepted content yet" icon={<IconSessions size={20} />}>
                  Accept a proposal from the abstracts review queue and it appears here with its
                  speakers already linked.
                </EmptyState>
              )}
            </div>
          </Card>

          <Card
            labelledBy="speaker-assets"
            title="Speaker assets"
            hint="Uploads stay private until you mark them publishable."
            tight
          >
            <div className="content-feedback">{assetFeedback.node}</div>
            {workspace.assets.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Speaker</th>
                      <th scope="col">Uploaded</th>
                      <th scope="col">Visibility</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspace.assets.map((asset) => (
                      <tr key={asset.id}>
                        <td className="primary-cell">
                          {asset.name}
                          <span className="sub">{asset.contentType}</span>
                        </td>
                        <td>
                          {speakerById.get(asset.speakerProfileId)?.name ?? "Unknown speaker"}
                        </td>
                        <td>{shortDate(asset.uploadedAt)}</td>
                        <td>
                          <Pill tone={asset.visibility === "publishable" ? "ok" : "neutral"}>
                            {asset.visibility === "publishable" ? "Publishable" : "Private"}
                          </Pill>
                        </td>
                        <td>
                          {/* The control stays mounted once it is spent so the keyboard
                              focus that triggered it is not thrown back to the body. */}
                          <button
                            type="button"
                            className="secondary small"
                            aria-disabled={busy || asset.visibility === "publishable"}
                            onClick={() => {
                              if (asset.visibility === "publishable") return;
                              publishAsset(asset.id, asset.name);
                            }}
                          >
                            {asset.visibility === "publishable"
                              ? "Publishable"
                              : "Mark publishable"}
                            <span className="visually-hidden"> — {asset.name}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No speaker uploads yet" icon={<IconInbox size={20} />}>
                Request an asset from a speaker and their upload lands here for review.
              </EmptyState>
            )}
          </Card>
        </div>

        <div className="content-stack">
          <Card labelledBy="speaker-roster" title="Speakers" hint="Who still owes you work." tight>
            {speakerRows.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Speaker</th>
                      <th scope="col" className="num">
                        Open
                      </th>
                      <th scope="col" className="num">
                        Assets
                      </th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {speakerRows.map((row) => (
                      <tr key={row.speaker.id}>
                        <td className="primary-cell">
                          {row.speaker.name}
                          <span className="sub">
                            {row.speaker.organization || row.speaker.email}
                          </span>
                        </td>
                        <td className="num">
                          {row.overdue ? (
                            <Pill tone="danger">{row.open}</Pill>
                          ) : row.open ? (
                            <Pill tone="warn">{row.open}</Pill>
                          ) : (
                            <Pill tone="ok">
                              <IconCheck size={12} />0
                            </Pill>
                          )}
                        </td>
                        <td className="num">{row.assets}</td>
                        <td>
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => {
                              setSpeakerChoice(row.speaker.id);
                              taskTitleRef.current?.focus();
                            }}
                          >
                            Follow up
                            <span className="visually-hidden"> with {row.speaker.name}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No speakers yet" icon={<IconSpeakers size={20} />}>
                Speaker records are created automatically when you accept a proposal.
              </EmptyState>
            )}
          </Card>

          <Card
            labelledBy="speaker-outreach"
            title="Speaker follow-up"
            hint="Ask one speaker for something, or log what you already sent them."
          >
            {selectedSpeaker ? (
              <div className="outreach">
                <div className="field">
                  <label htmlFor="outreach-speaker">Speaker</label>
                  <select
                    id="outreach-speaker"
                    value={selectedSpeaker.id}
                    onChange={(changeEvent) => setSpeakerChoice(changeEvent.target.value)}
                  >
                    {workspace.speakers.map((speaker) => (
                      <option key={speaker.id} value={speaker.id}>
                        {speaker.name}
                        {speaker.organization ? ` — ${speaker.organization}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <form className="outreach-form" onSubmit={requestTask}>
                  <div className="field">
                    <label htmlFor="task-title">Request a task</label>
                    <input
                      id="task-title"
                      ref={taskTitleRef}
                      value={taskTitle}
                      onChange={(changeEvent) => setTaskTitle(changeEvent.target.value)}
                      required
                      maxLength={160}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="task-due">Due date</label>
                    <input
                      id="task-due"
                      type="date"
                      value={taskDue}
                      onChange={(changeEvent) => setTaskDue(changeEvent.target.value)}
                      required
                    />
                  </div>
                  <button type="submit" aria-disabled={busy}>
                    <IconTask size={15} />
                    Request presentation asset
                  </button>
                </form>

                <form className="outreach-form" onSubmit={recordMessage}>
                  <div className="field">
                    <label htmlFor="message-subject">Record a communication</label>
                    <input
                      id="message-subject"
                      value={messageSubject}
                      onChange={(changeEvent) => setMessageSubject(changeEvent.target.value)}
                      required
                      maxLength={200}
                    />
                  </div>
                  <button type="submit" className="secondary" aria-disabled={busy}>
                    <IconSend size={15} />
                    Record communication
                  </button>
                </form>

                {outreachFeedback.node}
              </div>
            ) : (
              <EmptyState title="Nobody to contact yet" icon={<IconSend size={20} />}>
                Accept a proposal first; its speakers become contactable records.
              </EmptyState>
            )}
          </Card>

          <Card
            labelledBy="communication-history"
            title="Communication history"
            hint="What this event has already sent."
            tight
          >
            {workspace.messages.length ? (
              <ul className="plain-list">
                {workspace.messages.map((message) => (
                  <li key={message.id}>
                    <strong>{message.subject}</strong>
                    <span className="sub">
                      {speakerById.get(message.speakerProfileId)?.name ?? "Unknown speaker"} ·{" "}
                      <time dateTime={message.sentAt}>{shortDate(message.sentAt)}</time>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing sent yet" icon={<IconSend size={20} />}>
                Recorded messages give the whole organizing team one shared history.
              </EmptyState>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ============================= speaker portal ============================== */

type ProfileDraft = { name: string; pronouns: string; organization: string; bio: string };

function profileDraft(profile: SpeakerProfile): ProfileDraft {
  return {
    name: profile.name,
    pronouns: profile.pronouns,
    organization: profile.organization,
    bio: profile.bio,
  };
}

function SpeakerView({
  eventId,
  workspace,
  profile,
  busy,
  run,
}: {
  eventId: string;
  workspace: Workspace;
  profile: SpeakerProfile;
  busy: boolean;
  run: Run;
}) {
  const taskFeedback = useActionFeedback();
  const profileFeedback = useActionFeedback();
  const uploadFeedback = useActionFeedback();
  const uploadFormRef = useRef<HTMLFormElement>(null);

  // Re-seed the form whenever the stored profile changes; the previous uncontrolled
  // inputs kept showing the values from first paint even after a save or a refetch.
  const saved = useMemo(() => profileDraft(profile), [profile]);
  const savedSignature = JSON.stringify(saved);
  const [draft, setDraft] = useState<ProfileDraft>(saved);
  const [syncedTo, setSyncedTo] = useState(savedSignature);
  if (syncedTo !== savedSignature) {
    setSyncedTo(savedSignature);
    setDraft(saved);
  }
  const profileDirty = JSON.stringify(draft) !== savedSignature;

  const now = Date.now();
  const tasks = [...workspace.tasks].sort(
    (left, right) =>
      Number(left.status === "complete") - Number(right.status === "complete") ||
      new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime(),
  );
  const openTasks = tasks.filter(({ status }) => status === "open");
  const overdue = openTasks.filter((task) => daysUntil(task.dueAt, now) < 0).length;

  function completeTask(taskId: string, title: string) {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() => completeSpeakerTask(eventId, taskId)).then((ok) =>
      taskFeedback.announce(
        ok ? "success" : "error",
        ok ? `“${title}” marked complete.` : "That task could not be completed.",
      ),
    );
  }

  function saveProfile(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(() => updateSpeakerProfile(profile.id, draft)).then((ok) =>
      profileFeedback.announce(
        ok ? "success" : "error",
        ok ? "Profile saved. Organizers see this version." : "Your profile could not be saved.",
      ),
    );
  }

  function upload(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    const input = formEvent.currentTarget.elements.namedItem("asset") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      uploadFeedback.announce("error", "Choose a file before uploading.");
      return;
    }
    // ERROR-INTENT: handlers cannot await; run reports the failure through onError.
    void run(async () => {
      const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      await uploadSpeakerAsset({
        profileId: profile.id,
        name: file.name,
        contentType: file.type as "image/jpeg" | "image/png" | "application/pdf",
        contentBase64,
      });
    }).then((ok) => {
      if (ok) uploadFormRef.current?.reset();
      uploadFeedback.announce(
        ok ? "success" : "error",
        ok ? `${file.name} uploaded privately.` : "That file could not be uploaded.",
      );
    });
  }

  return (
    <div className="content-workspace">
      <dl className="grid-auto">
        <Stat
          label="Tasks to complete"
          value={openTasks.length}
          hint={overdue ? `${overdue} overdue` : "Nothing overdue"}
          icon={<IconTask size={15} />}
          attention={overdue > 0}
        />
        <Stat
          label="Your sessions"
          value={workspace.sessions.length}
          hint={`${workspace.sessions.filter((session) => session.schedule).length} scheduled`}
          icon={<IconSessions size={15} />}
        />
        <Stat
          label="Files uploaded"
          value={workspace.assets.length}
          hint="Private to you and the organizers"
          icon={<IconInbox size={15} />}
        />
      </dl>

      <Card
        labelledBy="speaker-tasks-title"
        title={
          openTasks.length
            ? `${openTasks.length} ${plural(openTasks.length, "task")} to complete`
            : "You’re all caught up"
        }
        hint={
          openTasks.length
            ? "Everything the organizers still need from you, soonest first."
            : "Nothing is outstanding. Organizers will let you know if that changes."
        }
        tight
      >
        <div className="content-feedback">{taskFeedback.node}</div>
        {tasks.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const days = daysUntil(task.dueAt, now);
                  return (
                    <tr key={task.id}>
                      <td className="primary-cell">{task.title}</td>
                      <td>
                        {shortDate(task.dueAt)}
                        <span className="sub">
                          {task.status === "open"
                            ? dueLabel(days)
                            : task.completedAt
                              ? `Completed ${shortDate(task.completedAt)}`
                              : "Completed"}
                        </span>
                      </td>
                      <td>
                        {task.status === "complete" ? (
                          <Pill tone="ok">
                            <IconCheck size={12} />
                            Complete
                          </Pill>
                        ) : (
                          <DueStatus days={days} />
                        )}
                      </td>
                      <td>
                        {/* The control stays mounted once it is spent so the keyboard
                            focus that triggered it is not thrown back to the body. */}
                        <button
                          type="button"
                          className={task.status === "complete" ? "secondary small" : "small"}
                          aria-disabled={busy || task.status === "complete"}
                          onClick={() => {
                            if (task.status === "complete") return;
                            completeTask(task.id, task.title);
                          }}
                        >
                          {task.status === "complete" ? "Completed" : "Mark complete"}
                          <span className="visually-hidden"> — {task.title}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tasks assigned" icon={<IconCheck size={20} />}>
            The organizers have not asked you for anything yet.
          </EmptyState>
        )}
      </Card>

      <div className="split">
        <Card
          labelledBy="speaker-profile-title"
          title="Your public profile"
          hint="This is what appears on the published programme."
        >
          <form className="profile-form" onSubmit={saveProfile}>
            <div className="field">
              <label htmlFor="profile-name">Name</label>
              <input
                id="profile-name"
                value={draft.name}
                onChange={(changeEvent) => setDraft({ ...draft, name: changeEvent.target.value })}
                required
                maxLength={120}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-pronouns">Pronouns</label>
              <input
                id="profile-pronouns"
                value={draft.pronouns}
                onChange={(changeEvent) =>
                  setDraft({ ...draft, pronouns: changeEvent.target.value })
                }
                maxLength={40}
              />
            </div>
            <div className="field profile-form-wide">
              <label htmlFor="profile-organization">Organization</label>
              <input
                id="profile-organization"
                value={draft.organization}
                onChange={(changeEvent) =>
                  setDraft({ ...draft, organization: changeEvent.target.value })
                }
                maxLength={120}
              />
            </div>
            <div className="field profile-form-wide">
              <label htmlFor="profile-bio">Bio</label>
              <textarea
                id="profile-bio"
                value={draft.bio}
                onChange={(changeEvent) => setDraft({ ...draft, bio: changeEvent.target.value })}
                maxLength={2000}
                aria-describedby="profile-bio-hint"
              />
              <p className="hint" id="profile-bio-hint">
                {draft.bio.length} of 2000 characters.
              </p>
            </div>
            <div className="profile-form-actions profile-form-wide">
              <button type="submit" aria-disabled={busy}>
                {busy ? "Saving…" : "Save profile"}
              </button>
              {profileDirty ? <span className="hint">Unsaved changes</span> : null}
            </div>
            {profileFeedback.node}
          </form>
        </Card>

        <Card
          labelledBy="speaker-uploads-title"
          title="Private uploads"
          hint="Headshots, slides, and handouts."
        >
          <Notice>
            Files stay private to you and the organizers until an organizer explicitly marks them
            publishable.
          </Notice>
          <form className="upload-form" ref={uploadFormRef} onSubmit={upload}>
            <div className="field">
              <label htmlFor="speaker-asset">Speaker asset</label>
              <input
                id="speaker-asset"
                name="asset"
                type="file"
                accept="image/png,image/jpeg,application/pdf"
                required
                aria-describedby="speaker-asset-hint"
              />
              <p className="hint" id="speaker-asset-hint">
                PNG, JPEG, or PDF.
              </p>
            </div>
            <button type="submit" aria-disabled={busy}>
              {busy ? "Uploading…" : "Upload asset"}
            </button>
          </form>
          {uploadFeedback.node}
          {workspace.assets.length ? (
            <ul className="upload-list">
              {workspace.assets.map((asset) => (
                <li key={asset.id}>
                  <span className="upload-name">
                    {asset.name}
                    <span className="sub">Uploaded {shortDate(asset.uploadedAt)}</span>
                  </span>
                  <Pill tone={asset.visibility === "publishable" ? "ok" : "neutral"}>
                    {asset.visibility === "publishable" ? "Publishable" : "Private"}
                  </Pill>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint upload-empty">No files stored yet.</p>
          )}
        </Card>
      </div>

      <Card
        labelledBy="speaker-sessions-title"
        title="Your sessions"
        hint="Times are shown in your device's timezone."
        actions={
          <a className="download" href={`/api/events/${eventId}/speaker-calendar.ics`} download>
            <IconCalendar size={15} />
            Download calendar (.ics)
          </a>
        }
        tight
      >
        {workspace.sessions.length ? (
          <ul className="plain-list">
            {workspace.sessions.map((session) => (
              <li key={session.id}>
                <div className="session-line">
                  <span>
                    <strong>{session.title}</strong>
                    <span className="sub">
                      {session.schedule
                        ? `${shortDateTime(session.schedule.startsAt)} · ${session.schedule.location}`
                        : "Schedule pending — organizers have not placed this yet"}
                    </span>
                  </span>
                  <span className="session-line-meta">
                    {session.schedule ? null : (
                      <Pill tone="warn">
                        <IconClock size={12} />
                        Unscheduled
                      </Pill>
                    )}
                    <Pill tone={PUBLICATION_TONE[session.publicationState]}>
                      {PUBLICATION_LABEL[session.publicationState]}
                    </Pill>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No sessions linked yet" icon={<IconLink size={20} />}>
            Once a proposal of yours is accepted it will appear here with its schedule.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}

/* =============================== container ================================= */

function LoadingWorkspace() {
  return (
    <div className="content-workspace">
      <div className="grid-auto" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="stat" key={index}>
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
            <div className="skeleton" style={{ height: 30, width: "35%", marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="card" aria-hidden="true">
        <div className="card-body">
          <div className="skeleton" style={{ height: 18, width: "40%" }} />
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} />
        </div>
      </div>
      <p className="visually-hidden" role="status">
        Loading the sessions and speakers workspace.
      </p>
    </div>
  );
}

// @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
export function ContentWorkspace({ eventId, role, onError }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setWorkspace(null);
    // ERROR-INTENT: React effects cannot await; the attached handler renders the failure.
    void getContent(eventId).then(setWorkspace).catch(onError);
  }, [eventId, onError]);

  const run: Run = async (action) => {
    setBusy(true);
    try {
      await action();
      setWorkspace(await getContent(eventId));
      return true;
    } catch (error) {
      // ERROR-INTENT: The parent shell renders the normalized API failure with its correlation ID;
      // the caller additionally announces the failure next to the control that triggered it.
      onError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!workspace) return <LoadingWorkspace />;

  if (role === "organizer")
    return <OrganizerView eventId={eventId} workspace={workspace} busy={busy} run={run} />;

  const profile = workspace.speakers[0];
  if (!profile)
    return (
      <Card>
        <EmptyState title="No speaker profile here" icon={<IconWarning size={20} />}>
          This identity is not linked to a speaker record on this event. Switch events, or ask an
          organizer to accept your proposal first.
        </EmptyState>
      </Card>
    );

  return (
    <SpeakerView eventId={eventId} workspace={workspace} profile={profile} busy={busy} run={run} />
  );
}
