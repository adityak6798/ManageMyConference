/**
 * The speaker outreach pipeline, and the organization-wide directory it draws from.
 *
 * Two modules, because they have two scopes. The pipeline is one event's; the directory spans
 * every event of the organization and is authorized at the organization. One surface carrying
 * both would have let the shell's event switcher silently change the meaning of a cross-event
 * list, so they are separate routes with separate access rules.
 *
 * Owned by the `crm` domain. @spec PRD-CRM-001
 */
import { CrmDirectoryWorkspace } from "../CrmDirectoryWorkspace";
import { CrmWorkspace } from "../CrmWorkspace";
import { IconSpeakers } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const crmWorkspace: WorkspaceModule = {
  domain: "crm",
  path: "/speakers",
  label: "Speaker CRM",
  group: "Audience",
  order: 5,
  icon: <IconSpeakers size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("crm:manage"),
  header: () => ({
    eyebrow: "Audience",
    title: "Speaker CRM",
    subtitle: "Track prospects through outreach and convert them into speakers.",
  }),
  render: ({ event, session }) => (
    <CrmWorkspace eventId={event.id} ownerId={session?.actor.id ?? ""} />
  ),
};

export const crmDirectoryWorkspace: WorkspaceModule = {
  domain: "crm",
  path: "/speaker-directory",
  label: "Speaker directory",
  group: "Audience",
  /**
   * Fractional, so the directory sits directly under the pipeline it feeds without renumbering
   * `communications` (order 6). Sidebar position is sorted, not indexed, and renumbering another
   * domain's module during a wave where several are being edited in parallel would be a merge
   * conflict over a line neither change meant anything by.
   */
  order: 5.5,
  icon: <IconSpeakers size={16} />,
  personas: ["organizer"],
  /**
   * Two conditions the browser can check, and one it deliberately cannot.
   *
   * `crm:manage` here is the *event-scoped* capability, so an organizer of another event cannot
   * mount this from a stale context; membership of at least one organization is what makes the
   * directory addressable at all. Whether the capability was earned inside the organization
   * that owns this event is the server's question — it needs event-to-organization data the
   * session does not carry — so the workspace mounts and renders the server's refusal rather
   * than guessing at it.
   */
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("crm:manage") && (session?.organizations.length ?? 0) > 0,
  header: () => ({
    eyebrow: "Audience",
    title: "Speaker directory",
    subtitle: "Every speaker this organization knows, across all of its events.",
  }),
  render: ({ event, session }) => (
    <CrmDirectoryWorkspace
      organizationId={event.organizationId}
      eventId={event.id}
      eventName={event.name}
      ownerId={session?.actor.id ?? ""}
    />
  ),
};
