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
import { IconTask } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const reportsWorkspace: WorkspaceModule = {
  domain: "platform",
  path: "/reports",
  label: "Reports",
  group: "home",
  /** After the inbox and before the audit timeline, which is where an operator looks next. */
  order: 9.5,
  icon: <IconTask size={16} />,
  personas: ["organizer", "reviewer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:read"),
  header: () => ({
    title: "Reports",
    subtitle:
      "Ask a bounded question of this event, export the answer, and share it behind a link that expires.",
  }),
  render: ({ event, capabilities }) => (
    <ReportsWorkspace
      key={event.id}
      eventId={event.id}
      canReadPii={capabilities.includes("reports:pii")}
    />
  ),
};
