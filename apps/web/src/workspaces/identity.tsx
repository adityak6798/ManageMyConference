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
import { IconSettings } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const membersWorkspace: WorkspaceModule = {
  domain: "identity-access",
  path: "/members",
  label: "Members",
  group: "Audience",
  /**
   * Fractional, so this sits beside the other organization-scoped surface without renumbering
   * `communications` (order 6) — the same reason the speaker directory took 5.5.
   */
  order: 5.7,
  icon: <IconSettings size={16} />,
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
  render: ({ event, session }) => (
    <MembersWorkspace organizationId={session?.organizations[0]?.id ?? ""} eventId={event.id} />
  ),
};
