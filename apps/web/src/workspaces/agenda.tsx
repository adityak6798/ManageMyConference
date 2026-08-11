/**
 * The scheduling board.
 *
 * Owned by the `agenda` domain. @spec PRD-AGD-001
 */
import { AgendaWorkspace } from "../AgendaWorkspace";
import { IconCalendar } from "../ui/icons";
import { Notice } from "../ui/primitives";
import type { WorkspaceModule } from "./contract";

export const agendaWorkspace: WorkspaceModule = {
  domain: "agenda",
  path: "/agenda",
  label: "Agenda",
  group: "Program",
  order: 3,
  icon: <IconCalendar size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("agenda:manage"),
  header: () => ({
    eyebrow: "Program",
    title: "Agenda",
    subtitle: "Place sessions across rooms and time slots, then publish the schedule.",
  }),
  render: ({ event, agendaLoadFailure, reportAgendaLoadFailure }) => (
    <>
      {/* The board reports a failure to load, and only that: it has no grid to put one in
          until a draft arrives. It is rendered here, above the space the board would have
          filled, rather than at the foot of the page. */}
      {agendaLoadFailure ? <Notice tone="error">{agendaLoadFailure}</Notice> : null}
      {/* The whole event, not only its id: the board renders every time on its grid in the
          event's own timezone. */}
      <AgendaWorkspace key={event.id} event={event} onError={reportAgendaLoadFailure} />
    </>
  ),
};
