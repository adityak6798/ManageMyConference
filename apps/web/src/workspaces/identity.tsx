/**
 * Membership administration in the console.
 *
 * Added here rather than in `App.tsx`: the shell is shared, `/` and `/settings` are the only
 * surfaces that legitimately live in it, and a workspace module is one import and one registry
 * line.
 *
 * Owned by the `identity-access` domain. @spec PRD-IAM-001 PRD-IAM-002
 */
import { MembersWorkspace } from "../MembersWorkspace";
import { IconMembers } from "../ui/icons";
import type { HubTabModule, WorkspaceModule } from "./contract";

export const membersWorkspace: WorkspaceModule = {
  domain: "identity-access",
  path: "/members",
  label: "Members",
  group: "reach",
  /**
   * Fractional, so this sits beside the other organization-scoped surface without renumbering
   * `communications` (order 6) — the same reason the speaker directory took 5.5.
   */
  order: 5.7,
  icon: <IconMembers />,
  personas: ["organizer"],
  /**
   * Two conditions the browser can check, and one it deliberately cannot.
   *
   * `identity:manage` here is the *event-scoped* capability, so an organizer of another event
   * cannot mount this from a stale context; belonging to at least one organization is what makes
   * the surface addressable at all. Whether the capability was earned inside the organization
   * that owns this event needs event-to-organization data the session does not carry, so that
   * stays the server's question and the workspace renders its refusal rather than guessing.
   */
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("identity:manage") && (session?.organizations.length ?? 0) > 0,
  header: () => ({
    eyebrow: "Audience",
    title: "Members",
    subtitle: "Invite co-organizers and reviewers, manage event roles, and read the audit log.",
  }),
  /*
   * Scoped to the organization that owns the **selected event**, not to the session's first one.
   * For anyone belonging to two organizations those differ, and keying on the session would have
   * read one organization while the invite form submitted the other event's id — a 403 saying
   * "that event is not part of this organization", which is true and unactionable.
   */
  render: ({ event }) => (
    <MembersWorkspace organizationId={event.organizationId} eventId={event.id} />
  ),
};

export const teamHubTab: HubTabModule = {
  domain: "identity-access",
  hub: "settings",
  tab: "team",
  label: "Team",
  order: 20,
  personas: ["organizer"],
  legacyPaths: ["/members"],
  canAccess: (access) => membersWorkspace.canAccess?.(access) ?? false,
  header: membersWorkspace.header,
  render: membersWorkspace.render,
};
