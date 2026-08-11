/**
 * Accepted content for an organizer, and the same data as a speaker's own portal.
 *
 * Owned by the `content` domain. @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
 */
import { ContentWorkspace } from "../ContentWorkspace";
import { IconSessions, IconTask } from "../ui/icons";
import type { WorkspaceContext, WorkspaceModule } from "./contract";

// The route allowlist redirect is an effect, so it runs *after* children mount and fire
// their requests. Every workspace must therefore gate on capability itself.
const canReadContent = ({ capabilities }: { capabilities: readonly string[] }) =>
  capabilities.includes("content:read");

const workspace = ({ event, session, activeRole }: WorkspaceContext) => (
  <ContentWorkspace
    key={`${event.id}:${session?.actor.id}:${activeRole}`}
    eventId={event.id}
    role={activeRole === "speaker" ? "speaker" : "organizer"}
  />
);

export const sessionsWorkspace: WorkspaceModule = {
  domain: "content",
  path: "/sessions",
  label: "Sessions & speakers",
  group: "Program",
  order: 2,
  icon: <IconSessions size={16} />,
  personas: ["organizer"],
  canAccess: canReadContent,
  header: () => ({
    eyebrow: "Program",
    title: "Sessions & speakers",
    subtitle: "Accepted content, speaker records, tasks, and assets.",
  }),
  render: workspace,
};

export const portalWorkspace: WorkspaceModule = {
  domain: "content",
  path: "/portal",
  label: "Speaker portal",
  group: "home",
  order: 0,
  icon: <IconTask size={16} />,
  personas: ["speaker"],
  canAccess: canReadContent,
  header: () => ({
    eyebrow: "Speaker",
    title: "Speaker portal",
    subtitle: "Your profile, onboarding tasks, private uploads, and sessions.",
  }),
  render: workspace,
};
