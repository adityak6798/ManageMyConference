/**
 * Reports in the console.
 *
 * Owned by the `platform` domain, beside search, the inbox and the audit timeline — the four
 * surfaces that compose other domains' reads rather than owning data of their own.
 *
 * Open to every persona that can read the event, not only organizers, because each dataset is
 * authorized again by the domain that owns it: a reviewer sees the datasets a reviewer can read
 * and is told "not yours" for the rest. Listing it for organizers alone would have hidden a
 * capability reviewers genuinely have.
 *
 * @spec PRD-OPS-004
 */
import { ReportsWorkspace } from "../ReportsWorkspace";
import { IconReport } from "../ui/icons";
import type { HubTabModule, WorkspaceModule } from "./contract";

export const reportsWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/reports",
  label: "Reports",
  group: "home",
  /** After the inbox and before the audit timeline, which is where an operator looks next. */
  order: 9.5,
  icon: <IconReport />,
  personas: ["organizer", "reviewer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({
    title: "Reports",
    subtitle: "Build, save, export, and securely share a view of your event data.",
  }),
  /*
   * The event's zone, not the reader's. A schedule fires in the event's timezone — the empty
   * state has always said so — while the create button sent `Intl…resolvedOptions().timeZone`,
   * so an organizer in Berlin scheduling a Pacific event created one nine hours off what the
   * screen promised.
   */
  render: ({ event, capabilities }) => (
    <ReportsWorkspace
      key={event.id}
      eventId={event.id}
      timezone={event.timezone}
      canReadPii={capabilities.includes("reports:pii")}
    />
  ),
};

export const reportsHubTab: HubTabModule = {
  domain: "platform",
  hub: "settings",
  tab: "reports",
  label: "Reports",
  order: 60,
  personas: ["organizer"],
  legacyPaths: ["/reports"],
  canAccess: (access) => reportsWorkspace.canAccess?.(access) ?? false,
  header: reportsWorkspace.header,
  render: reportsWorkspace.render,
};
