/**
 * The organizer's abstract triage and the reviewer's own queue.
 *
 * Owned by the `review` domain. @spec PRD-REV-001
 */
import { IconReview } from "../ui/icons";
import { OrganizerReviewWorkspace, ReviewerWorkspace } from "../ReviewWorkspace";
import type { WorkspaceModule } from "./contract";

export const abstractsWorkspace: WorkspaceModule = {
  domain: "review",
  path: "/abstracts",
  label: "Abstracts",
  group: "Program",
  order: 1,
  icon: <IconReview size={16} />,
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
    />
  ),
};

export const reviewsWorkspace: WorkspaceModule = {
  domain: "review",
  path: "/reviews",
  label: "Review assignments",
  group: "home",
  order: 0,
  icon: <IconReview size={16} />,
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
