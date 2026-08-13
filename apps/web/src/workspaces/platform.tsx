/**
 * Permission-aware search across one event.
 *
 * Owned by the `platform` domain. Every persona with a seat on the event gets it, because the
 * surface refuses nothing itself: what a caller can find is decided source by source on the
 * server, under each owning domain's own rule. @spec PRD-OPS-001
 */
import { SearchWorkspace } from "../platform/SearchWorkspace";
import { IconSearch } from "../ui/icons";
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
