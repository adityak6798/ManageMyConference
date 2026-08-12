import { type FormEvent, useMemo, useRef, useState } from "react";
import { contentFieldErrors, recordSpeakerMessage, requestSpeakerTask } from "../api/content";
import { IconCheck, IconSend, IconSpeakers, IconTask } from "../ui/icons";
import { Card, EmptyState, Pill, useActionFeedback } from "../ui/primitives";
import {
  daysUntil,
  FieldErrors,
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
  const titleRef = useRef<HTMLInputElement>(null);
  const feedback = useActionFeedback();
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
  }));

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
      <Card labelledBy="speaker-roster" title="Speakers" hint="Who still owes you work." tight>
        {rows.length ? (
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
                {rows.map((row) => (
                  <tr key={row.speaker.id}>
                    <td className="primary-cell">
                      {row.speaker.name}
                      <span className="sub">{row.speaker.organization || row.speaker.email}</span>
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
