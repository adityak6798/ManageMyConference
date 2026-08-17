/**
 * The scheduling board.
 *
 * Owned by the `agenda` domain. @spec PRD-AGD-001
 */
import { AgendaWorkspace } from "../agenda/AgendaWorkspace";
import { GeneratedDrafts } from "../agenda/GeneratedDrafts";
import { IconCalendar } from "../ui/icons";
import { Notice } from "../ui/primitives";
import { hubTabHref, type HubTabModule, type WorkspaceModule } from "./contract";

export const agendaWorkspace: WorkspaceModule = {
  domain: "agenda",
  path: "/agenda",
  label: "Agenda",
  group: "operate",
  order: 3,
  icon: <IconCalendar />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("agenda:manage"),
  header: () => ({
    eyebrow: "Program",
    title: "Agenda",
    subtitle: "Place sessions across rooms and time slots, then publish the schedule.",
  }),
  render: ({ event, agendaLoadFailure, reportAgendaLoadFailure, capabilities }) => (
    <>
      {/* The board reports a failure to load, and only that: it has no grid to put one in
          until a draft arrives. It is rendered here, above the space the board would have
          filled, rather than at the foot of the page. */}
      {agendaLoadFailure ? <Notice tone="error">{agendaLoadFailure}</Notice> : null}
      {/* The whole event, not only its id: the board renders every time on its grid in the
          event's own timezone. The generated-arrangements panel renders inside it, below the
          board, so that the two share one live region. */}
      <AgendaWorkspace
        key={event.id}
        event={event}
        onError={reportAgendaLoadFailure}
        belowBoard={(announce) => (
          <GeneratedDrafts
            eventId={event.id}
            canManage={capabilities.includes("agenda:manage")}
            announce={announce}
          />
        )}
      />
    </>
  ),
};

export const scheduleAgendaTab: HubTabModule = {
  domain: "agenda",
  hub: "schedule",
  tab: "agenda",
  label: "Agenda",
  order: 20,
  icon: <IconCalendar />,
  personas: ["organizer"],
  legacyPaths: ["/agenda"],
  canAccess: ({ capabilities }) => capabilities.includes("agenda:manage"),
  header: () => ({
    eyebrow: "Schedule",
    title: "Agenda",
    subtitle: "Place sessions, resolve conflicts, compare views, and publish the schedule.",
  }),
  render: agendaWorkspace.render,
};

export const scheduleAgendaHref = hubTabHref("schedule", scheduleAgendaTab.tab);
