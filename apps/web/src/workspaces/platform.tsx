/**
 * Permission-aware search across one event.
 *
 * Owned by the `platform` domain. Every persona with a seat on the event gets it, because the
 * surface refuses nothing itself: what a caller can find is decided source by source on the
 * server, under each owning domain's own rule. @spec PRD-OPS-001
 */
import { AuditWorkspace } from "../platform/AuditWorkspace";
import { OverviewPage } from "../OverviewPage";
import { InboxWorkspace } from "../platform/InboxWorkspace";
import { SearchWorkspace } from "../platform/SearchWorkspace";
import { IconClock, IconDashboard, IconInbox, IconSearch } from "../ui/icons";
import type { HubTabModule, WorkspaceModule } from "./contract";

/** Organizer home contribution exported for the final #237 cutover, not registered here. */
export const organizerOverviewWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/",
  label: "Overview",
  group: "home",
  order: 0,
  icon: <IconDashboard />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({ title: "Overview" }),
  render: ({ event, query, onPublicationChange }) => (
    <OverviewPage
      key={event.id}
      event={event}
      query={query}
      onPublicationChange={onPublicationChange}
    />
  ),
};

export const searchWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/search",
  label: "Search",
  group: "home",
  order: 5,
  icon: <IconSearch />,
  personas: ["organizer", "reviewer", "speaker"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({
    title: "Search",
    subtitle:
      "Find sessions, people, proposals, schedule items, messages, and contacts in one place.",
  }),
  render: ({ event }) => <SearchWorkspace eventId={event.id} />,
};

/**
 * Everything waiting on this event, derived on every read.
 *
 * Offered to every persona with a seat, for the same reason search is: the surface refuses
 * nothing itself, and each category is composed under its own domain's capability, so a reviewer
 * opening it sees their outstanding evaluations and is told which categories their role does not
 * include. @spec PRD-OPS-002
 */
export const inboxWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/inbox",
  label: "Inbox",
  group: "home",
  order: 6,
  icon: <IconInbox />,
  personas: ["organizer", "reviewer", "speaker"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({
    title: "Inbox",
    subtitle: "See the work that still needs attention across this event.",
  }),
  render: ({ event }) => <InboxWorkspace eventId={event.id} />,
};

/**
 * The unified audit timeline.
 *
 * Organizer-only, and gated on `events:settings:read` rather than on `events:read`: the log names
 * who did what to an event, which is the administrative view of it rather than something every
 * role on the event may read. @spec PRD-OPS-003
 */
export const auditWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/audit",
  label: "Activity",
  group: "admin",
  order: 9,
  icon: <IconClock />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:settings:read"),
  header: () => ({
    eyebrow: "Settings",
    title: "Activity",
    subtitle: "See what changed, when it happened, and who made the change.",
  }),
  render: ({ event }) => <AuditWorkspace eventId={event.id} />,
};

export const activityHubTab: HubTabModule = {
  domain: "platform",
  hub: "settings",
  tab: "activity",
  label: "Activity",
  order: 70,
  personas: ["organizer"],
  legacyPaths: ["/audit"],
  canAccess: (access) => auditWorkspace.canAccess?.(access) ?? false,
  header: auditWorkspace.header,
  render: auditWorkspace.render,
};
