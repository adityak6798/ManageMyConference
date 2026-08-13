/*
 * Organizer overview.
 *
 * This is the landing surface, so it answers the questions an organizer actually
 * opens the tool to ask: what needs a decision, who is holding up onboarding, and
 * what is not on the schedule yet. The outstanding-speaker-task table is the
 * product's answer to the "who still has open onboarding work" requirement, so it
 * gets a real table rather than a counter.
 *
 * "Scheduled" is two different questions and this page answers both of them by name.
 * The agenda *board* is the organizer's working draft: a session is on it as soon as
 * it is dropped into a slot, which is the question "what still needs placing?" — the
 * same question the board's own Unscheduled rail answers. The *published schedule* is
 * the snapshot the organizer committed to, which is the question the speaker portal,
 * the `.ics`, the public programme and the Schedule column of Sessions & speakers all
 * answer, and it only moves when the agenda is published. Between those two lies a
 * real state — placed but not published — so this page counts it rather than letting
 * the two screens quietly disagree: the stat and the card name the board, and the gap
 * to the published schedule is reported next to them.
 *
 * It composes three independent workspaces (content, review, agenda), so it degrades
 * per source: a panel whose workspace did not answer says so on its own card and the
 * rest of the dashboard stays usable. A dashboard that goes blank because one of its
 * three reads failed is worse than no dashboard, because it hides the two that worked.
 */

import type { EventDto } from "@greenroom/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { getAgenda } from "./api/agenda";
import type { getContent } from "./api/content";
import { getOrganizerOverview } from "./api/overview";
import type { getOrganizerReview } from "./api/review";
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

type ContentData = Awaited<ReturnType<typeof getContent>>;
type ReviewData = Awaited<ReturnType<typeof getOrganizerReview>>;
/** Only what the dashboard reads from the board, so "no draft yet" can be expressed. */
type AgendaData = Pick<
  Awaited<ReturnType<typeof getAgenda>>,
  "placements" | "conflicts" | "slots" | "rooms"
>;

/** When and where something happens, as either the board or the published snapshot says. */
type Placed = { startsAt: string; endsAt: string; location: string };

/**
 * One source of the dashboard. `value` is the last answer that arrived — kept across a
 * failed refresh so a transient blip never blanks a card that has real data in it —
 * and `failed` says whether the most recent read of *this* source did not answer.
 */
type Panel<T> = { value: T | null; failed: boolean; reason?: unknown };

type Panels = {
  content: Panel<ContentData>;
  review: Panel<ReviewData>;
  agenda: Panel<AgendaData>;
};

type Dashboard = {
  panels: Panels;
  /** When the last read finished, whatever it returned. Drives the relative due labels. */
  checkedAt: number | null;
  /** When every source last answered together. Drives the freshness stamp. */
  freshAt: number | null;
};

const IDLE: Dashboard = {
  panels: {
    content: { value: null, failed: false },
    review: { value: null, failed: false },
    agenda: { value: null, failed: false },
  },
  checkedAt: null,
  freshAt: null,
};

const DECIDED = new Set(["accepted", "declined", "withdrawn"]);

/** How often the dashboard re-reads its data without a manual reload. */
const REFRESH_MS = 15_000;

/** Stat value shown when the workspace behind the number did not answer. */
const NO_VALUE = "—";

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

function clockTime(at: number) {
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The agenda draft is written by the first placement, so an event nobody has scheduled
 * yet has no draft at all and the API answers 404. That is the honest answer "nothing is
 * placed", not a failure, and the dashboard reads it as an empty board — this page must
 * never provision a draft to make itself renderable. Every other failure is re-thrown so
 * the agenda panel reports itself unavailable.
 */
const failed = <T,>(reason: unknown): PromiseSettledResult<T> => ({ status: "rejected", reason });
const fulfilled = <T,>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });

/**
 * Where the *working board* puts each session, keyed by session id.
 *
 * The browser-side mirror of the agenda domain's `placedSessionTimes`, and it has to keep
 * agreeing with it: a placement whose slot the board no longer holds yields nothing, because
 * a session with an unusable start is unplaced rather than placed at an unknown hour, and a
 * removed room leaves the location empty while the hour stays true. Those are the same rules
 * the published snapshot was built with, which is what makes the two comparable at all.
 */
function boardTimes(agenda: AgendaData | null): ReadonlyMap<string, Placed> {
  if (!agenda) return new Map();
  const slots = new Map(agenda.slots.map((slot) => [slot.id, slot]));
  const rooms = new Map(agenda.rooms.map((room) => [room.id, room.name]));
  const placed = new Map<string, Placed>();
  for (const placement of agenda.placements) {
    const slot = slots.get(placement.slotId);
    if (!slot) continue;
    placed.set(placement.sessionId, {
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      location: rooms.get(placement.roomId) ?? "",
    });
  }
  return placed;
}

/** Absent on both sides counts as agreement; one side absent is a difference. */
function samePlacement(left: Placed | undefined, right: Placed | undefined) {
  if (!left || !right) return !left && !right;
  return (
    left.startsAt === right.startsAt &&
    left.endsAt === right.endsAt &&
    left.location === right.location
  );
}

/** Keeps the previous answer when a source fails, so only its own card degrades. */
function applyResult<T>(panel: Panel<T>, result: PromiseSettledResult<T>): Panel<T> {
  return result.status === "fulfilled"
    ? { value: result.value, failed: false }
    : { value: panel.value, failed: true, reason: result.reason };
}

/** What a card says when the workspace behind it did not answer. */
function PanelUnavailable({ what }: { what: string }) {
  return (
    <EmptyState title={`${what} could not be loaded`} icon={<IconWarning size={20} />}>
      This panel is retrying on its own; the rest of the dashboard is unaffected.
    </EmptyState>
  );
}

export function OverviewPage({
  event,
  query,
  welcome = false,
  onPublicationChange,
}: {
  event: EventDto;
  query: string;
  /**
   * Set by the sign-in that provisioned this workspace, and only by that one. A first-run
   * dashboard is all zeroes and every panel is empty, which is indistinguishable from a
   * dashboard whose event is over — so the first-run case says which it is, once.
   */
  welcome?: boolean;
  onPublicationChange?: (publication: { slug: string; state: string } | null) => void;
}) {
  const [dashboard, setDashboard] = useState<Dashboard>(IDLE);
  const linkProps = useLinkProps();

  const load = useCallback(
    async (refresh = false) => {
      let overview: Awaited<ReturnType<typeof getOrganizerOverview>>;
      try {
        overview = await getOrganizerOverview(event.id, { refresh });
      } catch (reason) {
        // ERROR-INTENT: the request-level failure is converted into the same three rejected
        // panels as an aggregate whose sources all failed; the page renders that terminal state.
        return {
          panels: {
            content: failed<ContentData>(reason),
            review: failed<ReviewData>(reason),
            agenda: failed<AgendaData>(reason),
          },
          fetchedAt: Date.now(),
          publication: null,
        };
      }
      const panel = <T,>(result: { ok: true; data: T } | { ok: false; error: unknown }) =>
        result.ok ? fulfilled(result.data) : failed<T>(result.error);
      const agenda =
        !overview.data.agenda.ok && overview.data.agenda.error.code === "NOT_FOUND"
          ? fulfilled<AgendaData>({ placements: [], conflicts: [], slots: [], rooms: [] })
          : panel<AgendaData>(overview.data.agenda);
      return {
        panels: {
          content: panel<ContentData>(overview.data.content),
          review: panel<ReviewData>(overview.data.review),
          agenda,
        },
        fetchedAt: overview.fetchedAt,
        publication: overview.data.publication.ok
          ? {
              slug: overview.data.publication.data.slug,
              state: overview.data.publication.data.state,
            }
          : null,
      };
    },
    [event.id],
  );

  useEffect(() => {
    let active = true;
    // Polls can overlap and land out of order. Applying an older answer would both
    // resurrect stale numbers and re-stamp them as fresh, so answers are numbered and
    // anything that arrives behind the newest applied answer is dropped.
    let issued = 0;
    let applied = 0;
    setDashboard(IDLE);

    const read = () => {
      const generation = ++issued;
      // ERROR-INTENT: effects cannot await, and load() settles every source rather than
      // rejecting; each source's failure is rendered by the panel that depends on it.
      void load(generation > 1).then(({ panels: settled, fetchedAt, publication }) => {
        if (!active || generation <= applied) return;
        applied = generation;
        onPublicationChange?.(publication);
        setDashboard((current) => {
          const panels: Panels = {
            content: applyResult(current.panels.content, settled.content),
            review: applyResult(current.panels.review, settled.review),
            agenda: applyResult(current.panels.agenda, settled.agenda),
          };
          const degraded = panels.content.failed || panels.review.failed || panels.agenda.failed;
          return {
            panels,
            checkedAt: fetchedAt,
            freshAt: degraded ? current.freshAt : fetchedAt,
          };
        });
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
  }, [load, onPublicationChange]);

  const { content, review, agenda } = dashboard.panels;
  // Recomputed on every read so "overdue" does not go stale while the page is open.
  const now = dashboard.checkedAt ?? Date.now();

  const model = useMemo(() => {
    const speakerById = new Map(
      (content.value?.speakers ?? []).map((speaker) => [speaker.id, speaker]),
    );
    const openTasks = content.value
      ? content.value.tasks
          .filter((task) => task.status === "open")
          .map((task) => ({
            ...task,
            speaker: speakerById.get(task.speakerProfileId),
            due: calendarDaysUntil(task.dueAt, now, event.timezone),
          }))
          .sort((left, right) => left.due.days - right.due.days)
      : null;

    // Scheduling needs both sides: which sessions exist, and which of them are placed.
    // `session.schedule` is the *published* snapshot's answer, resolved by the content API;
    // the board is the *draft*. Holding both here is what lets the page say which is which.
    const board = boardTimes(agenda.value);
    const unplaced =
      content.value && agenda.value
        ? content.value.sessions.filter((session) => !board.has(session.id))
        : null;
    // Placed and published are not the same fact, and the difference is the organizer's
    // next action. This counts every session the two disagree about, in either direction:
    // dropped on the board and never published, and taken off the board while the
    // published schedule still carries it.
    const unpublished =
      content.value && agenda.value
        ? content.value.sessions.filter(
            (session) => !samePlacement(board.get(session.id), session.schedule),
          )
        : null;

    const awaiting = review.value
      ? review.value.proposals.filter((proposal) => !DECIDED.has(proposal.status))
      : null;

    return {
      openTasks,
      unplaced,
      unpublished,
      awaiting,
      proposalCount: review.value?.proposals.length ?? 0,
      speakerCount: content.value?.speakers.length ?? 0,
      speakersWithOpenWork: new Set((openTasks ?? []).map((task) => task.speakerProfileId)),
      conflicts: agenda.value?.conflicts ?? null,
      sessions: content.value?.sessions ?? null,
    };
  }, [content.value, review.value, agenda.value, now, event.timezone]);

  const nothingLoaded = !content.value && !review.value && !agenda.value;
  const anyFailed = content.failed || review.failed || agenda.failed;
  const requestFailure = [content.reason, review.reason, agenda.reason].find(
    (reason) => reason instanceof Error,
  );

  // Hard-fail only when there is genuinely nothing to show. One failed source over a
  // rendered dashboard degrades its own card instead.
  if (nothingLoaded && anyFailed)
    return (
      <>
        <PageHeader title="Overview" subtitle={event.name} />
        <Notice tone="error">
          {requestFailure instanceof Error
            ? requestFailure.message
            : "The overview could not be loaded. Reload to try again."}
        </Notice>
      </>
    );

  if (nothingLoaded)
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

  const overdue = (model.openTasks ?? []).filter((task) => task.due.overdue).length;
  /**
   * An event nobody has put anything into yet, told apart from one whose work is finished.
   *
   * "Every proposal has a decision" is true of both and reassuring in only one of them, and a
   * newly provisioned workspace reading as a completed conference is how a first-time organizer
   * concludes the product is broken rather than empty. Claimed only when all three sources have
   * actually answered — a workspace that merely failed to load is neither.
   */
  const unstarted =
    Boolean(content.value && review.value && agenda.value) &&
    model.sessions?.length === 0 &&
    model.speakerCount === 0 &&
    model.proposalCount === 0 &&
    model.openTasks?.length === 0;
  // The sentence that reconciles the two questions. "Publish schedule" is the control on
  // the agenda board that closes the gap, so it is named rather than described.
  const publishGap = model.unpublished?.length
    ? `The board and the published schedule differ on ${model.unpublished.length} session${
        model.unpublished.length === 1 ? "" : "s"
      }. Use Publish schedule on the agenda board to release the change.`
    : null;
  const summary = [
    model.awaiting?.length
      ? `${model.awaiting.length} proposal${model.awaiting.length === 1 ? "" : "s"} awaiting a decision`
      : null,
    model.unplaced?.length
      ? `${model.unplaced.length} accepted session${model.unplaced.length === 1 ? "" : "s"} not on the agenda board`
      : null,
    // Named separately from the line above, because it is a different remedy: these are
    // already placed, and only publishing the agenda moves them onto the schedule that
    // Sessions & speakers, the speaker portal and the public programme read.
    model.unpublished?.length
      ? `${model.unpublished.length} board change${model.unpublished.length === 1 ? "" : "s"} not published yet`
      : null,
    model.conflicts?.length
      ? `${model.conflicts.length} scheduling conflict${model.conflicts.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        eyebrow="Organizer"
        title="Overview"
        subtitle={`${event.name} · ${event.timezone}`}
        actions={
          // The dashboard refreshes itself, so it has to say when it last did — otherwise
          // a stale number is indistinguishable from a current one. A refresh that failed
          // over data already on screen says so here rather than replacing the page.
          <p className={anyFailed ? "refreshed-at is-stale" : "refreshed-at"} role="status">
            {anyFailed
              ? dashboard.freshAt
                ? `Could not refresh — showing data from ${clockTime(dashboard.freshAt)}`
                : "Some panels could not be loaded"
              : dashboard.freshAt
                ? `Updated ${clockTime(dashboard.freshAt)}`
                : "Updating…"}
          </p>
        }
      />

      {/* The flag says the workspace was just provisioned; `unstarted` says it still is. A URL
          kept in a bookmark outlives the first run, and "nothing else has been assumed on your
          behalf" is a claim about an empty workspace rather than a greeting. */}
      {welcome && unstarted ? (
        <Card labelledBy="welcome-title" title="Your workspace is ready">
          <p>
            Greenroom made you an organization and one event to work in —{" "}
            <strong>{event.name}</strong>, currently in {event.timezone}. Nothing else has been
            assumed on your behalf.
          </p>
          <ol>
            <li>
              <strong>Name the event and set its timezone.</strong> Every time on the agenda board,
              in a calendar invitation and on the public site is rendered in it, so it is the one
              setting worth fixing before anything depends on it.{" "}
              <a {...linkProps(`/settings${query}`)}>Open Event settings</a>.
            </li>
            <li>
              <strong>Open the call for proposals.</strong> Compose the form, publish it, and
              submissions arrive ready to route, review and decide.{" "}
              <a {...linkProps(`/cfp${query}`)}>Open the call for proposals</a>.
            </li>
            <li>
              <strong>Then the work fills this page.</strong> Accepted sessions want placing on the
              agenda board, speakers pick up onboarding tasks, and publishing is what moves any of
              it to the public site and the speaker portal.
            </li>
          </ol>
        </Card>
      ) : null}

      <dl className="grid-auto">
        <Stat
          label="Awaiting decision"
          value={model.awaiting ? model.awaiting.length : NO_VALUE}
          hint={
            model.awaiting
              ? `${model.proposalCount} proposal${model.proposalCount === 1 ? "" : "s"} received`
              : "Abstracts unavailable"
          }
          icon={<IconReview size={15} />}
        />
        <Stat
          label="Accepted sessions"
          value={model.sessions ? model.sessions.length : NO_VALUE}
          hint={model.sessions ? undefined : "Sessions unavailable"}
          icon={<IconCheck size={15} />}
        />
        <Stat
          label="Speakers with open tasks"
          value={model.openTasks ? model.speakersWithOpenWork.size : NO_VALUE}
          hint={
            model.openTasks
              ? overdue
                ? `${overdue} task${overdue === 1 ? "" : "s"} overdue`
                : // "All on track" over an event with no speakers at all is a reassurance about
                  // nothing, which is exactly how a first-run dashboard reads as a broken one.
                  unstarted
                  ? "No speakers yet"
                  : "All on track"
              : "Speaker onboarding unavailable"
          }
          icon={<IconSpeakers size={15} />}
          attention={overdue > 0}
        />
        {/* The board's question, said in the board's words. The published schedule is the
            other question, and its answer is the hint rather than the headline: placing a
            session is the work this stat is counting, publishing it is the next step. */}
        <Stat
          label="Not on the board"
          value={model.unplaced ? model.unplaced.length : NO_VALUE}
          hint={
            model.unplaced
              ? model.conflicts?.length
                ? `${model.conflicts.length} agenda conflict(s)`
                : model.unpublished?.length
                  ? `${model.unpublished.length} board change(s) not published`
                  : "The board matches the published schedule"
              : "Agenda unavailable"
          }
          icon={<IconCalendar size={15} />}
          attention={Boolean(model.conflicts?.length)}
        />
      </dl>

      {summary.length ? (
        <Notice tone={model.conflicts?.length ? "warn" : "info"}>
          <IconWarning size={15} />
          <span>
            {summary.join(" · ")}
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
        {!model.openTasks ? (
          <PanelUnavailable what="Speaker onboarding" />
        ) : model.openTasks.length === 0 ? (
          unstarted ? (
            <EmptyState title="No speakers yet" icon={<IconSpeakers size={20} />}>
              A speaker appears here when a proposal is accepted, along with whatever onboarding you
              ask of them — a bio, a headshot, slides by a date.
            </EmptyState>
          ) : (
            <EmptyState title="No open onboarding tasks" icon={<IconCheck size={20} />}>
              Every accepted speaker has completed the work requested of them.
            </EmptyState>
          )
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
          {!model.awaiting ? (
            <PanelUnavailable what="Abstracts" />
          ) : model.awaiting.length === 0 ? (
            unstarted ? (
              <EmptyState title="No proposals yet" icon={<IconReview size={20} />}>
                Publish the call for proposals and every submission lands here, waiting to be
                routed, reviewed and decided.
              </EmptyState>
            ) : (
              <EmptyState title="Every proposal has a decision" icon={<IconCheck size={20} />} />
            )
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

        <Card
          labelledBy="unscheduled"
          title="Not on the agenda board"
          // Both halves of the answer sit in the header, so the reader gets them whichever
          // body branch renders: an empty list means the placing is done, which is not the
          // same as the published schedule — or the public — having caught up. The claim is
          // withheld entirely when a source did not answer, rather than asserting agreement
          // between two things this page failed to read.
          hint={
            model.unplaced
              ? `Accepted sessions the working draft gives no slot. ${
                  publishGap ?? "The board and the published schedule agree."
                }`
              : "Accepted sessions the working draft gives no slot."
          }
          tight
        >
          {!model.unplaced ? (
            <PanelUnavailable what={content.value ? "The agenda" : "Sessions"} />
          ) : model.unplaced.length === 0 ? (
            unstarted ? (
              <EmptyState title="Nothing to schedule yet" icon={<IconCalendar size={20} />}>
                Accepting a proposal creates the session, and it arrives here for you to drop onto
                the board.
              </EmptyState>
            ) : (
              <EmptyState
                title="Every accepted session is on the board"
                icon={<IconCalendar size={20} />}
              />
            )
          ) : (
            <ul className="plain-list">
              {model.unplaced.map((contentSession) => (
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
