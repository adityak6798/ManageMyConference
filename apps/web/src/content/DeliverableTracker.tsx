/*
 * What every speaker still owes, and the two things an organizer does about it.
 *
 * This replaces a panel that listed the latest upload of every asset and nothing else: it could
 * answer "what has arrived" but not "what has not", which is the question an organizer actually
 * has three days before a conference. Requested work is task-shaped, so the row is the task —
 * its deadline, what was asked for, which session it belongs to, and whichever upload answers
 * it — and the filters narrow by the states somebody actually chases.
 *
 * Two selection actions, and they do not take the same rows: chasing is only meaningful while a
 * task is open, downloading only once something has been uploaded. Reminders go through
 * communications on the same delivery key the automatic sweep uses, so pressing Remind on work
 * already covered says so instead of writing to the speaker twice. The ZIP takes only latest
 * versions. A third action is per-row rather than per-selection: commenting on the upload in
 * front of you.
 */

import { useMemo, useState } from "react";
import { addContentComment, downloadDeliverables, remindSpeakerTasks } from "../api/content";
import { EmptyState, Pill } from "../ui/primitives";
import {
  assetVersionGroups,
  daysUntil,
  dueLabel,
  DueStatus,
  plural,
  type Run,
  shortDate,
  type Workspace,
  withReference,
} from "./shared";

type Task = Workspace["tasks"][number];
type Asset = Workspace["assets"][number];

/** The states an organizer actually chases, rather than the storage enum. */
type StateFilter = "outstanding" | "overdue" | "complete" | "all";
const STATE_LABELS: Record<StateFilter, string> = {
  outstanding: "Outstanding",
  overdue: "Overdue",
  complete: "Complete",
  all: "Every task",
};

/**
 * One row: a requested task and whatever answers it.
 *
 * The upload is found by task binding first, which is the association the portal stores when a
 * speaker uploads *against* a request. A task with no bound upload shows none rather than
 * guessing from the speaker's other files — "they sent something, just not this" is exactly the
 * state an organizer needs to see.
 */
interface TrackedTask {
  readonly task: Task;
  readonly speakerName: string;
  readonly sessionTitle: string | null;
  readonly latest: Asset | null;
  readonly priorVersions: number;
  readonly overdue: boolean;
}

export function DeliverableTracker({
  eventId,
  workspace,
  busy,
  run,
  announce,
}: {
  eventId: string;
  workspace: Workspace;
  busy: boolean;
  run: Run;
  announce: (tone: "success" | "error", message: string) => void;
}) {
  const [state, setState] = useState<StateFilter>("outstanding");
  const [speakerId, setSpeakerId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const now = Date.now();
  const rows = useMemo<TrackedTask[]>(() => {
    const speakers = new Map(workspace.speakers.map((speaker) => [speaker.id, speaker.name]));
    const sessions = new Map(workspace.sessions.map((session) => [session.id, session.title]));
    // One entry per deliverable, so a re-uploaded deck counts once and reports its version.
    const groups = assetVersionGroups(workspace.assets);
    return workspace.tasks.map((task) => {
      const group = groups.find(({ latest }) => latest.taskId === task.id);
      return {
        task,
        speakerName: speakers.get(task.speakerProfileId) ?? "Unknown speaker",
        sessionTitle: task.sessionId ? (sessions.get(task.sessionId) ?? task.sessionId) : null,
        latest: group?.latest ?? null,
        priorVersions: group?.prior.length ?? 0,
        overdue: task.status === "open" && daysUntil(task.dueAt, now) < 0,
      };
    });
  }, [workspace, now]);

  const needle = search.trim().toLowerCase();
  const visible = rows
    .filter((row) => {
      if (state === "outstanding" && row.task.status !== "open") return false;
      if (state === "overdue" && !row.overdue) return false;
      if (state === "complete" && row.task.status !== "complete") return false;
      if (speakerId && row.task.speakerProfileId !== speakerId) return false;
      if (sessionId && row.task.sessionId !== sessionId) return false;
      if (!needle) return true;
      return `${row.task.title} ${row.speakerName} ${row.sessionTitle ?? ""} ${row.task.instructions ?? ""}`
        .toLowerCase()
        .includes(needle);
    })
    // Soonest first, and overdue before merely open: the order somebody chases in.
    .toSorted(
      (left, right) =>
        Number(left.task.status === "complete") - Number(right.task.status === "complete") ||
        new Date(left.task.dueAt).getTime() - new Date(right.task.dueAt).getTime(),
    );

  // A selection survives a filter change only for rows still on screen: reminding somebody the
  // organizer can no longer see is exactly the surprise this avoids.
  //
  // The two buttons below do not take the same rows, and collapsing them into one notion of
  // "selectable" made the ZIP unusable for its main purpose. Chasing is only meaningful while a
  // task is open; downloading is only meaningful once something has been uploaded, and a
  // *complete* task is the ordinary case there — an organizer collecting finished decks filters
  // to Complete, and every row then offered no checkbox at all. So a row is selectable when
  // either button could act on it, and each button counts its own share of the selection.
  const selectable = visible
    .filter(({ task, latest }) => task.status === "open" || latest)
    .map(({ task }) => task.id);
  const chosen = selected.filter((id) => selectable.includes(id));
  const remindable = visible
    .filter(({ task }) => chosen.includes(task.id) && task.status === "open")
    .map(({ task }) => task.id);
  const chosenAssets = visible
    .filter(({ task, latest }) => chosen.includes(task.id) && latest)
    .map(({ latest }) => (latest as Asset).id);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  function remind() {
    if (busy || remindable.length === 0) return;
    let report: Awaited<ReturnType<typeof remindSpeakerTasks>> = [];
    // ERROR-INTENT: handlers cannot await; both outcomes are announced below.
    void run(async () => {
      // The open share of the selection, never the whole of it: a complete task the organizer
      // ticked to download would otherwise be sent to the server as somebody to chase.
      report = await remindSpeakerTasks(eventId, remindable);
    }).then((result) => {
      if (!result.ok) {
        announce("error", withReference("Those reminders could not be sent.", result.error));
        return;
      }
      const count = (outcome: string) => report.filter((entry) => entry.outcome === outcome).length;
      const queued = count("queued");
      const already = count("already-sent");
      const unreachable = report.filter(({ outcome }) => outcome === "unreachable");
      const refused = report.filter(({ outcome }) => outcome === "refused");
      // Each clause is a different thing to do next, so none of them is folded into "sent".
      const parts = [
        `${queued} ${plural(queued, "reminder")} queued`,
        already ? `${already} already sent for this deadline` : "",
        unreachable.length
          ? `no address for ${unreachable.map(({ speakerName }) => speakerName).join(", ")}`
          : "",
        refused.length
          ? `refused for ${refused.map(({ title, reason }) => `${title} (${reason})`).join("; ")}`
          : "",
      ].filter(Boolean);
      announce(unreachable.length || refused.length ? "error" : "success", `${parts.join("; ")}.`);
      setSelected([]);
    });
  }

  return (
    <div className="deliverables">
      <div className="deliverable-filters">
        <label>
          Show
          <select value={state} onChange={(event) => setState(event.target.value as StateFilter)}>
            {(Object.keys(STATE_LABELS) as StateFilter[]).map((key) => (
              <option key={key} value={key}>
                {STATE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speaker
          <select value={speakerId} onChange={(event) => setSpeakerId(event.target.value)}>
            <option value="">Every speaker</option>
            {workspace.speakers.map((speaker) => (
              <option key={speaker.id} value={speaker.id}>
                {speaker.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Session
          <select value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
            <option value="">Every session</option>
            {workspace.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={search}
            placeholder="Task, speaker, or instructions"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <p className="deliverable-count">
          Showing {visible.length} of {rows.length}
        </p>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="Nothing matches this view">
          {rows.length
            ? "Choose another filter to see the rest of the requested work."
            : "Assign a task to a speaker and it appears here with whatever they upload against it."}
        </EmptyState>
      ) : (
        <>
          <div className="deliverable-actions">
            <label className="deliverable-select-all">
              <input
                type="checkbox"
                aria-label="Select every task in this view"
                checked={selectable.length > 0 && chosen.length === selectable.length}
                onChange={(event) => setSelected(event.target.checked ? selectable : [])}
                disabled={selectable.length === 0}
              />
              Select all open
            </label>
            {/*
             * Enabled whenever something is chosen, and it explains the two conditions it
             * cannot satisfy in its answer rather than by greying itself out — a control that
             * refuses silently is the shape #206's sweep exists to find.
             */}
            <button type="button" disabled={busy || remindable.length === 0} onClick={remind}>
              {/* The count only once there is one: "Send 0 reminders" reads as an offer to do
                  nothing rather than as "choose somebody first". The count is the *remindable*
                  share of the selection, not the selection — a complete task in it is there to be
                  downloaded, and counting it here would promise a chase that never happens. */}
              {remindable.length
                ? `Send ${remindable.length} ${plural(remindable.length, "reminder")}`
                : "Send reminders"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || chosenAssets.length === 0}
              onClick={() => {
                // ERROR-INTENT: run() owns rejection handling; the shared action state reports it.
                void run(() => downloadDeliverables(eventId, chosenAssets));
              }}
            >
              {chosenAssets.length
                ? `Download ${chosenAssets.length} ${plural(chosenAssets.length, "file")} as ZIP`
                : "Download selected as ZIP"}
            </button>
          </div>
          <div className="table-wrap">
            <table className="data deliverable-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Select</span>
                  </th>
                  <th scope="col">Requested</th>
                  <th scope="col">Speaker</th>
                  <th scope="col">Due</th>
                  <th scope="col">Session</th>
                  <th scope="col">Latest upload</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ task, speakerName, sessionTitle, latest, priorVersions }) => {
                  const days = daysUntil(task.dueAt, now);
                  return (
                    <tr key={task.id}>
                      <td className="select-cell" data-label="Select">
                        {task.status === "open" || latest ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${task.title} for ${speakerName}`}
                            checked={chosen.includes(task.id)}
                            onChange={() => toggle(task.id)}
                          />
                        ) : (
                          // Complete with nothing uploaded: neither button can act on it, so a
                          // checkbox here would be a control that does nothing when pressed.
                          <span className="visually-hidden">Complete, nothing uploaded</span>
                        )}
                      </td>
                      <td className="primary-cell" data-label="Requested">
                        {task.title}
                        <span className="sub">
                          {task.type === "file-request" ? "File request" : "General task"}
                          {task.instructions ? ` · ${task.instructions}` : ""}
                        </span>
                      </td>
                      <td data-label="Speaker">{speakerName}</td>
                      <td data-label="Due">
                        {task.status === "complete" ? (
                          <Pill tone="ok">Complete</Pill>
                        ) : (
                          <DueStatus days={days} />
                        )}
                        <span className="sub">
                          {task.status === "complete"
                            ? task.completedAt
                              ? `Completed ${shortDate(task.completedAt)}`
                              : "Completed"
                            : `${shortDate(task.dueAt)} · ${dueLabel(days)}`}
                        </span>
                      </td>
                      <td data-label="Session">{sessionTitle ?? "—"}</td>
                      <td data-label="Latest upload">
                        {latest ? (
                          <>
                            <a href={`/api/speaker-assets/${latest.id}`} download={latest.name}>
                              {latest.name}
                            </a>
                            <span className="sub">
                              v{latest.versionNumber ?? 1}
                              {priorVersions
                                ? ` · ${priorVersions} ${plural(priorVersions, "earlier version")}`
                                : ""}{" "}
                              · {shortDate(latest.uploadedAt)}
                            </span>
                            {/*
                              The organizer's half of an "attributed cross-role comment", which the
                              panel this tracker replaced carried and this one dropped — leaving
                              `POST /api/content-comments` reachable only by the speaker commenting
                              on their own file. Restoring it here rather than where it was: an
                              organizer says "wrong template" while looking at the upload, and this
                              is the row where they are looking at it.
                            */}
                            <form
                              className="row-actions"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const form = event.currentTarget;
                                const body = String(new FormData(form).get("body")).trim();
                                if (!body) return;
                                // ERROR-INTENT: handlers cannot await; run() owns rejection and
                                // announces both outcomes through the shared action state.
                                void run(() => addContentComment(latest.id, body)).then(
                                  (result) => {
                                    if (!result.ok) return;
                                    form.reset();
                                    announce(
                                      "success",
                                      `Comment added on ${latest.name} for ${speakerName}.`,
                                    );
                                  },
                                );
                              }}
                            >
                              <input
                                name="body"
                                aria-label={`Comment on ${latest.name} for ${speakerName}`}
                                required
                              />
                              <button type="submit" disabled={busy}>
                                Comment
                              </button>
                            </form>
                          </>
                        ) : (
                          <span className="sub">Nothing uploaded yet</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
