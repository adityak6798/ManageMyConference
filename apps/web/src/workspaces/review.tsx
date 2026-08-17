/**
 * The organizer's abstract triage and the reviewer's own queue.
 *
 * Owned by the `review` domain. @spec PRD-REV-001
 */
import { IconReview } from "../ui/icons";
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "../ReviewWorkspace";
import { hubTabHref, type HubTabModule, type WorkspaceModule } from "./contract";

export const abstractsWorkspace: WorkspaceModule = {
  domain: "review",
  path: "/abstracts",
  label: "Abstracts",
  group: "operate",
  order: 1,
  icon: <IconReview />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("review:manage"),
  header: () => ({
    eyebrow: "Program",
    title: "Abstracts",
    subtitle: "Triage submissions, assign reviewers, and record decisions.",
  }),
  render: ({ event, session }) => (
    <OrganizerReviewWorkspace
      key={`${event.id}:${session?.actor.id}:organizer-review`}
      eventId={event.id}
      {...(session ? { currentActor: session.actor } : {})}
    />
  ),
};

export const reviewsWorkspace: WorkspaceModule = {
  domain: "review",
  path: "/reviews",
  label: "Review assignments",
  group: "home",
  order: 0,
  icon: <IconReview />,
  personas: ["reviewer"],
  canAccess: ({ capabilities }) => capabilities.includes("review:evaluate"),
  header: () => ({
    eyebrow: "Reviewer",
    title: "Review assignments",
    subtitle: "Score each assigned proposal against the evaluation plan.",
  }),
  render: ({ event, session }) => (
    <ReviewerWorkspace
      key={`${event.id}:${session?.actor.id}:reviewer-review`}
      eventId={event.id}
    />
  ),
};

const organizerReview = ({ event, session }: Parameters<HubTabModule["render"]>[0]) => (
  <OrganizerReviewWorkspace
    key={`${event.id}:${session?.actor.id}:organizer-review`}
    eventId={event.id}
    {...(session ? { currentActor: session.actor } : {})}
  />
);

export const programSubmissionsTab: HubTabModule = {
  domain: "review",
  hub: "program",
  tab: "submissions",
  label: "Submissions",
  // First in the Program hub, because a hub opens on its first tab and this is the daily
  // queue. Forms is the once-per-event form builder, and opening the console on it put a
  // configuration surface in front of the work every single morning.
  order: 10,
  icon: <IconReview />,
  personas: ["organizer"],
  legacyPaths: ["/abstracts"],
  canAccess: ({ capabilities }) => capabilities.includes("review:manage"),
  header: () => ({
    eyebrow: "Program",
    title: "Submissions",
    subtitle: "Filter, route, assign, export, and decide proposals without losing your place.",
  }),
  render: organizerReview,
};

export const programReviewTab: HubTabModule = {
  ...programSubmissionsTab,
  tab: "review",
  label: "Review",
  order: 30,
  legacyPaths: [],
  header: () => ({
    eyebrow: "Program",
    title: "Review",
    subtitle: "Configure rounds and scoring, then follow reviewer progress and decision history.",
  }),
};

export const programSubmissionsHref = hubTabHref("program", programSubmissionsTab.tab);
export const programReviewHref = hubTabHref("program", programReviewTab.tab);
