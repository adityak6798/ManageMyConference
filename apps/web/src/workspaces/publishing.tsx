/**
 * Composing and publishing the public projection.
 *
 * Owned by the `publishing` domain. @spec PRD-PUB-001
 */
import { PublishingWorkspace } from "../PublishingWorkspace";
import { IconGlobe } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const publishingWorkspace: WorkspaceModule = {
  domain: "publishing",
  path: "/publishing",
  label: "Publishing",
  group: "Audience",
  order: 7,
  icon: <IconGlobe size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:settings:read"),
  header: () => ({
    eyebrow: "Audience",
    title: "Publishing",
    subtitle: "Publish one versioned programme across the site, JSON feed, and configured embeds.",
  }),
  render: ({ event, session, capabilities, onPublicationChange }) => (
    <PublishingWorkspace
      key={`${event.id}:${session?.actor.id}`}
      eventId={event.id}
      eventName={event.name}
      canPublish={capabilities.includes("events:settings:update")}
      onPublicationChange={onPublicationChange}
    />
  ),
};
