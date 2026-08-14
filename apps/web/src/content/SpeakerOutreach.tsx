import { type FormEvent, useMemo, useRef, useState } from "react";
import {
  contentFieldErrors,
  inviteSpeakers,
  recordSpeakerMessage,
  requestSpeakerTask,
} from "../api/content";
import { IconCheck, IconSend, IconSpeakers, IconTask } from "../ui/icons";
import { Card, EmptyState, Pill, useActionFeedback } from "../ui/primitives";
import {
  daysUntil,
  FieldErrors,
  plural,
  type Run,
  shortDate,
  type Workspace,
  withReference,
} from "./shared";

/** Owns speaker selection and the task/message follow-up forms. */
export function SpeakerOutreach({
  workspace,
  busy,
  run,
}: {
  workspace: Workspace;
  busy: boolean;
  run: Run;
}) {
  const [speakerChoice, setSpeakerChoice] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskErrors, setTaskErrors] = useState<Record<string, string[]>>({});
  const [messageSubject, setMessageSubject] = useState("");
  const [messageErrors, setMessageErrors] = useState<Record<string, string[]>>({});
  /** Who the next Invite writes to. Separate from the follow-up picker: that one edits, this sends. */
  const [invitees, setInvitees] = useState<string[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const feedback = useActionFeedback();
  const inviteFeedback = useActionFeedback();
  const selected =
    workspace.speakers.find(({ id }) => id === speakerChoice) ?? workspace.speakers[0];
  const speakerById = useMemo(
    () => new Map(workspace.speakers.map((speaker) => [speaker.id, speaker])),
    [workspace.speakers],
  );
  const now = Date.now();
  const rows = workspace.speakers.map((speaker) => ({
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
    invitations: speaker.invitationsSent ?? 0,
  }));

  // A selection survives a refetch only for speakers still on the roster: inviting somebody the
  // organizer can no longer see is exactly the surprise this avoids, and it is the rule the
  // deliverable tracker applies to its own reminder selection.
  const invitable = workspace.speakers.map(({ id }) => id);
  const chosen = invitees.filter((id) => invitable.includes(id));
  const toggleInvitee = (id: string) =>
    setInvitees((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  /**
   * Send the portal invitation to whoever is ticked, and say what happened to each of them.
   *
   * The event comes from the chosen speakers rather than from a prop: this panel is handed the
   * workspace and not the event id, and a speaker profile carries the event it belongs to — which
   * is the event the invitation is about, so deriving it here cannot address the wrong one.
   */
  function invite() {
    const eventId = workspace.speakers.find(({ id }) => id === chosen[0])?.eventId;
    if (busy || !eventId || chosen.length === 0) return;
    let report: Awaited<ReturnType<typeof inviteSpeakers>> = [];
    // ERROR-INTENT: handlers cannot await; both outcomes are announced below.
    void run(async () => {
      report = await inviteSpeakers(eventId, chosen);
    }).then((result) => {
      if (!result.ok) {
        inviteFeedback.announce(
          "error",
          withReference("Those invitations could not be sent.", result.error),
        );
        return;
      }
      const queued = report.filter(({ outcome }) => outcome === "queued").length;
      const already = report.filter(({ outcome }) => outcome === "already-sent").length;
      const unreachable = report.filter(({ outcome }) => outcome === "unreachable");
      const refused = report.filter(({ outcome }) => outcome === "refused");
      // Each clause is a different thing to do next, so none of them is folded into "sent".
      const parts = [
        `${queued} ${plural(queued, "invitation")} queued`,
        already ? `${already} already sent for this occurrence` : "",
        unreachable.length
          ? `no address for ${unreachable.map(({ speakerName }) => speakerName).join(", ")}`
          : "",
        refused.length
          ? `refused for ${refused.map(({ speakerName, reason }) => `${speakerName} (${reason})`).join("; ")}`
          : "",
      ].filter(Boolean);
      inviteFeedback.announce(
        unreachable.length || refused.length ? "error" : "success",
        `${parts.join("; ")}.`,
      );
      setInvitees([]);
    });
  }

  function requestTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !selected) return;
    const title = taskTitle.trim();
    const problems: Record<string, string[]> = {};
    if (!title) problems.title = ["Say what you need from this speaker."];
    if (!taskDue) problems.dueAt = ["Choose the day this is due."];
    else if (Number.isNaN(new Date(`${taskDue}T23:59:00.000Z`).getTime()))
      problems.dueAt = ["That is not a real date."];
    setTaskErrors(problems);
    if (Object.keys(problems).length) {
      feedback.announce("error", "That request is incomplete. Check the fields above.");
      return;
    }
    const speaker = selected;
    // ERROR-INTENT: handlers cannot await; the adjacent live region renders both outcomes.
    void run(() =>
      requestSpeakerTask({
        profileId: speaker.id,
        title,
        dueAt: new Date(`${taskDue}T23:59:00.000Z`).toISOString(),
      }),
    ).then((result) => {
      if (result.ok) {
        setTaskTitle("");
        setTaskDue("");
      } else setTaskErrors(contentFieldErrors(result.error));
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? `Requested “${title}” from ${speaker.name}.`
          : withReference("That task could not be requested.", result.error),
      );
    });
  }

  function recordMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !selected) return;
    const subject = messageSubject.trim();
    if (!subject) {
      setMessageErrors({ subject: ["Say what you sent this speaker."] });
      feedback.announce("error", "Enter the subject of the message you sent.");
      return;
    }
    setMessageErrors({});
    const speaker = selected;
    // ERROR-INTENT: handlers cannot await; the adjacent live region renders both outcomes.
    void run(() => recordSpeakerMessage({ profileId: speaker.id, subject })).then((result) => {
      if (result.ok) setMessageSubject("");
      else setMessageErrors(contentFieldErrors(result.error));
      feedback.announce(
        result.ok ? "success" : "error",
        result.ok
          ? `Logged “${subject}” to ${speaker.name}.`
          : withReference("That message could not be recorded.", result.error),
      );
    });
  }

  return (
    <div className="content-stack">
      <Card
        labelledBy="speaker-roster"
        title="Speakers"
        hint="Who still owes you work, and who has been invited into the portal."
        tight
      >
        {rows.length ? (
          <div className="roster">
            {/*
             * The portal invitation, as an action an organizer takes rather than one acceptance
             * takes for them. It was sent exactly once per speaker, when their proposal was
             * accepted, and nothing could ever send it again — so a speaker who deleted the mail
             * had no way back in and no organizer had a control to offer them (#189).
             */}
            <div className="roster-actions">
              <label className="roster-select-all">
                <input
                  type="checkbox"
                  aria-label="Select every speaker on this roster"
                  checked={invitable.length > 0 && chosen.length === invitable.length}
                  onChange={(event) => setInvitees(event.target.checked ? invitable : [])}
                  disabled={invitable.length === 0}
                />
                Select all
              </label>
              {/* Enabled whenever somebody is ticked, and it explains what it could not do in
                  its answer rather than by greying itself out: a speaker with no address is a
                  state the organizer has to be told about, not one to hide the button over. */}
              <button type="button" disabled={busy || chosen.length === 0} onClick={invite}>
                <IconSend size={15} />
                {/* The count only once there is one: "Invite 0 speakers" reads as an offer to do
                    nothing rather than as "choose somebody first". */}
                {chosen.length
                  ? `Invite ${chosen.length} ${plural(chosen.length, "speaker")}`
                  : "Invite to the portal"}
              </button>
              {inviteFeedback.node}
            </div>
            <div className="table-wrap">
              <table className="data content-table roster-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="visually-hidden">Select</span>
                    </th>
                    <th scope="col">Speaker</th>
                    <th scope="col" className="num">
                      Open
                    </th>
                    <th scope="col" className="num">
                      Assets
                    </th>
                    <th scope="col">Invited</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.speaker.id}>
                      <td className="select-cell" data-label="Select">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.speaker.name} for a portal invitation`}
                          checked={chosen.includes(row.speaker.id)}
                          onChange={() => toggleInvitee(row.speaker.id)}
                        />
                      </td>
                      <td className="primary-cell" data-label="Speaker">
                        {row.speaker.name}
                        <span className="sub">{row.speaker.organization || row.speaker.email}</span>
                      </td>
                      <td className="num" data-label="Open">
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
                      <td className="num" data-label="Assets">
                        {row.assets}
                      </td>
                      {/* The delivery history, in the one place an organizer asks for it. "Never"
                          is not "never contacted": the welcome sent when a proposal is accepted
                          is acceptance's own message and is not counted here. */}
                      <td data-label="Invited">
                        {row.invitations ? (
                          <Pill tone="ok">
                            {row.invitations} {plural(row.invitations, "invitation")}
                          </Pill>
                        ) : (
                          <span className="sub">Never invited</span>
                        )}
                      </td>
                      <td data-label="Actions">
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => {
                            setSpeakerChoice(row.speaker.id);
                            titleRef.current?.focus();
                          }}
                        >
                          Follow up<span className="visually-hidden"> with {row.speaker.name}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
        {selected ? (
          <div className="outreach">
            <div className="field">
              <label htmlFor="outreach-speaker">Speaker</label>
              <select
                id="outreach-speaker"
                value={selected.id}
                onChange={(event) => setSpeakerChoice(event.target.value)}
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
                  ref={titleRef}
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                  required
                  maxLength={160}
                  placeholder="What you need from them"
                  aria-invalid={Boolean(taskErrors.title?.length)}
                  aria-describedby={taskErrors.title?.length ? "task-title-error" : undefined}
                />
                <FieldErrors id="task-title-error" messages={taskErrors.title} />
              </div>
              <div className="field">
                <label htmlFor="task-due">Due date</label>
                <input
                  id="task-due"
                  type="date"
                  value={taskDue}
                  onChange={(event) => setTaskDue(event.target.value)}
                  required
                  aria-invalid={Boolean(taskErrors.dueAt?.length)}
                  aria-describedby={
                    taskErrors.dueAt?.length ? "task-due-error task-due-hint" : "task-due-hint"
                  }
                />
                <p className="hint" id="task-due-hint">
                  The speaker has until the end of this day.
                </p>
                <FieldErrors id="task-due-error" messages={taskErrors.dueAt} />
              </div>
              <button type="submit" aria-disabled={busy}>
                <IconTask size={15} />
                Request this task
              </button>
            </form>
            <form className="outreach-form" onSubmit={recordMessage}>
              <div className="field">
                <label htmlFor="message-subject">Record a communication</label>
                <input
                  id="message-subject"
                  value={messageSubject}
                  onChange={(event) => setMessageSubject(event.target.value)}
                  required
                  maxLength={200}
                  placeholder="Subject of what you sent"
                  aria-invalid={Boolean(messageErrors.subject?.length)}
                  aria-describedby={
                    messageErrors.subject?.length
                      ? "message-subject-error message-subject-hint"
                      : "message-subject-hint"
                  }
                />
                <p className="hint" id="message-subject-hint">
                  Logged as history for the whole organizing team. Nothing is sent from here.
                </p>
                <FieldErrors id="message-subject-error" messages={messageErrors.subject} />
              </div>
              <button type="submit" className="secondary" aria-disabled={busy}>
                <IconSend size={15} />
                Record this message
              </button>
            </form>
            {feedback.node}
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
  );
}
