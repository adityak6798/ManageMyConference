/**
 * Permission-aware search across one event.
 *
 * Owned by the `platform` domain. Every persona with a seat on the event gets it, because the
 * surface refuses nothing itself: what a caller can find is decided source by source on the
 * server, under each owning domain's own rule. @spec PRD-OPS-001
 */
import { AuditWorkspace } from "../platform/AuditWorkspace";
import { InboxWorkspace } from "../platform/InboxWorkspace";
import { SearchWorkspace } from "../platform/SearchWorkspace";
import { IconClock, IconInbox, IconSearch } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const searchWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/search",
  label: "Search",
  group: "home",
  order: 5,
  icon: <IconSearch size={16} />,
  personas: ["organizer", "reviewer", "speaker"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({
    title: "Search",
    subtitle:
      "Sessions, speakers, tasks, proposals, agenda placements, deliveries and contacts — " +
      "each searched under the permission its own workspace already asks for.",
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
  icon: <IconInbox size={16} />,
  personas: ["organizer", "reviewer", "speaker"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({
    title: "Inbox",
    subtitle:
      "Programme gaps, speaker work, outstanding reviews, failed deliveries and unpublished " +
      "changes. Every item is derived, so finishing the work is what removes it.",
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
  group: "Audience",
  order: 9,
  icon: <IconClock size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:settings:read"),
  header: () => ({
    eyebrow: "Audience",
    title: "Activity",
    subtitle:
      "Every recorded change on this event, in one order, from every domain — with who made it, " +
      "whether it was a person or a program, and the correlation id it happened under.",
  }),
  render: ({ event }) => <AuditWorkspace eventId={event.id} />,
};
