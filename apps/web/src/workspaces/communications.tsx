/**
 * The outbound delivery history.
 *
 * Owned by the `communications-integrations` domain. @spec PRD-COM-001 PRD-INT-001
 */
import { CommunicationsWorkspace } from "../CommunicationsWorkspace";
import { IconSend } from "../ui/icons";
import type { WorkspaceModule } from "./contract";

export const communicationsWorkspace: WorkspaceModule = {
  domain: "communications-integrations",
  path: "/communications",
  label: "Communications",
  group: "Audience",
  order: 6,
  icon: <IconSend size={16} />,
  personas: ["organizer"],
  // The actor-level capability *and* organizer role on this event: delivery history is
  // event-scoped, so a capability held through some other event must not open it here.
  canAccess: ({ session, isEventOrganizer }) =>
    Boolean(session?.capabilities.includes("communications:manage")) && isEventOrganizer,
  header: () => ({
    eyebrow: "Audience",
    title: "Communications",
    subtitle: "Outbound delivery history with queued, retrying, sent, and failed states.",
  }),
  render: ({ event }) => <CommunicationsWorkspace event={event} />,
};
