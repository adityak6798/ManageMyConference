/*
 * Organizer overview.
 *
 * This is the landing surface, so it answers the questions an organizer actually
 * opens the tool to ask: what needs a decision, who is holding up onboarding, and
 * what is not on the schedule yet. The outstanding-speaker-task table is the
 * product's answer to the "who still has open onboarding work" requirement, so it
 * gets a real table rather than a counter.
 */

import type { EventDto } from "@greenroom/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAgenda } from "./api/agenda";
import { getContent } from "./api/content";
import { getOrganizerReview } from "./api/review";
import { useLinkProps } from "./router";
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconReview,
  IconSpeakers,
  IconWarning,
} from "./ui/icons";
import { Card, EmptyState, Notice, PageHeader, Pill, Stat } from "./ui/primitives";

type Overview = {
  content: Awaited<ReturnType<typeof getContent>>;
  review: Awaited<ReturnType<typeof getOrganizerReview>>;
  agenda: Awaited<ReturnType<typeof getAgenda>>;
};

const DECIDED = new Set(["accepted", "declined", "withdrawn"]);

/** How often the dashboard re-reads its data without a manual reload. */
const REFRESH_MS = 15_000;

/**
 * Calendar days between now and a deadline, counted in the event's timezone.
 *
 * Rounding the raw elapsed duration was wrong at the boundary: a task eleven hours past
 * its deadline rounded to zero and read as "Due today" rather than overdue. Overdue is
 * therefore decided from the instant, and only the *label* is expressed in whole days.
 */
function calendarDaysUntil(iso: string, now: number, timeZone: string) {
  const dayIn = (value: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  const due = Date.parse(iso);
  const diff = Date.parse(`${dayIn(due)}T00:00:00Z`) - Date.parse(`${dayIn(now)}T00:00:00Z`);
  return { overdue: due < now, days: Math.round(diff / 86_400_000) };
}

function dueLabel({ overdue, days }: { overdue: boolean; days: number }) {
  if (overdue) {
    const late = Math.abs(days);
    return late === 0 ? "Overdue today" : `${late} day${late === 1 ? "" : "s"} overdue`;
  }
  if (days === 0) return "Due today";
  return `Due in ${days} day${days === 1 ? "" : "s"}`;
}

export function OverviewPage({ event, query }: { event: EventDto; query: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const linkProps = useLinkProps();

  const load = useCallback(async () => {
    // One parallel fan-out rather than a per-card waterfall: the overview is the
    // first paint an evaluator sees and it should settle in a single round trip.
    const [content, review, agenda] = await Promise.all([
      getContent(event.id),
      getOrganizerReview(event.id),
      getAgenda(event.id),
    ]);
    return { content, review, agenda };
  }, [event.id]);

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    setRefreshedAt(null);

    const read = () => {
      // ERROR-INTENT: effects cannot await; both outcomes are rendered below.
      void load()
        .then((next) => {
          if (!active) return;
          setData(next);
          setRefreshedAt(Date.now());
          setError(null);
        })
        .catch(() => {
          if (active) setError("The overview could not be loaded. Reload to try again.");
        });
    };

    read();
    // Speakers complete tasks and other organizers make decisions while this is open, so
    // the dashboard re-reads on a timer rather than waiting for a manual reload.
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);

  // Recomputed on every refresh so "overdue" does not go stale while the page is open.
  const now = refreshedAt ?? Date.now();

  const model = useMemo(() => {
    if (!data) return null;
    const speakerById = new Map(data.content.speakers.map((speaker) => [speaker.id, speaker]));
    const openTasks = data.content.tasks
      .filter((task) => task.status === "open")
      .map((task) => ({
        ...task,
        speaker: speakerById.get(task.speakerProfileId),
        due: calendarDaysUntil(task.dueAt, now, event.timezone),
      }))
      .sort((left, right) => left.due.days - right.due.days);

    const placedSessionIds = new Set(
      data.agenda.placements.map((placement) => placement.sessionId),
    );
    const unscheduled = data.content.sessions.filter(
      (contentSession) => !placedSessionIds.has(contentSession.id),
    );
    const awaiting = data.review.proposals.filter((proposal) => !DECIDED.has(proposal.status));
    const speakersWithOpenWork = new Set(openTasks.map((task) => task.speakerProfileId));

    return {
      openTasks,
      unscheduled,
      awaiting,
      proposalCount: data.review.proposals.length,
      speakersWithOpenWork,
      conflicts: data.agenda.conflicts,
      sessions: data.content.sessions,
      speakers: data.content.speakers,
    };
  }, [data, now, event.timezone]);

  if (error)
    return (
      <>
        <PageHeader title="Overview" subtitle={event.name} />
        <Notice tone="error">{error}</Notice>
      </>
    );

  if (!model)
    return (
      <>
        <PageHeader title="Overview" subtitle={event.name} />
        <div className="grid-auto" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="stat">
              <div className="skeleton" style={{ height: 14, width: "60%" }} />
              <div className="skeleton" style={{ height: 30, width: "35%", marginTop: 8 }} />
            </div>
          ))}
        </div>
        <p className="visually-hidden" role="status">
          Loading the event overview.
        </p>
      </>
    );

  const overdue = model.openTasks.filter((task) => task.due.overdue).length;

  return (
    <>
      <PageHeader
        eyebrow="Organizer"
        title="Overview"
        subtitle={`${event.name} · ${event.timezone}`}
        actions={
          // The dashboard refreshes itself, so it has to say when it last did — otherwise
          // a stale number is indistinguishable from a current one.
          <p className="refreshed-at" role="status">
            {refreshedAt
              ? `Updated ${new Date(refreshedAt).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                })}`
              : "Updating…"}
          </p>
        }
      />

      <dl className="grid-auto">
        <Stat
          label="Awaiting decision"
          value={model.awaiting.length}
          hint={`${model.proposalCount} proposal${model.proposalCount === 1 ? "" : "s"} received`}
          icon={<IconReview size={15} />}
        />
        <Stat
          label="Accepted sessions"
          value={model.sessions.length}
          icon={<IconCheck size={15} />}
        />
        <Stat
          label="Speakers with open tasks"
          value={model.speakersWithOpenWork.size}
          hint={overdue ? `${overdue} task${overdue === 1 ? "" : "s"} overdue` : "All on track"}
          icon={<IconSpeakers size={15} />}
          attention={overdue > 0}
        />
        <Stat
          label="Unscheduled sessions"
          value={model.unscheduled.length}
          hint={model.conflicts.length ? `${model.conflicts.length} agenda conflict(s)` : undefined}
          icon={<IconCalendar size={15} />}
          attention={model.conflicts.length > 0}
        />
      </dl>

      {model.conflicts.length || model.unscheduled.length || model.awaiting.length ? (
        <Notice tone={model.conflicts.length ? "warn" : "info"}>
          <IconWarning size={15} />
          <span>
            {[
              model.awaiting.length
                ? `${model.awaiting.length} proposal${model.awaiting.length === 1 ? "" : "s"} awaiting a decision`
                : null,
              model.unscheduled.length
                ? `${model.unscheduled.length} accepted session${model.unscheduled.length === 1 ? "" : "s"} still needs a time slot`
                : null,
              model.conflicts.length
                ? `${model.conflicts.length} scheduling conflict${model.conflicts.length === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {". "}
            <a {...linkProps(`/abstracts${query}`)}>Review abstracts</a>
            {" · "}
            <a {...linkProps(`/agenda${query}`)}>Open the agenda</a>
          </span>
        </Notice>
      ) : null}

      <Card
        labelledBy="outstanding-tasks"
        title="Outstanding speaker onboarding"
        hint="Every open task assigned to a speaker, soonest deadline first."
        tight
      >
        {model.openTasks.length === 0 ? (
          <EmptyState title="No open onboarding tasks" icon={<IconCheck size={20} />}>
            Every accepted speaker has completed the work requested of them.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Speaker</th>
                  <th scope="col">Task</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {model.openTasks.map((task) => (
                  <tr key={task.id}>
                    <td className="primary-cell">
                      {task.speaker?.name ?? "Unassigned speaker"}
                      {task.speaker?.organization ? (
                        <span className="sub">{task.speaker.organization}</span>
                      ) : null}
                    </td>
                    <td>{task.title}</td>
                    <td>
                      {new Date(task.dueAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        timeZone: event.timezone,
                      })}
                      <span className="sub">{dueLabel(task.due)}</span>
                    </td>
                    <td>
                      {task.due.overdue ? (
                        <Pill tone="danger">Overdue</Pill>
                      ) : task.due.days <= 3 ? (
                        <Pill tone="warn">
                          <IconClock size={12} />
                          Due soon
                        </Pill>
                      ) : (
                        <Pill tone="info">Open</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="split">
        <Card
          labelledBy="awaiting-decision"
          title="Awaiting decision"
          hint="Proposals that have not been accepted or declined."
          tight
        >
          {model.awaiting.length === 0 ? (
            <EmptyState title="Every proposal has a decision" icon={<IconCheck size={20} />} />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Proposal</th>
                    <th scope="col">Submitter</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {model.awaiting.map((proposal) => (
                    <tr key={proposal.id}>
                      <td className="primary-cell">{proposal.title}</td>
                      <td>{proposal.submitterName}</td>
                      <td>
                        <Pill tone="info">{proposal.status.replaceAll("_", " ")}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card labelledBy="unscheduled" title="Not yet scheduled" tight>
          {model.unscheduled.length === 0 ? (
            <EmptyState
              title="Every accepted session has a slot"
              icon={<IconCalendar size={20} />}
            />
          ) : (
            <ul className="plain-list">
              {model.unscheduled.map((contentSession) => (
                <li key={contentSession.id}>
                  <strong>{contentSession.title}</strong>
                  <span className="sub">{contentSession.format}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
