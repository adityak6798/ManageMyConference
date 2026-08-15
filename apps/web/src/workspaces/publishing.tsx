/**
 * Composing and publishing the public projection.
 *
 * Owned by the `publishing` domain. @spec PRD-PUB-001
 */
import { PublishingWorkspace } from "../PublishingWorkspace";
import { IconGlobe } from "../ui/icons";
import type { HubTabModule, WorkspaceModule } from "./contract";

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

const publicationTab = (
  tab: "event-site" | "embeds",
  label: string,
  order: number,
): HubTabModule => ({
  domain: "publishing",
  hub: "publish",
  tab,
  label,
  order,
  personas: ["organizer"],
  legacyPaths: ["/publishing"],
  canAccess: (access) => publishingWorkspace.canAccess?.(access) ?? false,
  header: () => ({
    eyebrow: "Publish",
    title: label,
    subtitle:
      tab === "event-site"
        ? "See what is live, compare unpublished differences, preview, publish, or take it down."
        : "Configure technical snippets and feeds backed by the current immutable projection.",
  }),
  // Status, draft comparison, site controls and snippets share one publication preview. Keeping
  // that read together prevents the technical view from claiming a different live revision.
  render: publishingWorkspace.render,
});

export const eventSiteHubTab = publicationTab("event-site", "Event site", 10);
export const embedsHubTab = publicationTab("embeds", "Embeds", 30);
