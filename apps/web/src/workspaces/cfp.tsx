/**
 * The organizer's call-for-proposals composer.
 *
 * Owned by the `cfp` domain. @spec PRD-CFP-001 PRD-CFP-002
 */
import { CfpWorkspace } from "../CfpWorkspace";
import { IconForm } from "../ui/icons";
import { hubTabHref, type HubTabModule, type WorkspaceModule } from "./contract";

export const cfpWorkspace: WorkspaceModule = {
  domain: "cfp",
  path: "/cfp",
  label: "Call for proposals",
  group: "Program",
  order: 4,
  icon: <IconForm size={16} />,
  personas: ["organizer"],
  canAccess: ({ capabilities }) => capabilities.includes("events:settings:update"),
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
      // The submission deadline is entered and shown in the event's own zone, never the
      // operator's: a `datetime-local` input carries no timezone at all.
      timezone={event.timezone}
    />
  ),
};

/** Domain-owned Program contribution. Registered only by the final #237 cutover. */
export const programFormsTab: HubTabModule = {
  domain: "cfp",
  hub: "program",
  tab: "forms",
  label: "Forms",
  order: 10,
  icon: <IconForm size={16} />,
  personas: ["organizer"],
  legacyPaths: ["/cfp"],
  canAccess: ({ capabilities }) => capabilities.includes("events:settings:update"),
  header: () => ({
    eyebrow: "Program",
    title: "Forms",
    subtitle: "Build the submission form, check readiness, and control when it is live.",
  }),
  render: cfpWorkspace.render,
};

/** Stable URL exported beside the module for consumers that link directly into Forms. */
export const programFormsHref = hubTabHref("program", programFormsTab.tab);
