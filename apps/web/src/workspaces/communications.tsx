/**
 * The outbound delivery history.
 *
 * Owned by the `communications-integrations` domain. @spec PRD-COM-001 PRD-INT-001
 */
import { CommunicationsWorkspace } from "../CommunicationsWorkspace";
import { IconSend } from "../ui/icons";
import type { HubTabModule, WorkspaceModule } from "./contract";

export const communicationsWorkspace: WorkspaceModule = {
  domain: "communications-integrations",
  path: "/communications",
  label: "Communications",
  group: "reach",
  order: 6,
  icon: <IconSend />,
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

const communicationsTab = (
  tab: string,
  label: string,
  order: number,
  subtitle: string,
): HubTabModule => ({
  domain: "communications-integrations",
  hub: "communications",
  tab,
  label,
  order,
  personas: ["organizer"],
  legacyPaths: ["/communications"],
  canAccess: (access) => communicationsWorkspace.canAccess?.(access) ?? false,
  header: () => ({ eyebrow: "Communications", title: label, subtitle }),
  // Compose and template versioning deliberately share their roster/template read; delivery
  // recovery refreshes the same outbox after a send. The hub tab changes the entry job without
  // inventing a second state lifecycle or weakening idempotency and provider-state honesty.
  render: communicationsWorkspace.render,
});

export const composeHubTab = communicationsTab(
  "compose",
  "Compose",
  10,
  "Choose the recipients, inspect their resolved messages, and confirm the sending impact.",
);
export const communicationTemplatesHubTab = communicationsTab(
  "templates",
  "Templates",
  20,
  "Create immutable message versions while keeping every earlier send attributable.",
);
export const deliveryHubTab = communicationsTab(
  "delivery",
  "Delivery",
  30,
  "Inspect queued, retrying, sent, and terminal attempts, then recover eligible failures.",
);
