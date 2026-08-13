/**
 * Reusable event templates: save an event's configuration, and clone it into another.
 *
 * Owned by the `events` domain. @spec PRD-EVT-002 ARC-FLOW-006
 */
import { EventTemplatesWorkspace } from "../events/EventTemplatesWorkspace";
import { IconInbox } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const eventTemplatesWorkspace: WorkspaceModule = {
  domain: "events",
  path: "/event-templates",
  label: "Event templates",
  group: "Audience",
  /** 60–69 is this lane's band, which puts templates after the surfaces they configure. */
  order: 60,
  icon: <IconInbox size={16} />,
  personas: ["organizer"],
  /**
   * Two conditions the browser can check, and one it deliberately cannot.
   *
   * `events:settings:read` is the *event-scoped* grant previewing needs, so an organizer of
   * another event cannot mount this from a stale context; membership of at least one
   * organization is what makes a template library addressable at all. Whether this event's
   * organization is one the account belongs to is the server's question — it needs
   * event-to-organization data the session does not carry — so the workspace mounts and
   * renders the server's refusal rather than guessing at it.
   */
  canAccess: ({ capabilities, session }) =>
    capabilities.includes("events:settings:read") && (session?.organizations.length ?? 0) > 0,
  header: ({ event }) => ({
    eyebrow: "Audience",
    title: "Event templates",
    subtitle: `Save a configuration once, then clone it into ${event.name} category by category.`,
  }),
  render: ({ event, session, capabilities }) => (
    <EventTemplatesWorkspace
      key={`${event.id}:${session?.actor.id}`}
      organizationId={event.organizationId}
      eventId={event.id}
      eventName={event.name}
      canApply={capabilities.includes("events:settings:update")}
      canAuthor={Boolean(session?.capabilities.includes("events:create"))}
    />
  ),
};
