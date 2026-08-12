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

import type { UpdateContentSessionInput } from "@greenroom/contracts";
import { Fragment, useMemo, useState } from "react";
import {
  clearSpeakerProfilePhoto,
  contentFieldErrors,
  publishSpeakerAsset,
  setSpeakerProfilePhoto,
  unpublishSpeakerAsset,
  updateContentSession,
  withdrawContentSession,
} from "../api/content";
import "../styles/content.css";
import { IconInbox, IconSessions, IconSpeakers, IconTask, IconWarning } from "../ui/icons";
import { Card, EmptyState, Notice, Pill, Stat, Tabs, useActionFeedback } from "../ui/primitives";

import { SessionEditor } from "./SessionEditor";
import { SpeakerOutreach } from "./SpeakerOutreach";
import { ResourceEditor } from "./ResourceEditor";
import {
  daysUntil,
  isImageAsset,
  PUBLICATION_LABEL,
  PUBLICATION_TONE,
  type PublicationState,
  photoVisibility,
  plural,
  type Run,
  type SpeakerAsset,
  type SpeakerProfile,
  shortDate,
  shortDateTime,
  type Workspace,
  withReference,
} from "./shared";
// This organizer state owner intentionally exceeds 400 lines. Session edits, withdrawals, task
// requests, speaker messages, asset visibility, and profile-photo choices all share the mutation
// runner and speaker/session projections above; their table/panel markup is used once, so splitting
// it would create the presentational-fragment forest issue #70 forbids. SessionEditor is extracted
// because it owns an independent form lifecycle; shared calculations live in shared.tsx.
export function OrganizerView({
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
  const assetFeedback = useActionFeedback();

  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | PublicationState>("all");
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  // Withdrawal is destructive and irreversible, so it is a two-step control: the row asks
  // before anything is sent, the way converting a prospect does.
  const [withdrawingSessionId, setWithdrawingSessionId] = useState<string | null>(null);

  const now = Date.now();
  const openTasks = workspace.tasks.filter(({ status }) => status === "open");
  const speakersWithOpenWork = new Set(openTasks.map(({ speakerProfileId }) => speakerProfileId));

  const speakerById = useMemo(
    () => new Map(workspace.speakers.map((speaker) => [speaker.id, speaker])),
    [workspace.speakers],
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

  function saveSession(sessionId: string, input: UpdateContentSessionInput) {
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() => updateContentSession(sessionId, input)).then((result) =>
      sessionFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? `Saved “${input.title}”.`
          : withReference("That session could not be saved.", result.error),
      ),
    );
  }

  /**
   * Take a session out of the programme.
   *
   * The control the decline dialog points at. Declining an abstract that was already accepted
   * reverses the decision but cannot remove the session it created — that object belongs to
   * this workspace — so this is where a session leaves, taking its agenda placements with it.
   */
  function withdrawSession(sessionId: string, title: string) {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() => withdrawContentSession(sessionId)).then((result) => {
      if (result.ok) {
        setWithdrawingSessionId(null);
        setExpandedSessionId((current) => (current === sessionId ? null : current));
      }
      sessionFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? `“${title}” was withdrawn, along with any agenda placement holding it. It leaves the public page the next time you publish.`
          : withReference("That session could not be withdrawn.", result.error),
      );
    });
  }

  /**
   * Publication is reversible, so this control is a toggle rather than a one-way switch.
   * Returning a file to private closes the public door on the very next read, and a headshot
   * withdrawn this way leaves the public gallery at the next publish.
   */
  function setAssetVisibility(asset: SpeakerAsset) {
    if (busy) return;
    const publishing = asset.visibility !== "publishable";
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() =>
      publishing ? publishSpeakerAsset(asset.id) : unpublishSpeakerAsset(asset.id),
    ).then((result) =>
      assetFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? publishing
            ? `“${asset.name}” is now publishable.`
            : `“${asset.name}” is private again and has left the public page.`
          : withReference(
              publishing
                ? "That asset could not be published."
                : "That asset could not be made private.",
              result.error,
            ),
      ),
    );
  }

  /**
   * An organizer may set or remove a speaker's headshot too — they own the programme it
   * appears on, and a speaker who has gone quiet still needs a face on the gallery. It marks
   * a choice only: the file's visibility is untouched by this control.
   */
  function setProfilePhoto(speaker: SpeakerProfile, asset: SpeakerAsset | null) {
    if (busy) return;
    // ERROR-INTENT: handlers cannot await; the announcement below renders both outcomes.
    void run(() =>
      asset ? setSpeakerProfilePhoto(speaker.id, asset.id) : clearSpeakerProfilePhoto(speaker.id),
    ).then((result) =>
      assetFeedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? asset
            ? `“${asset.name}” is now ${speaker.name}’s profile photo. ${photoVisibility(asset)}`
            : `${speaker.name} has no profile photo now.`
          : withReference(
              contentFieldErrors(result.error).assetId?.[0] ??
                "That profile photo could not be changed.",
              result.error,
            ),
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
      <ResourceEditor eventId={eventId} workspace={workspace} busy={busy} run={run} />
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
          hint={`${speakersWithOpenWork.size} with open work`}
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
          {/* Sessions are created by accepting an abstract in review, never from here: the
              acceptance command names a proposal and the server resolves the rest of it. */}
          <Card
            labelledBy="accepted-sessions"
            title="Accepted sessions"
            hint="Content that survived review. Edit a row to change how it will be published."
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
                      const withdrawing = withdrawingSessionId === session.id;
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
                                <span className="hint">Not on the published schedule</span>
                              )}
                            </td>
                            <td aria-label="Session actions">
                              <div className="row-actions">
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
                                <button
                                  type="button"
                                  className="secondary small"
                                  aria-expanded={withdrawing}
                                  aria-controls={`session-withdraw-${session.id}`}
                                  onClick={() =>
                                    setWithdrawingSessionId(withdrawing ? null : session.id)
                                  }
                                >
                                  Withdraw
                                  <span className="visually-hidden"> {session.title}</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                          {withdrawing ? (
                            <tr className="editor-row">
                              <td
                                colSpan={6}
                                id={`session-withdraw-${session.id}`}
                                aria-label="Withdraw session confirmation"
                              >
                                <Notice tone="warn">
                                  <IconWarning size={15} />
                                  <span>
                                    Withdraw “{session.title}”? It leaves the programme and any
                                    agenda placement holding it is removed.{" "}
                                    {session.speakerProfileIds.length
                                      ? "The speaker keeps their profile, tasks, and uploads."
                                      : "No speaker profile is removed."}{" "}
                                    It stays on the published public page until you publish again.
                                  </span>
                                </Notice>
                                <div className="session-editor-actions">
                                  <button
                                    type="button"
                                    aria-disabled={busy}
                                    onClick={() => withdrawSession(session.id, session.title)}
                                  >
                                    {busy ? "Withdrawing…" : `Yes, withdraw ${session.title}`}
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    onClick={() => setWithdrawingSessionId(null)}
                                  >
                                    Keep this session
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                          {expanded ? (
                            <tr className="editor-row">
                              <td
                                colSpan={6}
                                id={`session-editor-${session.id}`}
                                aria-label="Session editor"
                              >
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
            hint="Uploads stay private until you mark them publishable, and marking one as a headshot does not publish it."
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
                    {workspace.assets.map((asset) => {
                      const owner = speakerById.get(asset.speakerProfileId);
                      const isPhoto = Boolean(owner && owner.photoAssetId === asset.id);
                      return (
                        <tr key={asset.id}>
                          <td className="primary-cell">
                            {asset.name}
                            <span className="sub">
                              {asset.contentType}
                              {isPhoto ? " · Profile photo" : ""}
                            </span>
                          </td>
                          <td>{owner?.name ?? "Unknown speaker"}</td>
                          <td>{shortDate(asset.uploadedAt)}</td>
                          <td>
                            <Pill tone={asset.visibility === "publishable" ? "ok" : "neutral"}>
                              {asset.visibility === "publishable" ? "Publishable" : "Private"}
                            </Pill>
                          </td>
                          <td>
                            {/* Both controls stay mounted through the round trip, so the
                                keyboard focus that triggered one is not thrown back to the
                                body; each is a toggle, because both decisions are reversible. */}
                            <div className="row-actions">
                              {/* An organizer has to be able to open what a speaker sent them —
                                  a slide deck the workspace only lists is not delivered.
                                  `GET /api/speaker-assets/:id` already authorizes this. */}
                              <a
                                className="download"
                                href={`/api/speaker-assets/${asset.id}`}
                                download={asset.name}
                              >
                                Download
                                <span className="visually-hidden"> — {asset.name}</span>
                              </a>
                              <button
                                type="button"
                                className="secondary small"
                                aria-disabled={busy}
                                onClick={() => setAssetVisibility(asset)}
                              >
                                {asset.visibility === "publishable"
                                  ? "Make private"
                                  : "Mark publishable"}
                                <span className="visually-hidden"> — {asset.name}</span>
                              </button>
                              {owner && isImageAsset(asset) ? (
                                <button
                                  type="button"
                                  className="ghost small"
                                  aria-disabled={busy}
                                  onClick={() => setProfilePhoto(owner, isPhoto ? null : asset)}
                                >
                                  {isPhoto ? "Remove profile photo" : "Use as profile photo"}
                                  <span className="visually-hidden"> — {asset.name}</span>
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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

        <SpeakerOutreach workspace={workspace} busy={busy} run={run} />
      </div>
    </div>
  );
}
