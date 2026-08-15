/**
 * Organization portals in the console.
 *
 * Owned by the `publishing` domain, and separate from the publishing workspace because the two
 * publish different things: that one takes *one event's* programme live, this one takes an
 * organization's portal over several programs live. Sharing a surface would mean one Publish
 * button whose meaning depended on which tab was open.
 *
 * @spec PRD-PUB-002
 */
import { SitesWorkspace } from "../SitesWorkspace";
import { IconGlobe } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const sitesWorkspace: WorkspaceModule = {
  domain: "publishing",
  path: "/sites",
  label: "Portals",
  group: "Audience",
  /** Immediately after Publishing (7), which is the surface an organizer reaches for first. */
  order: 7.1,
  icon: <IconGlobe size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("events:settings:read") && (session?.organizations.length ?? 0) > 0,
  header: () => ({
    eyebrow: "Audience",
    title: "Portals",
    subtitle:
      "Compose one branded address over several programs, with a versioned privacy notice registration records against.",
  }),
  /*
   * Scoped to the organization that owns the **selected event**, for the reason the members
   * surface states: for anybody belonging to two organizations those differ, and keying on the
   * session would read one organization while every write named the other.
   */
  render: ({ event, capabilities }) => (
    <SitesWorkspace
      key={event.organizationId}
      organizationId={event.organizationId}
      canManage={capabilities.includes("events:settings:update")}
    />
  ),
};
