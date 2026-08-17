/**
 * Accepted content for an organizer, and the same data as a speaker's own portal.
 *
 * Owned by the `content` domain. @spec PRD-SPK-001 PRD-SPK-002 PRD-CNT-001
 */
import { ContentWorkspace } from "../ContentWorkspace";
import { IconSessions, IconTask } from "../ui/icons";
import {
  hubTabHref,
  type HubTabModule,
  type WorkspaceContext,
  type WorkspaceModule,
} from "./contract";

// The route allowlist redirect is an effect, so it runs *after* children mount and fire
// their requests. Every workspace must therefore gate on capability itself.
const canReadContent = ({ capabilities }: { capabilities: readonly string[] }) =>
  capabilities.includes("content:read");

const workspace = ({ event, session, activeRole }: WorkspaceContext) => (
  <ContentWorkspace
    key={`${event.id}:${session?.actor.id}:${activeRole}`}
    eventId={event.id}
    role={activeRole === "speaker" ? "speaker" : "organizer"}
    canAdministerShares={activeRole === "organizer"}
  />
);

const renderSessions = ({ event, session, activeRole }: WorkspaceContext) => (
  <ContentWorkspace
    key={`${event.id}:${session?.actor.id}:${activeRole}:sessions`}
    eventId={event.id}
    role={activeRole === "speaker" ? "speaker" : "organizer"}
    canAdministerShares={false}
    sessionsOnly
  />
);

export const sessionsWorkspace: WorkspaceModule = {
  domain: "content",
  path: "/sessions",
  label: "Sessions & speakers",
  group: "operate",
  order: 2,
  icon: <IconSessions />,
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
  icon: <IconTask />,
  personas: ["speaker"],
  canAccess: canReadContent,
  header: () => ({
    eyebrow: "Speaker",
    title: "Speaker portal",
    subtitle: "Your profile, onboarding tasks, private uploads, and sessions.",
  }),
  render: workspace,
};

export const scheduleSessionsTab: HubTabModule = {
  domain: "content",
  hub: "schedule",
  tab: "sessions",
  label: "Sessions",
  order: 10,
  icon: <IconSessions />,
  personas: ["organizer"],
  legacyPaths: ["/sessions"],
  canAccess: canReadContent,
  header: () => ({
    eyebrow: "Schedule",
    title: "Sessions",
    subtitle: "Prepare accepted session metadata and see what is ready for the agenda.",
  }),
  render: renderSessions,
};

export const scheduleSessionsHref = hubTabHref("schedule", scheduleSessionsTab.tab);

const peopleContentTab = (tab: string, label: string, order: number): HubTabModule => ({
  domain: "content",
  hub: "people",
  tab,
  label,
  order,
  personas: ["organizer"],
  // The former combined route has one deterministic redirect: Schedule > Sessions. These are
  // additional focused views of the same content workspace, not competing redirect targets.
  legacyPaths: [],
  canAccess: canReadContent,
  header: () => ({
    eyebrow: "People",
    title: label,
    subtitle:
      tab === "speakers"
        ? "Accepted speakers, profile readiness, publication, and outreach."
        : tab === "tasks"
          ? "Speaker onboarding work, deadlines, checklist assignment, and reminders."
          : "Requested deliverables, uploads, downloads, and immutable asset versions.",
  }),
  render: workspace,
});

export const speakersHubTab = peopleContentTab("speakers", "Speakers", 30);
export const tasksHubTab = peopleContentTab("tasks", "Tasks", 40);
export const filesHubTab = peopleContentTab("files", "Files", 50);
