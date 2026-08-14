/**
 * Custom event roles and per-field access in the console.
 *
 * A surface of its own rather than a tab inside Members, because it answers a different question:
 * Members is who belongs here, and this is what a role may see. Registering it separately also
 * keeps `MembersWorkspace` from growing a second state lifecycle it does not share.
 *
 * Owned by the `identity-access` domain. @spec PRD-IAM-002
 */
import { CustomRolesWorkspace } from "../CustomRolesWorkspace";
import { IconShield } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const customRolesWorkspace: WorkspaceModule = {
  domain: "identity-access",
  path: "/roles",
  label: "Roles and access",
  group: "Audience",
  /** Beside Members (5.7), before communications (6). */
  order: 5.8,
  icon: <IconShield size={16} />,
  personas: ["organizer"],
  /**
   * The same two conditions the members surface checks, and the same one it cannot.
   *
   * `identity:manage` here is the *event-scoped* capability, so an organizer of another event
   * cannot mount this from a stale context. Whether the capability was earned inside the
   * organization that owns this event needs data the session does not carry, so that stays the
   * server's question and this workspace renders its refusal rather than guessing.
   */
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("identity:manage") && (session?.organizations.length ?? 0) > 0,
  header: () => ({
    eyebrow: "Audience",
    title: "Roles and access",
    subtitle:
      "Compose an event role, decide what it sees field by field, and preview the result before anybody holds it.",
  }),
  render: ({ event, capabilities }) => (
    <CustomRolesWorkspace
      key={event.id}
      organizationId={event.organizationId}
      eventId={event.id}
      canManage={capabilities.includes("identity:manage")}
    />
  ),
};
