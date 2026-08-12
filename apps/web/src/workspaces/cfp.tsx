/**
 * The organizer's call-for-proposals composer.
 *
 * Owned by the `cfp` domain. @spec PRD-CFP-001 PRD-CFP-002
 */
import { CfpWorkspace } from "../CfpWorkspace";
import { IconForm } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const cfpWorkspace: WorkspaceModule = {
  domain: "cfp",
  path: "/cfp",
  label: "Call for proposals",
  group: "Program",
  order: 4,
  icon: <IconForm size={16} />,
  personas: ["organizer"],
  canAccess: ({ isEventOrganizer }) => isEventOrganizer,
  header: () => ({
    eyebrow: "Program",
    title: "Call for proposals",
    subtitle: "Compose the public submission form, then publish it.",
  }),
  render: ({ event, session, activeRole }) => (
    <CfpWorkspace
      key={`${event.id}:${session?.actor.id}:${activeRole}`}
      eventId={event.id}
      organizer={activeRole === "organizer"}
    />
  ),
};
