/**
 * The speaker outreach pipeline.
 *
 * Owned by the `crm` domain. @spec PRD-CRM-001
 */
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
